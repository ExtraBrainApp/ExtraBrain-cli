import type { SpawnSyncOptionsWithStringEncoding } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { createCredentialStore } from '../src/credentialStore'

const platforms: NodeJS.Platform[] = ['darwin', 'linux', 'win32']

describe.each(platforms)('%s protected credential adapter', (platform) => {
  it('reads after writing without placing the credential in process arguments', () => {
    let stored = ''
    const calls: Array<{ command: string; args: string[] }> = []
    const runner = (command: string, args: string[], options: SpawnSyncOptionsWithStringEncoding) => {
      calls.push({ command, args })
      if (platform === 'darwin' && args[0] === 'add-generic-password') {
        stored = String(options.input ?? '').split('\n')[0]
      } else if (platform === 'linux' && args[0] === 'store') {
        stored = String(options.input ?? '')
      } else if (platform === 'win32' && options.input) {
        stored = String(options.input)
      }
      const isRead = platform === 'darwin'
        ? args[0] === 'find-generic-password'
        : platform === 'linux' ? args[0] === 'lookup' : !options.input
      return { status: 0, stdout: isRead ? stored : '', stderr: '' }
    }
    const store = createCredentialStore(platform, runner)
    store.write('private-test-token')
    expect(store.read()).toEqual({ status: 'found', value: 'private-test-token' })
    expect(JSON.stringify(calls)).not.toContain('private-test-token')
    expect(calls[0].command).toBe(platform === 'darwin' ? 'security' : platform === 'linux' ? 'secret-tool' : 'powershell.exe')
  })

  it('distinguishes a missing credential from unavailable protected storage', () => {
    const missingCode = platform === 'darwin' ? 44 : platform === 'linux' ? 1 : 2
    const missing = createCredentialStore(platform, () => ({ status: missingCode, stdout: '', stderr: '' }))
    expect(missing.read()).toEqual({ status: 'notFound' })
    const unavailable = createCredentialStore(platform, () => ({ status: null, stdout: '', stderr: 'unavailable' }))
    expect(unavailable.read()).toEqual({ status: 'failed' })
    expect(() => unavailable.write('private-test-token')).toThrow('Protected credential storage is unavailable')
  })
})
