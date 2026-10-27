import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

// Cross-target builds embed a portable blob (no snapshot or code cache) into the
// official Node binary for the target, downloaded and checked against SHASUMS256.txt.
const TARGETS = ['darwin-arm64', 'darwin-x64', 'win32-arm64', 'win32-x64']
const host = `${process.platform}-${process.arch}`
const { values } = parseArgs({ options: { target: { type: 'string', multiple: true } } })
const requested = values.target ?? []
for (const target of requested) {
  if (!TARGETS.includes(target)) throw new Error(`--target must be one of: ${TARGETS.join(', ')}`)
}

const outputDir = 'dist'
const seaConfig = join(outputDir, 'sea-config.json')
const blob = join(outputDir, 'sea.blob')
const nodeVersion = `v${process.versions.node}`
const nodeDist = `https://nodejs.org/dist/${nodeVersion}`
const cacheDir = join('node_modules', '.cache', 'extrabrain-sea', nodeVersion)

const run = (command, args) => {
  const result = spawnSync(command, args, { stdio: 'inherit' })
  if (result.error || result.status !== 0) {
    throw new Error(`${command} failed: ${result.error?.message ?? result.status}`)
  }
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

const fetchBytes = async (url) => {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Download failed: ${url} (${response.status})`)
  return Buffer.from(await response.arrayBuffer())
}

let checksums
const verifiedDownload = async (name) => {
  checksums ??= (await fetchBytes(`${nodeDist}/SHASUMS256.txt`)).toString('utf8')
  const expected = checksums.split('\n').find((line) => line.endsWith(`  ${name}`))?.slice(0, 64)
  if (!expected) throw new Error(`${name} is missing from ${nodeDist}/SHASUMS256.txt`)
  const path = join(cacheDir, name.replaceAll('/', '-'))
  if (existsSync(path) && sha256(await readFile(path)) === expected) return path
  const bytes = await fetchBytes(`${nodeDist}/${name}`)
  if (sha256(bytes) !== expected) throw new Error(`Checksum mismatch for ${name}`)
  await mkdir(cacheDir, { recursive: true })
  await writeFile(path, bytes)
  return path
}

const baseBinary = async (platform, arch) => {
  if (`${platform}-${arch}` === host) return process.execPath
  if (platform === 'win32') return verifiedDownload(`win-${arch}/node.exe`)
  const name = `node-${nodeVersion}-darwin-${arch}`
  const archive = await verifiedDownload(`${name}.tar.gz`)
  run('tar', ['-xzf', archive, '-C', cacheDir, `${name}/bin/node`])
  return join(cacheDir, name, 'bin', 'node')
}

const findSigntool = async () => {
  if (process.env.EXTRABRAIN_SIGNTOOL_PATH) return process.env.EXTRABRAIN_SIGNTOOL_PATH
  const kits = join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Windows Kits', '10', 'bin')
  const versions = existsSync(kits) ? await readdir(kits) : []
  versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
  for (const version of versions) {
    const tool = join(kits, version, process.arch === 'arm64' ? 'arm64' : 'x64', 'signtool.exe')
    if (existsSync(tool)) return tool
  }
  return 'signtool'
}

// Copies the target's Node binary to the executable path without its signature.
const prepareExecutable = async (platform, base, executable) => {
  await rm(executable, { force: true })
  if (platform === 'darwin') {
    if (process.platform !== 'darwin') throw new Error('macOS executables must be built on macOS')
    await copyFile(base, executable)
    run('codesign', ['--remove-signature', executable])
  } else if (platform === 'win32' && process.platform === 'win32') {
    await copyFile(base, executable)
    run(await findSigntool(), ['remove', '/s', executable])
  } else if (platform === 'win32') {
    run(process.env.EXTRABRAIN_OSSLSIGNCODE_PATH ?? 'osslsigncode', ['remove-signature', '-in', base, '-out', executable])
  } else {
    await copyFile(base, executable)
  }
}

const build = async (target) => {
  const [platform, arch] = target.split('-')
  const directory = requested.length ? join(outputDir, target) : outputDir
  const executable = join(directory, platform === 'win32' ? 'extrabrain.exe' : 'extrabrain')
  await mkdir(directory, { recursive: true })
  await prepareExecutable(platform, await baseBinary(platform, arch), executable)
  run(process.execPath, [
    join('node_modules', 'postject', 'dist', 'cli.js'),
    executable,
    'NODE_SEA_BLOB',
    blob,
    '--sentinel-fuse',
    'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
    ...(platform === 'darwin' ? ['--macho-segment-name', 'NODE_SEA'] : [])
  ])
  if (platform !== 'win32') await chmod(executable, 0o755)
  if (platform === 'darwin') run('codesign', ['--force', '--sign', '-', executable])
}

await mkdir(outputDir, { recursive: true })
await writeFile(
  seaConfig,
  JSON.stringify({
    main: join(outputDir, 'extrabrain.cjs'),
    output: blob,
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false
  })
)
run(process.execPath, ['--experimental-sea-config', seaConfig])
for (const target of requested.length ? requested : [host]) await build(target)
