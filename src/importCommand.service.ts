import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat } from 'node:fs/promises'
import type { DocumentApiClient } from './apiClient.service'
import { CliApiError } from './apiClient.service'
import { expandInputPaths } from './fileExpansion.service'
import { requestJson } from './request.service'
import type { ResumeItem, ResumeManifest, ResumeStore } from './resumeStore.service'
import { CliExitCode, type CliResult } from './types'

const fingerprintCurrentFile = async (
  item: ResumeItem
): Promise<{ hash: string; size: number }> => {
  const stat = await lstat(item.path)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Source is no longer a regular file')
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(item.path)) hash.update(chunk as Buffer)
  return { hash: hash.digest('hex'), size: stat.size }
}

const recordImportFailure = (item: ResumeItem, error: unknown): void => {
  item.status = 'failed'
  item.errorCode = error instanceof CliApiError ? error.code : 'FILE_ERROR'
  if (error instanceof CliApiError && typeof error.details?.existingDocumentId === 'string') {
    item.existingDocumentId = error.details.existingDocumentId
  }
}

const admitImportItem = async (
  client: DocumentApiClient,
  manifest: ResumeManifest,
  item: ResumeItem
): Promise<Record<string, unknown>> =>
  requestJson(
    client,
    `/api/v1/document-imports/batches/${encodeURIComponent(String(manifest.batchId))}/items`,
    'POST',
    {
      declaredHash: item.hash,
      declaredSize: item.size,
      fileName: item.fileName,
      idempotencyKey: item.idempotencyKey
    }
  )

const processImportItem = async (
  client: DocumentApiClient,
  manifest: ResumeManifest,
  item: ResumeItem,
  store: ResumeStore
): Promise<void> => {
  if (item.status === 'succeeded') return
  try {
    const current = await fingerprintCurrentFile(item)
    if (current.hash !== item.hash || current.size !== item.size) {
      item.status = 'failed'
      item.errorCode = 'CHANGED_FILE_REQUIRES_NEW_INTENT'
      await store.save(manifest)
      return
    }
    const admission = await admitImportItem(client, manifest, item)
    const operationId = admission.operationId
    if (typeof operationId !== 'string') {
      if (admission.status !== 'completed') {
        throw new CliApiError('INVALID_RESPONSE', 'Import admission omitted its operation ID')
      }
      item.status = 'succeeded'
      if (typeof admission.documentId === 'string') item.documentId = admission.documentId
      await store.save(manifest)
      return
    }
    item.operationId = operationId
    if (typeof admission.documentId === 'string') item.documentId = admission.documentId
    await store.save(manifest)
    await client.upload(operationId, item.path, item.size)
    item.status = 'succeeded'
    delete item.errorCode
  } catch (error) {
    recordImportFailure(item, error)
  }
  await store.save(manifest)
}

const runWithConcurrency = async (
  jobs: Array<() => Promise<void>>,
  limit: number
): Promise<void> => {
  let cursor = 0
  const worker = async (): Promise<void> => {
    while (cursor < jobs.length) {
      const index = cursor
      cursor += 1
      await jobs[index]()
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker))
}

const createBatch = async (
  client: DocumentApiClient,
  manifest: ResumeManifest,
  store: ResumeStore
): Promise<void> => {
  if (manifest.batchId) return
  const response = await requestJson(client, '/api/v1/document-imports/batches', 'POST', {
    idempotencyKey: manifest.batchIdempotencyKey,
    itemCount: manifest.items.length,
    ...(manifest.group ? { groupId: manifest.group.resolved?.id } : {})
  })
  const batch = response.batch as { id?: unknown } | undefined
  if (typeof batch?.id !== 'string') {
    throw new CliApiError('INVALID_RESPONSE', 'Import batch omitted its ID')
  }
  manifest.batchId = batch.id
  await store.save(manifest)
}

const resolveDestination = async (
  client: DocumentApiClient,
  manifest: ResumeManifest,
  store: ResumeStore
): Promise<void> => {
  const intent = manifest.group
  if (!intent) return
  const savedId = intent.resolved?.id
  const explicitId = intent.selector.kind === 'id' ? intent.selector.value : undefined
  if (!savedId && !explicitId && Math.floor(Date.now() / 1000) - manifest.createdAt >= 7 * 24 * 60 * 60) {
    throw new CliApiError('EXPIRED_GROUP_INTENT', 'Unresolved group intent expired; start a new import explicitly')
  }
  const targetId = savedId ?? explicitId
  const response = targetId
    ? await requestJson(client, `/api/v1/document-groups/${encodeURIComponent(targetId)}`)
    : await requestJson(client, '/api/v1/document-groups/resolve', 'POST', {
        name: intent.selector.value,
        idempotencyKey: intent.resolutionKey
      })
  const group = response.group as { id?: unknown; name?: unknown } | undefined
  if (typeof group?.id !== 'string' || !group.id || typeof group.name !== 'string' || !group.name || (targetId && group.id !== targetId)) {
    throw new CliApiError('INVALID_RESPONSE', 'Group response did not identify the requested destination')
  }
  intent.resolved = { id: group.id, name: group.name }
  await store.save(manifest)
}

export const executeImport = async (
  client: DocumentApiClient,
  manifest: ResumeManifest,
  store: ResumeStore
): Promise<CliResult> => {
  try {
    await resolveDestination(client, manifest, store)
    await createBatch(client, manifest, store)
  } catch (error) {
    const message = `${error instanceof Error ? error.message : 'Import failed'}. Resume with: extrabrain documents resume ${manifest.id}`
    if (error instanceof CliApiError) throw new CliApiError(error.code, message, error.status, error.details)
    throw new Error(message)
  }
  await runWithConcurrency(
    manifest.items.map((item) => () => processImportItem(client, manifest, item, store)),
    2
  )
  const succeeded = manifest.items.filter((item) => item.status === 'succeeded').length
  const failed = manifest.items.length - succeeded
  const items = manifest.items.map(
    ({ fileName, documentId, errorCode, existingDocumentId, operationId, status }) => ({
      documentId: documentId ?? null,
      errorCode: errorCode ?? null,
      existingDocumentId: existingDocumentId ?? null,
      fileName,
      operationId: operationId ?? null,
      status
    })
  )
  const destination = manifest.group?.resolved
    ? ` into “${manifest.group.resolved.name}” (${manifest.group.resolved.id})`
    : ''
  return {
    code: failed ? CliExitCode.PARTIAL_SUCCESS : CliExitCode.SUCCESS,
    data: { batchId: manifest.batchId, failed, items, resumeId: manifest.id, succeeded, group: manifest.group?.resolved ?? null },
    message: failed
      ? `Imported ${succeeded} file(s)${destination}; ${failed} failed. Resume with: extrabrain documents resume ${manifest.id}`
      : `Imported ${succeeded} file(s)${destination}.`
  }
}

export const startImport = async (
  client: DocumentApiClient,
  inputPaths: readonly string[],
  recursive: boolean,
  store: ResumeStore,
  selector?: NonNullable<ResumeManifest['group']>['selector']
): Promise<CliResult> => {
  const files = await expandInputPaths(inputPaths, recursive)
  const manifest = store.create(files)
  if (selector) {
    manifest.schemaVersion = 2
    manifest.group = { selector, resolutionKey: randomUUID() }
  }
  await store.save(manifest)
  return executeImport(client, manifest, store)
}
