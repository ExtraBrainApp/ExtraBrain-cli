import { createReadStream } from 'node:fs'
import { writeFile } from 'node:fs/promises'

export const resolveApiOrigin = (port = process.env.EXTRABRAIN_PORT): string => {
  if (port === undefined || port === '') return 'http://127.0.0.1:37373'
  if (!/^[1-9][0-9]{0,4}$/.test(port) || Number(port) > 65535) {
    throw new Error('EXTRABRAIN_PORT must be a number from 1 to 65535')
  }
  return `http://127.0.0.1:${port}`
}

interface ApiErrorBody {
  error?: {
    code?: string
    details?: Record<string, unknown>
    message?: string
    retryable?: boolean
  }
}

export class CliApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number | null = null,
    readonly details?: Record<string, unknown>
  ) {
    super(message)
    this.name = 'CliApiError'
  }
}

const parseResponse = async (response: Response): Promise<unknown> => {
  const text = await response.text()
  if (!text) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new CliApiError('INVALID_RESPONSE', 'ExtraBrain returned an invalid response')
  }
}

const isStructuredConflict = (
  response: Response,
  payload: unknown
): payload is Record<string, unknown> & { status: string } =>
  response.status === 409 &&
  Boolean(payload) &&
  typeof payload === 'object' &&
  !Array.isArray(payload) &&
  typeof (payload as { status?: unknown }).status === 'string'

const toFailedResponseError = async (response: Response): Promise<CliApiError> => {
  const parsed = await parseResponse(response)
  if (isStructuredConflict(response, parsed)) {
    const { status } = parsed
    return new CliApiError(
      status.toUpperCase(),
      `Import item was not accepted: ${status}`,
      response.status,
      parsed as Record<string, unknown>
    )
  }
  const payload = parsed as ApiErrorBody | null
  return new CliApiError(
    payload?.error?.code ?? `HTTP_${response.status}`,
    payload?.error?.message ?? `ExtraBrain request failed (${response.status})`,
    response.status,
    payload?.error?.details
  )
}

export class DocumentApiClient {
  constructor(
    private readonly credential: string | null,
    private readonly origin = resolveApiOrigin(),
    private readonly request: typeof fetch = fetch
  ) {}

  private async send(
    path: string,
    init: RequestInit = {},
    authenticated = false
  ): Promise<Response> {
    const headers = new Headers(init.headers)
    if (!headers.has('accept')) headers.set('accept', 'application/json')
    if (authenticated) {
      if (!this.credential) throw new CliApiError('PAIRING_REQUIRED', 'Pair the CLI first')
      headers.set('authorization', `Bearer ${this.credential}`)
    }
    try {
      const response = await this.request(`${this.origin}${path}`, {
        ...init,
        headers,
        redirect: 'error'
      })
      if (response.ok) return response
      throw await toFailedResponseError(response)
    } catch (error) {
      if (error instanceof CliApiError) throw error
      if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
        throw new CliApiError('REQUEST_TIMEOUT', 'ExtraBrain request timed out')
      }
      const codes: string[] = []
      const pending: unknown[] = [error]
      const seen = new Set<unknown>()
      while (pending.length && seen.size < 32) {
        const item = pending.shift()
        if (!item || typeof item !== 'object' || seen.has(item)) continue
        seen.add(item)
        const cause = item as { code?: unknown; cause?: unknown; errors?: unknown[] }
        if (typeof cause.code === 'string') codes.push(cause.code)
        pending.push(cause.cause)
        if (Array.isArray(cause.errors)) pending.push(...cause.errors.slice(0, 32))
      }
      const blocked = codes.some((code) => code === 'EPERM' || code === 'EACCES')
      const refused = codes.includes('ECONNREFUSED')
      const timedOut = codes.some((code) => ['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT'].includes(code))
      const code = blocked ? 'LOCAL_ACCESS_BLOCKED' : timedOut ? 'REQUEST_TIMEOUT' : refused ? 'CONNECTION_REFUSED' : 'CONNECTION_FAILED'
      const message = blocked
        ? 'Access to ExtraBrain on localhost was blocked. Allow this command to access the local service through your agent permission flow.'
        : timedOut
          ? 'The connection to ExtraBrain timed out.'
          : 'Could not reach ExtraBrain. Check that the app is running, CLI access is enabled in Settings > Agent Skills, and this command has permission to access localhost.'
      throw new CliApiError(code, message, null, { origin: this.origin, networkCodes: [...new Set(codes)] })
    }
  }

  async json(
    path: string,
    init: RequestInit = {},
    authenticated = false
  ): Promise<Record<string, unknown>> {
    const response = await this.send(path, init, authenticated)
    const payload = await parseResponse(response)
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new CliApiError('INVALID_RESPONSE', 'ExtraBrain returned an invalid response')
    }
    return payload as Record<string, unknown>
  }

  async discovery(): Promise<Record<string, unknown>> {
    const result = await this.json('/.well-known/extrabrain', { signal: AbortSignal.timeout(10_000) }, false)
    if (result.apiVersion === 'v1' && result.available === false) {
      throw new CliApiError('CLI_ACCESS_DISABLED', 'CLI access is disabled. Enable CLI access in ExtraBrain Settings > Agent Skills.')
    }
    return result
  }

  sessionAsset(sessionId: string, screenshotId: string, representation: string, snapshot: string): Promise<Response> {
    const query = new URLSearchParams({ representation, snapshot })
    return this.send(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/screenshots/${encodeURIComponent(screenshotId)}/image?${query}`,
      { method: 'GET', headers: { accept: 'image/*' }, signal: AbortSignal.timeout(30000) },
      false
    )
  }

  pair(input: {
    clientName: string
    clientVersion: string
    scopes: readonly string[]
  }): Promise<Record<string, unknown>> {
    return this.json(
      '/api/v1/pairing/requests',
      {
        body: JSON.stringify(input),
        headers: { 'content-type': 'application/json' },
        method: 'POST'
      },
      false
    )
  }

  async upload(itemId: string, path: string, size: number): Promise<Record<string, unknown>> {
    return this.json(`/api/v1/document-imports/items/${encodeURIComponent(itemId)}/content`, {
      body: createReadStream(path) as unknown as BodyInit,
      duplex: 'half',
      headers: {
        'content-length': String(size),
        'content-type': 'application/octet-stream'
      },
      method: 'PUT'
    } as RequestInit & { duplex: 'half' })
  }

  async exportOriginal(documentId: string, outputPath: string): Promise<void> {
    const response = await this.send(`/api/v1/documents/${encodeURIComponent(documentId)}/original`)
    await writeFile(outputPath, Buffer.from(await response.arrayBuffer()), {
      flag: 'wx',
      mode: 0o600
    })
  }
}
