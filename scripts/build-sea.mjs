import { spawnSync } from 'node:child_process'
import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const outputDir = 'dist'
const executable = join(outputDir, process.platform === 'win32' ? 'extrabrain.exe' : 'extrabrain')
const seaConfig = join(outputDir, 'sea-config.json')
const blob = join(outputDir, 'sea.blob')

const run = (command, args) => {
  const result = spawnSync(command, args, { stdio: 'inherit' })
  if (result.error || result.status !== 0) {
    throw new Error(`${command} failed: ${result.error?.message ?? result.status}`)
  }
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
await copyFile(process.execPath, executable)
if (process.platform === 'darwin') run('codesign', ['--remove-signature', executable])
if (process.platform === 'win32') {
  run(process.env.EXTRABRAIN_SIGNTOOL_PATH ?? 'signtool', ['remove', '/s', executable])
}
run(process.execPath, [
  join('node_modules', 'postject', 'dist', 'cli.js'),
  executable,
  'NODE_SEA_BLOB',
  blob,
  '--sentinel-fuse',
  'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ...(process.platform === 'darwin' ? ['--macho-segment-name', 'NODE_SEA'] : [])
])
if (process.platform !== 'win32') run('chmod', ['755', executable])
if (process.platform === 'darwin') run('codesign', ['--force', '--sign', '-', executable])
