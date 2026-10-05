import { createHash } from 'node:crypto'
import type { DocumentApiClient } from './apiClient.service'
import { executeImport, startImport } from './importCommand.service'
import { requestJson } from './request.service'
import { requireCapabilities } from './protocol'
import { CliExitCode, type CliDependencies, type CliResult, type ParsedArguments } from './types'

const getStringFlag = (parsed: ParsedArguments, name: string): string | undefined => {
  const value = parsed.flags.get(name)
  return typeof value === 'string' ? value : undefined
}

const requireArgument = (values: readonly string[], index: number, name: string): string => {
  const value = values[index]
  if (!value) throw new Error(`${name} is required`)
  return value
}

const readText = async (parsed: ParsedArguments, client: DocumentApiClient): Promise<CliResult> => {
  const id = encodeURIComponent(requireArgument(parsed.command, 2, 'document ID'))
  const generation = getStringFlag(parsed, 'generation')
  if (!generation) throw new Error('--generation is required')
  const query = new URLSearchParams({ generation })
  const offset = getStringFlag(parsed, 'offset')
  const maxChars = getStringFlag(parsed, 'max-chars')
  if (offset) query.set('offset', offset)
  if (maxChars) query.set('maxChars', maxChars)
  const data = await requestJson(client, `/api/v1/documents/${id}/text?${query}`)
  return { code: CliExitCode.SUCCESS, data, message: String(data.text ?? '') }
}

const search = async (parsed: ParsedArguments, client: DocumentApiClient): Promise<CliResult> => {
  const queryText = parsed.command.slice(2).join(' ')
  if (!queryText) throw new Error('search query is required')
  const query = new URLSearchParams({ q: queryText })
  const limit = getStringFlag(parsed, 'limit')
  if (limit) query.set('limit', limit)
  const data = await requestJson(client, `/api/v1/documents/search?${query}`)
  return { code: CliExitCode.SUCCESS, data, message: 'Search completed.' }
}

const exportOriginal = async (
  parsed: ParsedArguments,
  client: DocumentApiClient
): Promise<CliResult> => {
  const documentId = requireArgument(parsed.command, 2, 'document ID')
  const outputPath = getStringFlag(parsed, 'output')
  if (!outputPath) throw new Error('--output is required')
  await client.exportOriginal(documentId, outputPath)
  return {
    code: CliExitCode.SUCCESS,
    data: { documentId, output: outputPath },
    message: `Original exported to ${outputPath}.`
  }
}

const deleteDocument = async (
  parsed: ParsedArguments,
  client: DocumentApiClient
): Promise<CliResult> => {
  const documentId = requireArgument(parsed.command, 2, 'document ID')
  const revision = getStringFlag(parsed, 'revision')
  if (!revision) throw new Error('--revision is required')
  const idempotencyKey = createHash('sha256')
    .update(`documents.delete:${documentId}:${revision}`)
    .digest('hex')
  const data = await requestJson(
    client,
    `/api/v1/documents/${encodeURIComponent(documentId)}`,
    'DELETE',
    undefined,
    { 'x-extrabrain-expected-revision': revision, 'x-idempotency-key': idempotencyKey }
  )
  return { code: CliExitCode.SUCCESS, data, message: 'Document deleted.' }
}

export const executeDocumentsCommand = async (
  parsed: ParsedArguments,
  dependencies: CliDependencies,
  client: DocumentApiClient
): Promise<CliResult> => {
  const action = parsed.command[1]
  if (action === 'import') {
    const name = getStringFlag(parsed, 'group')
    const id = getStringFlag(parsed, 'group-id')
    const selector = name !== undefined
      ? { kind: 'name' as const, value: name }
      : id !== undefined ? { kind: 'id' as const, value: id } : undefined
    if (selector) requireCapabilities(await client.discovery(), ['documentGroups'])
    const inlinePaths = parsed.command.slice(2)
    if (inlinePaths.some((path) => path.startsWith('-'))) {
      throw new Error('File names beginning with - must follow --')
    }
    return startImport(
      client,
      [...inlinePaths, ...parsed.paths],
      parsed.flags.has('recursive'),
      dependencies.resumeStore,
      selector
    )
  }
  if (action === 'resume') {
    const id = requireArgument(parsed.command, 2, 'resume ID')
    const manifest = await dependencies.resumeStore.load(id)
    if (manifest.group) requireCapabilities(await client.discovery(), ['documentGroups'])
    return executeImport(client, manifest, dependencies.resumeStore)
  }
  if (action === 'groups') {
    const data = await requestJson(client, '/api/v1/document-groups')
    return { code: CliExitCode.SUCCESS, data, message: 'Document groups listed.' }
  }
  if (action === 'list') {
    const data = await requestJson(client, '/api/v1/documents')
    return { code: CliExitCode.SUCCESS, data, message: 'Documents listed.' }
  }
  if (action === 'status') {
    const id = encodeURIComponent(requireArgument(parsed.command, 2, 'batch or item ID'))
    const kind = parsed.flags.has('item') ? 'items' : 'batches'
    const data = await requestJson(client, `/api/v1/document-imports/${kind}/${id}`)
    return { code: CliExitCode.SUCCESS, data, message: 'Import status retrieved.' }
  }
  if (action === 'text') return readText(parsed, client)
  if (action === 'search') return search(parsed, client)
  if (action === 'export') return exportOriginal(parsed, client)
  if (action === 'delete') return deleteDocument(parsed, client)
  throw new Error('Unknown documents command')
}
