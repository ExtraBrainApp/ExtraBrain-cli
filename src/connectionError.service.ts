const MAX_VISITED_ERRORS = 32
const BLOCKED_NETWORK_CODES = new Set(['EPERM', 'EACCES'])
const TIMEOUT_NETWORK_CODES = new Set(['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT'])
const UNREACHABLE_MESSAGE =
  'Could not connect to ExtraBrain. Make sure the app is open and CLI access is on in Settings > Agent Skills.'

export const REQUEST_TIMEOUT_MESSAGE = 'ExtraBrain took too long to respond.'

/** Every CLI error code that means the local app could not be used, all reported as exit 3. */
export const CONNECTION_ERROR_CODES: ReadonlySet<string> = new Set([
  'APP_NOT_RUNNING',
  'CLI_ACCESS_DISABLED',
  'LOCAL_ACCESS_BLOCKED',
  'CONNECTION_REFUSED',
  'CONNECTION_FAILED',
  'REQUEST_TIMEOUT'
])

interface ErrorNode {
  code?: unknown
  cause?: unknown
  errors?: unknown
}

export interface ConnectionFailure {
  code: string
  message: string
}

/**
 * Collects the distinct network codes from an error, its causes, and aggregated
 * errors. `fetch` nests the real failure, and the walk is bounded because the
 * error graph is untrusted and can be cyclic.
 */
export const collectNetworkCodes = (error: unknown): string[] => {
  const codes = new Set<string>()
  const visited = new Set<object>()
  const pending: unknown[] = [error]
  while (pending.length > 0 && visited.size < MAX_VISITED_ERRORS) {
    const item = pending.shift()
    if (!item || typeof item !== 'object' || visited.has(item)) continue
    visited.add(item)
    const { code, cause, errors } = item as ErrorNode
    if (typeof code === 'string') codes.add(code)
    pending.push(cause)
    if (Array.isArray(errors)) pending.push(...errors.slice(0, MAX_VISITED_ERRORS))
  }
  return [...codes]
}

/** Maps network codes to a CLI error. A permission block wins over any other code. */
export const describeConnectionFailure = (networkCodes: string[]): ConnectionFailure => {
  if (networkCodes.some((code) => BLOCKED_NETWORK_CODES.has(code))) {
    return {
      code: 'LOCAL_ACCESS_BLOCKED',
      message:
        'This command was blocked from connecting to ExtraBrain. If an AI assistant ran it, allow the connection when asked, then try again.'
    }
  }
  if (networkCodes.some((code) => TIMEOUT_NETWORK_CODES.has(code))) {
    return { code: 'REQUEST_TIMEOUT', message: REQUEST_TIMEOUT_MESSAGE }
  }
  if (networkCodes.includes('ECONNREFUSED')) {
    return { code: 'CONNECTION_REFUSED', message: UNREACHABLE_MESSAGE }
  }
  return { code: 'CONNECTION_FAILED', message: UNREACHABLE_MESSAGE }
}
