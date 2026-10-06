import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { DocumentApiClient } from '../src/apiClient.service'
import { ResumeStore } from '../src/resumeStore.service'
import { runCli } from '../src/run.service'

const directories: string[] = []
const version = 'v0.1.0'
const platform = 'darwin'
const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
const asset = `extrabrain-${version}-${platform}-${arch}.tar.gz`

const fixture = async (prefix = 'extrabrain-install-') => {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  directories.push(directory)
  const release = join(directory, 'releases', 'download', version)
  const installDir = join(directory, 'bin')
  const releaseBase = pathToFileURL(join(directory, 'releases')).href
  await mkdir(release, { recursive: true })
  const source = join(directory, 'extrabrain')
  const publish = async (contents: string | Uint8Array, valid = true) => {
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
        PATH: `${installDir}:${process.env.PATH ?? ''}`,
        EXTRABRAIN_RELEASE_BASE: releaseBase,
        EXTRABRAIN_VERSION: version,
        EXTRABRAIN_INSTALL_DIR: installDir,
        ...extraEnv
      }
    })
  const userEnv = {
    ...process.env,
    HOME: directory,
    ZDOTDIR: directory,
    BASH_ENV: '',
    SHELL: '/bin/zsh',
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    EXTRABRAIN_RELEASE_BASE: releaseBase,
    EXTRABRAIN_VERSION: version,
    EXTRABRAIN_INSTALL_DIR: '',
    EXTRABRAIN_NO_MODIFY_PATH: '0'
  }
  const installForUser = (extraEnv: Record<string, string> = {}) => spawnSync('bash', ['-c', 'cat install.sh | bash'], {
    encoding: 'utf8',
    env: { ...userEnv, ...extraEnv }
  })
  return { directory, installDir, install, publish, releaseBase, userEnv, installForUser }
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

  it('is immediately available by name after piped installation into a directory on PATH', async () => {
    const state = await fixture()
    await state.publish('#!/bin/sh\necho 0.1.0\n')
    const result = spawnSync('sh', ['-c', 'cat install.sh | sh && extrabrain --version'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${state.installDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
        EXTRABRAIN_RELEASE_BASE: state.releaseBase,
        EXTRABRAIN_VERSION: version,
        EXTRABRAIN_INSTALL_DIR: state.installDir
      }
    })
    expect(result.status).toBe(0)
    expect(result.stdout.trim().split('\n').at(-1)).toBe('0.1.0')
    expect(result.stderr).toBe('')
    expect((await stat(join(state.installDir, 'extrabrain'))).mode & 0o777).toBe(0o755)
  })

  it.skipIf(process.getuid?.() === 0)('elevates only installation operations for an explicit system destination', async () => {
    const state = await fixture()
    await state.publish('#!/bin/sh\necho 0.1.0\n')
    const fakeBin = join(state.directory, 'fake-bin')
    await mkdir(fakeBin)
    const log = join(state.directory, 'privileged-commands')
    const sudo = join(fakeBin, 'sudo')
    await writeFile(sudo, `#!/bin/sh
[ "$1" = -n ] || exit 1
shift
[ "$1" != -v ] || exit 0
printf '%s\\n' "$*" >> "$EXTRABRAIN_TEST_PRIVILEGE_LOG"
if [ "$1" = /usr/bin/install ]; then
  shift
  [ "$1" = -o ] && [ "$2" = root ] && [ "$3" = -g ] && [ "$4" = wheel ] || exit 1
  shift 4
  exec /usr/bin/install "$@"
fi
exec "$@"
`)
    await chmod(sudo, 0o755)
    // Relocate only the system directory constant so this test never changes the host installation.
    const installer = join(state.directory, 'install.sh')
    await writeFile(installer, (await readFile('install.sh', 'utf8')).replaceAll('/usr/local/bin', state.installDir))
    const result = spawnSync('sh', ['-c', 'cat "$1" | sh && extrabrain --version', 'sh', installer], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: state.directory,
        PATH: `${state.installDir}:${fakeBin}:/usr/bin:/bin`,
        EXTRABRAIN_RELEASE_BASE: state.releaseBase,
        EXTRABRAIN_VERSION: version,
        EXTRABRAIN_INSTALL_DIR: state.installDir,
        EXTRABRAIN_TEST_PRIVILEGE_LOG: log
      }
    })
    expect(result.status).toBe(0)
    expect(result.stdout.trim().split('\n').at(-1)).toBe('0.1.0')
    const commands = (await readFile(log, 'utf8')).trim().split('\n')
    expect(commands.map((line) => line.split(' ')[0])).toEqual(['/bin/mkdir', '/usr/bin/mktemp', '/usr/bin/install', '/bin/mv'])
    expect(commands[2]).toContain('-o root -g wheel -m 755')
    expect(result.stderr).toContain(`Administrator access is required to install at ${state.installDir}`)
    await expect(stat(join(state.directory, '.local/bin/extrabrain'))).rejects.toThrow()
  })

  it('explains when a custom destination is outside PATH', async () => {
    const state = await fixture()
    await state.publish('#!/bin/sh\necho 0.1.0\n')
    const result = state.install({ PATH: '/usr/bin:/bin:/usr/sbin:/sbin' })
    expect(result.status).toBe(0)
    expect(result.stderr).toContain('not on this terminal\'s PATH')
    expect(result.stderr).toContain(state.installDir)
  })

  it('identifies an older executable that shadows the installation', async () => {
    const state = await fixture()
    await state.publish('#!/bin/sh\necho 0.1.0\n')
    const oldBin = join(state.directory, 'old-bin')
    await mkdir(oldBin)
    const oldExecutable = join(oldBin, 'extrabrain')
    await writeFile(oldExecutable, '#!/bin/sh\necho old\n')
    await chmod(oldExecutable, 0o755)
    const result = state.install({ PATH: `${oldBin}:${state.installDir}:/usr/bin:/bin` })
    expect(result.status).toBe(0)
    expect(result.stderr).toContain(`PATH currently resolves extrabrain to ${oldExecutable}`)
    expect(await readFile(oldExecutable, 'utf8')).toContain('echo old')
  })

  it.skipIf(process.getuid?.() === 0)('requires administrator access for an explicit system destination without a user-local fallback', async () => {
    const state = await fixture()
    await state.publish('#!/bin/sh\necho 0.1.0\n')
    const fakeBin = join(state.directory, 'fake-bin')
    await mkdir(fakeBin)
    const sudo = join(fakeBin, 'sudo')
    await writeFile(sudo, '#!/bin/sh\necho "Authorization denied" >&2\nexit 1\n')
    await chmod(sudo, 0o755)
    const result = await new Promise<{ status: number | null; stderr: string }>((resolve, reject) => {
      const child = spawn('sh', ['-c', 'cat install.sh | sh'], {
        detached: true,
        env: {
          ...process.env,
          HOME: state.directory,
          PATH: `${fakeBin}:/usr/bin:/bin:/usr/sbin:/sbin`,
          EXTRABRAIN_RELEASE_BASE: state.releaseBase,
          EXTRABRAIN_VERSION: version,
          EXTRABRAIN_INSTALL_DIR: '/usr/local/bin'
        },
        stdio: ['ignore', 'ignore', 'pipe']
      })
      let stderr = ''
      child.stderr!.on('data', (chunk) => { stderr += chunk.toString() })
      child.on('error', reject)
      child.on('close', (status) => resolve({ status, stderr }))
    })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Administrator access is required to install at /usr/local/bin')
    expect(result.stderr).toContain('No terminal is available for administrator authentication')
    await expect(stat(join(state.directory, '.local/bin/extrabrain'))).rejects.toThrow()
  })

  it.skipIf(process.getuid?.() === 0)('preserves an installed executable when authorization for an unwritable destination fails', async () => {
    const state = await fixture()
    await state.publish('original')
    expect(state.install().status).toBe(0)
    await state.publish('replacement')
    const fakeBin = join(state.directory, 'fake-bin')
    await mkdir(fakeBin)
    await writeFile(join(fakeBin, 'sudo'), '#!/bin/sh\nexit 1\n')
    await chmod(join(fakeBin, 'sudo'), 0o755)
    await chmod(state.installDir, 0o555)
    try {
      const result = state.install({ PATH: `${fakeBin}:/usr/bin:/bin` })
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('Administrator access is required')
      expect(await readFile(join(state.installDir, 'extrabrain'), 'utf8')).toBe('original')
    } finally {
      await chmod(state.installDir, 0o755)
    }
  })

  it('supports a custom installation directory containing spaces', async () => {
    const state = await fixture()
    await state.publish('#!/bin/sh\necho 0.1.0\n')
    const installDir = join(state.directory, 'custom bin')
    const result = state.install({ EXTRABRAIN_INSTALL_DIR: installDir, PATH: `${installDir}:/usr/bin:/bin` })
    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
    expect(spawnSync(join(installDir, 'extrabrain'), ['--version'], { encoding: 'utf8' }).stdout.trim()).toBe('0.1.0')
  })

  it('refuses a symlink destination without changing the linked executable', async () => {
    const state = await fixture()
    await state.publish('replacement')
    await mkdir(state.installDir)
    const oldExecutable = join(state.directory, 'old-extrabrain')
    await writeFile(oldExecutable, 'original')
    await symlink(oldExecutable, join(state.installDir, 'extrabrain'))
    const result = state.install()
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Refusing to replace a symlink')
    expect(await readFile(oldExecutable, 'utf8')).toBe('original')
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

  it.skipIf(process.getuid?.() === 0)('installs for the current user without sudo and makes the command available in a new zsh terminal', async () => {
    const state = await fixture()
    await state.publish('#!/bin/sh\necho 0.1.0\n')
    const fakeBin = join(state.directory, 'fake-bin')
    await mkdir(fakeBin)
    await writeFile(join(fakeBin, 'sudo'), '#!/bin/sh\necho "Unexpected administrator request" >&2\nexit 1\n')
    await chmod(join(fakeBin, 'sudo'), 0o755)
    const installed = state.installForUser({ PATH: `${fakeBin}:${state.userEnv.PATH}` })
    expect(installed.status).toBe(0)
    expect(installed.stderr).toBe('')
    expect(installed.stdout).toContain('Open a new terminal')
    const target = join(state.directory, '.local/bin/extrabrain')
    expect((await stat(target)).uid).toBe(process.getuid!())
    expect((await stat(target)).mode & 0o777).toBe(0o755)
    for (const mode of ['-lc', '-ic']) {
      const versionCheck = spawnSync('/bin/zsh', [mode, 'extrabrain --version'], { encoding: 'utf8', env: state.userEnv })
      expect(versionCheck.status).toBe(0)
      expect(versionCheck.stdout.trim()).toBe('0.1.0')
    }
  })

  it('preserves zsh configuration and avoids duplicate PATH blocks on reinstall', async () => {
    const state = await fixture()
    await state.publish('#!/bin/sh\necho 0.1.0\n')
    const existing = 'export EXTRABRAIN_PROFILE_TEST=preserved\n'
    await writeFile(join(state.directory, '.zshrc'), existing)
    expect(state.installForUser().status).toBe(0)
    const first = await readFile(join(state.directory, '.zshrc'), 'utf8')
    expect(first.startsWith(existing)).toBe(true)
    expect(state.installForUser().status).toBe(0)
    expect(await readFile(join(state.directory, '.zshrc'), 'utf8')).toBe(first)
    const result = spawnSync('/bin/zsh', ['-lic', 'printf "%s\\n%s" "$EXTRABRAIN_PROFILE_TEST" "$PATH"'], {
      encoding: 'utf8', env: state.userEnv
    })
    expect(result.status).toBe(0)
    const [preserved, path] = result.stdout.split('\n')
    expect(preserved).toBe('preserved')
    expect(path.split(':').filter((entry) => entry === join(state.directory, '.local/bin'))).toHaveLength(1)
  })

  for (const loginProfile of ['.bash_profile', '.bash_login', '.profile']) {
    it(`configures bash while preserving the existing ${loginProfile} login file`, async () => {
      const state = await fixture()
      await state.publish('#!/bin/sh\necho 0.1.0\n')
      const existing = 'export EXTRABRAIN_PROFILE_TEST=preserved\n'
      await writeFile(join(state.directory, loginProfile), existing)
      expect(state.installForUser({ SHELL: '/bin/bash' }).status).toBe(0)
      expect((await readFile(join(state.directory, loginProfile), 'utf8')).startsWith(existing)).toBe(true)
      if (loginProfile !== '.bash_profile') await expect(stat(join(state.directory, '.bash_profile'))).rejects.toThrow()
      for (const mode of ['-lc', '-ic']) {
        const result = spawnSync('/bin/bash', [mode, 'extrabrain --version'], { encoding: 'utf8', env: state.userEnv })
        expect(result.status).toBe(0)
        expect(result.stdout.trim()).toBe('0.1.0')
      }
    })
  }

  it('respects a custom ZDOTDIR and supports home directories with spaces', async () => {
    const state = await fixture('extrabrain-install with spaces-')
    await state.publish('#!/bin/sh\necho 0.1.0\n')
    const shellDirectory = join(state.directory, 'dotfiles')
    const installed = state.installForUser({ ZDOTDIR: shellDirectory })
    expect(installed.status).toBe(0)
    expect(installed.stderr).toBe('')
    await expect(stat(join(state.directory, '.zshrc'))).rejects.toThrow()
    const result = spawnSync('/bin/zsh', ['-lc', 'extrabrain --version'], {
      encoding: 'utf8', env: { ...state.userEnv, ZDOTDIR: shellDirectory }
    })
    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe('0.1.0')
  })

  it('allows opting out of shell modifications and reports unsupported shells', async () => {
    const state = await fixture()
    await state.publish('#!/bin/sh\necho 0.1.0\n')
    const optedOut = state.installForUser({ EXTRABRAIN_NO_MODIFY_PATH: '1' })
    expect(optedOut.status).toBe(0)
    expect(optedOut.stderr).toContain('not on this terminal\'s PATH')
    await expect(stat(join(state.directory, '.zshrc'))).rejects.toThrow()
    const unsupported = state.installForUser({ SHELL: '/usr/local/bin/fish' })
    expect(unsupported.status).toBe(0)
    expect(unsupported.stderr).toContain('automatic PATH setup supports zsh and bash')
    await expect(stat(join(state.directory, '.zshrc'))).rejects.toThrow()
  })

  it.skipIf(process.getuid?.() === 0)('reports unwritable profiles without altering their contents or requesting sudo', async () => {
    const state = await fixture()
    await state.publish('#!/bin/sh\necho 0.1.0\n')
    const profile = join(state.directory, '.zshrc')
    await writeFile(profile, '# Existing configuration\n')
    await chmod(profile, 0o444)
    const result = state.installForUser()
    expect(result.status).toBe(0)
    expect(result.stderr).toContain(`could not configure PATH in ${profile}`)
    expect(result.stdout).not.toContain('Open a new terminal')
    expect(await readFile(profile, 'utf8')).toBe('# Existing configuration\n')
    expect(result.stderr).not.toContain('Administrator access')
  })

  it.skipIf(process.getuid?.() === 0)('does not elevate when the default user directory is unwritable', async () => {
    const state = await fixture()
    await state.publish('#!/bin/sh\necho original\n')
    expect(state.installForUser().status).toBe(0)
    const installDir = join(state.directory, '.local/bin')
    await chmod(installDir, 0o555)
    await state.publish('replacement')
    try {
      const result = state.installForUser()
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('User installation directory is not writable')
      expect(result.stderr).not.toContain('Administrator access')
      expect(await readFile(join(installDir, 'extrabrain'), 'utf8')).toContain('echo original')
    } finally {
      await chmod(installDir, 0o755)
    }
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
      directory: process.env.EXTRABRAIN_INSTALL_DIR,
      path: process.env.PATH
    }
    try {
      process.env.EXTRABRAIN_RELEASE_BASE = state.releaseBase
      process.env.EXTRABRAIN_VERSION = version
      process.env.EXTRABRAIN_INSTALL_DIR = state.installDir
      process.env.PATH = `${state.installDir}:${original.path ?? ''}`
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
      if (original.path === undefined) delete process.env.PATH
      else process.env.PATH = original.path
    }
    expect(spawnSync(target, ['--version'], { encoding: 'utf8' }).stdout.trim()).toBe('0.1.1')
  })

  describe.skipIf(!process.env.EXTRABRAIN_TEST_EXECUTABLE)('packaged executable updates', () => {
    for (const location of ['custom/bin', '.local/bin']) {
      it(`updates the running executable in ${location} without a destination override`, async () => {
        const state = await fixture()
        const installDir = join(state.directory, location)
        await state.publish(await readFile(process.env.EXTRABRAIN_TEST_EXECUTABLE!))
        expect(state.install({ EXTRABRAIN_INSTALL_DIR: installDir }).status).toBe(0)
        await state.publish('#!/bin/sh\necho updated\n')
        const target = join(installDir, 'extrabrain')
        const result = spawnSync(target, ['--json', 'update'], {
          encoding: 'utf8',
          env: {
            ...process.env,
            HOME: state.directory,
            ZDOTDIR: state.directory,
            PATH: `${installDir}:/usr/bin:/bin`,
            EXTRABRAIN_RELEASE_BASE: state.releaseBase,
            EXTRABRAIN_VERSION: version,
            EXTRABRAIN_INSTALL_DIR: ''
          }
        })
        expect(result.status).toBe(0)
        expect(JSON.parse(result.stdout)).toMatchObject({ code: 0, message: 'CLI updated.' })
        expect(result.stderr).toBe('')
        expect(spawnSync(target, ['--version'], { encoding: 'utf8' }).stdout.trim()).toBe('updated')
      }, 30_000)
    }

    it('honors an explicit destination override', async () => {
      const state = await fixture()
      const original = await readFile(process.env.EXTRABRAIN_TEST_EXECUTABLE!)
      await state.publish(original)
      expect(state.install().status).toBe(0)
      await state.publish('#!/bin/sh\necho updated\n')
      const override = join(state.directory, 'other-bin')
      const target = join(state.installDir, 'extrabrain')
      const result = spawnSync(target, ['--json', 'update'], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${override}:/usr/bin:/bin`,
          EXTRABRAIN_RELEASE_BASE: state.releaseBase,
          EXTRABRAIN_VERSION: version,
          EXTRABRAIN_INSTALL_DIR: override
        }
      })
      expect(result.status).toBe(0)
      expect(JSON.parse(result.stdout).code).toBe(0)
      expect(createHash('sha256').update(await readFile(target)).digest('hex'))
        .toBe(createHash('sha256').update(original).digest('hex'))
      expect(spawnSync(join(override, 'extrabrain'), ['--version'], { encoding: 'utf8' }).stdout.trim()).toBe('updated')
    }, 30_000)

    it('returns installer failure details as valid JSON without replacing the executable', async () => {
      const state = await fixture()
      const original = await readFile(process.env.EXTRABRAIN_TEST_EXECUTABLE!)
      await state.publish(original)
      expect(state.install().status).toBe(0)
      await state.publish('corrupt', false)
      const target = join(state.installDir, 'extrabrain')
      const result = spawnSync(target, ['--json', 'update'], {
        encoding: 'utf8',
        env: {
          ...process.env,
          EXTRABRAIN_RELEASE_BASE: state.releaseBase,
          EXTRABRAIN_VERSION: version,
          EXTRABRAIN_INSTALL_DIR: ''
        }
      })
      expect(result.status).toBe(1)
      expect(JSON.parse(result.stdout)).toMatchObject({ code: 1, message: expect.stringContaining('Release checksum mismatch') })
      expect(createHash('sha256').update(await readFile(target)).digest('hex'))
        .toBe(createHash('sha256').update(original).digest('hex'))
    }, 30_000)
  })
})
