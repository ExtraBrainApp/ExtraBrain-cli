import { CliApiError } from './apiClient.service'
import type { SessionCapability } from './types'

export type DocumentCapability =
  | 'documentGroups'
  | 'documentImport'
  | 'documentMetadata'
  | 'extractedText'
  | 'indexedSearch'
  | 'originalExport'
  | 'revisionSafeDelete'

export type ProfileCapability =
  | 'profileRead'
  | 'profileWrite'
  | 'profileSelection'
  | 'profileActions'

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
  if (action === 'groups') return ['documentGroups']
  if (action === 'list') return ['documentMetadata']
  if (action === 'text') return ['extractedText']
  if (action === 'search') return ['indexedSearch']
  if (action === 'export') return ['originalExport']
  if (action === 'delete') return ['revisionSafeDelete']
  return []
}

export const requireSessionCapabilities = (
  discovery: Record<string, unknown>,
  required: readonly SessionCapability[]
): void => {
  if (discovery.apiVersion !== 'v1' || discovery.sessionApiVersion !== 'v1') {
    throw new CliApiError('UNSUPPORTED_API_VERSION', 'ExtraBrain session API v1 is required')
  }
  const capabilities = discovery.capabilities
  if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) {
    throw new CliApiError('UNSUPPORTED_CAPABILITY', 'ExtraBrain did not advertise session capabilities')
  }
  for (const capability of required) {
    if ((capabilities as Record<string, unknown>)[capability] !== true) {
      throw new CliApiError('UNSUPPORTED_CAPABILITY', `ExtraBrain does not support ${capability}`)
    }
  }
}

export const requiredProfileCapabilities = (command: readonly string[]): ProfileCapability[] => {
  const operation = command[1]
  if (operation === 'list' || operation === 'get') return ['profileRead']
  if (operation === 'selection') return ['profileSelection']
  if (operation === 'create' || operation === 'update' || operation === 'delete') return ['profileWrite']
  if (operation === 'pin' || operation === 'auto') return ['profileSelection']
  if (operation === 'actions') return ['profileActions']
  return []
}

export const requireProfileCapabilities = (
  discovery: Record<string, unknown>,
  required: readonly ProfileCapability[]
): void => {
  if (discovery.apiVersion !== 'v1' || discovery.profileApiVersion !== 'v1') {
    throw new CliApiError('UNSUPPORTED_API_VERSION', 'ExtraBrain profile API v1 is required')
  }
  const capabilities = discovery.capabilities
  if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) {
    throw new CliApiError('UNSUPPORTED_CAPABILITY', 'ExtraBrain did not advertise profile capabilities')
  }
  for (const capability of required) {
    if ((capabilities as Record<string, unknown>)[capability] !== true) {
      throw new CliApiError('UNSUPPORTED_CAPABILITY', `ExtraBrain does not support ${capability}`)
    }
  }
}
