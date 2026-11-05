import { describe, expect, it, vi } from 'vitest'
import { DocumentApiClient } from '../src/apiClient.service'
import { runCli } from '../src/run.service'
import type { CliDependencies } from '../src/types'

describe('connection recovery contract', () => {
  it.each([
    ['EPERM', 'LOCAL_ACCESS_BLOCKED'],
    ['EACCES', 'LOCAL_ACCESS_BLOCKED'],
    ['ECONNREFUSED', 'CONNECTION_REFUSED'],
    ['ETIMEDOUT', 'REQUEST_TIMEOUT'],
    ['UND_ERR_CONNECT_TIMEOUT', 'REQUEST_TIMEOUT'],
    ['ECONNRESET', 'CONNECTION_FAILED']
  ])('preserves nested %s failures for agents', async (networkCode, errorCode) => {
    const request = vi.fn<typeof fetch>(async () => {
      throw new TypeError('fetch failed', { cause: new AggregateError([
        Object.assign(new Error('connection failed'), { code: networkCode })
      ]) })
    })
    const client = new DocumentApiClient(null, 'http://127.0.0.1:37373', request)
    const output: string[] = []
    const deps = { apiFactory: () => client, output: { write: (value: string) => output.push(value), error: vi.fn() } } as unknown as CliDependencies
    expect(await runCli(['--json', 'capabilities'], deps)).toBe(3)
    expect(JSON.parse(output[0])).toMatchObject({ code: 3, data: { error: errorCode, details: { origin: 'http://127.0.0.1:37373', networkCodes: [networkCode] } } })
    expect(output[0]).not.toContain('ExtraBrain is not running')
    expect(request).toHaveBeenCalledOnce()
  })

  it('does not replay writes on blocked access', async () => {
    const request = vi.fn<typeof fetch>(async () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }) })
    await expect(new DocumentApiClient(null, undefined, request).json('/api/v1/profiles/custom', { method: 'POST', body: '{}' })).rejects.toMatchObject({ code: 'LOCAL_ACCESS_BLOCKED' })
    expect(request).toHaveBeenCalledOnce()
  })

  it('handles cyclic and opaque errors without claiming the app stopped', async () => {
    const cause: { cause?: unknown } = {}; cause.cause = cause
    const request = vi.fn<typeof fetch>(async () => { throw cause })
    await expect(new DocumentApiClient(null, undefined, request).discovery()).rejects.toMatchObject({ code: 'CONNECTION_FAILED' })
  })

  it.each(['AbortError', 'TimeoutError'])('preserves %s', async (name) => {
    const request = vi.fn<typeof fetch>(async () => { throw new DOMException('timeout', name) })
    await expect(new DocumentApiClient(null, undefined, request).discovery()).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' })
  })
})
