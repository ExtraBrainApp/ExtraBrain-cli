export const CliExitCode = {
  SUCCESS: 0,
  USAGE: 2,
  APP_NOT_RUNNING: 3,
  AUTHENTICATION: 4,
  CONFLICT: 5,
  PARTIAL_SUCCESS: 6,
  PROTECTED_STORAGE_UNAVAILABLE: 7,
  UNSUPPORTED: 8,
  FAILURE: 1
} as const

export type CliExitCodeType = (typeof CliExitCode)[keyof typeof CliExitCode]

export interface CliOutput {
  error: (message: string) => void
  write: (message: string) => void
}

export interface CliResult {
  code: CliExitCodeType
  data?: unknown
  message: string
}

export interface CredentialStore {
  clear: () => void
  read: () => { status: 'failed' | 'notFound' } | { status: 'found'; value: string }
  write: (credential: string) => void
}

export interface CliDependencies {
  apiFactory: (credential: string | null) => DocumentApiClient
  credentialStore: CredentialStore
  output: CliOutput
  resumeStore: ResumeStore
}

export interface ParsedArguments {
  command: string[]
  flags: Map<string, string | true>
  json: boolean
  paths: string[]
}
import type { DocumentApiClient } from './apiClient.service'
import type { ResumeStore } from './resumeStore.service'
