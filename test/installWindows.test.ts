import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const directories: string[] = []
const servers: Array<ReturnType<typeof createServer>> = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
})

describe.skipIf(process.platform !== 'win32')('public Windows installer', () => {
  it('installs and reinstalls, and preserves the prior executable on checksum failure', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'extrabrain-windows-install-'))
    directories.push(directory)
    const installDir = join(directory, 'bin')
    const source = join(directory, 'extrabrain.exe')
    const asset = 'extrabrain-v0.1.0-win32-x64.zip'
    const archive = join(directory, asset)
    let checksum = ''
    const publish = async (content: string, valid = true) => {
      await writeFile(source, content)
      const zip = spawnSync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        `Compress-Archive -LiteralPath '${source}' -DestinationPath '${archive}' -Force`
      ])
      expect(zip.status).toBe(0)
      checksum = valid
        ? createHash('sha256').update(await readFile(archive)).digest('hex')
        : '0'.repeat(64)
    }
    const server = createServer((request, response) => {
      if (request.url?.endsWith('/SHA256SUMS')) {
        response.end(`${checksum}  ${asset}\n`)
      } else if (request.url?.endsWith(`/${asset}`)) {
        createReadStream(archive).pipe(response)
      } else {
        response.writeHead(404).end()
      }
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Fixture address is invalid')
    const install = () => new Promise<{ code: number | null; stderr: string }>((resolve) => {
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', 'install.ps1'], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          EXTRABRAIN_RELEASE_BASE: `http://127.0.0.1:${address.port}/releases`,
          EXTRABRAIN_VERSION: 'v0.1.0',
          EXTRABRAIN_INSTALL_DIR: installDir
        }
      })
      let stderr = ''
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
      child.on('close', (code) => resolve({ code, stderr }))
    })

    await publish('first')
    const first = await install()
    if (first.code !== 0) throw new Error(first.stderr)
    expect(await readFile(join(installDir, 'extrabrain.exe'), 'utf8')).toBe('first')
    await publish('second')
    const second = await install()
    if (second.code !== 0) throw new Error(second.stderr)
    expect(await readFile(join(installDir, 'extrabrain.exe'), 'utf8')).toBe('second')
    await publish('corrupt', false)
    const failed = await install()
    expect(failed.code).not.toBe(0)
    expect(failed.stderr).toContain('Release checksum mismatch')
    expect(await readFile(join(installDir, 'extrabrain.exe'), 'utf8')).toBe('second')
  }, 30_000)
})
