// @vitest-environment jsdom

/*
 * Reconciling a row after its category changes.
 *
 * Tags are inherited from the category and its group, so a recategorized row's tags change too — but
 * only the server can say to what, since resolution also spans the account and the row's own blocks.
 * The row is patched in place rather than refetched, so a write that answers with nothing leaves the
 * *previous* category's inherited tags on screen and nothing corrects them. These pin the two phases:
 * the category paints immediately, the tags land with the write's answer.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { applyCategoryChange, categoryReconcilePatch, txnMutations } from '../txnMutations.js'

// Held as locals rather than reached through the mocked `api` object: the repo forbids touching the
// wrapped category writes outside txnMutations, and a test is not the place to make an exception.
const { overrideCategory, clearOverride, getTransactions } = vi.hoisted(() => ({
  overrideCategory: vi.fn(),
  clearOverride: vi.fn(),
  getTransactions: vi.fn(),
}))

vi.mock('../api.js', () => ({ api: { overrideCategory, clearOverride, getTransactions } }))

const DINING = { id: 'cat-dining', name: 'Dining' }
const TREAT = { id: 'tag-treat', name: 'Treat', color: '#f59e0b', source: 'category' }

beforeEach(() => {
  overrideCategory.mockReset()
  clearOverride.mockReset()
  getTransactions.mockReset()
  overrideCategory.mockResolvedValue({ ok: true, tags: [TREAT], blocked_tags: [] })
})

describe('applying a category change to a row', () => {
  it('paints the category before the write answers, then the tags it resolved to', async () => {
    const patches = []
    await applyCategoryChange('t1', DINING, patch => patches.push(patch))

    expect(patches).toHaveLength(2)
    // First phase is what the client already knows — no tag claim, since it cannot know one.
    expect(patches[0].category_id).toBe('cat-dining')
    expect(patches[0].tags).toBeUndefined()
    // Second carries the server's answer, and still the category, so a caller that merges only one
    // of the two patches never shows the wrong category.
    expect(patches[1].category_id).toBe('cat-dining')
    expect(patches[1].tags).toEqual([TREAT])
    expect(patches[1].blocked_tags).toEqual([])
  })

  it('holds the tag patch until the write resolves', async () => {
    let release
    overrideCategory.mockReturnValue(new Promise(resolve => { release = resolve }))
    const patches = []
    const pending = applyCategoryChange('t1', DINING, patch => patches.push(patch))

    expect(patches).toHaveLength(1)
    release({ ok: true, tags: [TREAT], blocked_tags: [] })
    await pending
    expect(patches[1].tags).toEqual([TREAT])
  })

  it('takes the caller\'s own write, since clearing an override is not setting a null category', async () => {
    clearOverride.mockResolvedValue({ ok: true, tags: [], blocked_tags: [] })
    const patches = []
    await applyCategoryChange('t1', null, patch => patches.push(patch), () => txnMutations.uncategorize('t1'))

    expect(clearOverride).toHaveBeenCalledWith('t1')
    expect(overrideCategory).not.toHaveBeenCalled()
    expect(patches[1].category_id).toBeNull()
    // An emptied tag list is an answer, not a missing one: the inherited tag has to come off the row.
    expect(patches[1].tags).toEqual([])
  })

  it('claims nothing about tags when the write does not report them', async () => {
    overrideCategory.mockResolvedValue({ ok: true })
    const patches = []
    await applyCategoryChange('t1', DINING, patch => patches.push(patch))

    expect('tags' in patches[1]).toBe(false)
  })

  it('refreshes the refunds that followed the payment, under their own ids', async () => {
    // A refund paired with this payment moved with it on the server; the caller only patched the
    // payment, so without this the refund beside it keeps showing its old category.
    overrideCategory.mockResolvedValue({ ok: true, tags: [], blocked_tags: [], followed_ids: ['r1'] })
    getTransactions.mockResolvedValue({ transactions: [{ id: 'r1', category_id: 'cat-dining' }] })
    const applied = []
    await applyCategoryChange('t1', DINING, (patch, id) => applied.push([id, patch.category_id]))

    expect(getTransactions).toHaveBeenCalledWith({ ids: 'r1', limit: 1 })
    expect(applied).toEqual([['t1', 'cat-dining'], ['t1', 'cat-dining'], ['r1', 'cat-dining']])
  })
})

describe('categoryReconcilePatch', () => {
  it('carries tags only when a resolved set is handed to it', () => {
    expect('tags' in categoryReconcilePatch(DINING)).toBe(false)
    expect(categoryReconcilePatch(DINING, { tags: [TREAT] })).toMatchObject({
      category_id: 'cat-dining',
      tags: [TREAT],
      blocked_tags: [],
    })
  })
})
