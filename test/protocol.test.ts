import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DocumentApiClient } from '../src/apiClient.service'
import { ResumeStore } from '../src/resumeStore.service'
import { runCli } from '../src/run.service'

const directories: string[] = []
const servers: Array<ReturnType<typeof createServer>> = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
})

const reply = (response: ServerResponse, status: number, body: unknown) => {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

describe('versioned app API fixture', () => {
  it.each(['notFound', 'failed', 'found'] as const)('runs a token-free document workflow with %s credential storage', async (status) => {
    const sent: Buffer[] = []
    const requests: Array<{ path: string; authorization: string | undefined }> = []
    const server = createServer(async (request: IncomingMessage, response) => {
      const path = request.url ?? ''
      requests.push({ path, authorization: request.headers.authorization })
      if (path === '/.well-known/extrabrain') {
        reply(response, 200, {
          apiVersion: 'v1', available: true,
          capabilities: {
            documentImport: true, documentGroups: true, documentMetadata: true, extractedText: true,
            indexedSearch: true, originalExport: true, revisionSafeDelete: true
          }
        })
      } else if (path === '/api/v1/document-imports/batches') {
        reply(response, 200, { batch: { id: 'batch-1' } })
      } else if (path === '/api/v1/document-imports/batches/batch-1/items') {
        reply(response, 200, { documentId: 'document-1', operationId: 'operation-1' })
      } else if (path === '/api/v1/document-imports/items/operation-1/content') {
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(chunk as Buffer)
        sent.push(Buffer.concat(chunks))
        reply(response, sent.length === 1 ? 503 : 200, sent.length === 1
          ? { error: { code: 'TEMPORARILY_UNAVAILABLE', message: 'Interrupted transfer' } }
          : { status: 'completed' })
      } else if (path === '/api/v1/documents/document-1/original') {
        response.writeHead(200, { 'content-type': 'application/pdf' })
        response.end(sent.at(-1))
      } else if (path === '/api/v1/document-groups') {
        reply(response, 200, { groups: [] })
      } else if (path === '/api/v1/document-imports/batches/batch-1' || path === '/api/v1/document-imports/items/operation-1') {
        reply(response, 200, { status: 'indexed' })
      } else if (path === '/api/v1/documents/document-1/text?generation=1') {
        reply(response, 200, { text: 'Résumé' })
      } else if (path === '/api/v1/documents/search?q=R%C3%A9sum%C3%A9') {
        reply(response, 200, { documents: [{ id: 'document-1' }] })
      } else if (path === '/api/v1/documents') {
        reply(response, 200, { documents: [{ id: 'document-1' }] })
      } else if (path === '/api/v1/documents/document-1' && request.method === 'DELETE') {
        expect(request.headers['x-extrabrain-expected-revision']).toBe('1')
        expect(request.headers['x-idempotency-key']).toBeTruthy()
        reply(response, 200, { status: 'deleted' })
      } else {
        reply(response, 404, { error: { code: 'NOT_FOUND', message: 'Unknown route' } })
      }
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Fixture address is invalid')
    const origin = `http://127.0.0.1:${address.port}`
    const directory = await mkdtemp(join(tmpdir(), 'extrabrain-protocol-'))
    directories.push(directory)
    const source = join(directory, 'Résumé notes.pdf')
    const bytes = Buffer.from('%PDF-1.4\nRésumé\n', 'utf8')
    await writeFile(source, bytes)
    const output: string[] = []
    const dependencies = {
      apiFactory: (credential: string | null) => new DocumentApiClient(credential, origin),
      credentialStore: {
        read: vi.fn(() => status === 'found' ? { status, value: 'stale-token' } : { status }),
        write: vi.fn(), clear: vi.fn()
      },
      output: { write: (value: string) => output.push(value), error: () => {} },
      resumeStore: new ResumeStore(join(directory, 'state'))
    }
    await expect(runCli(['--json', 'capabilities'], dependencies)).resolves.toBe(0)
    await expect(runCli(['--json', 'documents', 'import', '--', source], dependencies)).resolves.toBe(6)
    const resumeId = JSON.parse(output.at(-1)!).data.resumeId
    await expect(runCli(['--json', 'documents', 'resume', resumeId], dependencies)).resolves.toBe(0)
    const exported = join(directory, 'export.pdf')
    const commands = [
      ['documents', 'status', 'batch-1'],
      ['documents', 'status', '--item', 'operation-1'],
      ['documents', 'groups'],
      ['documents', 'list'],
      ['documents', 'text', '--generation', '1', 'document-1'],
      ['documents', 'search', 'Résumé'],
      ['documents', 'export', '--output', exported, 'document-1'],
      ['documents', 'delete', '--revision', '1', 'document-1']
    ]
    for (const command of commands) {
      await expect(runCli(['--json', ...command], dependencies)).resolves.toBe(0)
    }
    expect(sent).toEqual([bytes, bytes])
    expect(await readFile(exported)).toEqual(bytes)
    expect(requests.every((request) => request.authorization === undefined)).toBe(true)
    expect(requests.some((request) => request.path.includes('/pairing/'))).toBe(false)
    expect(dependencies.credentialStore.read).not.toHaveBeenCalled()
    expect(dependencies.credentialStore.write).not.toHaveBeenCalled()
    expect(dependencies.credentialStore.clear).not.toHaveBeenCalled()
    expect(output[1]).not.toContain(source)
  })
})

describe('document HTTP errors', () => {
  it.each([
    [401, { error: { code: 'AUTHENTICATION_REQUIRED', message: 'Unauthorized' } }, 'AUTHENTICATION_REQUIRED'],
    [403, { error: { code: 'FORBIDDEN', message: 'Forbidden' } }, 'FORBIDDEN'],
    [409, { error: { code: 'REVISION_CONFLICT', message: 'Stale revision' } }, 'REVISION_CONFLICT'],
    [409, { status: 'duplicate', existingDocumentId: 'existing' }, 'DUPLICATE'],
    [404, { error: { code: 'NOT_FOUND', message: 'Not found' } }, 'NOT_FOUND'],
    [503, {}, 'HTTP_503']
  ])('preserves HTTP %s errors without a credential', async (status, body, code) => {
    const request = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status }))
    const client = new DocumentApiClient(null, 'http://127.0.0.1:37373', request)
    await expect(client.json('/api/v1/documents')).rejects.toMatchObject({ code, status })
    expect(request).toHaveBeenCalledOnce()
    expect(new Headers(request.mock.calls[0]?.[1]?.headers).has('authorization')).toBe(false)
  })

  it('preserves explicit credential authentication for legacy callers', async () => {
    const request = vi.fn<typeof fetch>(async () => new Response('{}'))
    const missing = new DocumentApiClient(null, undefined, request)
    await expect(missing.json('/protected', {}, true)).rejects.toMatchObject({ code: 'PAIRING_REQUIRED' })
    expect(request).not.toHaveBeenCalled()
    await new DocumentApiClient('legacy-token', undefined, request).json('/protected', {}, true)
    expect(new Headers(request.mock.calls[0]?.[1]?.headers).get('authorization')).toBe('Bearer legacy-token')
  })
})

describe('session HTTP fixture', () => {
  it('uses loopback port override, scoped routes, and no Authorization header', async () => {
    const requests: Array<{ path: string; authorization: string | undefined }> = []
    const image = Buffer.from([0, 255, 1])
    const imageHash = createHash('sha256').update(image).digest('hex')
    const server = createServer((request, response) => {
      const path = request.url ?? ''
      requests.push({ path, authorization: request.headers.authorization })
      if (path === '/.well-known/extrabrain') {
        reply(response, 200, { apiVersion: 'v1', sessionApiVersion: 'v1', capabilities: { sessionMetadata: true, sessionSearch: true, sessionCurrent: true, sessionData: true, analysisData: true, screenshotExport: true } })
      } else if (path.startsWith('/api/v1/sessions/search?') || path.startsWith('/api/v1/sessions?')) {
        reply(response, 200, { items: [], totalCount: 0, nextCursor: null, snapshot: 'rev-1' })
      } else if (path === '/api/v1/sessions/current') {
        reply(response, 200, { activeSessionId: null, state: 'idle', coverage: { kind: 'live' } })
      } else if (path.startsWith('/api/v1/sessions/s%2F1/content/')) {
        reply(response, 200, { contentId: 'c 1', text: '話', offset: 0, nextOffset: null, totalChars: 1, snapshot: 'rev-1' })
      } else if (path.startsWith('/api/v1/sessions/s%2F1/screenshots/shot1/image?')) {
        response.writeHead(200, { 'content-type': path.includes('representation=original') ? 'image/png' : 'image/jpeg' })
        response.end(image)
      } else if (path.startsWith('/api/v1/sessions/s%2F1/analyses/a%201')) {
        reply(response, 200, { schemaVersion: 'v1', sessionId: 's/1', analysisId: 'a 1', snapshot: 'rev-1', analysis: { request: 'Why?', result: 'Because' }, provenance: { status: 'complete', missing: [] }, parts: [], assets: [] })
      } else if (path.startsWith('/api/v1/sessions/s%2F1/analyses?')) {
        reply(response, 200, { items: [{ analysisId: 'a 1' }], totalCount: 1, nextCursor: null, snapshot: 'rev-1' })
      } else if (path.startsWith('/api/v1/sessions/s%2F1/transcripts')) {
        reply(response, 200, { items: [{ id: 't1', text: 'um', source: 'microphone' }], totalCount: 1, nextCursor: null, snapshot: 'rev-1' })
      } else if (path.startsWith('/api/v1/sessions/s%2F1/screenshots?')) {
        reply(response, 200, { items: [{ id: 'shot1', defaultRepresentation: 'analysis-jpeg', representations: [{ representation: 'analysis-jpeg', mediaType: 'image/jpeg', byteLength: image.length, sha256: imageHash, available: true }, { representation: 'original', mediaType: 'image/png', byteLength: image.length, sha256: imageHash, available: true }] }], totalCount: 1, nextCursor: null, snapshot: 'rev-1' })
      } else if (/\/(screenshots|facts|topics|questions|chat-turns|insights)\?/.test(path)) {
        reply(response, 200, { items: [], totalCount: 0, nextCursor: null, snapshot: 'rev-1' })
      } else if (path.startsWith('/api/v1/sessions/s%2F1')) {
        reply(response, 200, { sessionId: 's/1', snapshot: 'rev-1', summary: 'saved', counts: { transcripts: 1, screenshots: 1, analyses: 1 } })
      } else reply(response, 404, { error: { code: 'NOT_FOUND', message: 'Unknown route' } })
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Fixture address is invalid')
    const oldPort = process.env.EXTRABRAIN_PORT
    process.env.EXTRABRAIN_PORT = String(address.port)
    try {
      const directory = await mkdtemp(join(tmpdir(), 'extrabrain-session-'))
      directories.push(directory)
      const output: string[] = []
      const dependencies = {
        apiFactory: (credential: string | null) => new DocumentApiClient(credential),
        credentialStore: { read: () => { throw new Error('credential read') }, write: () => { throw new Error('pairing') }, clear: () => {} },
        output: { write: (value: string) => output.push(value), error: () => {} },
        resumeStore: new ResumeStore(join(directory, 'state'))
      }
      const commands = [
        ['sessions', 'get', 's/1'],
        ['sessions', 'transcripts', '--cursor', 'opaque+cursor', 's/1'],
        ['sessions', 'content', '--snapshot', 'rev-1', 's/1', 'c 1'],
        ['sessions', 'analyses', 'get', 's/1', 'a 1']
      ]
      for (const command of commands) await expect(runCli(['--json', ...command], dependencies)).resolves.toBe(0)
      expect(requests.filter((entry) => entry.path !== '/.well-known/extrabrain').map((entry) => entry.path)).toEqual([
        '/api/v1/sessions/s%2F1',
        '/api/v1/sessions/s%2F1/transcripts?limit=50&cursor=opaque%2Bcursor',
        '/api/v1/sessions/s%2F1/content/c%201?snapshot=rev-1&offset=0&maxChars=10000',
        '/api/v1/sessions/s%2F1/analyses/a%201'
      ])
      expect(requests.every((entry) => entry.authorization === undefined)).toBe(true)
      expect(output[2]).toContain('話')
      const documented = [
        ['sessions', 'list', '--limit', '50', '--since', '1760000000', '--until', '1760100000'],
        ['sessions', 'search', '--limit', '50', 'release risks'],
        ['sessions', 'current'],
        ...['screenshots', 'facts', 'topics', 'questions', 'chat-turns', 'insights'].map((collection) => ['sessions', collection, 's/1']),
        ['sessions', 'analyses', 'list', 's/1']
      ]
      for (const command of documented) await expect(runCli(['--json', ...command], dependencies)).resolves.toBe(0)
      const screenshotPath = join(directory, 'copy.jpg')
      const originalPath = join(directory, 'original.png')
      const analysisPath = join(directory, 'analysis-export')
      const sessionPath = join(directory, 'session-export')
      await expect(runCli(['--json', 'sessions', 'screenshot', 'export', '--output', screenshotPath, 's/1', 'shot1'], dependencies)).resolves.toBe(0)
      await expect(runCli(['--json', 'sessions', 'screenshot', 'export', '--output', originalPath, '--representation', 'original', 's/1', 'shot1'], dependencies)).resolves.toBe(0)
      await expect(runCli(['--json', 'sessions', 'analyses', 'export', '--output', analysisPath, 's/1', 'a 1'], dependencies)).resolves.toBe(0)
      await expect(runCli(['--json', 'sessions', 'export', '--output', sessionPath, 's/1'], dependencies)).resolves.toBe(0)
      expect(await readFile(screenshotPath)).toEqual(image)
      expect(await readFile(originalPath)).toEqual(image)
      expect(JSON.parse(await readFile(join(analysisPath, 'manifest.json'), 'utf8')).retrieval.complete).toBe(true)
      expect(JSON.parse(await readFile(join(sessionPath, 'manifest.json'), 'utf8')).counts.transcripts).toBe(1)
      expect(requests.every((entry) => entry.authorization === undefined)).toBe(true)
      const beforeInvalid = requests.length
      await expect(runCli(['--json', 'sessions', 'export', 's/1'], dependencies)).resolves.toBe(2)
      await expect(runCli(['--json', 'sessions', 'screenshot', 'export', '--output', join(directory, 'bad.jpg'), '--unknown', 's/1', 'shot1'], dependencies)).resolves.toBe(2)
      expect(requests).toHaveLength(beforeInvalid)
      const unsupported = {
        ...dependencies,
        apiFactory: () => ({
          discovery: async () => ({ apiVersion: 'v1', sessionApiVersion: 'v1', capabilities: { sessionMetadata: true, sessionData: true, analysisData: true } }),
          json: async () => { throw new Error('Session data request should not occur') }
        }) as unknown as DocumentApiClient
      }
      await expect(runCli(['--json', 'sessions', 'export', '--output', join(directory, 'unsupported'), 's/1'], unsupported)).resolves.toBe(8)
      expect(output.at(-1)).toContain('screenshotExport')
    } finally {
      if (oldPort === undefined) delete process.env.EXTRABRAIN_PORT
      else process.env.EXTRABRAIN_PORT = oldPort
    }
  })
})
