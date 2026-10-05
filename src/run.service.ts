import { LocalPrincipalScope } from './scopes'
import { CliApiError } from './apiClient.service'
import { executeDocumentsCommand } from './documentCommands.service'
import { FileExpansionError } from './fileExpansion.service'
import { requireCapabilities, requiredDocumentCapabilities } from './protocol'
import { executeSessionCommand, parseSessionCommand } from './sessionCommands.service'
import { updateCli } from './update'
import { CLI_VERSION } from './version'
import {
  CliExitCode,
  type CliDependencies,
  type CliOutput,
  type CliResult,
  type ParsedArguments
} from './types'

const HELP = `Usage: extrabrain [--json] <command>

Commands:
  pair [--scope <scope>]...
  capabilities
  documents import [--group <name> | --group-id <id>] [--recursive] [--] <files-or-directories...>
  documents resume <resume-id>
  documents status [--item] <batch-or-item-id>
  documents groups
  documents list
  documents text --generation <n> [--offset <n>] [--max-chars <n>] <document-id>
  documents search [--limit <n>] <query>
  documents export --output <path> <document-id>
  documents delete --revision <n> <document-id>
  sessions list [--limit <n>] [--cursor <cursor>] [--since <seconds>] [--until <seconds>]
  sessions search [page flags] <query>
  sessions current
  sessions get <session-id>
  sessions <transcripts|screenshots|facts|topics|questions|chat-turns|insights> [page flags] <session-id>
  sessions content --snapshot <snapshot> [--offset <n>] [--max-chars <n>] <session-id> <content-id>
  sessions analyses list [page flags] <session-id>
  sessions analyses get <session-id> <analysis-id>
  sessions export --output <new-directory> <session-id>
  sessions screenshot export --output <new-file> [--representation <name>] <session-id> <screenshot-id>
  sessions analyses export --output <new-directory> <session-id> <analysis-id>
  update
  --version

Exit codes: 0 success, 1 failure, 2 usage, 3 APP_NOT_RUNNING,
4 authentication or revocation, 5 conflict, 6 partial success,
7 protected storage unavailable, 8 unsupported or unavailable.`

const DOCUMENT_SCOPES = [
  LocalPrincipalScope.DOCUMENTS_METADATA_READ,
  LocalPrincipalScope.DOCUMENTS_TEXT_READ,
  LocalPrincipalScope.DOCUMENTS_IMPORT,
  LocalPrincipalScope.DOCUMENTS_DELETE,
  LocalPrincipalScope.DOCUMENTS_ORIGINAL_EXPORT
] as const
const DEFAULT_DOCUMENT_SCOPES = [
  LocalPrincipalScope.DOCUMENTS_METADATA_READ,
  LocalPrincipalScope.DOCUMENTS_IMPORT
] as const

const VALUE_FLAGS = new Set([
  'group',
  'group-id',
  'output',
  'generation',
  'offset',
  'max-chars',
  'limit',
  'revision',
  'scope',
  'cursor',
  'since',
  'until',
  'snapshot',
  'representation'
])

const setFlag = (flags: Map<string, string | true>, name: string, value: string | true): void => {
  const existing = flags.get(name)
  if (existing !== undefined && name !== 'scope') throw new Error(`--${name} may only be supplied once`)
  flags.set(
    name,
    name === 'scope' && typeof existing === 'string' && typeof value === 'string'
      ? `${existing},${value}`
      : value
  )
}

const parseArguments = (args: readonly string[]): ParsedArguments => {
  const flags = new Map<string, string | true>()
  const command: string[] = []
  const paths: string[] = []
  let afterSeparator = false
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]
    if (value === '--') {
      afterSeparator = true
      continue
    }
    if (!afterSeparator && value.startsWith('--')) {
      const separator = value.indexOf('=')
      const name = value.slice(2, separator < 0 ? undefined : separator)
      const inlineValue = separator < 0 ? undefined : value.slice(separator + 1)
      if (inlineValue !== undefined) setFlag(flags, name, inlineValue)
      else if (VALUE_FLAGS.has(name)) {
        const next = args[index + 1]
        if (!next || next.startsWith('--')) throw new Error(`--${name} requires a value`)
        setFlag(flags, name, next)
        index += 1
      } else setFlag(flags, name, true)
      continue
    }
    if (afterSeparator) paths.push(value)
    else command.push(value)
  }
  for (const name of ['group', 'group-id']) {
    const value = flags.get(name)
    if (value !== undefined && (typeof value !== 'string' || !value.trim())) {
      throw new Error(`--${name} requires a value`)
    }
  }
  if (flags.has('group') && flags.has('group-id')) {
    throw new Error('--group and --group-id are mutually exclusive')
  }
  if ((flags.has('group') || flags.has('group-id')) && (command[0] !== 'documents' || command[1] !== 'import')) {
    throw new Error('Group selectors are only supported by documents import; resume keeps its saved destination')
  }
  return { command, flags, json: flags.has('json'), paths }
}

const getPairingScopes = (scopeFlag: string | true | undefined): readonly string[] => {
  if (scopeFlag === undefined) return DEFAULT_DOCUMENT_SCOPES
  if (scopeFlag === true) throw new Error('--scope requires a value')
  const requested = [
    ...new Set(
      scopeFlag
        .split(',')
        .map((scope) => scope.trim())
        .filter(Boolean)
    )
  ]
  if (
    requested.length === 0 ||
    requested.some((scope) => !DOCUMENT_SCOPES.includes(scope as (typeof DOCUMENT_SCOPES)[number]))
  ) {
    throw new Error(`--scope must be one of: ${DOCUMENT_SCOPES.join(', ')}`)
  }
  return requested
}

const pair = async (
  dependencies: CliDependencies,
  scopeFlag: string | true | undefined
): Promise<CliResult> => {
  if (dependencies.credentialStore.read().status === 'failed') {
    throw new CliApiError(
      'PROTECTED_STORAGE_UNAVAILABLE',
      'Protected credential storage is unavailable'
    )
  }
  const scopes = getPairingScopes(scopeFlag)
  const publicClient = dependencies.apiFactory(null)
  requireCapabilities(await publicClient.discovery(), [
    ...new Set(
      scopes.map((scope) => {
        if (scope === LocalPrincipalScope.DOCUMENTS_IMPORT) return 'documentImport'
        if (scope === LocalPrincipalScope.DOCUMENTS_TEXT_READ) return 'extractedText'
        if (scope === LocalPrincipalScope.DOCUMENTS_DELETE) return 'revisionSafeDelete'
        if (scope === LocalPrincipalScope.DOCUMENTS_ORIGINAL_EXPORT) return 'originalExport'
        return 'documentMetadata'
      })
    )
  ])
  const payload = await publicClient.pair({
    clientName: 'ExtraBrain CLI',
    clientVersion: CLI_VERSION,
    scopes
  })
  const token = payload.token
  if (typeof token !== 'string' || !token) {
    throw new CliApiError('INVALID_RESPONSE', 'Pairing did not return a credential')
  }
  try {
    dependencies.credentialStore.write(token)
  } catch {
    throw new CliApiError('PROTECTED_STORAGE_UNAVAILABLE', 'Protected credential storage is unavailable')
  }
  const verified = dependencies.credentialStore.read()
  if (verified.status === 'failed') {
    throw new CliApiError('PROTECTED_STORAGE_UNAVAILABLE', 'Protected credential storage could not be verified')
  }
  if (verified.status !== 'found' || verified.value !== token) {
    dependencies.credentialStore.clear()
    throw new CliApiError(
      'PROTECTED_STORAGE_UNAVAILABLE',
      'Protected credential storage could not be verified'
    )
  }
  return {
    code: CliExitCode.SUCCESS,
    data: { paired: true, principalId: payload.principalId, scopes: payload.scopes },
    message: 'ExtraBrain CLI paired successfully.'
  }
}

const mapError = (error: unknown): CliResult => {
  const message = error instanceof Error ? error.message : 'CLI command failed'
  if (error instanceof FileExpansionError) return { code: CliExitCode.USAGE, message }
  if (!(error instanceof CliApiError)) return { code: CliExitCode.USAGE, message }
  if (error.code === 'APP_NOT_RUNNING') return { code: CliExitCode.APP_NOT_RUNNING, message }
  if (error.code === 'PROTECTED_STORAGE_UNAVAILABLE') {
    return { code: CliExitCode.PROTECTED_STORAGE_UNAVAILABLE, message }
  }
  if (['PAIRING_REQUIRED', 'AUTHENTICATION_REQUIRED', 'FORBIDDEN'].includes(error.code) || error.status === 401 || error.status === 403) {
    return {
      code: CliExitCode.AUTHENTICATION,
      data: { error: error.code },
      message: `${message}. Pair the CLI again if its credential was revoked.`
    }
  }
  if (['NOT_FOUND', 'ORIGINAL_UNAVAILABLE', 'TEXT_UNAVAILABLE', 'REPRESENTATION_UNAVAILABLE', 'UNSUPPORTED_API_VERSION', 'UNSUPPORTED_CAPABILITY'].includes(error.code)) {
    return { code: CliExitCode.UNSUPPORTED, data: { error: error.code }, message }
  }
  if (error.status === 409) {
    return { code: CliExitCode.CONFLICT, data: { error: error.code }, message }
  }
  return { code: CliExitCode.FAILURE, data: { error: error.code }, message }
}

const render = (result: CliResult, json: boolean, output: CliOutput): void => {
  if (json) {
    output.write(
      JSON.stringify({ code: result.code, data: result.data ?? null, message: result.message })
    )
  } else if (result.code === CliExitCode.SUCCESS || result.code === CliExitCode.PARTIAL_SUCCESS) {
    output.write(result.message)
  } else output.error(result.message)
}

const executeCommand = async (
  parsed: ParsedArguments,
  dependencies: CliDependencies
): Promise<CliResult> => {
  const [command] = parsed.command
  if (parsed.flags.has('version') || command === 'version') {
    return { code: CliExitCode.SUCCESS, data: { version: CLI_VERSION }, message: CLI_VERSION }
  }
  if (command === 'help' || parsed.flags.has('help')) {
    return { code: CliExitCode.SUCCESS, data: { version: CLI_VERSION }, message: HELP }
  }
  if (command === 'pair') return pair(dependencies, parsed.flags.get('scope'))
  if (command === 'capabilities') {
    const data = await dependencies.apiFactory(null).discovery()
    requireCapabilities(data, [])
    return { code: CliExitCode.SUCCESS, data, message: 'Capabilities retrieved.' }
  }
  if (command === 'update') {
    const data = updateCli()
    return {
      code: CliExitCode.SUCCESS,
      data,
      message: data.scheduled ? 'Update scheduled. Check --version after this process exits.' : 'CLI updated.'
    }
  }
  if (command === 'documents') {
    const publicClient = dependencies.apiFactory(null)
    requireCapabilities(await publicClient.discovery(), requiredDocumentCapabilities(parsed.command[1]))
    return executeDocumentsCommand(parsed, dependencies, publicClient)
  }
  if (command === 'sessions') {
    const request = parseSessionCommand(parsed)
    return executeSessionCommand(request, dependencies.apiFactory(null))
  }
  throw new Error(HELP)
}

export const runCli = async (
  args: readonly string[],
  dependencies: CliDependencies
): Promise<number> => {
  try {
    const parsed = parseArguments(args)
    const result = await executeCommand(parsed, dependencies)
    render(result, parsed.json, dependencies.output)
    return result.code
  } catch (error) {
    const result = mapError(error)
    render(result, args.includes('--json'), dependencies.output)
    return result.code
  }
}
