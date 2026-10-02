import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CliApiError, DocumentApiClient } from '../src/apiClient.service'
import { SessionExportService } from '../src/sessionExport.service'

const directories: string[] = []
const servers: Array<ReturnType<typeof createServer>> = []
const bytes = Buffer.from([0, 255, 10, 11, 12])
const sha256 = createHash('sha256').update(bytes).digest('hex')
const descriptor = { representation: 'analysis-jpeg', mediaType: 'image/jpeg', byteLength: bytes.length, sha256, available: true }
const screenshot = { id: 'shot/../1', defaultRepresentation: 'analysis-jpeg', representations: [descriptor, { representation: 'original', available: false, reason: 'not retained' }] }

const reply = (response: ServerResponse, body: unknown, status = 200) => {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

type Handler = (request: IncomingMessage, response: ServerResponse) => boolean
const fixture = async (override?: Handler) => {
  const paths: string[] = []
  const server = createServer((request, response) => {
    const path = request.url ?? ''
    paths.push(path)
    if (override) {
      const handled = override(request, response)
      if (handled) return
    }
    const url = new URL(path, 'http://fixture')
    if (url.pathname.endsWith('/image')) {
      response.writeHead(200, { 'content-type': 'image/jpeg' })
      response.end(bytes)
    } else if (url.pathname === '/api/v1/sessions/s1') {
      reply(response, { sessionId: 's1', snapshot: 'rev-1', summary: 'saved', counts: { transcripts: 521, screenshots: 1, facts: 0, topics: 0, questions: 0, 'chat-turns': 1, insights: 1, analyses: 2 } })
    } else if (url.pathname === '/api/v1/sessions/s1/analyses/a1' || url.pathname === '/api/v1/sessions/s1/analyses/a2') {
      const analysisId = url.pathname.endsWith('a1') ? 'a1' : 'a2'
      reply(response, { schemaVersion: 'v1', sessionId: 's1', analysisId, snapshot: 'rev-1', analysis: { request: 'Why?', result: 'Because' }, provenance: { status: analysisId === 'a1' ? 'complete' : 'legacy_partial', missing: analysisId === 'a1' ? [] : [{ category: 'strategy', reason: 'not retained' }] }, parts: [{ id: '../input', role: 'model-input', totalCount: 1 }, { id: 'future', role: 'new-role', totalCount: 1 }], assets: [{ ...descriptor, screenshotId: screenshot.id }] })
    } else if (url.pathname.includes('/parts/')) {
      reply(response, { items: [{ id: 'record', contentRef: { contentId: 'large', totalChars: 5, sha256: createHash('sha256').update('話hello'.slice(0, 5)).digest('hex') } }], totalCount: 1, nextCursor: null, snapshot: 'rev-1', sessionId: 's1', analysisId: url.pathname.includes('/a1/') ? 'a1' : 'a2' })
    } else if (url.pathname.endsWith('/content/large')) {
      reply(response, { contentId: 'large', text: '話hell', offset: 0, nextOffset: null, totalChars: 5, snapshot: 'rev-1' })
    } else if (url.pathname === '/api/v1/sessions/s1/analyses') {
      reply(response, { items: [{ analysisId: 'a1' }, { analysisId: 'a2' }], totalCount: 2, nextCursor: null, snapshot: 'rev-1' })
    } else if (url.pathname === '/api/v1/sessions/s1/transcripts') {
      const cursor = Number(url.searchParams.get('cursor') ?? 0)
      const items = Array.from({ length: Math.min(200, 521 - cursor) }, (_, index) => ({ id: `t${cursor + index}`, timestamp: 100, text: 'raw um', source: 'microphone', speaker: 'Alice', relativeStartMs: index }))
      reply(response, { items, totalCount: 521, nextCursor: cursor + items.length < 521 ? String(cursor + items.length) : null, snapshot: 'rev-1', sessionId: 's1' })
    } else if (url.pathname === '/api/v1/sessions/s1/screenshots') {
      reply(response, { items: [screenshot], totalCount: 1, nextCursor: null, snapshot: 'rev-1', sessionId: 's1' })
    } else if (url.pathname === '/api/v1/sessions/s1/chat-turns') {
      reply(response, { items: [{ id: 'chat1', role: 'user', text: 'What changed?' }], totalCount: 1, nextCursor: null, snapshot: 'rev-1', sessionId: 's1' })
    } else if (url.pathname === '/api/v1/sessions/s1/insights') {
      reply(response, { items: [{ id: 'insight1', text: 'Saved insight' }], totalCount: 1, nextCursor: null, snapshot: 'rev-1', sessionId: 's1' })
    } else if (url.pathname.startsWith('/api/v1/sessions/s1/')) {
      reply(response, { items: [], totalCount: 0, nextCursor: null, snapshot: 'rev-1', sessionId: 's1' })
    } else reply(response, { error: { code: 'NOT_FOUND', message: 'Missing' } }, 404)
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Invalid fixture address')
  const directory = await mkdtemp(join(tmpdir(), 'extrabrain-export-'))
  directories.push(directory)
  const origin = `http://127.0.0.1:${address.port}`
  return { service: new SessionExportService(new DocumentApiClient(null, origin)), directory, paths, origin }
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('session exports', () => {
  it('writes exact advertised bytes, default representation, and metadata without bytes or internal paths', async () => {
    const { service, directory, paths } = await fixture()
    const output = join(directory, 'screenshot.jpg')
    const result = await service.exportScreenshot(output, 's1', screenshot.id)
    expect(await readFile(output)).toEqual(bytes)
    expect(result).toEqual({ screenshotId: screenshot.id, representation: 'analysis-jpeg', mediaType: 'image/jpeg', byteLength: 5, sha256, snapshot: 'rev-1' })
    expect(JSON.stringify(result)).not.toContain(output)
    expect(paths.find((path) => path.endsWith('/image?representation=analysis-jpeg&snapshot=rev-1'))).toContain('shot%2F..%2F1')
  })

  it('refuses existing files and symlinks without modifying them', async () => {
    const { service, directory } = await fixture()
    const existing = join(directory, 'existing')
    await writeFile(existing, 'untouched')
    await expect(service.exportScreenshot(existing, 's1', screenshot.id)).rejects.toMatchObject({ code: 'DESTINATION_EXISTS' })
    expect(await readFile(existing, 'utf8')).toBe('untouched')
    const link = join(directory, 'link')
    await symlink(existing, link)
    await expect(service.exportScreenshot(link, 's1', screenshot.id)).rejects.toMatchObject({ code: 'DESTINATION_EXISTS' })
  })

  it('reports unavailable representations without creating a file', async () => {
    const { service, directory } = await fixture()
    await expect(service.exportScreenshot(join(directory, 'missing.png'), 's1', screenshot.id, 'original')).rejects.toMatchObject({ code: 'REPRESENTATION_UNAVAILABLE' })
    expect(await readdir(directory)).toEqual([])
  })

  it('leaves an identified partial file on corrupt image bytes', async () => {
    const { service, directory } = await fixture((request, response) => {
      if (request.url?.includes('/image?')) {
        response.writeHead(200, { 'content-type': 'image/jpeg' })
        response.end(Buffer.from('corrupt'))
        return true
      }
      return false
    })
    const output = join(directory, 'bad.jpg')
    await expect(service.exportScreenshot(output, 's1', screenshot.id)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' } satisfies Partial<CliApiError>)
    expect((await readdir(directory)).some((name) => name.startsWith('bad.jpg.partial-'))).toBe(true)
    expect(await readdir(directory)).not.toContain('bad.jpg')
  })

  it('rejects a same-length image with a corrupt hash', async () => {
    const { service, directory } = await fixture((request, response) => {
      if (!request.url?.includes('/image?')) return false
      response.writeHead(200, { 'content-type': 'image/jpeg' })
      response.end(Buffer.from([5, 4, 3, 2, 1]))
      return true
    })
    await expect(service.exportScreenshot(join(directory, 'wrong.jpg'), 's1', screenshot.id)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    expect(await readdir(directory)).not.toContain('wrong.jpg')
  })

  it('propagates a non-200 image response without publishing a destination', async () => {
    const { service, directory } = await fixture((request, response) => {
      if (!request.url?.includes('/image?')) return false
      reply(response, { error: { code: 'IMAGE_UNAVAILABLE', message: 'Image not retained' } }, 404)
      return true
    })
    await expect(service.exportScreenshot(join(directory, 'missing.jpg'), 's1', screenshot.id)).rejects.toMatchObject({ code: 'IMAGE_UNAVAILABLE' })
    expect(await readdir(directory)).toEqual([])
  })

  it('uses a finite asset request timeout', async () => {
    const request = async (): Promise<Response> => { throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }) }
    const client = new DocumentApiClient(null, 'http://127.0.0.1:1', request as typeof fetch)
    await expect(client.sessionAsset('s1', 'shot', 'original', 'rev-1')).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' })
  })

  it('leaves a partial file when the image stream ends prematurely', async () => {
    const { directory, origin } = await fixture()
    const request = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      if (!String(input).includes('/image?')) return fetch(input, init)
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes)
          controller.error(new Error('stream terminated'))
        }
      })
      return new Response(body, { headers: { 'content-type': 'image/jpeg' } })
    }
    const service = new SessionExportService(new DocumentApiClient(null, origin, request as typeof fetch))
    await expect(service.exportScreenshot(join(directory, 'short.jpg'), 's1', screenshot.id)).rejects.toMatchObject({ code: 'TRANSFER_FAILED' })
    expect(await readdir(directory)).not.toContain('short.jpg')
  })

  it('exports an independently readable analysis with additive roles, content and image', async () => {
    const { service, directory } = await fixture()
    const output = join(directory, 'analysis')
    const manifest = await service.exportAnalysis(output, 's1', 'a1')
    expect(manifest.retrieval).toEqual({ complete: true })
    expect((manifest.parts as Record<string, unknown>[]).map((part) => part.role)).toEqual(['model-input', 'new-role'])
    expect((await readdir(join(output, 'parts'))).length).toBe(2)
    expect((await readdir(join(output, 'parts'))).every((name) => !name.includes('..'))).toBe(true)
    expect((await readdir(join(output, 'content'))).length).toBe(1)
    expect((await readdir(join(output, 'screenshots'))).length).toBe(1)
    expect(await readdir(output)).toContain('manifest.json')
    expect(await readdir(output)).not.toContain('incomplete.json')
    expect(JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8')).sessionId).toBe('s1')
  })

  it('downloads duplicate analysis asset identities once', async () => {
    const { service, directory, paths } = await fixture((request, response) => {
      if (!request.url?.startsWith('/api/v1/sessions/s1/analyses/duplicate')) return false
      reply(response, { schemaVersion: 'v1', sessionId: 's1', analysisId: 'duplicate', snapshot: 'rev-1', analysis: { request: 'Why?', result: 'Because' }, provenance: { status: 'complete', missing: [] }, parts: [], assets: [{ ...descriptor, screenshotId: screenshot.id }, { ...descriptor, screenshotId: screenshot.id }] })
      return true
    })
    const output = join(directory, 'duplicate')
    const result = await service.exportAnalysis(output, 's1', 'duplicate')
    expect((result.assets as Record<string, unknown>[])).toHaveLength(2)
    expect(await readdir(join(output, 'screenshots'))).toHaveLength(1)
    expect(paths.filter((path) => path.includes('/image?'))).toHaveLength(1)
  })

  it('streams analysis content larger than the JSON get bound', async () => {
    const text = 'x'.repeat(100000)
    const recordCount = 170
    const { service, directory } = await fixture((request, response) => {
      const url = new URL(request.url ?? '', 'http://fixture')
      if (url.pathname === '/api/v1/sessions/s1/analyses/big') {
        reply(response, { schemaVersion: 'v1', sessionId: 's1', analysisId: 'big', snapshot: 'rev-1', analysis: { request: 'Why?', result: 'Because' }, provenance: { status: 'complete', missing: [] }, parts: [{ id: 'input', role: 'model-input', totalCount: recordCount }], assets: [] })
        return true
      }
      if (url.pathname.endsWith('/parts/input')) {
        const offset = Number(url.searchParams.get('cursor') ?? 0)
        const items = Array.from({ length: Math.min(50, recordCount - offset) }, (_, index) => ({ id: `input-${offset + index}`, text }))
        const nextOffset = offset + items.length
        reply(response, { items, totalCount: recordCount, nextCursor: nextOffset < recordCount ? String(nextOffset) : null, snapshot: 'rev-1' })
        return true
      }
      return false
    })
    const output = join(directory, 'big-analysis')
    const manifest = await service.exportAnalysis(output, 's1', 'big')
    const partPath = (manifest.parts as Array<{ file: string }>)[0].file
    expect((await readFile(join(output, partPath))).length).toBeGreaterThan(16 * 1024 * 1024)
    expect((manifest.parts as Array<{ fetched: number }>)[0].fetched).toBe(recordCount)
    expect(manifest.retrieval).toEqual({ complete: true })
  })

  it('exports every collection and multiple analyses under one snapshot', async () => {
    const { service, directory } = await fixture()
    const output = join(directory, 'session')
    const manifest = await service.exportSession(output, 's1')
    expect(manifest.counts).toMatchObject({ transcripts: 521, screenshots: 1, facts: 0, 'chat-turns': 1, insights: 1 })
    expect((await readFile(join(output, 'transcripts.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(521)
    expect(await readFile(join(output, 'facts.jsonl'), 'utf8')).toBe('')
    expect(await readFile(join(output, 'chat-turns.jsonl'), 'utf8')).toContain('What changed?')
    expect(await readFile(join(output, 'insights.jsonl'), 'utf8')).toContain('Saved insight')
    expect((manifest.metadata as Record<string, unknown>).summary).toBe('saved')
    expect((manifest.analyses as unknown[])).toHaveLength(2)
    expect((manifest.assets as unknown[])).toHaveLength(2)
    expect(await readdir(join(output, 'analyses'))).toHaveLength(2)
    expect(await readdir(output)).toContain('manifest.json')
    expect(await readdir(output)).not.toContain('incomplete.json')
  })

  it('leaves an incomplete directory on snapshot conflict', async () => {
    const { service, directory } = await fixture((request, response) => {
      if (request.url?.includes('/facts?')) {
        reply(response, { error: { code: 'SNAPSHOT_CONFLICT', message: 'Changed' } }, 409)
        return true
      }
      return false
    })
    const output = join(directory, 'partial')
    await expect(service.exportSession(output, 's1')).rejects.toMatchObject({ code: 'SNAPSHOT_CONFLICT' })
    expect(await readdir(output)).toContain('incomplete.json')
    expect(await readdir(output)).not.toContain('manifest.json')
    expect(JSON.parse(await readFile(join(output, 'incomplete.json'), 'utf8'))).toMatchObject({ complete: false, stage: 'failed', error: 'SNAPSHOT_CONFLICT' })
  })

  it('does not misreport a missing output parent as app unavailable', async () => {
    const { service, directory } = await fixture()
    await expect(service.exportSession(join(directory, 'absent', 'session'), 's1')).rejects.toMatchObject({ code: 'EXPORT_FAILED' })
  })
})
