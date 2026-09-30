import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
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
  it('discovers v1 and sends exact file bytes through the paired API', async () => {
    const sent: Buffer[] = []
    const requests: Array<{ path: string; authorization: string | undefined }> = []
    const server = createServer(async (request: IncomingMessage, response) => {
      const path = request.url ?? ''
      requests.push({ path, authorization: request.headers.authorization })
      if (path === '/.well-known/extrabrain') {
        reply(response, 200, {
          apiVersion: 'v1', available: true,
          capabilities: {
            documentImport: true, documentMetadata: true, extractedText: true,
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
        reply(response, 200, { status: 'completed' })
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
        read: () => ({ status: 'found' as const, value: 'fixture-token' }),
        write: () => {}, clear: () => {}
      },
      output: { write: (value: string) => output.push(value), error: () => {} },
      resumeStore: new ResumeStore(join(directory, 'state'))
    }
    await expect(runCli(['--json', 'capabilities'], dependencies)).resolves.toBe(0)
    await expect(runCli(['--json', 'documents', 'import', '--', source], dependencies)).resolves.toBe(0)
    expect(sent).toEqual([bytes])
    expect(requests.find((request) => request.path === '/.well-known/extrabrain')?.authorization).toBeUndefined()
    expect(requests.find((request) => request.path.endsWith('/content'))?.authorization).toBe('Bearer fixture-token')
    expect(output[1]).not.toContain(source)
  })
})
