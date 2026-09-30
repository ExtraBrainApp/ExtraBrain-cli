import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readdir, realpath } from 'node:fs/promises'
import { basename, relative, resolve, sep } from 'node:path'

export interface ExpandedFile {
  fileName: string
  hash: string
  modifiedAt: number
  path: string
  size: number
}

export class FileExpansionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FileExpansionError'
  }
}

const hashFile = async (path: string): Promise<string> => {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

const assertContained = (root: string, candidate: string): void => {
  const child = relative(root, candidate)
  if (child === '..' || child.startsWith(`..${sep}`) || child.includes(`\0`)) {
    throw new FileExpansionError(`Path escapes the selected directory: ${candidate}`)
  }
}

const inspectFile = async (path: string, root?: string): Promise<ExpandedFile> => {
  const stat = await lstat(path)
  if (stat.isSymbolicLink())
    throw new FileExpansionError(`Symbolic links are not supported: ${path}`)
  if (!stat.isFile()) throw new FileExpansionError(`Only regular files are supported: ${path}`)
  const canonical = await realpath(path)
  if (root) assertContained(root, canonical)
  return {
    fileName: basename(path),
    hash: await hashFile(canonical),
    modifiedAt: Math.floor(stat.mtimeMs / 1000),
    path: canonical,
    size: stat.size
  }
}

const expandDirectory = async (
  path: string,
  recursive: boolean,
  selectedRoot?: string
): Promise<ExpandedFile[]> => {
  const root = selectedRoot ?? (await realpath(path))
  const files: ExpandedFile[] = []
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const candidate = resolve(path, entry.name)
    if (entry.isSymbolicLink()) {
      throw new FileExpansionError(`Symbolic links are not supported: ${candidate}`)
    }
    if (entry.isDirectory()) {
      if (!recursive) {
        throw new FileExpansionError(`Nested directory requires --recursive: ${candidate}`)
      }
      files.push(...(await expandDirectory(candidate, true, root)))
    } else {
      files.push(await inspectFile(candidate, root))
    }
  }
  return files
}

export const expandInputPaths = async (
  inputPaths: readonly string[],
  recursive: boolean
): Promise<ExpandedFile[]> => {
  if (inputPaths.length === 0)
    throw new FileExpansionError('At least one file or directory is required')
  const files: ExpandedFile[] = []
  for (const inputPath of inputPaths) {
    const path = resolve(inputPath)
    const stat = await lstat(path)
    if (stat.isSymbolicLink())
      throw new FileExpansionError(`Symbolic links are not supported: ${path}`)
    if (stat.isDirectory()) files.push(...(await expandDirectory(path, recursive)))
    else files.push(await inspectFile(path))
  }
  if (files.length === 0) throw new FileExpansionError('No regular files were selected')
  return files.sort((left, right) => left.path.localeCompare(right.path))
}
