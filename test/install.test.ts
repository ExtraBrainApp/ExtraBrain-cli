import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DocumentApiClient } from '../src/apiClient.service'
import { ResumeStore } from '../src/resumeStore.service'
import { runCli } from '../src/run.service'

const directories: string[] = []
const version = 'v0.1.0'
const platform = 'darwin'
const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
const asset = `extrabrain-${version}-${platform}-${arch}.tar.gz`

const fixture = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'extrabrain-install-'))
  directories.push(directory)
  const release = join(directory, 'releases', 'download', version)
  const installDir = join(directory, 'bin')
  await mkdir(release, { recursive: true })
  const source = join(directory, 'extrabrain')
  const publish = async (contents: string, valid = true) => {
    await writeFile(source, contents)
    const tar = spawnSync('tar', ['-czf', join(release, asset), '-C', directory, 'extrabrain'])
    expect(tar.status).toBe(0)
    const actual = createHash('sha256').update(await readFile(join(release, asset))).digest('hex')
    await writeFile(join(release, 'SHA256SUMS'), `${valid ? actual : '0'.repeat(64)}  ${asset}\n`)
  }
  const install = (extraEnv: Record<string, string> = {}) =>
    spawnSync('sh', ['install.sh'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        EXTRABRAIN_RELEASE_BASE: `file://${join(directory, 'releases')}`,
        EXTRABRAIN_VERSION: version,
        EXTRABRAIN_INSTALL_DIR: installDir,
        ...extraEnv
      }
    })
  return { directory, installDir, install, publish }
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe.skipIf(process.platform !== 'darwin')('public shell installer', () => {
  it('installs and replaces a verified executable', async () => {
    const state = await fixture()
    await state.publish('first')
    expect(state.install().status).toBe(0)
    expect(await readFile(join(state.installDir, 'extrabrain'), 'utf8')).toBe('first')
    await state.publish('second')
    expect(state.install().status).toBe(0)
    expect(await readFile(join(state.installDir, 'extrabrain'), 'utf8')).toBe('second')
  })

  it('keeps the installed executable when a release is corrupt', async () => {
    const state = await fixture()
    await state.publish('original')
    expect(state.install().status).toBe(0)
    await state.publish('corrupt', false)
    const result = state.install()
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('checksum mismatch')
    expect(await readFile(join(state.installDir, 'extrabrain'), 'utf8')).toBe('original')
  })

  it('rejects unsupported platforms before downloading', async () => {
    const state = await fixture()
    const fakeBin = join(state.directory, 'fake-bin')
    await mkdir(fakeBin)
    const uname = join(fakeBin, 'uname')
    await writeFile(uname, '#!/bin/sh\necho Linux\n')
    await chmod(uname, 0o755)
    const result = state.install({ PATH: `${fakeBin}:${process.env.PATH ?? ''}` })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Unsupported operating system')
  })

  it('updates through the verified installer only on explicit request', async () => {
    const state = await fixture()
    await state.publish('#!/bin/sh\necho 0.1.0\n')
    expect(state.install().status).toBe(0)
    const target = join(state.installDir, 'extrabrain')
    expect(spawnSync(target, ['--version'], { encoding: 'utf8' }).stdout.trim()).toBe('0.1.0')
    await state.publish('#!/bin/sh\necho 0.1.1\n')
    const original = {
      base: process.env.EXTRABRAIN_RELEASE_BASE,
      version: process.env.EXTRABRAIN_VERSION,
      directory: process.env.EXTRABRAIN_INSTALL_DIR
    }
    try {
      process.env.EXTRABRAIN_RELEASE_BASE = `file://${join(state.directory, 'releases')}`
      process.env.EXTRABRAIN_VERSION = version
      process.env.EXTRABRAIN_INSTALL_DIR = state.installDir
      const output: string[] = []
      const dependencies = {
        apiFactory: () => ({
          discovery: async () => ({ apiVersion: 'v1', available: true, capabilities: { documentMetadata: true } }),
          json: async () => ({ documents: [] })
        }) as unknown as DocumentApiClient,
        credentialStore: {
          read: () => ({ status: 'found' as const, value: 'test-token' }),
          write: () => {}, clear: () => {}
        },
        output: { write: (value: string) => output.push(value), error: () => {} },
        resumeStore: new ResumeStore(join(state.directory, 'state'))
      }
      await expect(runCli(['documents', 'list'], dependencies)).resolves.toBe(0)
      expect(spawnSync(target, ['--version'], { encoding: 'utf8' }).stdout.trim()).toBe('0.1.0')
      await expect(runCli(['update'], dependencies)).resolves.toBe(0)
      expect(output.at(-1)).toBe('CLI updated.')
    } finally {
      if (original.base === undefined) delete process.env.EXTRABRAIN_RELEASE_BASE
      else process.env.EXTRABRAIN_RELEASE_BASE = original.base
      if (original.version === undefined) delete process.env.EXTRABRAIN_VERSION
      else process.env.EXTRABRAIN_VERSION = original.version
      if (original.directory === undefined) delete process.env.EXTRABRAIN_INSTALL_DIR
      else process.env.EXTRABRAIN_INSTALL_DIR = original.directory
    }
    expect(spawnSync(target, ['--version'], { encoding: 'utf8' }).stdout.trim()).toBe('0.1.1')
  })
})
