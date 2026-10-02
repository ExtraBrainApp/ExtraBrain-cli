import { CliApiError, type DocumentApiClient } from './apiClient.service'
import { requireSessionCapabilities } from './protocol'
import { SESSION_COLLECTIONS, SessionDataService, type SessionCollection } from './sessionData.service'
import { SessionExportService } from './sessionExport.service'
import { CliExitCode, type CliResult, type ParsedArguments, type SessionCapability } from './types'

interface SessionRequest {
  action: 'list' | 'search' | 'current' | 'get' | 'collection' | 'content' | 'analyses-list' | 'analyses-get' | 'session-export' | 'analysis-export' | 'screenshot-export'
  capabilities: SessionCapability[]
  sessionId?: string
  analysisId?: string
  collection?: SessionCollection
  query?: string
  output?: string
  representation?: string
  options: { limit?: number; cursor?: string; since?: number; until?: number; snapshot?: string; offset?: number; maxChars?: number }
}

const usage = (message: string): never => { throw new Error(message) }
const exact = (words: string[], expected: number): void => {
  if (words.length !== expected || words.some((word) => !word)) usage('Invalid sessions command arguments')
}
const numberFlag = (value: string | true | undefined, name: string, min: number, max: number): number | undefined => {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) usage(`--${name} must be an integer`)
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < min || number > max) usage(`--${name} must be between ${min} and ${max}`)
  return number
}
const valueFlag = (value: string | true | undefined, name: string): string | undefined => {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !value) usage(`--${name} requires a value`)
  return value as string
}

export const parseSessionCommand = (parsed: ParsedArguments): SessionRequest => {
  const [, noun, ...rest] = parsed.command
  if (parsed.paths.length) usage('Unexpected arguments after --')
  let action: SessionRequest['action'] | undefined
  let capabilities: SessionCapability[] = []
  let allowed: string[] = []
  let arity = 0
  let sessionId: string | undefined
  let analysisId: string | undefined
  let collection: SessionCollection | undefined
  let query: string | undefined
  let output: string | undefined
  let representation: string | undefined
  if (noun === 'list' || noun === 'search') {
    action = noun
    capabilities = [noun === 'list' ? 'sessionMetadata' : 'sessionSearch']
    allowed = ['limit', 'cursor', 'since', 'until']
    arity = noun === 'search' ? 1 : 0
    exact(rest, arity)
    query = rest[0]
  } else if (noun === 'current') {
    action = 'current'; capabilities = ['sessionCurrent']; exact(rest, 0)
  } else if (noun === 'get') {
    action = 'get'; capabilities = ['sessionMetadata']; exact(rest, 1); sessionId = rest[0]
  } else if (noun === 'content') {
    action = 'content'; capabilities = ['sessionData']; allowed = ['snapshot', 'offset', 'max-chars']; exact(rest, 2); sessionId = rest[0]; query = rest[1]
  } else if (SESSION_COLLECTIONS.includes(noun as SessionCollection)) {
    action = 'collection'; capabilities = ['sessionData']; allowed = ['limit', 'cursor']; exact(rest, 1); sessionId = rest[0]; collection = noun as SessionCollection
  } else if (noun === 'analyses') {
    const [verb, ...args] = rest
    if (verb === 'list') {
      action = 'analyses-list'; capabilities = ['analysisData']; allowed = ['limit', 'cursor']; exact(args, 1); sessionId = args[0]
    } else if (verb === 'get') {
      action = 'analyses-get'; capabilities = ['analysisData']; exact(args, 2); sessionId = args[0]; analysisId = args[1]
    } else if (verb === 'export') {
      action = 'analysis-export'; capabilities = ['analysisData', 'screenshotExport']; allowed = ['output']; exact(args, 2); sessionId = args[0]; analysisId = args[1]
    } else usage('Unknown sessions analyses command')
  } else if (noun === 'export') {
    action = 'session-export'; capabilities = ['sessionMetadata', 'sessionData', 'analysisData', 'screenshotExport']; allowed = ['output']; exact(rest, 1); sessionId = rest[0]
  } else if (noun === 'screenshot') {
    const [verb, ...args] = rest
    if (verb !== 'export') usage('Unknown sessions screenshot command')
    action = 'screenshot-export'; capabilities = ['sessionMetadata', 'sessionData', 'screenshotExport']; allowed = ['output', 'representation']; exact(args, 2); sessionId = args[0]; analysisId = args[1]
  } else usage('Unknown sessions command')
  if (!action) usage('Unknown sessions command')
  for (const key of parsed.flags.keys()) {
    if (key !== 'json' && !allowed.includes(key)) usage(`--${key} is not supported by this sessions command`)
  }
  const options = {
    limit: numberFlag(parsed.flags.get('limit'), 'limit', 1, 200),
    cursor: valueFlag(parsed.flags.get('cursor'), 'cursor'),
    since: numberFlag(parsed.flags.get('since'), 'since', 0, Number.MAX_SAFE_INTEGER),
    until: numberFlag(parsed.flags.get('until'), 'until', 0, Number.MAX_SAFE_INTEGER),
    snapshot: valueFlag(parsed.flags.get('snapshot'), 'snapshot'),
    offset: numberFlag(parsed.flags.get('offset'), 'offset', 0, Number.MAX_SAFE_INTEGER),
    maxChars: numberFlag(parsed.flags.get('max-chars'), 'max-chars', 1, 100000)
  }
  if (options.since !== undefined && options.until !== undefined && options.since > options.until) usage('--since must be at or before --until')
  if (action === 'content' && !options.snapshot) usage('--snapshot is required')
  if (action === 'session-export' || action === 'analysis-export' || action === 'screenshot-export') {
    output = valueFlag(parsed.flags.get('output'), 'output')
    if (!output) usage('--output is required')
    representation = valueFlag(parsed.flags.get('representation'), 'representation')
  }
  return { action: action as SessionRequest['action'], capabilities, sessionId, analysisId, collection, query, output, representation, options }
}

const messageFor = (request: SessionRequest, data: Record<string, unknown>): string => {
  if (request.action === 'current') return data.activeSessionId === null ? 'No active session.' : `Active session: ${data.activeSessionId}`
  if (request.action === 'session-export' || request.action === 'analysis-export') return `Export complete at ${request.output}; snapshot ${data.snapshot}; retrieval complete.`
  if (request.action === 'screenshot-export') return `Screenshot ${data.screenshotId} exported to ${request.output}; ${data.representation}, ${data.byteLength} bytes.`
  if ('items' in data) return `${request.action}: ${(data.items as unknown[]).length}/${data.totalCount} records; snapshot ${data.snapshot}; next cursor ${data.nextCursor ?? 'none'}.`
  if (request.action === 'analyses-get') {
    const provenance = data.provenance as Record<string, unknown>
    return `Analysis ${request.analysisId}: retrieval complete; provenance ${provenance.status}; missing ${JSON.stringify(provenance.missing)}.`
  }
  if (request.action === 'content') return `Content ${data.contentId}: offset ${data.offset}, next ${data.nextOffset ?? 'none'}, total ${data.totalChars}.`
  return `Session ${request.sessionId}: snapshot ${data.snapshot}; ${JSON.stringify(data.counts ?? {})}.`
}

export const executeSessionCommand = async (request: SessionRequest, client: DocumentApiClient): Promise<CliResult> => {
  requireSessionCapabilities(await client.discovery(), request.capabilities)
  const service = new SessionDataService(client)
  const { action, options, sessionId, analysisId } = request
  let data: Record<string, unknown>
  if (action === 'session-export') data = await new SessionExportService(client).exportSession(request.output!, sessionId!)
  else if (action === 'analysis-export') data = await new SessionExportService(client).exportAnalysis(request.output!, sessionId!, analysisId!)
  else if (action === 'screenshot-export') data = await new SessionExportService(client).exportScreenshot(request.output!, sessionId!, analysisId!, request.representation)
  else if (action === 'list') data = await service.list(options)
  else if (action === 'search') data = await service.search(request.query!, options)
  else if (action === 'current') data = await service.current()
  else if (action === 'get') data = await service.get(sessionId!)
  else if (action === 'collection') data = await service.collection(sessionId!, request.collection!, options)
  else if (action === 'content') data = await service.content(sessionId!, request.query!, options.snapshot!, options.offset, options.maxChars)
  else if (action === 'analyses-list') data = await service.analyses(sessionId!, options)
  else if (action === 'analyses-get') data = await service.getAnalysis(sessionId!, analysisId!)
  else throw new CliApiError('INVALID_COMMAND', 'Unknown session action')
  return { code: CliExitCode.SUCCESS, data, message: messageFor(request, data) }
}
