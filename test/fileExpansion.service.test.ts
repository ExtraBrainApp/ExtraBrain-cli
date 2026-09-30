import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { expandInputPaths } from '../src/fileExpansion.service'

const temporaryDirectories: string[] = []

const createTemporaryDirectory = async (): Promise<string> => {
  const path = await mkdtemp(join(tmpdir(), 'extrabrain-cli-files-'))
  temporaryDirectories.push(path)
  return path
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true }))
  )
})

describe('CLI file expansion', () => {
  it('preserves Unicode, whitespace, and leading option characters for explicit files', async () => {
    const directory = await createTemporaryDirectory()
    const path = join(directory, '- Résumé notes.txt')
    await writeFile(path, 'content')

    await expect(expandInputPaths([path], false)).resolves.toEqual([
      expect.objectContaining({
        fileName: '- Résumé notes.txt',
        path: await realpath(path),
        size: 7
      })
    ])
  })

  it('requires explicit recursion and rejects symbolic links', async () => {
    const directory = await createTemporaryDirectory()
    const nested = join(directory, 'nested')
    await mkdir(nested)
    await writeFile(join(nested, 'document.txt'), 'content')

    await expect(expandInputPaths([directory], false)).rejects.toThrow('--recursive')
    await expect(expandInputPaths([directory], true)).resolves.toHaveLength(1)

    const link = join(directory, 'linked.txt')
    await symlink(join(nested, 'document.txt'), link)
    await expect(expandInputPaths([link], false)).rejects.toThrow('Symbolic links')
  })

  it.skipIf(process.platform === 'win32')('rejects device files', async () => {
    await expect(expandInputPaths(['/dev/null'], false)).rejects.toThrow('Only regular files')
  })
})
