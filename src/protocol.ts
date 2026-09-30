import { CliApiError } from './apiClient.service'

export type DocumentCapability =
  | 'documentGroups'
  | 'documentImport'
  | 'documentMetadata'
  | 'extractedText'
  | 'indexedSearch'
  | 'originalExport'
  | 'revisionSafeDelete'

export const requireCapabilities = (
  discovery: Record<string, unknown>,
  required: readonly DocumentCapability[]
): void => {
  if (discovery.apiVersion !== 'v1') {
    throw new CliApiError('UNSUPPORTED_API_VERSION', 'ExtraBrain API version is unsupported')
  }
  if (discovery.available !== true) {
    throw new CliApiError('UNSUPPORTED_CAPABILITY', 'ExtraBrain document API is unavailable')
  }
  const capabilities = discovery.capabilities
  if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) {
    throw new CliApiError('UNSUPPORTED_CAPABILITY', 'ExtraBrain did not advertise document capabilities')
  }
  for (const capability of required) {
    if ((capabilities as Record<string, unknown>)[capability] !== true) {
      throw new CliApiError('UNSUPPORTED_CAPABILITY', `ExtraBrain does not support ${capability}`)
    }
  }
}

export const requiredDocumentCapabilities = (action: string | undefined): DocumentCapability[] => {
  if (action === 'import' || action === 'resume' || action === 'status') return ['documentImport']
  if (action === 'list') return ['documentMetadata']
  if (action === 'text') return ['extractedText']
  if (action === 'search') return ['indexedSearch']
  if (action === 'export') return ['originalExport']
  if (action === 'delete') return ['revisionSafeDelete']
  return []
}
