import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import manifest from '../package.json'
import { CliApiError, DocumentApiClient } from '../src/apiClient.service'
import { ResumeStore } from '../src/resumeStore.service'
import { runCli } from '../src/run.service'
import { CliExitCode, type CliDependencies, type CredentialStore } from '../src/types'

const temporaryDirectories: string[] = []

interface TestHarness {
  dependencies: CliDependencies
  directory: string
  errors: string[]
  secrets: string[]
  written: string[]
}

const createHarness = async (
  api: Partial<DocumentApiClient>,
  credentialResult?: ReturnType<CredentialStore['read']>
): Promise<TestHarness> => {
  const directory = await mkdtemp(join(tmpdir(), 'extrabrain-cli-run-'))
  temporaryDirectories.push(directory)
  const written: string[] = []
  const errors: string[] = []
  const secrets: string[] = []
  const readCredential = (): ReturnType<CredentialStore['read']> =>
    credentialResult ?? { status: 'found', value: 'protected-token' }
  return {
    dependencies: {
      apiFactory: () => ({
        discovery: async () => ({
          apiVersion: 'v1',
          available: true,
          capabilities: {
            documentImport: true,
            documentMetadata: true,
            extractedText: true,
            indexedSearch: true,
            originalExport: true,
            revisionSafeDelete: true
          }
        }),
        ...api
      }) as DocumentApiClient,
      credentialStore: {
        clear: vi.fn(),
        read: vi.fn(readCredential),
        write: vi.fn((value: string) => secrets.push(value))
      },
      output: {
        error: (message: string) => errors.push(message),
        write: (message: string) => written.push(message)
      },
      resumeStore: new ResumeStore(join(directory, 'state'))
    },
    directory,
    errors,
    secrets,
    written
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true }))
  )
})

describe('ExtraBrain CLI contract', () => {
  it('reports APP_NOT_RUNNING with a stable JSON exit code', async () => {
    const harness = await createHarness({
      discovery: vi.fn(async () => {
        throw new CliApiError('APP_NOT_RUNNING', 'ExtraBrain is not running')
      })
    })

    await expect(runCli(['--json', 'capabilities'], harness.dependencies)).resolves.toBe(
      CliExitCode.APP_NOT_RUNNING
    )
    expect(JSON.parse(harness.written[0])).toMatchObject({
      code: 3,
      message: 'ExtraBrain is not running'
    })
  })

  it('fails closed before pairing when protected storage is unavailable', async () => {
    const pair = vi.fn()
    const harness = await createHarness({ pair }, { status: 'failed' })

    await expect(runCli(['pair'], harness.dependencies)).resolves.toBe(
      CliExitCode.PROTECTED_STORAGE_UNAVAILABLE
    )
    expect(pair).not.toHaveBeenCalled()
  })

  it('pairs with least-privilege defaults and requires explicit elevated scopes', async () => {
    const defaultPair = vi.fn(async () => ({
      principalId: 'default-principal',
      scopes: ['documents.metadata.read', 'documents.import'],
      token: 'default-token'
    }))
    const defaultHarness = await createHarness({ pair: defaultPair })
    vi.mocked(defaultHarness.dependencies.credentialStore.read)
      .mockReturnValueOnce({ status: 'notFound' })
      .mockReturnValueOnce({ status: 'found', value: 'default-token' })

    await expect(runCli(['pair'], defaultHarness.dependencies)).resolves.toBe(CliExitCode.SUCCESS)
    expect(defaultPair).toHaveBeenCalledWith({
      clientName: 'ExtraBrain CLI',
      clientVersion: manifest.version,
      scopes: ['documents.metadata.read', 'documents.import']
    })

    const elevatedPair = vi.fn(async () => ({
      principalId: 'elevated-principal',
      scopes: ['documents.text.read', 'documents.original.export'],
      token: 'elevated-token'
    }))
    const elevatedHarness = await createHarness({ pair: elevatedPair })
    vi.mocked(elevatedHarness.dependencies.credentialStore.read)
      .mockReturnValueOnce({ status: 'notFound' })
      .mockReturnValueOnce({ status: 'found', value: 'elevated-token' })

    await expect(
      runCli(
        ['pair', '--scope', 'documents.text.read', '--scope=documents.original.export'],
        elevatedHarness.dependencies
      )
    ).resolves.toBe(CliExitCode.SUCCESS)
    expect(elevatedPair).toHaveBeenCalledWith({
      clientName: 'ExtraBrain CLI',
      clientVersion: manifest.version,
      scopes: ['documents.text.read', 'documents.original.export']
    })
  })

  it('rejects unknown pairing scopes before opening an approval request', async () => {
    const pair = vi.fn()
    const harness = await createHarness({ pair })

    await expect(
      runCli(['pair', '--scope', 'documents.everything'], harness.dependencies)
    ).resolves.toBe(CliExitCode.USAGE)
    expect(pair).not.toHaveBeenCalled()
    expect(harness.errors[0]).toContain('--scope must be one of')
  })

  it('documents its stable command and exit-code contract', async () => {
    const harness = await createHarness({})

    await expect(runCli(['help'], harness.dependencies)).resolves.toBe(CliExitCode.SUCCESS)
    expect(harness.written[0]).toContain('3 APP_NOT_RUNNING')
    expect(harness.written[0]).toContain('pair [--scope <scope>]...')
    expect(harness.written[0]).toContain('documents delete --revision')
    await expect(runCli(['--version'], harness.dependencies)).resolves.toBe(CliExitCode.SUCCESS)
    expect(harness.written[1]).toBe(manifest.version)
  })

  it('rejects an incompatible API before reading a protected credential', async () => {
    const harness = await createHarness({
      discovery: vi.fn(async () => ({ apiVersion: 'v2', available: true, capabilities: {} }))
    })
    await expect(runCli(['--json', 'documents', 'list'], harness.dependencies)).resolves.toBe(
      CliExitCode.UNSUPPORTED
    )
    expect(harness.dependencies.credentialStore.read).not.toHaveBeenCalled()
    expect(harness.written[0]).toContain('UNSUPPORTED_API_VERSION')
  })

  it('requires the advertised capability for the selected operation', async () => {
    const harness = await createHarness({
      discovery: vi.fn(async () => ({
        apiVersion: 'v1',
        available: true,
        capabilities: { documentMetadata: true }
      }))
    })
    await expect(runCli(['--json', 'documents', 'export', '--output', 'copy.pdf', 'doc'], harness.dependencies)).resolves.toBe(CliExitCode.UNSUPPORTED)
    expect(harness.written[0]).toContain('originalExport')
  })

  it.each([
    [['documents', 'list'], 'documentMetadata'],
    [['documents', 'import', 'report.pdf'], 'documentImport'],
    [['documents', 'text', '--generation', '1', 'doc'], 'extractedText'],
    [['documents', 'search', 'query'], 'indexedSearch'],
    [['documents', 'export', '--output', 'copy.pdf', 'doc'], 'originalExport'],
    [['documents', 'delete', '--revision', '1', 'doc'], 'revisionSafeDelete']
  ])('requires %s capability %s', async (command, capability) => {
    const harness = await createHarness({
      discovery: vi.fn(async () => ({ apiVersion: 'v1', available: true, capabilities: {} }))
    })
    await expect(runCli(['--json', ...command], harness.dependencies)).resolves.toBe(CliExitCode.UNSUPPORTED)
    expect(harness.written[0]).toContain(capability)
    expect(harness.dependencies.credentialStore.read).not.toHaveBeenCalled()
  })

  it('reports revocation and stale revision with distinct JSON outcomes', async () => {
    const revoked = await createHarness({
      json: vi.fn(async () => { throw new CliApiError('AUTHENTICATION_REQUIRED', 'Revoked', 401) })
    })
    await expect(runCli(['--json', 'documents', 'list'], revoked.dependencies)).resolves.toBe(CliExitCode.AUTHENTICATION)
    expect(revoked.written[0]).toContain('AUTHENTICATION_REQUIRED')

    const conflict = await createHarness({
      json: vi.fn(async () => { throw new CliApiError('REVISION_CONFLICT', 'Stale revision', 409) })
    })
    await expect(runCli(['--json', 'documents', 'delete', '--revision', '1', 'doc'], conflict.dependencies)).resolves.toBe(CliExitCode.CONFLICT)
    expect(conflict.written[0]).toContain('REVISION_CONFLICT')
  })

  it('reuses the delete idempotency key for the same document revision', async () => {
    const requests: RequestInit[] = []
    const harness = await createHarness({
      json: vi.fn(async (_path: string, init?: RequestInit) => {
        requests.push(init ?? {})
        return { status: 'deleted' }
      })
    })

    await expect(
      runCli(['documents', 'delete', '--revision', '4', 'document-1'], harness.dependencies)
    ).resolves.toBe(CliExitCode.SUCCESS)
    await expect(
      runCli(['documents', 'delete', '--revision', '4', 'document-1'], harness.dependencies)
    ).resolves.toBe(CliExitCode.SUCCESS)

    expect(new Headers(requests[0]?.headers).get('x-idempotency-key')).toBeTruthy()
    expect(new Headers(requests[1]?.headers).get('x-idempotency-key')).toBe(
      new Headers(requests[0]?.headers).get('x-idempotency-key')
    )
  })

  it('routes status, list, bounded text, search, and original export through the API', async () => {
    const paths: string[] = []
    const exportOriginal = vi.fn(async () => {})
    const harness = await createHarness({
      json: vi.fn(async (path: string) => {
        paths.push(path)
        return { text: 'bounded result' }
      }),
      exportOriginal
    })
    const commands = [
      ['documents', 'status', 'batch-1'],
      ['documents', 'status', '--item', 'item-1'],
      ['documents', 'list'],
      ['documents', 'text', '--generation', '2', '--offset', '0', '--max-chars', '5000', 'document-1'],
      ['documents', 'search', '--limit', '10', 'release risks'],
      ['documents', 'export', '--output', 'copy.pdf', 'document-1']
    ]
    for (const command of commands) {
      await expect(runCli(['--json', ...command], harness.dependencies)).resolves.toBe(CliExitCode.SUCCESS)
    }
    expect(paths).toEqual([
      '/api/v1/document-imports/batches/batch-1',
      '/api/v1/document-imports/items/item-1',
      '/api/v1/documents',
      '/api/v1/documents/document-1/text?generation=2&offset=0&maxChars=5000',
      '/api/v1/documents/search?q=release+risks&limit=10'
    ])
    expect(exportOriginal).toHaveBeenCalledWith('document-1', 'copy.pdf')
  })

  it('imports files with two API phases, private resume state, and no caller path in JSON', async () => {
    const requests: Array<{ body?: unknown; path: string }> = []
    const upload = vi.fn(async () => ({ status: 'completed' }))
    const api = {
      json: vi.fn(async (path: string, init?: RequestInit) => {
        const body = init?.body ? JSON.parse(String(init.body)) : undefined
        requests.push({ body, path })
        if (path.endsWith('/batches')) return { batch: { id: 'batch-1' } }
        return { documentId: 'document-1', operationId: 'operation-1', status: 'accepted' }
      }),
      upload
    }
    const harness = await createHarness(api)
    const source = join(harness.directory, '- agent notes.txt')
    await writeFile(source, 'agent notes')

    await expect(
      runCli(['--json', 'documents', 'import', '--', source], harness.dependencies)
    ).resolves.toBe(CliExitCode.SUCCESS)

    expect(upload).toHaveBeenCalledWith('operation-1', await realpath(source), 11)
    expect(JSON.stringify(requests)).not.toContain(source)
    const result = JSON.parse(harness.written[0]) as {
      data: {
        items: Array<Record<string, unknown>>
        resumeId: string
      }
    }
    expect(result.data.items).toEqual([
      {
        documentId: 'document-1',
        errorCode: null,
        existingDocumentId: null,
        fileName: '- agent notes.txt',
        operationId: 'operation-1',
        status: 'succeeded'
      }
    ])
    const resumePath = harness.dependencies.resumeStore.path(result.data.resumeId)
    if (process.platform !== 'win32') {
      expect((await stat(resumePath)).mode & 0o777).toBe(0o600)
    }
    expect(await readFile(resumePath, 'utf8')).not.toContain('protected-token')
  })

  it('skips successful resume items and rejects changed files as a new intent', async () => {
    const upload = vi.fn(async () => ({ status: 'completed' }))
    const api = {
      json: vi.fn(async (path: string) =>
        path.endsWith('/batches')
          ? { batch: { id: 'batch-1' } }
          : { documentId: 'document-1', operationId: 'operation-1' }
      ),
      upload
    }
    const harness = await createHarness(api)
    const source = join(harness.directory, 'notes.txt')
    await writeFile(source, 'first')
    await runCli(['--json', 'documents', 'import', source], harness.dependencies)
    const first = JSON.parse(harness.written[0]) as { data: { resumeId: string } }
    await runCli(['--json', 'documents', 'resume', first.data.resumeId], harness.dependencies)
    expect(upload).toHaveBeenCalledTimes(1)

    const manifest = await harness.dependencies.resumeStore.load(first.data.resumeId)
    manifest.items[0].status = 'failed'
    await harness.dependencies.resumeStore.save(manifest)
    await writeFile(source, 'changed')
    await expect(
      runCli(['--json', 'documents', 'resume', first.data.resumeId], harness.dependencies)
    ).resolves.toBe(CliExitCode.PARTIAL_SUCCESS)
    expect(harness.written.at(-1)).toContain('CHANGED_FILE_REQUIRES_NEW_INTENT')
  })

  it('reports structured duplicate identities as a per-file partial result', async () => {
    const api = {
      json: vi.fn(async (path: string) => {
        if (path.endsWith('/batches')) return { batch: { id: 'batch-1' } }
        throw new CliApiError('DUPLICATE', 'Import item was not accepted: duplicate', 409, {
          existingDocumentId: 'existing-document',
          operationId: 'operation-1',
          status: 'duplicate'
        })
      }),
      upload: vi.fn()
    }
    const harness = await createHarness(api)
    const source = join(harness.directory, 'duplicate.txt')
    await writeFile(source, 'same content')

    await expect(
      runCli(['--json', 'documents', 'import', source], harness.dependencies)
    ).resolves.toBe(CliExitCode.PARTIAL_SUCCESS)

    expect(harness.written[0]).toContain('existing-document')
    expect(harness.written[0]).toContain('DUPLICATE')
    expect(api.upload).not.toHaveBeenCalled()
  })

  it('resumes an interrupted upload with the same item identity', async () => {
    const keys: string[] = []
    let uploads = 0
    const api = {
      json: vi.fn(async (path: string, init?: RequestInit) => {
        if (path.endsWith('/batches')) return { batch: { id: 'batch-1' } }
        keys.push(JSON.parse(String(init?.body)).idempotencyKey as string)
        return { documentId: 'document-1', operationId: 'operation-1' }
      }),
      upload: vi.fn(async () => {
        uploads += 1
        if (uploads === 1) throw new Error('Interrupted')
        return { status: 'completed' }
      })
    }
    const harness = await createHarness(api)
    const source = join(harness.directory, 'report.pdf')
    await writeFile(source, '%PDF-1.4')
    await expect(runCli(['--json', 'documents', 'import', source], harness.dependencies)).resolves.toBe(CliExitCode.PARTIAL_SUCCESS)
    const resumeId = (JSON.parse(harness.written[0]) as { data: { resumeId: string } }).data.resumeId
    await expect(runCli(['--json', 'documents', 'resume', resumeId], harness.dependencies)).resolves.toBe(CliExitCode.SUCCESS)
    expect(keys).toHaveLength(2)
    expect(keys[0]).toBe(keys[1])
    expect(uploads).toBe(2)
  })
})
