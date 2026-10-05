import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { beforeAll, describe, expect, it } from 'vitest'
import { SESSION_COLLECTIONS } from '../src/sessionData.service'

const execute = promisify(execFile)
const candidate = process.env.EXTRABRAIN_TEST_CLI
const bundle = resolve('dist/extrabrain.cjs')
type Mode = 'within' | 'across' | 'valid' | 'missing' | 'conflicting'
type Target = (typeof SESSION_COLLECTIONS)[number] | 'analyses' | 'part'

beforeAll(async () => {
  if (!candidate) await execute(process.execPath, ['scripts/build-bundle.mjs'])
})

const exportFixture = async (target: Target, mode: Mode) => {
  const directory = await mkdtemp(join(tmpdir(), 'extrabrain-cli-identities-'))
  const output = join(directory, 'export')
  const paths: string[] = []
  const counts = Object.fromEntries([...SESSION_COLLECTIONS, 'analyses'].map((name) => [name, name === target ? 2 : 0]))
  const manifest = (analysisId: string) => ({
    schemaVersion: 'v1', sessionId: 'fixture-session', analysisId, snapshot: 'fixture-snapshot',
    analysis: { id: analysisId }, provenance: { status: 'complete', missing: [] }, assets: [],
    parts: target === 'part' ? [{ id: 'input', role: 'model-input', totalCount: 2 }] : []
  })
  const server = createServer((request, response) => {
    const url = new URL(request.url!, 'http://fixture')
    paths.push(url.pathname + url.search)
    response.setHeader('content-type', 'application/json')
    let body: unknown
    if (url.pathname === '/.well-known/extrabrain') {
      body = { apiVersion: 'v1', sessionApiVersion: 'v1', available: true, capabilities: { sessionMetadata: true, sessionData: true, analysisData: true, screenshotExport: true } }
    } else if (url.pathname === '/api/v1/sessions/fixture-session') {
      body = { sessionId: 'fixture-session', snapshot: 'fixture-snapshot', counts }
    } else if (/\/analyses\/[^/]+$/.test(url.pathname)) {
      body = manifest(url.pathname.split('/').at(-1)!)
    } else {
      const selected = target === 'part' ? url.pathname.endsWith('/parts/input') : url.pathname.endsWith(`/${target}`)
      let items: Record<string, unknown>[] = []
      let nextCursor: string | null = null
      if (selected) {
        items = [0, 1].map((index) => {
          const id = `expected-${index === 1 && (mode === 'within' || mode === 'across') ? 1 : index + 1}`
          const item: Record<string, unknown> = { content: `known ${index}`, timestamp: 100 }
          if (mode !== 'missing' || index === 0) {
            // Exercise the aliases already supported by the export consumer.
            if (target === 'analyses') item.analysisId = id
            else if (target === 'screenshots') item.screenshotId = id
            else item.id = id
          }
          if (mode === 'conflicting') item.id = `different-${index}`
          if (target === 'screenshots') {
            item.defaultRepresentation = 'original'
            item.representations = [{ representation: 'original', available: false }]
          }
          // A part record's reference identity is not its own identity.
          if (target === 'part') item.screenshotId = 'shared-reference'
          return item
        })
        if (mode === 'across' || mode === 'valid') {
          items = [items[url.searchParams.has('cursor') ? 1 : 0]]
          nextCursor = url.searchParams.has('cursor') ? null : 'page-2'
        }
      }
      body = { sessionId: 'fixture-session', snapshot: 'fixture-snapshot', items, totalCount: selected ? 2 : 0, nextCursor,
        ...(target === 'part' ? { analysisId: 'a1' } : {}) }
    }
    response.end(JSON.stringify(body))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing fixture address')
    const command = target === 'part'
      ? ['sessions', 'analyses', 'export', 'fixture-session', 'a1']
      : ['sessions', 'export', 'fixture-session']
    const args = ['--json', ...command, '--output', output]
    const result = await execute(candidate ?? process.execPath, candidate ? args : [bundle, ...args], {
      env: { ...process.env, EXTRABRAIN_PORT: String(address.port) }, timeout: 10000
    }).then((result) => ({ ...result, code: 0 }), (error) => ({ stdout: error.stdout as string, stderr: error.stderr as string, code: error.code as number }))
    const files = await readdir(output)
    if (mode === 'valid') {
      expect(result.code, JSON.stringify(result)).toBe(0)
      const complete = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'))
      expect(complete.retrieval).toEqual({ complete: true })
      expect(files).not.toContain('incomplete.json')
      if (target === 'analyses') expect(complete.analyses.map((item: { id: string }) => item.id)).toEqual(['expected-1', 'expected-2'])
      else {
        const file = target === 'part' ? complete.parts[0].file : `${target}.jsonl`
        const rows = (await readFile(join(output, file), 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
        expect(rows.map((item) => item.id ?? item.screenshotId)).toEqual(['expected-1', 'expected-2'])
      }
      expect(paths.filter((path) => path.includes('cursor=page-2'))).toHaveLength(1)
      expect(paths.filter((path) => path.includes('cursor=page-2'))[0]).toContain('snapshot=fixture-snapshot')
    } else {
      expect(result.code, JSON.stringify({ result, files, manifest: await readFile(join(output, 'manifest.json'), 'utf8').catch(() => null) })).not.toBe(0)
      expect(files).not.toContain('manifest.json')
      expect(JSON.parse(await readFile(join(output, 'incomplete.json'), 'utf8'))).toMatchObject({ complete: false, stage: 'failed', error: 'INVALID_RESPONSE',
        message: expect.stringContaining(mode === 'missing' ? 'Invalid record identity' : mode === 'conflicting' ? 'Conflicting record identity' : 'Duplicate record identity') })
      if (mode === 'across' && target !== 'analyses') {
        const file = target === 'part' ? join('parts', (await readdir(join(output, 'parts')))[0]) : `${target}.jsonl`
        const rows = (await readFile(join(output, file), 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
        expect(rows).toHaveLength(1)
        expect(rows[0].id ?? rows[0].screenshotId).toBe('expected-1')
      }
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
  }
}

describe('compiled session export identity validation', () => {
  for (const target of [...SESSION_COLLECTIONS, 'analyses', 'part'] as const) {
    it.each(['within', 'across', 'valid'] as const)(`${target}: %s page identities`, async (mode) => {
      await exportFixture(target, mode)
    })
  }
  it.each(['transcripts', 'screenshots', 'analyses', 'part'] as const)('%s: missing identity', async (target) => {
    await exportFixture(target, 'missing')
  })
  it.each(['screenshots', 'analyses'] as const)('%s: conflicting identity aliases', async (target) => {
    await exportFixture(target, 'conflicting')
  })
})
