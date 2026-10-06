import { spawn, spawnSync } from 'node:child_process'
import { dirname } from 'node:path'
import { isSea } from 'node:sea'
import installShell from '../install.sh?raw'
import installPowerShell from '../install.ps1?raw'
import { CliApiError } from './apiClient.service'

export const updateCli = (): { scheduled: boolean } => {
  if (process.platform === 'win32') {
    const encoded = Buffer.from(installPowerShell, 'utf16le').toString('base64')
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, EXTRABRAIN_WAIT_PID: String(process.pid) }
      }
    )
    child.unref()
    return { scheduled: true }
  }
  const result = spawnSync('sh', ['-s'], {
    encoding: 'utf8',
    input: installShell,
    env: {
      ...process.env,
      ...(isSea() && !process.env.EXTRABRAIN_INSTALL_DIR
        ? { EXTRABRAIN_INSTALL_DIR: dirname(process.execPath) }
        : {})
    },
    timeout: 120_000
  })
  if (result.error || result.status !== 0) {
    const detail = result.stderr?.trim() || result.error?.message || `Installer exited with status ${result.status}`
    throw new CliApiError('UPDATE_FAILED', `Verified CLI update failed: ${detail}`)
  }
  if (result.stderr) process.stderr.write(result.stderr)
  return { scheduled: false }
}
