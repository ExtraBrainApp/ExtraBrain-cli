import { readFileSync } from 'node:fs'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const version = process.env.RELEASE_TAG
if (version !== `v${manifest.version}`) {
  throw new Error(`Release tag must be v${manifest.version}`)
}
