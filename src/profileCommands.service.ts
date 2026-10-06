import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { CliApiError, type DocumentApiClient } from './apiClient.service'
import { requestJson } from './request.service'
import { CliExitCode, type CliResult, type ParsedArguments } from './types'

type JsonObject = Record<string, unknown>
type ProfileKind = 'system' | 'custom'

const PROFILE_SETTINGS = [
  'expandWindowOnAnalysis',
  'analyzeOnRegionCapture',
  'useFullSessionContext',
  'autoAnalyzeTopics',
  'autoAnalyzeQuestions'
] as const

const PROFILE_ICONS = new Set([
  'assistant', 'interview', 'system_design', 'behavioral', 'meeting', 'hr_screen', 'bug',
  'search', 'braces', 'database', 'sparkles', 'terminal', 'lightbulb', 'target',
  'message_square', 'brain', 'book_open', 'presentation', 'rocket', 'shield', 'wrench',
  'flask', 'chart', 'cpu', 'camera', 'microphone', 'pen_tool', 'palette',
  'graduation_cap', 'clipboard_check', 'list_checks', 'network', 'git_branch', 'hammer',
  'puzzle', 'file_text', 'bot', 'compass', 'life_buoy', 'zap', 'trophy', 'star',
  'megaphone', 'headphones', 'monitor', 'globe', 'map', 'workflow'
])
const ACTION_ICONS = new Set([
  'book_open_text', 'circle_question', 'message_reply', 'messages_square', 'pen_line',
  'clipboard_list', 'wand', ...PROFILE_ICONS
])

const PROFILE_BEHAVIOR_FLAGS = PROFILE_SETTINGS.flatMap((name) => {
    const flagName = name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
    return [flagName, `no-${flagName}`, `reset-${flagName}`]
  })

const assertFlags = (parsed: ParsedArguments, allowed: readonly string[]): void => {
  const permitted = new Set(allowed)
  for (const name of parsed.flags.keys()) {
    if (!permitted.has(name)) throw new Error(`--${name} is not supported by this profiles command`)
  }
}

const assertArity = (command: readonly string[], expected: number): void => {
  if (command.length !== expected) throw new Error('This profiles command has unexpected positional arguments')
}

const READ_FLAGS = ['json'] as const
const MUTATION_FLAGS = ['json', 'revision', 'request-id'] as const
const PROFILE_INPUT_FLAGS = [
  ...MUTATION_FLAGS,
  'input', 'input-file', 'name', 'description', 'prompt', 'icon', 'enabled', 'disabled',
  ...PROFILE_BEHAVIOR_FLAGS
] as const
const SYSTEM_PROFILE_INPUT_FLAGS = [...MUTATION_FLAGS, 'input', 'input-file', 'enabled', 'disabled'] as const
const ACTION_INPUT_FLAGS = [...MUTATION_FLAGS, 'input', 'input-file', 'name', 'prompt', 'icon', 'enabled', 'disabled'] as const

const flag = (parsed: ParsedArguments, name: string): string | undefined => {
  const value = parsed.flags.get(name)
  if (value === true) throw new Error(`--${name} requires a value`)
  return value
}

const required = (values: readonly string[], index: number, label: string): string => {
  const value = values[index]
  if (!value) throw new Error(`${label} is required`)
  return value
}

const kind = (value: string): ProfileKind => {
  if (value === 'system' || value === 'custom') return value
  throw new Error('profile kind must be system or custom')
}

const id = (value: string, label: string): string => {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw new Error(`${label} must be a valid profile or action ID`)
  return value
}

const revision = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined
  if (!/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error('--revision must be a nonnegative safe integer')
  }
  return Number(value)
}

const readInput = async (parsed: ParsedArguments): Promise<JsonObject | undefined> => {
  const inline = flag(parsed, 'input')
  const file = flag(parsed, 'input-file')
  if (inline !== undefined && file !== undefined) throw new Error('--input and --input-file are mutually exclusive')
  const source = file === undefined ? inline : await readFile(file, 'utf8')
  if (source === undefined) return undefined
  try {
    const parsedInput: unknown = JSON.parse(source)
    if (!parsedInput || typeof parsedInput !== 'object' || Array.isArray(parsedInput)) {
      throw new Error('input must be a JSON object')
    }
    return parsedInput as JsonObject
  } catch (error) {
    if (error instanceof Error && error.message === 'input must be a JSON object') throw error
    throw new Error('input must contain valid JSON')
  }
}

const assertKeys = (input: JsonObject, allowed: readonly string[], label: string): void => {
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key))
  if (unknown.length) throw new Error(`${label} contains unsupported fields: ${unknown.join(', ')}`)
}

const text = (input: JsonObject, key: string, max: number, requiredField: boolean): void => {
  const value = input[key]
  if (value === undefined && !requiredField) return
  if (typeof value !== 'string' || value.length > max) throw new Error(`${key} must be text of at most ${max} characters`)
}

const boolean = (input: JsonObject, key: string): void => {
  if (input[key] !== undefined && typeof input[key] !== 'boolean') throw new Error(`${key} must be true or false`)
}

const settings = (input: JsonObject): void => {
  if (input.settings === undefined) return
  if (!input.settings || typeof input.settings !== 'object' || Array.isArray(input.settings)) throw new Error('settings must be an object')
  const settingInput = input.settings as JsonObject
  assertKeys(settingInput, PROFILE_SETTINGS, 'settings')
  for (const key of PROFILE_SETTINGS) {
    if (settingInput[key] !== undefined && settingInput[key] !== null && typeof settingInput[key] !== 'boolean') {
      throw new Error(`settings.${key} must be true, false, or null`)
    }
  }
}

const validateProfile = (input: JsonObject, create: boolean): void => {
  assertKeys(input, ['name', 'description', 'prompt', 'icon', 'enabled', 'settings'], 'profile input')
  text(input, 'name', 64, create)
  text(input, 'description', 300, create)
  text(input, 'prompt', 2000, create)
  if (input.icon !== undefined && (typeof input.icon !== 'string' || !PROFILE_ICONS.has(input.icon))) throw new Error('icon is not a supported profile icon')
  boolean(input, 'enabled')
  settings(input)
  if (!create && (Object.keys(input).length === 0 || (Object.keys(input).length === 1 && Object.keys(input.settings as JsonObject ?? {}).length === 0))) {
    throw new Error('profile patch must contain an editable field')
  }
}

const validateAction = (input: JsonObject, create: boolean): void => {
  assertKeys(input, ['name', 'prompt', 'icon', 'enabled'], 'action input')
  text(input, 'name', 40, create)
  text(input, 'prompt', 1000, create)
  if (input.icon !== undefined && (typeof input.icon !== 'string' || !ACTION_ICONS.has(input.icon))) throw new Error('icon is not a supported action icon')
  boolean(input, 'enabled')
  if (!create && Object.keys(input).length === 0) throw new Error('action patch must contain an editable field')
}

const commandFields = (parsed: ParsedArguments, action: 'profile' | 'action'): JsonObject => {
  const fields: JsonObject = {}
  for (const name of ['name', 'description', 'prompt', 'icon']) {
    const value = flag(parsed, name)
    if (value !== undefined) fields[name] = value
  }
  if (parsed.flags.has('enabled') && parsed.flags.has('disabled')) throw new Error('--enabled and --disabled are mutually exclusive')
  if (parsed.flags.has('enabled')) fields.enabled = true
  if (parsed.flags.has('disabled')) fields.enabled = false
  if (action === 'profile') {
    const value: JsonObject = {}
    for (const name of PROFILE_SETTINGS) {
      const cliName = name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
      const reset = `reset-${cliName}`
      if (parsed.flags.has(cliName) && parsed.flags.has(`no-${cliName}`)) throw new Error(`--${cliName} and --no-${cliName} are mutually exclusive`)
      if (parsed.flags.has(cliName)) value[name] = true
      if (parsed.flags.has(`no-${cliName}`)) value[name] = false
      if (parsed.flags.has(reset)) {
        if (value[name] !== undefined) throw new Error(`--${reset} cannot be combined with --${cliName}`)
        value[name] = null
      }
    }
    if (Object.keys(value).length) fields.settings = value
  }
  return fields
}

const mergeInput = async (parsed: ParsedArguments, action: 'profile' | 'action'): Promise<JsonObject> => {
  const json = await readInput(parsed)
  const flags = commandFields(parsed, action)
  if (json && Object.keys(flags).length) throw new Error('JSON input cannot be combined with field flags')
  return json ?? flags
}

const currentRevision = async (client: DocumentApiClient, path: string): Promise<number> => {
  const data = await requestJson(client, path)
  const value = data.revision
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new CliApiError('INVALID_RESPONSE', 'ExtraBrain did not return a valid settings revision')
  }
  return value
}

const mutation = async (
  client: DocumentApiClient,
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  revisionPath: string,
  parsed: ParsedArguments,
  field: string,
  value?: unknown
): Promise<CliResult> => {
  const expectedRevision = revision(flag(parsed, 'revision')) ?? await currentRevision(client, revisionPath)
  const requestId = flag(parsed, 'request-id') ?? randomUUID()
  if (requestId.length < 1 || requestId.length > 200) throw new Error('--request-id must contain 1 to 200 characters')
  const data = method === 'DELETE'
    ? await requestJson(client, path, method, undefined, {
      'x-extrabrain-expected-revision': String(expectedRevision),
      'x-extrabrain-request-id': requestId
    })
    : await requestJson(client, path, method, { requestId, expectedRevision, [field]: value })
  return {
    code: CliExitCode.SUCCESS,
    data: { ...data, expectedRevision, requestId },
    message: `Profile operation completed. Request ID: ${requestId}; expected revision: ${expectedRevision}${data.replayed === true ? ' (replayed)' : ''}.`
  }
}

const profilePath = (profileKind: ProfileKind, profileId: string): string =>
  `/api/v1/profiles/${profileKind}/${encodeURIComponent(profileId)}`

const actionsPath = (profileKind: ProfileKind, profileId: string): string =>
  `${profilePath(profileKind, profileId)}/actions`

const read = async (client: DocumentApiClient, path: string, message: string): Promise<CliResult> => ({
  code: CliExitCode.SUCCESS, data: await requestJson(client, path), message
})

export const executeProfileCommand = async (parsed: ParsedArguments, client: DocumentApiClient): Promise<CliResult> => {
  const command = parsed.command
  const operation = command[1]
  if (operation === 'list') {
    assertArity(command, 2); assertFlags(parsed, READ_FLAGS)
    return read(client, '/api/v1/profiles', 'Profiles listed.')
  }
  if (operation === 'get') {
    assertArity(command, 4); assertFlags(parsed, READ_FLAGS)
    return read(client, profilePath(kind(required(command, 2, 'profile kind')), id(required(command, 3, 'profile ID'), 'profile ID')), 'Profile retrieved.')
  }
  if (operation === 'selection') {
    assertArity(command, 2); assertFlags(parsed, READ_FLAGS)
    return read(client, '/api/v1/profiles/selection', 'Profile selection retrieved.')
  }
  if (operation === 'pin') {
    assertArity(command, 4); assertFlags(parsed, MUTATION_FLAGS)
    const profileKind = kind(required(command, 2, 'profile kind'))
    const profileId = id(required(command, 3, 'profile ID'), 'profile ID')
    return mutation(client, 'PATCH', '/api/v1/profiles/selection', '/api/v1/profiles/selection', parsed, 'selection', { mode: 'pinned', profile: { kind: profileKind, id: profileId } })
  }
  if (operation === 'auto') {
    assertArity(command, 2); assertFlags(parsed, MUTATION_FLAGS)
    return mutation(client, 'PATCH', '/api/v1/profiles/selection', '/api/v1/profiles/selection', parsed, 'selection', { mode: 'auto' })
  }
  if (operation === 'create') {
    assertArity(command, 2); assertFlags(parsed, PROFILE_INPUT_FLAGS)
    const input = await mergeInput(parsed, 'profile')
    validateProfile(input, true)
    return mutation(client, 'POST', '/api/v1/profiles/custom', '/api/v1/profiles', parsed, 'profile', input)
  }
  if (operation === 'update') {
    assertArity(command, 4)
    const profileKind = kind(required(command, 2, 'profile kind'))
    const profileId = id(required(command, 3, 'profile ID'), 'profile ID')
    assertFlags(parsed, profileKind === 'system' ? SYSTEM_PROFILE_INPUT_FLAGS : PROFILE_INPUT_FLAGS)
    const input = await mergeInput(parsed, 'profile')
    if (profileKind === 'system') {
      if (Object.keys(input).length !== 1 || typeof input.enabled !== 'boolean') throw new Error('system profile updates require exactly --enabled or --disabled')
      if (profileId === 'assistant' && input.enabled === false) throw new Error('Assistant must remain enabled')
    } else validateProfile(input, false)
    return mutation(client, 'PATCH', profilePath(profileKind, profileId), profilePath(profileKind, profileId), parsed, 'patch', input)
  }
  if (operation === 'delete') {
    assertArity(command, 4); assertFlags(parsed, MUTATION_FLAGS)
    const profileKind = kind(required(command, 2, 'profile kind'))
    const profileId = id(required(command, 3, 'profile ID'), 'profile ID')
    if (profileKind === 'system') throw new Error('system profiles cannot be deleted')
    return mutation(client, 'DELETE', profilePath(profileKind, profileId), profilePath(profileKind, profileId), parsed, 'unused')
  }
  if (operation !== 'actions') throw new Error('Unknown profiles command')
  const action = required(command, 2, 'profiles actions command')
  const profileKind = kind(required(command, 3, 'profile kind'))
  const profileId = id(required(command, 4, 'profile ID'), 'profile ID')
  const base = actionsPath(profileKind, profileId)
  if (action === 'list') {
    assertArity(command, 5); assertFlags(parsed, READ_FLAGS)
    return read(client, base, 'Profile actions listed.')
  }
  if (action === 'get') {
    assertArity(command, 6); assertFlags(parsed, READ_FLAGS)
    return read(client, `${base}/${encodeURIComponent(id(required(command, 5, 'action ID'), 'action ID'))}`, 'Profile action retrieved.')
  }
  if (action === 'create') {
    assertArity(command, 5); assertFlags(parsed, ACTION_INPUT_FLAGS)
    const input = await mergeInput(parsed, 'action')
    validateAction(input, true)
    return mutation(client, 'POST', base, base, parsed, 'action', input)
  }
  if (action === 'update') {
    assertArity(command, 6); assertFlags(parsed, ACTION_INPUT_FLAGS)
    const actionId = id(required(command, 5, 'action ID'), 'action ID')
    const input = await mergeInput(parsed, 'action')
    validateAction(input, false)
    return mutation(client, 'PATCH', `${base}/${encodeURIComponent(actionId)}`, `${base}/${encodeURIComponent(actionId)}`, parsed, 'patch', input)
  }
  if (action === 'delete') {
    assertArity(command, 6); assertFlags(parsed, MUTATION_FLAGS)
    const actionId = id(required(command, 5, 'action ID'), 'action ID')
    return mutation(client, 'DELETE', `${base}/${encodeURIComponent(actionId)}`, `${base}/${encodeURIComponent(actionId)}`, parsed, 'unused')
  }
  if (action === 'order') {
    assertFlags(parsed, MUTATION_FLAGS)
    const actionIds = command.slice(5).map((value) => id(value, 'action ID'))
    if (!actionIds.length) throw new Error('at least one action ID is required for order')
    return mutation(client, 'PUT', `${base}/order`, base, parsed, 'actionIds', actionIds)
  }
  throw new Error('Unknown profiles actions command')
}
