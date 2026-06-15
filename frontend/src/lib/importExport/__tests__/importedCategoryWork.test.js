// The "Group imported categories" button shows a pending count and dims when there's no work, on the
// Import page, the Categories page, and the App-level workspace provider — all via this one helper, so
// the three can't drift. The count is subtle: it must (a) look only at still-pending imported labels
// under Unassigned, (b) discount labels the in-progress draft has already grouped, and (c) still count
// brand-new labels the draft hasn't seen yet. `total` is every pending label; `pending` is what's left.

import { describe, it, expect } from 'vitest'
import {
  pendingImportedCategorySourceValues,
  getImportedCategoryWorkCounts,
} from '../importedCategoryWork.js'
import { createCategoryImportDraftState } from '../../categoryImportState.js'
import { UNASSIGNED_CATEGORY_SYSTEM_KEY } from '../constants.js'

const UNASSIGNED = { id: 'u', parent_id: null, system_key: UNASSIGNED_CATEGORY_SYSTEM_KEY, name: 'Unassigned' }

// Build a category list: pending imported labels live as import_pending leaves under Unassigned.
function cats(pendingNames, extra = []) {
  return [
    UNASSIGNED,
    ...pendingNames.map((name, i) => ({ id: `p${i}`, parent_id: 'u', name, import_pending: 1 })),
    ...extra,
  ]
}

// Minimal draft mirroring the categoryImportState snapshot shape (see categoryWorkspaceDraft.js):
// `inbox` = still-unsorted source values; `groups` = expense groups holding already-placed values.
function draftWith({ inbox = [], groups = [] } = {}) {
  return {
    snapshot: {
      tree: {
        income: [],
        expense: groups.map((g, i) => ({
          id: `g${i}`,
          name: g.name,
          categoryType: 'expense',
          children: (g.children || []).map(v => ({ sourceValue: v })),
        })),
      },
      sourceOrder: [...inbox],
      setAsideOrder: [],
      selectedSourceIds: [],
      selectedNodeId: null,
      collapsedGroups: {},
    },
  }
}

describe('pendingImportedCategorySourceValues', () => {
  it('returns only import_pending leaves directly under the Unassigned group', () => {
    const list = cats(['GROCERIES', 'GAS'], [
      { id: 'm', parent_id: 'u', name: 'Manual', import_pending: 0 }, // not pending
      { id: 'o', parent_id: 'other', name: 'Elsewhere', import_pending: 1 }, // under a different group
    ])
    expect(pendingImportedCategorySourceValues(list)).toEqual(['GROCERIES', 'GAS'])
  })

  it('is empty when there is no Unassigned group', () => {
    expect(pendingImportedCategorySourceValues([{ id: 'g', parent_id: null, system_key: 'expenses', name: 'Expenses' }])).toEqual([])
  })
})

describe('getImportedCategoryWorkCounts', () => {
  it('with no draft, every pending label is outstanding (pending === total)', () => {
    expect(getImportedCategoryWorkCounts(cats(['A', 'B', 'C']), null)).toEqual({ pending: 3, total: 3 })
  })

  it('discounts labels the draft has already grouped', () => {
    // GROCERIES placed into a group, GAS still in the inbox → 1 of 2 left.
    const draft = draftWith({ inbox: ['GAS'], groups: [{ name: 'Food', children: ['GROCERIES'] }] })
    expect(getImportedCategoryWorkCounts(cats(['GROCERIES', 'GAS']), draft)).toEqual({ pending: 1, total: 2 })
  })

  it('reports zero pending once every label is grouped (the dim-the-button case)', () => {
    const draft = draftWith({ groups: [{ name: 'Food', children: ['A', 'B'] }] })
    expect(getImportedCategoryWorkCounts(cats(['A', 'B']), draft)).toEqual({ pending: 0, total: 2 })
  })

  it('counts a brand-new pending label the draft has never seen', () => {
    // Draft only knows A and B (both in inbox); C arrived in a later import → untracked, still pending.
    const draft = draftWith({ inbox: ['A', 'B'] })
    expect(getImportedCategoryWorkCounts(cats(['A', 'B', 'C']), draft)).toEqual({ pending: 3, total: 3 })
  })

  it('composes correctly with a draft built by the real factory', () => {
    const draft = createCategoryImportDraftState(['X', 'Y'], [])
    const counts = getImportedCategoryWorkCounts(cats(['X', 'Y']), draft)
    expect(counts).toEqual({ pending: 2, total: 2 }) // fresh inbox: nothing grouped yet
  })
})
