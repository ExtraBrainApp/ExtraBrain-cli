import { describe, expect, it, vi } from 'vitest'
import { CliApiError, type DocumentApiClient } from '../src/apiClient.service'
import { ANALYSIS_JSON_LIMIT, SessionDataService } from '../src/sessionData.service'

const service = (respond: (path: string) => Record<string, unknown>) => {
  const json = vi.fn(async (path: string) => respond(path))
  return { data: new SessionDataService({ json } as unknown as DocumentApiClient), json }
}

const partManifest = (parts: Record<string, unknown>[], status = 'complete') => ({
  schemaVersion: 'v1', sessionId: 's/東京', analysisId: 'a 1', snapshot: 'rev-1',
  analysis: { request: 'Why?', result: 'Because', provider: 'example' },
  provenance: { status, missing: status === 'complete' ? [] : [{ category: 'tool-results', reason: 'not retained' }] },
  parts, assets: [{ screenshotId: 'shot-1', representation: 'analysis-jpeg', available: false }]
})

describe('session data contract', () => {
  it('traverses more than 500 records without losing same-timestamp records', async () => {
    const records = Array.from({ length: 521 }, (_, i) => ({ id: `r${i}`, timestamp: 100, source: 'microphone', speaker: 'Alice', relativeStartMs: i, text: i === 0 ? 'um' : '話' }))
    const { data, json } = service((path) => {
      const url = new URL(path, 'http://fixture')
      const offset = Number(url.searchParams.get('cursor') ?? 0)
      return { items: records.slice(offset, offset + 200), totalCount: records.length,
        nextCursor: offset + 200 < records.length ? String(offset + 200) : null, snapshot: 'rev-1', sessionId: 's/東京' }
    })
    const result: string[] = []
    for await (const page of data.allPages((cursor) => data.collection('s/東京', 'transcripts', { cursor, limit: 200, snapshot: 'rev-1' }), 'rev-1')) {
      result.push(...page.items.map((item) => item.id as string))
    }
    expect(result).toEqual(records.map((record) => record.id))
    expect(json).toHaveBeenCalledTimes(3)
    expect(vi.mocked(json).mock.calls[0][0]).toContain('s%2F%E6%9D%B1%E4%BA%AC')
  })

  it.each([
    [{}, 'id'], [{ id: '' }, 'id'], [{ id: 1 }, 'id'], [{ id: null }, 'id'],
    [{ id: 'valid', analysisId: '' }, 'analysisId'],
    [{ id: 'valid', analysisId: null }, 'analysisId'],
    [{ id: 'valid', screenshotId: 1 }, 'screenshotId']
  ] as const)('rejects missing or malformed record identity %j', async (item, field) => {
    const { data } = service(() => ({ items: [item], totalCount: 1, nextCursor: null, snapshot: 'rev-1' }))
    const traversal = data.allPages(() => data.page('/fixture'), 'rev-1', field)
    await expect(traversal.next()).rejects.toMatchObject({ code: 'INVALID_RESPONSE', message: 'Invalid record identity' })
  })

  it.each(['id', 'analysisId', 'screenshotId'] as const)('rejects duplicate %s before yielding the corrupt page', async (field) => {
    const { data } = service((path) => ({ items: [{ [field]: 'same', text: path }], totalCount: 2,
      nextCursor: path.includes('cursor=') ? null : 'second', snapshot: 'rev-1' }))
    const traversal = data.allPages((cursor) => data.page('/fixture', { cursor }), 'rev-1', field)
    expect((await traversal.next()).done).toBe(false)
    await expect(traversal.next()).rejects.toMatchObject({ code: 'INVALID_RESPONSE', message: 'Duplicate record identity' })
  })

  it('rejects duplicate rows within a page before yielding any rows', async () => {
    const { data } = service(() => ({ items: [{ id: 'same' }, { id: 'same' }], totalCount: 2, nextCursor: null, snapshot: 'rev-1' }))
    await expect(data.allPages(() => data.page('/fixture')).next()).rejects.toThrow('Duplicate record identity')
  })

  it.each(['analysisId', 'screenshotId'] as const)('preserves matching %s aliases and distinct identities across pages', async (field) => {
    const { data } = service((path) => {
      const id = path.includes('cursor=') ? 'second' : 'first'
      return { items: [{ id, [field]: id }], totalCount: 2, nextCursor: id === 'first' ? 'second' : null, snapshot: 'rev-1' }
    })
    const ids: unknown[] = []
    for await (const page of data.allPages((cursor) => data.page('/fixture', { cursor }), 'rev-1', field)) ids.push(...page.items.map((item) => item.id))
    expect(ids).toEqual(['first', 'second'])
  })

  it.each(['analysisId', 'screenshotId'] as const)('rejects conflicting %s aliases', async (field) => {
    const { data } = service(() => ({ items: [{ id: 'first', [field]: 'other' }], totalCount: 1, nextCursor: null, snapshot: 'rev-1' }))
    await expect(data.allPages(() => data.page('/fixture'), 'rev-1', field).next()).rejects.toThrow('Conflicting record identity')
  })

  it('rejects duplicate part records during JSON analysis retrieval', async () => {
    const { data } = service((path) => path.includes('/parts/')
      ? { items: [{ id: 'same' }, { id: 'same' }], totalCount: 2, nextCursor: null, snapshot: 'rev-1' }
      : partManifest([{ id: 'input', role: 'model-input', totalCount: 2 }]))
    await expect(data.getAnalysis('s/東京', 'a 1')).rejects.toMatchObject({ code: 'INVALID_RESPONSE', message: 'Duplicate record identity' })
  })

  it('assembles non-ASCII content over 100000 UTF-16 units', async () => {
    const original = '🌍é話'.repeat(30000)
    const { data } = service((path) => {
      const url = new URL(path, 'http://fixture')
      const offset = Number(url.searchParams.get('offset'))
      const text = original.slice(offset, offset + 10000)
      const nextOffset = offset + text.length
      return { contentId: 'c 1', text, offset, nextOffset: nextOffset < original.length ? nextOffset : null,
        totalChars: original.length, snapshot: 'rev-1', sessionId: 's/東京' }
    })
    expect(await data.fullContent('s/東京', 'c 1', 'rev-1')).toBe(original)
  })

  it('returns complete retrieval with partial provenance and all advertised parts', async () => {
    const descriptors = [
      { id: 'primary', role: 'primary', totalCount: 1 },
      { id: 'continuity', role: 'continuity', totalCount: 1 },
      { id: 'tools', role: 'tool-result', totalCount: 1 },
      { id: 'model-input', role: 'model-input', totalCount: 1 }
    ]
    const { data } = service((path) => {
      if (path.includes('/parts/')) {
        return { items: [{ id: path.split('/parts/')[1].split('?')[0], contentRef: { contentId: 'c1', totalChars: 5 } }], totalCount: 1, nextCursor: null, snapshot: 'rev-1', sessionId: 's/東京', analysisId: 'a 1' }
      }
      if (path.includes('/content/')) return { contentId: 'c1', text: 'hello', offset: 0, nextOffset: null, totalChars: 5, snapshot: 'rev-1' }
      return partManifest(descriptors, 'legacy_partial')
    })
    const result = await data.getAnalysis('s/東京', 'a 1')
    expect(result.retrieval).toEqual({ complete: true })
    expect(result.provenance).toEqual({ status: 'legacy_partial', missing: [{ category: 'tool-results', reason: 'not retained' }] })
    expect((result.parts as Record<string, unknown>[]).map((part) => part.role)).toEqual(['primary', 'continuity', 'tool-result', 'model-input'])
    expect(result.content).toEqual({ c1: 'hello' })
    expect(result.assets).toEqual([{ screenshotId: 'shot-1', representation: 'analysis-jpeg', available: false }])
  })

  it('preserves every advertised historical category and partial missing reasons', async () => {
    const roles = [
      'request', 'result', 'profile', 'system-prompt', 'user-prompt', 'strategy',
      'provider-attempt', 'primary', 'continuity', 'previous-analysis', 'fact',
      'topic', 'question', 'tool-call', 'tool-result', 'budget-decision', 'model-input'
    ]
    const descriptors = roles.map((role) => ({ id: role, role, totalCount: 1 }))
    const { data } = service((path) => path.includes('/parts/')
      ? { items: [{ id: path.split('/parts/')[1].split('?')[0], evidence: 'retained' }], totalCount: 1, nextCursor: null, snapshot: 'rev-1' }
      : partManifest(descriptors, 'partial'))
    const result = await data.getAnalysis('s/東京', 'a 1')
    expect((result.parts as Record<string, unknown>[]).map((part) => part.role)).toEqual(roles)
    expect(result.provenance).toEqual({ status: 'partial', missing: [{ category: 'tool-results', reason: 'not retained' }] })
    expect(result.retrieval).toEqual({ complete: true })
  })

  it.each([
    [{ items: [], totalCount: -1, nextCursor: null, snapshot: 'rev-1' }, 'Invalid totalCount'],
    [{ items: [], totalCount: 0, nextCursor: 'again', snapshot: 'rev-1' }, 'Invalid page count'],
    [{ items: [], totalCount: 0, nextCursor: null, snapshot: 'rev-2' }, 'Snapshot changed'],
    [{ items: [], totalCount: 0, nextCursor: null, snapshot: 'rev-1', sessionId: 'wrong' }, 'Mismatched sessionId']
  ])('rejects malformed or mismatched pages', async (page, message) => {
    const { data } = service(() => page)
    await expect(data.collection('s/東京', 'facts', { snapshot: 'rev-1' })).rejects.toThrow(message)
  })

  it('rejects repeated continuation cursors', async () => {
    const { data } = service((path) => ({ items: [{ id: path.includes('cursor=') ? 'second' : 'first' }], totalCount: 3, nextCursor: 'same', snapshot: 'rev-1' }))
    const collect = async () => { for await (const _page of data.allPages((cursor) => data.page('/api/v1/sessions', { cursor }))) { /* consume */ } }
    await expect(collect()).rejects.toThrow('Repeated cursor')
  })

  it('rejects changed content offsets and mismatched analysis scope', async () => {
    const { data } = service((path) => path.includes('/content/')
      ? { contentId: 'c1', text: 'x', offset: 2, nextOffset: null, totalChars: 1, snapshot: 'rev-1' }
      : { ...partManifest([]), analysisId: 'other' })
    await expect(data.content('s/東京', 'c1', 'rev-1')).rejects.toThrow('Invalid content range')
    await expect(data.analysisManifest('s/東京', 'a 1')).rejects.toThrow('Mismatched analysis identity')
  })

  it('stops an oversized JSON analysis and recommends export', async () => {
    const huge = 'x'.repeat(ANALYSIS_JSON_LIMIT + 1)
    const { data } = service((path) => path.includes('/parts/')
      ? { items: [{ id: 'large-record', text: huge }], totalCount: 1, nextCursor: null, snapshot: 'rev-1' }
      : partManifest([{ id: 'part', role: 'model-input', totalCount: 1 }]))
    await expect(data.getAnalysis('s/東京', 'a 1')).rejects.toMatchObject({ code: 'OUTPUT_TOO_LARGE' } satisfies Partial<CliApiError>)
  })
})
