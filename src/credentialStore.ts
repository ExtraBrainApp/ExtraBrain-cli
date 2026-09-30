import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from 'node:child_process'
import type { CredentialStore } from './types'

const SERVICE = 'ExtraBrain standalone CLI document automation'
const ACCOUNT = 'local-api'
const WINDOWS_SCRIPT = `
$ErrorActionPreference = 'Stop'
$path = Join-Path $env:LOCALAPPDATA 'ExtraBrain\\cli-credential.dat'
try {
  if ($env:EXTRABRAIN_CLI_CREDENTIAL_ACTION -eq 'read') {
    if (-not (Test-Path -LiteralPath $path)) { exit 2 }
    $bytes = [IO.File]::ReadAllBytes($path)
    $secret = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    [Console]::Out.Write([Text.Encoding]::UTF8.GetString($secret))
  } elseif ($env:EXTRABRAIN_CLI_CREDENTIAL_ACTION -eq 'write') {
    $secret = [Console]::In.ReadToEnd()
    $bytes = [Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($secret), $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    $directory = Split-Path -Parent $path
    [IO.Directory]::CreateDirectory($directory) | Out-Null
    $temporary = "$path.$PID.tmp"
    [IO.File]::WriteAllBytes($temporary, $bytes)
    Move-Item -LiteralPath $temporary -Destination $path -Force
  } elseif ($env:EXTRABRAIN_CLI_CREDENTIAL_ACTION -eq 'clear') {
    Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
  }
} catch { exit 1 }
`

interface CommandResult {
  status: number | null
  stdout: string
  stderr: string
}

type CommandRunner = (
  command: string,
  args: string[],
  options: SpawnSyncOptionsWithStringEncoding
) => { error?: Error; status: number | null; stdout: string; stderr: string }

const execute = (
  operation: 'read' | 'write' | 'clear',
  platform: NodeJS.Platform,
  runner: CommandRunner,
  value?: string
): CommandResult => {
  const options = { encoding: 'utf8' as const, input: value, timeout: 10_000 }
  if (platform === 'darwin') {
    const common = ['-a', ACCOUNT, '-s', SERVICE]
    const args =
      operation === 'read'
        ? ['find-generic-password', ...common, '-w']
        : operation === 'write'
          ? ['add-generic-password', ...common, '-U', '-w']
          : ['delete-generic-password', ...common]
    const result = runner('security', args, {
      ...options,
      input: operation === 'write' ? `${value}\n${value}\n` : undefined
    })
    return { status: result.error ? null : result.status, stdout: result.stdout, stderr: result.stderr }
  }
  if (platform === 'linux') {
    const attributes = ['service', SERVICE, 'account', ACCOUNT]
    const args =
      operation === 'write'
        ? ['store', '--label', SERVICE, ...attributes]
        : [operation === 'read' ? 'lookup' : 'clear', ...attributes]
    const result = runner('secret-tool', args, options)
    return { status: result.error ? null : result.status, stdout: result.stdout, stderr: result.stderr }
  }
  if (platform === 'win32') {
    const encoded = Buffer.from(WINDOWS_SCRIPT, 'utf16le').toString('base64')
    const result = runner(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { ...options, env: { ...process.env, EXTRABRAIN_CLI_CREDENTIAL_ACTION: operation } }
    )
    return { status: result.error ? null : result.status, stdout: result.stdout, stderr: result.stderr }
  }
  return { status: null, stdout: '', stderr: '' }
}

export const createCredentialStore = (
  platform: NodeJS.Platform = process.platform,
  runner: CommandRunner = spawnSync
): CredentialStore => ({
  read: () => {
    const result = execute('read', platform, runner)
    if (result.status === 0 && result.stdout.trim()) {
      return { status: 'found', value: result.stdout.trimEnd() }
    }
    if (platform === 'darwin' && result.status === 44) return { status: 'notFound' }
    if (platform === 'linux' && result.status === 1 && !result.stderr.trim()) {
      return { status: 'notFound' }
    }
    if (platform === 'win32' && result.status === 2) return { status: 'notFound' }
    return { status: 'failed' }
  },
  write: (value) => {
    if (execute('write', platform, runner, value).status !== 0) {
      throw new Error('Protected credential storage is unavailable')
    }
  },
  clear: () => {
    const result = execute('clear', platform, runner)
    if (result.status !== 0 && result.status !== 1 && result.status !== 44) {
      throw new Error('Protected credential storage is unavailable')
    }
  }
})

export const credentialStore = createCredentialStore()
