import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CliApiError, DocumentApiClient } from '../src/apiClient.service'
import { ResumeStore } from '../src/resumeStore.service'
import { runCli } from '../src/run.service'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { force: true, recursive: true })))
})

const harness = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'extrabrain-groups-'))
  directories.push(directory)
  const source = join(directory, '- Résumé.txt')
  await writeFile(source, 'Interview source bytes')
  const store = new ResumeStore(join(directory, 'state'))
  const output: string[] = []
  const requests: Array<{ path: string; body: Record<string, unknown> }> = []
  const discovery = vi.fn(async () => ({ apiVersion: 'v1', available: true, capabilities: { documentImport: true, documentGroups: true } }))
  const json = vi.fn(async (path: string, init?: RequestInit): Promise<Record<string, unknown>> => {
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {}
    requests.push({ path, body })
    if (path.includes('document-groups')) return { group: { id: 'group-1', name: 'Renamed interview' } }
    if (path.endsWith('/batches')) return { batch: { id: 'batch-1' } }
    return { documentId: 'document-1', operationId: 'operation-1' }
  })
  const upload = vi.fn(async () => ({ status: 'completed' }))
  const api = { discovery, json, upload } as unknown as DocumentApiClient
  const dependencies = {
    apiFactory: () => api,
    credentialStore: { read: () => ({ status: 'found' as const, value: 'test-token' }), write: () => {}, clear: () => {} },
    output: { write: (value: string) => output.push(value), error: (value: string) => output.push(value) },
    resumeStore: store
  }
  const run = (args: string[]) => runCli(['--json', 'documents', ...args], dependencies)
  const saved = async () => {
    const names = await readdir(join(directory, 'state'))
    return store.load(names[0].replace('.json', ''))
  }
  return { source, store, output, requests, discovery, json, upload, run, saved }
}

describe('durable grouped imports', () => {
  it.each([
    ['--group'], ['--group-id'], ['--group='], ['--group', '--', 'file.txt'],
    ['--group', 'name', '--group-id', 'id']
  ].map((flags) => ({ flags })))('rejects invalid selectors before network effects: $flags', async ({ flags }) => {
    const h = await harness()
    expect(await h.run(['import', ...flags])).toBe(2)
    expect(h.discovery).not.toHaveBeenCalled()
    expect(h.json).not.toHaveBeenCalled()
  })

  it('requires grouping capability before creating group or batch effects', async () => {
    const h = await harness()
    h.discovery.mockResolvedValue({ apiVersion: 'v1', available: true, capabilities: { documentImport: true, documentGroups: false } })
    expect(await h.run(['import', '--group', 'Interview', '--', h.source])).toBe(8)
    expect(h.json).not.toHaveBeenCalled()
    expect(await h.run(['import', '--', h.source])).toBe(0)
  })

  it('saves intent before resolution and destination before admission, preserving Unicode and equals signs', async () => {
    const h = await harness()
    const original = h.json.getMockImplementation()!
    h.json.mockImplementation(async (path, init) => {
      const manifest = await h.saved()
      if (path.endsWith('/resolve')) {
        expect(manifest.group).toMatchObject({ selector: { kind: 'name', value: 'Résumé = 面接' }, resolutionKey: expect.any(String) })
        expect(manifest.group?.resolved).toBeUndefined()
      } else if (path.endsWith('/batches')) {
        expect(manifest.group?.resolved?.id).toBe('group-1')
      }
      return original(path, init)
    })
    expect(await h.run(['import', '--group=Résumé = 面接', '--', h.source])).toBe(0)
    const manifest = await h.saved()
    expect(h.requests[0].body).toEqual({ name: 'Résumé = 面接', idempotencyKey: manifest.group?.resolutionKey })
    expect(h.requests[1].body.groupId).toBe('group-1')
    expect(JSON.parse(h.output[0]).data.group).toEqual({ id: 'group-1', name: 'Renamed interview' })
    expect(h.output[0]).not.toContain(h.source)
  })

  it('replays lost resolution responses with the same saved key', async () => {
    const h = await harness()
    const keys: unknown[] = []
    const original = h.json.getMockImplementation()!
    h.json.mockImplementation(async (path, init) => {
      if (path.endsWith('/resolve')) {
        keys.push(JSON.parse(String(init?.body)).idempotencyKey)
        if (keys.length === 1) throw new CliApiError('NETWORK_ERROR', 'Lost response')
      }
      return original(path, init)
    })
    expect(await h.run(['import', '--group', 'Interview', h.source])).toBe(1)
    const manifest = await h.saved()
    expect(h.output[0]).toContain(manifest.id)
    expect(await h.run(['resume', manifest.id])).toBe(0)
    expect(keys).toEqual([manifest.group?.resolutionKey, manifest.group?.resolutionKey])
  })

  it('keeps group, batch, and failed item identities after rename and skips successful files', async () => {
    const h = await harness()
    const second = join(directories.at(-1)!, 'second.txt')
    await writeFile(second, 'Independent second file')
    h.upload.mockRejectedValueOnce(new Error('Interrupted'))
    expect(await h.run(['import', '--group', 'Original name', '--', h.source, second])).toBe(6)
    const before = await h.saved()
    expect(before.items.filter(({ status }) => status === 'succeeded')).toHaveLength(1)
    expect(await h.run(['resume', before.id])).toBe(0)
    const after = await h.saved()
    expect(after.batchId).toBe(before.batchId)
    expect(after.items.map(({ idempotencyKey }) => idempotencyKey)).toEqual(before.items.map(({ idempotencyKey }) => idempotencyKey))
    expect(h.requests.filter(({ path }) => path.endsWith('/resolve'))).toHaveLength(1)
    expect(h.requests.filter(({ path }) => path.endsWith('/batches'))).toHaveLength(1)
    expect(h.requests.some(({ path }) => path === '/api/v1/document-groups/group-1')).toBe(true)
    expect(h.upload).toHaveBeenCalledTimes(3)
    expect(await h.run(['resume', before.id, '--group', 'Other'])).toBe(2)
  })

  it('rejects deleted destinations without resolving a reused name or uploading', async () => {
    const h = await harness()
    h.upload.mockRejectedValueOnce(new Error('Interrupted'))
    await h.run(['import', '--group', 'Original name', h.source])
    const manifest = await h.saved()
    h.json.mockRejectedValue(new CliApiError('GROUP_UNAVAILABLE', 'Group deleted', 409))
    expect(await h.run(['resume', manifest.id])).toBe(5)
    expect(h.json.mock.calls.at(-1)?.[0]).toBe('/api/v1/document-groups/group-1')
    expect(h.upload).toHaveBeenCalledTimes(1)
  })

  it('expires unresolved name intents before any new resolution request', async () => {
    const h = await harness()
    h.json.mockRejectedValueOnce(new CliApiError('NETWORK_ERROR', 'Lost response'))
    await h.run(['import', '--group', 'Original name', h.source])
    const manifest = await h.saved()
    manifest.createdAt -= 7 * 24 * 60 * 60
    await h.store.save(manifest)
    h.json.mockClear()
    expect(await h.run(['resume', manifest.id])).toBe(1)
    expect(h.output.at(-1)).toContain('EXPIRED_GROUP_INTENT')
    expect(h.json).not.toHaveBeenCalled()
  })

  it('validates explicit IDs and rejects mismatched responses before batch admission', async () => {
    const h = await harness()
    expect(await h.run(['import', '--group-id', 'group-1', h.source])).toBe(0)
    expect(h.requests[0].path).toBe('/api/v1/document-groups/group-1')
    expect(h.requests.some(({ path }) => path.endsWith('/resolve'))).toBe(false)
    h.requests.length = 0
    expect(await h.run(['import', '--group-id', 'group-2', h.source])).toBe(1)
    expect(h.requests).toHaveLength(1)
  })

  it('requires grouping capability for saved grouped resumes', async () => {
    const h = await harness()
    await h.run(['import', '--group-id', 'group-1', h.source])
    const manifest = await h.saved()
    h.discovery.mockResolvedValue({ apiVersion: 'v1', available: true, capabilities: { documentImport: true, documentGroups: false } })
    h.json.mockClear()
    expect(await h.run(['resume', manifest.id])).toBe(8)
    expect(h.json).not.toHaveBeenCalled()
  })
})
