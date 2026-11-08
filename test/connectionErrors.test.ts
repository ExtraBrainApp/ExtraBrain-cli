import { describe, expect, it, vi } from 'vitest'
import { DocumentApiClient } from '../src/apiClient.service'
import { collectNetworkCodes, describeConnectionFailure } from '../src/connectionError.service'
import { runCli } from '../src/run.service'
import type { CliDependencies } from '../src/types'

const runCapabilities = async (client: DocumentApiClient): Promise<{ exitCode: number; output: string[] }> => {
  const output: string[] = []
  const deps = {
    apiFactory: () => client,
    output: { write: (value: string) => output.push(value), error: vi.fn() }
  } as unknown as CliDependencies
  const exitCode = await runCli(['--json', 'capabilities'], deps)
  return { exitCode, output }
}

describe('connection failure classification', () => {
  it('finds distinct codes through causes and aggregated errors', () => {
    const inner = Object.assign(new Error('inner'), { code: 'ECONNREFUSED' })
    const error = new TypeError('fetch failed', { cause: new AggregateError([inner, inner]) })
    expect(collectNetworkCodes(Object.assign(error, { code: 'ECONNREFUSED' }))).toEqual(['ECONNREFUSED'])
  })

  it('stops at a bounded number of errors', () => {
    const wide = { errors: Array.from({ length: 100 }, (_, index) => ({ code: `E${index}` })) }
    expect(collectNetworkCodes(wide).length).toBeLessThan(32)
  })

  it('prefers a permission block over other codes', () => {
    expect(describeConnectionFailure(['ECONNREFUSED', 'ETIMEDOUT', 'EPERM']).code).toBe('LOCAL_ACCESS_BLOCKED')
  })

  it('prefers a timeout over a refused connection', () => {
    expect(describeConnectionFailure(['ECONNREFUSED', 'ETIMEDOUT']).code).toBe('REQUEST_TIMEOUT')
  })
})

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
    const { exitCode, output } = await runCapabilities(client)
    expect(exitCode).toBe(3)
    expect(JSON.parse(output[0])).toMatchObject({ code: 3, data: { error: errorCode, details: { origin: 'http://127.0.0.1:37373', networkCodes: [networkCode] } } })
    expect(output[0]).not.toContain('ExtraBrain is not running')
    expect(request).toHaveBeenCalledOnce()
  })

  it('reports disabled CLI access without asking users to enable MCP', async () => {
    const request = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ apiVersion: 'v1', available: false, capabilities: {} }), { status: 200 }))
    const client = new DocumentApiClient(null, undefined, request)
    const { exitCode, output } = await runCapabilities(client)
    expect(exitCode).toBe(3)
    expect(JSON.parse(output[0])).toMatchObject({ data: { error: 'CLI_ACCESS_DISABLED' } })
    expect(output[0]).toContain('Settings > Agent Skills')
    expect(output[0]).not.toContain('MCP')
    expect(request).toHaveBeenCalledOnce()
  })

  it('does not replay writes on blocked access', async () => {
    const request = vi.fn<typeof fetch>(async () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }) })
    await expect(new DocumentApiClient(null, undefined, request).json('/api/v1/profiles/custom', { method: 'POST', body: '{}' })).rejects.toMatchObject({ code: 'LOCAL_ACCESS_BLOCKED' })
    expect(request).toHaveBeenCalledOnce()
    expect(request.mock.calls[0]?.[1]?.signal).toBeUndefined()
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
