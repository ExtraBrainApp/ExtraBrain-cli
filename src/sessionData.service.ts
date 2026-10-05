import { CliApiError, type DocumentApiClient } from './apiClient.service'

export const SESSION_COLLECTIONS = [
  'transcripts', 'screenshots', 'facts', 'topics', 'questions', 'chat-turns', 'insights'
] as const
export type SessionCollection = (typeof SESSION_COLLECTIONS)[number]
export const ANALYSIS_JSON_LIMIT = 16 * 1024 * 1024

export interface SessionPage {
  items: Record<string, unknown>[]
  totalCount: number
  nextCursor: string | null
  snapshot: string
  [key: string]: unknown
}

const invalid = (message: string): never => {
  throw new CliApiError('INVALID_RESPONSE', message)
}
const object = (value: unknown, name: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`Invalid ${name}`)
  return value as Record<string, unknown>
}
const identity = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || !value) invalid(`Invalid ${name}`)
  return value as string
}
const count = (value: unknown, name: string): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid(`Invalid ${name}`)
  return value as number
}
const checkScope = (data: Record<string, unknown>, key: string, expected: string): void => {
  if (data[key] !== undefined && data[key] !== expected) invalid(`Mismatched ${key}`)
}
const checkSnapshot = (data: Record<string, unknown>, expected?: string): string => {
  const snapshot = identity(data.snapshot, 'snapshot')
  if (expected && snapshot !== expected) invalid('Snapshot changed during retrieval')
  return snapshot
}
const encode = encodeURIComponent
const queryPath = (path: string, params: Record<string, string | number | undefined>): string => {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) query.set(key, String(value))
  }
  const suffix = query.toString()
  return suffix ? `${path}?${suffix}` : path
}

export class SessionDataService {
  constructor(private readonly client: DocumentApiClient) {}

  private read(path: string): Promise<Record<string, unknown>> {
    return this.client.json(path, { method: 'GET' }, false)
  }

  async page(
    path: string,
    options: { limit?: number; cursor?: string; snapshot?: string; q?: string; since?: number; until?: number } = {},
    scope: { sessionId?: string; analysisId?: string } = {}
  ): Promise<SessionPage> {
    const data = await this.read(queryPath(path, { ...options, limit: options.limit ?? 50 }))
    const items = data.items
    if (!Array.isArray(items) || items.some((item) => !item || typeof item !== 'object' || Array.isArray(item))) invalid('Invalid page items')
    const totalCount = count(data.totalCount, 'totalCount')
    const nextCursor = data.nextCursor
    if (nextCursor !== null && (typeof nextCursor !== 'string' || !nextCursor)) invalid('Invalid nextCursor')
    checkSnapshot(data, options.snapshot)
    if (scope.sessionId) checkScope(data, 'sessionId', scope.sessionId)
    if (scope.analysisId) checkScope(data, 'analysisId', scope.analysisId)
    if ((items as unknown[]).length > totalCount || ((items as unknown[]).length === 0 && nextCursor !== null)) invalid('Invalid page count')
    return data as unknown as SessionPage
  }

  list(options: { limit?: number; cursor?: string; since?: number; until?: number } = {}): Promise<SessionPage> {
    return this.page('/api/v1/sessions', options)
  }

  search(q: string, options: { limit?: number; cursor?: string; since?: number; until?: number } = {}): Promise<SessionPage> {
    return this.page('/api/v1/sessions/search', { ...options, q })
  }

  async current(): Promise<Record<string, unknown>> {
    const data = await this.read('/api/v1/sessions/current')
    if (!('activeSessionId' in data) || (data.activeSessionId !== null && typeof data.activeSessionId !== 'string')) invalid('Invalid current session identity')
    return data
  }

  async get(sessionId: string, snapshot?: string): Promise<Record<string, unknown>> {
    const data = await this.read(queryPath(`/api/v1/sessions/${encode(sessionId)}`, { snapshot }))
    checkScope(data, 'sessionId', sessionId)
    checkSnapshot(data, snapshot)
    return data
  }

  collection(sessionId: string, collection: SessionCollection, options: { limit?: number; cursor?: string; snapshot?: string } = {}): Promise<SessionPage> {
    return this.page(`/api/v1/sessions/${encode(sessionId)}/${collection}`, options, { sessionId })
  }

  analyses(sessionId: string, options: { limit?: number; cursor?: string; snapshot?: string } = {}): Promise<SessionPage> {
    return this.page(`/api/v1/sessions/${encode(sessionId)}/analyses`, options, { sessionId })
  }

  async content(sessionId: string, contentId: string, snapshot: string, offset = 0, maxChars = 10000): Promise<Record<string, unknown>> {
    const data = await this.read(queryPath(`/api/v1/sessions/${encode(sessionId)}/content/${encode(contentId)}`, { snapshot, offset, maxChars }))
    checkScope(data, 'sessionId', sessionId)
    checkScope(data, 'contentId', contentId)
    checkSnapshot(data, snapshot)
    if (data.contentId !== contentId || typeof data.text !== 'string') invalid('Invalid content page')
    const actualOffset = count(data.offset, 'content offset')
    const totalChars = count(data.totalChars, 'totalChars')
    const text = data.text as string
    if (actualOffset !== offset || actualOffset > totalChars || text.length > maxChars || actualOffset + text.length > totalChars) invalid('Invalid content range')
    const nextOffset = data.nextOffset
    if (nextOffset !== null && (!Number.isSafeInteger(nextOffset) || text.length === 0 || (nextOffset as number) !== actualOffset + text.length || (nextOffset as number) >= totalChars)) invalid('Invalid nextOffset')
    if (nextOffset === null && actualOffset + text.length !== totalChars) invalid('Incomplete content page')
    return data
  }

  async analysisManifest(sessionId: string, analysisId: string, snapshot?: string): Promise<Record<string, unknown>> {
    const data = await this.read(queryPath(`/api/v1/sessions/${encode(sessionId)}/analyses/${encode(analysisId)}`, { snapshot }))
    if (data.sessionId !== sessionId || data.analysisId !== analysisId) invalid('Mismatched analysis identity')
    checkSnapshot(data, snapshot)
    identity(data.schemaVersion, 'analysis schemaVersion')
    object(data.analysis, 'analysis record')
    const provenance = object(data.provenance, 'provenance')
    if (!['complete', 'partial', 'legacy_partial'].includes(String(provenance.status)) || !Array.isArray(provenance.missing)) invalid('Invalid provenance')
    if (!Array.isArray(data.parts)) invalid('Invalid analysis parts')
    if (!Array.isArray(data.assets)) invalid('Invalid analysis assets')
    for (const part of data.parts as unknown[]) {
      const descriptor = object(part, 'part descriptor')
      identity(descriptor.id, 'part ID')
      identity(descriptor.role, 'part role')
      count(descriptor.totalCount, 'part totalCount')
    }
    return data
  }

  part(sessionId: string, analysisId: string, partId: string, options: { limit?: number; cursor?: string; snapshot: string }): Promise<SessionPage> {
    return this.page(`/api/v1/sessions/${encode(sessionId)}/analyses/${encode(analysisId)}/parts/${encode(partId)}`, options, { sessionId, analysisId })
  }

  async *allPages(
    read: (cursor: string | undefined, snapshot: string | undefined) => Promise<SessionPage>,
    initialSnapshot?: string,
    identityField: 'id' | 'analysisId' | 'screenshotId' = 'id'
  ): AsyncGenerator<SessionPage> {
    let cursor: string | undefined
    let snapshot = initialSnapshot
    let fetched = 0
    let totalCount: number | undefined
    const seen = new Set<string>()
    const seenIds = new Set<string>()
    do {
      const page = await read(cursor, snapshot)
      snapshot = checkSnapshot(page, snapshot)
      if (totalCount !== undefined && page.totalCount !== totalCount) invalid('Page totalCount changed')
      totalCount = page.totalCount
      for (const item of page.items) {
        const id = identity(item[identityField] === undefined ? item.id : item[identityField], 'record identity')
        // These list aliases name the same record. Part references can name other records.
        if (identityField !== 'id' && item.id !== undefined) {
          if (identity(item.id, 'record identity') !== id) invalid('Conflicting record identity')
        }
        if (seenIds.has(id)) invalid('Duplicate record identity')
        seenIds.add(id)
      }
      fetched += page.items.length
      if (fetched > totalCount || (page.nextCursor === null && fetched !== totalCount)) invalid('Incomplete page traversal')
      yield page
      if (page.nextCursor === null) return
      if (seen.has(page.nextCursor)) invalid('Repeated cursor')
      seen.add(page.nextCursor)
      cursor = page.nextCursor
    } while (cursor)
  }

  async fullContent(sessionId: string, contentId: string, snapshot: string, budget?: (value: unknown) => void): Promise<string> {
    let offset = 0
    let text = ''
    while (true) {
      const page = await this.content(sessionId, contentId, snapshot, offset)
      const chunk = page.text as string
      text += chunk
      budget?.(chunk)
      if (page.nextOffset === null) return text
      offset = page.nextOffset as number
    }
  }

  async getAnalysis(sessionId: string, analysisId: string): Promise<Record<string, unknown>> {
    const manifest = await this.analysisManifest(sessionId, analysisId)
    const snapshot = manifest.snapshot as string
    let bytes = Buffer.byteLength(JSON.stringify(manifest))
    const budget = (value: unknown): void => {
      bytes += Buffer.byteLength(JSON.stringify(value))
      if (bytes > ANALYSIS_JSON_LIMIT) throw new CliApiError('OUTPUT_TOO_LARGE', 'Analysis exceeds 16 MiB; use sessions analyses export')
    }
    budget('')
    const parts: Record<string, unknown>[] = []
    const content: Record<string, string> = {}
    const seenParts = new Set<string>()
    for (const raw of manifest.parts as unknown[]) {
      const descriptor = object(raw, 'part descriptor')
      const partId = descriptor.id as string
      if (seenParts.has(partId)) invalid('Duplicate part ID')
      seenParts.add(partId)
      if (descriptor.available === false) {
        parts.push({ ...descriptor, items: [] })
        continue
      }
      const items: Record<string, unknown>[] = []
      for await (const page of this.allPages((cursor) => this.part(sessionId, analysisId, partId, { cursor, snapshot }), snapshot)) {
        for (const item of page.items) {
          budget(item)
          items.push(item)
          for (const ref of this.findContentRefs(item)) {
            if (!(ref in content)) {
              content[ref] = await this.fullContent(sessionId, ref, snapshot, budget)
            }
          }
        }
      }
      if (items.length !== descriptor.totalCount) invalid('Part count does not match manifest')
      parts.push({ ...descriptor, items })
    }
    const result = { ...manifest, parts, content, retrieval: { complete: true } }
    if (Buffer.byteLength(JSON.stringify(result)) > ANALYSIS_JSON_LIMIT) {
      throw new CliApiError('OUTPUT_TOO_LARGE', 'Analysis exceeds 16 MiB; use sessions analyses export')
    }
    return result
  }

  private findContentRefs(value: unknown): string[] {
    if (!value || typeof value !== 'object') return []
    if (Array.isArray(value)) return value.flatMap((item) => this.findContentRefs(item))
    const data = value as Record<string, unknown>
    const own = typeof data.contentId === 'string' && Number.isSafeInteger(data.totalChars) ? [data.contentId] : []
    return [...own, ...Object.values(data).flatMap((item) => this.findContentRefs(item))]
  }
}
