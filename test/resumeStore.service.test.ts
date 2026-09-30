import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ResumeStore } from '../src/resumeStore.service'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true }))
  )
})

describe('CLI resume store', () => {
  it('loads legacy manifests and rejects inconsistent grouped destinations', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'extrabrain-resume-group-'))
    temporaryDirectories.push(directory)
    const store = new ResumeStore(directory)
    const manifest = store.create([])
    await store.save(manifest)
    await expect(store.load(manifest.id)).resolves.toMatchObject({ schemaVersion: 1 })
    manifest.group = { selector: { kind: 'id', value: 'original' }, resolutionKey: 'resolution', resolved: { id: 'other', name: 'Other' } }
    manifest.schemaVersion = 2
    await store.save(manifest)
    await expect(store.load(manifest.id)).rejects.toThrow('invalid')
    manifest.group.resolved = undefined
    manifest.batchId = 'batch'
    await store.save(manifest)
    await expect(store.load(manifest.id)).rejects.toThrow('invalid')
    await writeFile(store.path(manifest.id), JSON.stringify({ ...manifest, schemaVersion: 1 }))
    await expect(store.load(manifest.id)).rejects.toThrow('invalid')
  })
  it('serializes concurrent private manifest writes without poisoning later saves', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'extrabrain-resume-store-'))
    temporaryDirectories.push(directory)
    const store = new ResumeStore(directory)
    const manifest = store.create([
      {
        fileName: 'one.txt',
        hash: 'a'.repeat(64),
        modifiedAt: 1,
        path: '/private/input/one.txt',
        size: 1
      }
    ])

    await Promise.all([store.save(manifest), store.save(manifest), store.save(manifest)])
    manifest.items[0].status = 'succeeded'
    await store.save(manifest)

    await expect(store.load(manifest.id)).resolves.toMatchObject({
      items: [{ status: 'succeeded' }]
    })
    if (process.platform !== 'win32') {
      expect((await stat(store.path(manifest.id))).mode & 0o777).toBe(0o600)
    }
  })
})
