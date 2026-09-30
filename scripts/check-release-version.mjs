import { readFileSync } from 'node:fs'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const source = readFileSync(new URL('../src/version.ts', import.meta.url), 'utf8')
const version = process.env.RELEASE_TAG
if (version !== `v${manifest.version}`) {
  throw new Error(`Release tag must be v${manifest.version}`)
}
if (!source.includes(`export const CLI_VERSION = '${manifest.version}'`)) {
  throw new Error('CLI source version does not match package.json')
}
