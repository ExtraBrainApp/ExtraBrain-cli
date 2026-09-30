import type { DocumentApiClient } from './apiClient.service'

export const requestJson = (
  client: DocumentApiClient,
  path: string,
  method = 'GET',
  body?: unknown,
  headers?: HeadersInit
): Promise<Record<string, unknown>> =>
  client.json(path, {
    method,
    ...(body === undefined
      ? {}
      : {
          body: JSON.stringify(body),
          headers: { 'content-type': 'application/json', ...headers }
        }),
    ...(body === undefined && headers ? { headers } : {})
  })
