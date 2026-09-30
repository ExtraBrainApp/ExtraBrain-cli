import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ExpandedFile } from './fileExpansion.service'

export type ResumeItemStatus = 'failed' | 'pending' | 'succeeded'

export interface ResumeItem extends ExpandedFile {
  documentId?: string
  errorCode?: string
  existingDocumentId?: string
  operationId?: string
  idempotencyKey: string
  status: ResumeItemStatus
}

export interface ResumeManifest {
  batchId?: string
  batchIdempotencyKey: string
  createdAt: number
  id: string
  items: ResumeItem[]
  schemaVersion: 1 | 2
  group?: {
    selector: { kind: 'name' | 'id'; value: string }
    resolutionKey: string
    resolved?: { id: string; name: string }
  }
}

const defaultDirectory = (): string => join(homedir(), '.local', 'state', 'extrabrain', 'imports')

export class ResumeStore {
  private saveQueue: Promise<void> = Promise.resolve()

  constructor(private readonly directory = defaultDirectory()) {}

  create(
    files: readonly ExpandedFile[],
    timestamp = Math.floor(Date.now() / 1000)
  ): ResumeManifest {
    return {
      batchIdempotencyKey: randomUUID(),
      createdAt: timestamp,
      id: randomUUID(),
      items: files.map((file) => ({
        ...file,
        idempotencyKey: randomUUID(),
        status: 'pending'
      })),
      schemaVersion: 1
    }
  }

  path(id: string): string {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Resume ID is invalid')
    return join(this.directory, `${id}.json`)
  }

  async load(id: string): Promise<ResumeManifest> {
    const parsed = JSON.parse(await readFile(this.path(id), 'utf8')) as unknown
    if (!isResumeManifest(parsed) || parsed.id !== id) throw new Error('Resume manifest is invalid')
    return parsed
  }

  async save(manifest: ResumeManifest): Promise<void> {
    const snapshot = `${JSON.stringify(manifest, null, 2)}\n`
    this.saveQueue = this.saveQueue
      .catch(() => undefined)
      .then(async () => {
        const path = this.path(manifest.id)
        await mkdir(dirname(path), { recursive: true, mode: 0o700 })
        const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
        await writeFile(temporary, snapshot, { mode: 0o600 })
        await rename(temporary, path)
      })
    return this.saveQueue
  }
}

const isResumeManifest = (value: unknown): value is ResumeManifest => {
  if (!value || typeof value !== 'object') return false
  const manifest = value as Partial<ResumeManifest>
  return (
    (manifest.schemaVersion === 1 || manifest.schemaVersion === 2) &&
    (manifest.schemaVersion !== 1 || manifest.group === undefined) &&
    validGroupIntent(manifest) &&
    typeof manifest.id === 'string' &&
    typeof manifest.batchIdempotencyKey === 'string' &&
    Array.isArray(manifest.items) &&
    manifest.items.every(
      (item) =>
        item &&
        typeof item.path === 'string' &&
        typeof item.hash === 'string' &&
        typeof item.idempotencyKey === 'string' &&
        ['pending', 'failed', 'succeeded'].includes(item.status)
    )
  )
}

const validGroupIntent = (manifest: Partial<ResumeManifest>): boolean => {
  const group = manifest.group
  if (group === undefined) return true
  if (!group || typeof group !== 'object') return false
  return (
    Number.isSafeInteger(manifest.createdAt) && Number(manifest.createdAt) > 0 &&
    typeof group.resolutionKey === 'string' && group.resolutionKey.length > 0 &&
    !!group.selector && ['name', 'id'].includes(group.selector.kind) &&
    typeof group.selector.value === 'string' && group.selector.value.trim().length > 0 &&
    (group.resolved === undefined
      ? !manifest.batchId
      : !!group.resolved && typeof group.resolved.id === 'string' && group.resolved.id.length > 0 &&
        typeof group.resolved.name === 'string' && group.resolved.name.length > 0 &&
        (group.selector.kind !== 'id' || group.selector.value === group.resolved.id))
  )
}
