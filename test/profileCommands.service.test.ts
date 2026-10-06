import { describe, expect, it, vi } from 'vitest'
import { CliApiError, type DocumentApiClient } from '../src/apiClient.service'
import { ResumeStore } from '../src/resumeStore.service'
import { runCli } from '../src/run.service'
import { CliExitCode, type CliDependencies } from '../src/types'

const discovery = {
  apiVersion: 'v1',
  profileApiVersion: 'v1',
  capabilities: { profileRead: true, profileWrite: true, profileSelection: true, profileActions: true }
}

type JsonMock = ReturnType<typeof vi.fn<(path: string, init?: RequestInit) => Promise<Record<string, unknown>>>>

const harness = (json: JsonMock = vi.fn(async () => ({ revision: 9 }))): { dependencies: CliDependencies; json: JsonMock; out: string[]; errors: string[] } => {
  const out: string[] = []
  const errors: string[] = []
  return {
    dependencies: {
      apiFactory: () => ({ discovery: async () => discovery, json }) as unknown as DocumentApiClient,
      credentialStore: { clear: vi.fn(), read: vi.fn(), write: vi.fn() },
      output: { write: (value) => out.push(value), error: (value) => errors.push(value) },
      resumeStore: new ResumeStore('/tmp/extrabrain-profile-command-test')
    },
    json,
    out,
    errors
  }
}

describe('profile commands', () => {
  it('sends every documented mutation route with revision, request ID, and documented payload or headers', async () => {
    const json: JsonMock = vi.fn(async () => ({ revision: 10, replayed: false }))
    const test = harness(json)
    const commands = [
      ['profiles', 'create', '--revision', '9', '--request-id', 'create-1', '--name', 'Research', '--description', '', '--prompt', '', '--icon', 'brain', '--disabled', '--use-full-session-context'],
      ['profiles', 'update', 'custom', 'profile1', '--revision', '9', '--request-id', 'update-1', '--description', '', '--reset-use-full-session-context'],
      ['profiles', 'delete', 'custom', 'profile1', '--revision', '9', '--request-id', 'delete-1'],
      ['profiles', 'update', 'system', 'assistant', '--revision', '9', '--request-id', 'system-1', '--enabled'],
      ['profiles', 'pin', 'system', 'assistant', '--revision', '9', '--request-id', 'pin-1'],
      ['profiles', 'auto', '--revision', '9', '--request-id', 'auto-1'],
      ['profiles', 'actions', 'create', 'custom', 'profile1', '--revision', '9', '--request-id', 'action-create', '--name', '', '--prompt', '', '--icon', 'wand'],
      ['profiles', 'actions', 'update', 'system', 'assistant', 'action1', '--revision', '9', '--request-id', 'action-update', '--disabled'],
      ['profiles', 'actions', 'delete', 'system', 'assistant', 'action1', '--revision', '9', '--request-id', 'action-delete'],
      ['profiles', 'actions', 'order', 'system', 'assistant', 'action1', 'action2', '--revision', '9', '--request-id', 'order-1']
    ]
    for (const command of commands) await expect(runCli(['--json', ...command], test.dependencies)).resolves.toBe(0)
    const calls = json.mock.calls.filter(([path]) => path !== '/.well-known/extrabrain')
    expect(calls.map(([path, init]) => [path, init?.method])).toEqual([
      ['/api/v1/profiles/custom', 'POST'],
      ['/api/v1/profiles/custom/profile1', 'PATCH'],
      ['/api/v1/profiles/custom/profile1', 'DELETE'],
      ['/api/v1/profiles/system/assistant', 'PATCH'],
      ['/api/v1/profiles/selection', 'PATCH'],
      ['/api/v1/profiles/selection', 'PATCH'],
      ['/api/v1/profiles/custom/profile1/actions', 'POST'],
      ['/api/v1/profiles/system/assistant/actions/action1', 'PATCH'],
      ['/api/v1/profiles/system/assistant/actions/action1', 'DELETE'],
      ['/api/v1/profiles/system/assistant/actions/order', 'PUT']
    ])
    const createBody = JSON.parse(String(calls[0]?.[1]?.body))
    expect(createBody).toEqual({ requestId: 'create-1', expectedRevision: 9, profile: { name: 'Research', description: '', prompt: '', icon: 'brain', enabled: false, settings: { useFullSessionContext: true } } })
    expect(JSON.parse(String(calls[1]?.[1]?.body)).patch).toEqual({ description: '', settings: { useFullSessionContext: null } })
    expect(new Headers(calls[2]?.[1]?.headers).get('x-extrabrain-expected-revision')).toBe('9')
    expect(new Headers(calls[2]?.[1]?.headers).get('x-extrabrain-request-id')).toBe('delete-1')
    expect(JSON.parse(String(calls[9]?.[1]?.body)).actionIds).toEqual(['action1', 'action2'])
    expect(JSON.parse(test.out[0]!).data.requestId).toBe('create-1')
  })

  it('reads a current revision for a new intent and keeps a supplied retry exactly controlled', async () => {
    const json: JsonMock = vi.fn(async (_path: string, init?: RequestInit) => {
      if (!init?.method || init.method === 'GET') return { revision: 27 }
      return { revision: 28, replayed: true }
    })
    const test = harness(json)
    await expect(runCli(['--json', 'profiles', 'auto'], test.dependencies)).resolves.toBe(0)
    expect(json.mock.calls.map(([path, init]) => [path, init?.method ?? 'GET'])).toEqual([
      ['/api/v1/profiles/selection', 'GET'],
      ['/api/v1/profiles/selection', 'PATCH']
    ])
    const body = JSON.parse(String(json.mock.calls[1]?.[1]?.body))
    expect(body.expectedRevision).toBe(27)
    expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/)
    expect(JSON.parse(test.out[0]!).data).toMatchObject({ revision: 28, replayed: true, requestId: body.requestId })
  })

  it('rejects invalid local inputs before a request and preserves explicit reset and empty text semantics', async () => {
    const test = harness()
    await expect(runCli(['profiles', 'update', 'custom', 'profile1'], test.dependencies)).resolves.toBe(CliExitCode.USAGE)
    await expect(runCli(['profiles', 'create', '--name', 'x', '--description', 'x', '--prompt', 'x', '--icon', 'nope'], test.dependencies)).resolves.toBe(CliExitCode.USAGE)
    await expect(runCli(['profiles', 'actions', 'update', 'system', 'assistant', 'action1', '--name', 'forbidden'], test.dependencies)).resolves.toBe(CliExitCode.SUCCESS)
    expect(test.errors[0]).toContain('editable field')
    expect(test.errors[1]).toContain('supported profile icon')
  })

  it('rejects unknown, inapplicable, impossible, and trailing input before opening a profile request', async () => {
    const json: JsonMock = vi.fn(async () => ({ revision: 9 }))
    const test = harness(json)
    const invalid = [
      ['profiles', 'create', '--name', 'n', '--description', 'd', '--prompt', 'p', '--enabledd'],
      ['profiles', 'delete', 'custom', 'profile1', '--name', 'ignored'],
      ['profiles', 'delete', 'system', 'assistant'],
      ['profiles', 'update', 'system', 'assistant', '--disabled'],
      ['profiles', 'pin', 'custom', 'profile1', 'trailing'],
      ['profiles', 'actions', 'get', 'system', 'assistant', 'action1', 'trailing']
    ]
    for (const command of invalid) await expect(runCli(command, test.dependencies)).resolves.toBe(CliExitCode.USAGE)
    expect(json).not.toHaveBeenCalled()
  })

  it('checks the profile API version and operation capability without affecting older document commands', async () => {
    const out: string[] = []
    const dependencies: CliDependencies = {
      apiFactory: () => ({ discovery: async () => ({ apiVersion: 'v1', available: true, capabilities: { documentMetadata: true } }), json: vi.fn() }) as unknown as DocumentApiClient,
      credentialStore: { clear: vi.fn(), read: vi.fn(), write: vi.fn() },
      output: { write: (value) => out.push(value), error: (value) => out.push(value) },
      resumeStore: new ResumeStore('/tmp/extrabrain-profile-compat-test')
    }
    await expect(runCli(['--json', 'profiles', 'list'], dependencies)).resolves.toBe(CliExitCode.UNSUPPORTED)
    await expect(runCli(['--json', 'documents', 'list'], dependencies)).resolves.toBe(CliExitCode.SUCCESS)
    expect(out[0]).toContain('UNSUPPORTED_API_VERSION')
  })

  it.each([
    [['profiles', 'list'], 'profileRead'],
    [['profiles', 'create', '--name', 'n', '--description', 'd', '--prompt', 'p'], 'profileWrite'],
    [['profiles', 'selection'], 'profileSelection'],
    [['profiles', 'actions', 'list', 'system', 'assistant'], 'profileActions']
  ])('requires the advertised %s capability', async (command, capability) => {
    const out: string[] = []
    const dependencies: CliDependencies = {
      apiFactory: () => ({ discovery: async () => ({ apiVersion: 'v1', profileApiVersion: 'v1', capabilities: {} }), json: vi.fn() }) as unknown as DocumentApiClient,
      credentialStore: { clear: vi.fn(), read: vi.fn(), write: vi.fn() },
      output: { write: (value) => out.push(value), error: (value) => out.push(value) },
      resumeStore: new ResumeStore('/tmp/extrabrain-profile-capability-test')
    }
    await expect(runCli(['--json', ...command], dependencies)).resolves.toBe(CliExitCode.UNSUPPORTED)
    expect(out[0]).toContain(capability)
  })

  it.each([
    ['REVISION_CONFLICT', 409, CliExitCode.CONFLICT, 'Read the latest resource revision'],
    ['REQUEST_ID_REUSE', 409, CliExitCode.CONFLICT, 'exact original route'],
    ['OPERATION_STATE_UNKNOWN', 409, CliExitCode.CONFLICT, 'Inspect current profiles'],
    ['PRO_REQUIRED', 403, CliExitCode.FAILURE, 'requires ExtraBrain Pro'],
    ['READ_ONLY', 400, CliExitCode.FAILURE, 'editable fields'],
    ['NOT_FOUND', 404, CliExitCode.UNSUPPORTED, 'Missing']
  ])('maps %s with actionable recovery', async (code, status, exitCode, message) => {
    const test = harness(vi.fn(async () => { throw new CliApiError(code, 'Missing', status) }))
    await expect(runCli(['--json', 'profiles', 'list'], test.dependencies)).resolves.toBe(exitCode)
    expect((test.out[0] ?? test.errors[0])).toContain(message)
  })
})
