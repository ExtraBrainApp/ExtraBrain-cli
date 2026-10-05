import { createHash, randomUUID } from 'node:crypto'
import { link, lstat, mkdir, open, unlink, writeFile, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { CliApiError, type DocumentApiClient } from './apiClient.service'
import { SESSION_COLLECTIONS, SessionDataService } from './sessionData.service'

interface ContentReference {
  contentId: string
  totalChars: number
  sha256?: string
}
interface AssetDescriptor {
  screenshotId: string
  representation: string
  mediaType: string
  byteLength: number
  sha256: string
  available: boolean
  [key: string]: unknown
}

const invalid = (message: string): never => { throw new CliApiError('INVALID_RESPONSE', message) }
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('Invalid export metadata')
  return value as Record<string, unknown>
}
const text = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || !value) invalid(`Invalid ${name}`)
  return value as string
}
const safeName = (identity: string): string => createHash('sha256').update(identity).digest('hex')
const writeJson = (path: string, data: unknown): Promise<void> =>
  writeFile(path, `${JSON.stringify(data)}\n`, { flag: 'wx', mode: 0o600 })
const progress = (path: string, stage: string): Promise<void> =>
  writeFile(path, `${JSON.stringify({ complete: false, stage })}\n`, { mode: 0o600 })
const markFailure = async (directory: string, error: unknown): Promise<void> => {
  const marker = join(directory, 'incomplete.json')
  try {
    await lstat(marker)
    await writeFile(marker, `${JSON.stringify({ complete: false, stage: 'failed', error: error instanceof CliApiError ? error.code : 'EXPORT_FAILED', message: String(error instanceof Error ? error.message : error) })}\n`, { mode: 0o600 })
  } catch {
    // Preserve the original failure when the marker itself cannot be updated.
  }
}
const writeBuffer = async (file: FileHandle, buffer: Buffer): Promise<void> => {
  let offset = 0
  while (offset < buffer.length) {
    const result = await file.write(buffer, offset, buffer.length - offset)
    if (result.bytesWritten <= 0) throw new Error('File write made no progress')
    offset += result.bytesWritten
  }
}
const writeLine = (file: FileHandle, data: unknown): Promise<void> =>
  writeBuffer(file, Buffer.from(`${JSON.stringify(data)}\n`))
const contentRefs = (value: unknown): ContentReference[] => {
  if (!value || typeof value !== 'object') return []
  if (Array.isArray(value)) return value.flatMap(contentRefs)
  const record = value as Record<string, unknown>
  const own = typeof record.contentId === 'string' && Number.isSafeInteger(record.totalChars) && (record.totalChars as number) >= 0
    ? [{ contentId: record.contentId, totalChars: record.totalChars as number, ...(typeof record.sha256 === 'string' ? { sha256: record.sha256 } : {}) }]
    : []
  return [...own, ...Object.values(record).flatMap(contentRefs)]
}
const asset = (value: unknown): AssetDescriptor => {
  const record = object(value)
  text(record.screenshotId, 'screenshot ID')
  text(record.representation, 'representation')
  if (typeof record.available !== 'boolean') invalid('Invalid asset availability')
  if (record.available) {
    text(record.mediaType, 'media type')
    if (!Number.isSafeInteger(record.byteLength) || (record.byteLength as number) < 0) invalid('Invalid asset length')
    if (typeof record.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(record.sha256)) invalid('Invalid asset hash')
  }
  return record as unknown as AssetDescriptor
}
const ensureAbsent = async (path: string): Promise<void> => {
  try {
    await lstat(path)
    throw new CliApiError('DESTINATION_EXISTS', `Destination already exists: ${path}`)
  } catch (error) {
    if (error instanceof CliApiError) throw error
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

export class SessionExportService {
  private readonly data: SessionDataService
  constructor(private readonly client: DocumentApiClient) {
    this.data = new SessionDataService(client)
  }

  private async contentFile(
    directory: string, sessionId: string, reference: ContentReference, snapshot: string,
    registry: Record<string, Record<string, unknown>>
  ): Promise<void> {
    const previous = registry[reference.contentId]
    if (previous) {
      if (previous.totalChars !== reference.totalChars || (reference.sha256 && previous.sha256 !== reference.sha256)) invalid('Conflicting content reference')
      return
    }
    const fileName = `${safeName(reference.contentId)}.txt`
    const file = await open(join(directory, fileName), 'wx', 0o600)
    const hash = createHash('sha256')
    let offset = 0
    let carry = ''
    try {
      while (true) {
        const page = await this.data.content(sessionId, reference.contentId, snapshot, offset, 100000)
        let chunk = carry + (page.text as string)
        carry = ''
        if (chunk.length && /[\uD800-\uDBFF]/.test(chunk.at(-1)!)) {
          carry = chunk.at(-1)!
          chunk = chunk.slice(0, -1)
        }
        const bytes = Buffer.from(chunk, 'utf8')
        await writeBuffer(file, bytes)
        hash.update(bytes)
        if (page.nextOffset === null) {
          if (carry) invalid('Content ended inside a surrogate pair')
          if (offset + (page.text as string).length !== reference.totalChars) invalid('Content length disagrees with reference')
          break
        }
        offset = page.nextOffset as number
      }
    } finally {
      await file.close()
    }
    const sha256 = hash.digest('hex')
    if (reference.sha256 && sha256.toLowerCase() !== reference.sha256.toLowerCase()) invalid('Content hash mismatch')
    registry[reference.contentId] = { file: `content/${fileName}`, totalChars: reference.totalChars, sha256 }
  }

  private async assetFile(path: string, sessionId: string, descriptor: AssetDescriptor, snapshot: string): Promise<void> {
    await ensureAbsent(path)
    const partial = `${path}.partial-${randomUUID()}`
    const response = await this.client.sessionAsset(sessionId, descriptor.screenshotId, descriptor.representation, snapshot)
    if (response.headers.get('content-type') && response.headers.get('content-type')!.split(';')[0] !== descriptor.mediaType) invalid('Image media type mismatch')
    const body = response.body
    if (!body) invalid('Image response has no body')
    const file = await open(partial, 'wx', 0o600)
    const hash = createHash('sha256')
    let count = 0
    try {
      for await (const chunk of body as ReadableStream<Uint8Array>) {
        const bytes = Buffer.from(chunk)
        count += bytes.length
        if (count > descriptor.byteLength) invalid(`Image exceeds advertised length; partial file: ${partial}`)
        hash.update(bytes)
        try {
          await writeBuffer(file, bytes)
        } catch (error) {
          throw new CliApiError('EXPORT_FAILED', `Image write failed; partial file: ${partial}; ${String(error)}`)
        }
      }
    } catch (error) {
      if (error instanceof CliApiError) throw error
      throw new CliApiError('TRANSFER_FAILED', `Image transfer failed; partial file: ${partial}`)
    } finally {
      await file.close()
    }
    if (count !== descriptor.byteLength || hash.digest('hex').toLowerCase() !== descriptor.sha256.toLowerCase()) {
      invalid(`Image length or SHA-256 mismatch; partial file: ${partial}`)
    }
    await link(partial, path)
    await unlink(partial)
  }

  private async imageFiles(
    directory: string, sessionId: string, descriptors: unknown[], snapshot: string
  ): Promise<Record<string, unknown>[]> {
    const results: Record<string, unknown>[] = []
    const seen = new Map<string, string>()
    for (const raw of descriptors) {
      const descriptor = asset(raw)
      const key = `${descriptor.screenshotId}\0${descriptor.representation}`
      const prior = seen.get(key)
      if (prior) {
        const previous = results.find((item) => item.file === prior)
        if (previous && (previous.byteLength !== descriptor.byteLength || previous.sha256 !== descriptor.sha256 || previous.mediaType !== descriptor.mediaType)) invalid('Conflicting asset descriptor')
        results.push({ ...descriptor, file: prior })
        continue
      }
      if (!descriptor.available) {
        results.push({ ...descriptor, file: null })
        continue
      }
      const fileName = `${safeName(key)}.bin`
      const file = `screenshots/${fileName}`
      await this.assetFile(join(directory, fileName), sessionId, descriptor, snapshot)
      seen.set(key, file)
      results.push({ ...descriptor, file })
    }
    return results
  }

  private async finish(directory: string, manifest: Record<string, unknown>): Promise<void> {
    const partial = join(directory, `.manifest-${randomUUID()}.partial`)
    await writeJson(partial, manifest)
    await link(partial, join(directory, 'manifest.json'))
    await unlink(partial)
    await unlink(join(directory, 'incomplete.json'))
  }

  private async analysisDirectory(directory: string, sessionId: string, analysisId: string, snapshot?: string): Promise<Record<string, unknown>> {
    await mkdir(directory, { mode: 0o700 })
    const marker = join(directory, 'incomplete.json')
    await writeJson(marker, { complete: false, stage: 'manifest' })
    await mkdir(join(directory, 'parts'), { mode: 0o700 })
    await mkdir(join(directory, 'content'), { mode: 0o700 })
    await mkdir(join(directory, 'screenshots'), { mode: 0o700 })
    const manifest = await this.data.analysisManifest(sessionId, analysisId, snapshot)
    const effectiveSnapshot = manifest.snapshot as string
    const contents: Record<string, Record<string, unknown>> = {}
    const parts: Record<string, unknown>[] = []
    const seenParts = new Set<string>()
    for (const raw of manifest.parts as unknown[]) {
      const descriptor = object(raw)
      const partId = text(descriptor.id, 'part ID')
      if (seenParts.has(partId)) invalid('Duplicate part ID')
      seenParts.add(partId)
      if (descriptor.available === false) {
        parts.push({ ...descriptor, file: null })
        continue
      }
      const fileName = `${safeName(partId)}.jsonl`
      const file = await open(join(directory, 'parts', fileName), 'wx', 0o600)
      let fetched = 0
      try {
        for await (const page of this.data.allPages((cursor) => this.data.part(sessionId, analysisId, partId, { cursor, snapshot: effectiveSnapshot }), effectiveSnapshot)) {
          for (const item of page.items) {
            await writeLine(file, item)
            fetched += 1
            for (const reference of contentRefs(item)) await this.contentFile(join(directory, 'content'), sessionId, reference, effectiveSnapshot, contents)
          }
        }
      } finally {
        await file.close()
      }
      if (fetched !== descriptor.totalCount) invalid('Part count disagrees with manifest')
      parts.push({ ...descriptor, file: `parts/${fileName}`, fetched })
      await progress(marker, `part:${partId}`)
    }
    const assets = await this.imageFiles(join(directory, 'screenshots'), sessionId, manifest.assets as unknown[], effectiveSnapshot)
    const complete = { ...manifest, parts, assets, content: contents, retrieval: { complete: true }, exportedAt: Math.floor(Date.now() / 1000) }
    await this.finish(directory, complete)
    return complete
  }

  async exportAnalysis(output: string, sessionId: string, analysisId: string): Promise<Record<string, unknown>> {
    try {
      return await this.analysisDirectory(output, sessionId, analysisId)
    } catch (error) {
      await markFailure(output, error)
      if (error instanceof CliApiError) throw new CliApiError(error.code, `${error.message}; export directory: ${output}`, error.status, error.details)
      throw new CliApiError('EXPORT_FAILED', `Analysis export incomplete at ${output}: ${String(error)}`)
    }
  }

  async exportSession(output: string, sessionId: string): Promise<Record<string, unknown>> {
    try {
      await mkdir(output, { mode: 0o700 })
      const marker = join(output, 'incomplete.json')
      await writeJson(marker, { complete: false, stage: 'metadata' })
      await mkdir(join(output, 'content'), { mode: 0o700 })
      await mkdir(join(output, 'screenshots'), { mode: 0o700 })
      await mkdir(join(output, 'analyses'), { mode: 0o700 })
      const metadata = await this.data.get(sessionId)
      const snapshot = metadata.snapshot as string
      const contents: Record<string, Record<string, unknown>> = {}
      const counts: Record<string, number> = {}
      const images: unknown[] = []
      for (const collection of SESSION_COLLECTIONS) {
        const file = await open(join(output, `${collection}.jsonl`), 'wx', 0o600)
        let fetched = 0
        try {
          for await (const page of this.data.allPages((cursor) => this.data.collection(sessionId, collection, { cursor, snapshot }), snapshot, collection === 'screenshots' ? 'screenshotId' : 'id')) {
            for (const item of page.items) {
              await writeLine(file, item)
              fetched += 1
              for (const reference of contentRefs(item)) await this.contentFile(join(output, 'content'), sessionId, reference, snapshot, contents)
              if (collection === 'screenshots') {
                const representations = item.representations
                if (!Array.isArray(representations)) invalid('Screenshot lacks representations')
                for (const representation of representations as unknown[]) images.push({ ...object(representation), screenshotId: text(item.id ?? item.screenshotId, 'screenshot ID') })
              }
            }
          }
        } finally {
          await file.close()
        }
        counts[collection] = fetched
        const advertised = object(metadata.counts ?? {})[collection]
        if (advertised !== undefined && advertised !== fetched) invalid(`Collection count disagrees: ${collection}`)
        await progress(marker, `collection:${collection}`)
      }
      const assets = await this.imageFiles(join(output, 'screenshots'), sessionId, images, snapshot)
      const analyses: Record<string, unknown>[] = []
      for await (const page of this.data.allPages((cursor) => this.data.analyses(sessionId, { cursor, snapshot }), snapshot, 'analysisId')) {
        for (const item of page.items) {
          const id = text(item.analysisId ?? item.id, 'analysis ID')
          const file = `analyses/${safeName(id)}`
          const result = await this.analysisDirectory(join(output, file), sessionId, id, snapshot)
          analyses.push({ id, file, provenance: result.provenance })
          await progress(marker, `analysis:${id}`)
        }
      }
      const advertisedAnalyses = object(metadata.counts ?? {}).analyses
      if (advertisedAnalyses !== undefined && advertisedAnalyses !== analyses.length) invalid('Analysis count disagrees')
      const manifest = { schemaVersion: 'v1', sessionId, snapshot, metadata, counts, content: contents, assets, analyses, retrieval: { complete: true }, exportedAt: Math.floor(Date.now() / 1000) }
      await this.finish(output, manifest)
      return manifest
    } catch (error) {
      await markFailure(output, error)
      if (error instanceof CliApiError) throw new CliApiError(error.code, `${error.message}; export directory: ${output}`, error.status, error.details)
      throw new CliApiError('EXPORT_FAILED', `Session export incomplete at ${output}: ${String(error)}`)
    }
  }

  async exportScreenshot(output: string, sessionId: string, screenshotId: string, representation?: string): Promise<Record<string, unknown>> {
    try {
      await ensureAbsent(output)
      const metadata = await this.data.get(sessionId)
      const snapshot = metadata.snapshot as string
      let selected: Record<string, unknown> | undefined
      for await (const page of this.data.allPages((cursor) => this.data.collection(sessionId, 'screenshots', { cursor, snapshot }), snapshot, 'screenshotId')) {
        selected = page.items.find((item) => item.id === screenshotId || item.screenshotId === screenshotId) ?? selected
      }
      if (!selected) throw new CliApiError('NOT_FOUND', 'Screenshot is not in this session')
      const wanted = representation ?? text(selected.defaultRepresentation, 'default representation')
      const representations = selected.representations
      if (!Array.isArray(representations)) invalid('Screenshot lacks representations')
      const raw = (representations as unknown[]).find((item) => object(item).representation === wanted)
      if (!raw) throw new CliApiError('REPRESENTATION_UNAVAILABLE', `Representation ${wanted} is unavailable`)
      const descriptor = asset({ ...object(raw), screenshotId })
      if (!descriptor.available) throw new CliApiError('REPRESENTATION_UNAVAILABLE', `Representation ${wanted} is unavailable`)
      await this.assetFile(output, sessionId, descriptor, snapshot)
      return { screenshotId, representation: descriptor.representation, mediaType: descriptor.mediaType, byteLength: descriptor.byteLength, sha256: descriptor.sha256, snapshot }
    } catch (error) {
      if (error instanceof CliApiError) throw error
      throw new CliApiError('EXPORT_FAILED', `Screenshot export failed: ${String(error)}`)
    }
  }
}
