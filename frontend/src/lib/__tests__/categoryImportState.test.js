// Invariant coverage for reconcileSnapshotGroupsWithCategories — the merge that runs every time
// the organize workspace opens. It has to surface live groups as drop targets WITHOUT discarding
// a group the user created in the draft but hasn't Applied yet. Conflating those two (both are
// "not a live category") is the bug that lost in-progress grouping on navigate-away/return, so the
// distinction is worth pinning: a `pending` draft group is kept, a deleted-live group is dropped.

import { describe, it, expect } from 'vitest'
import { reconcileSnapshotGroupsWithCategories } from '../categoryImportState.js'

function makeSnapshot(tree) {
  return {
    tree: { income: [], expense: [], ...tree },
    sourceOrder: [],
    setAsideOrder: [],
    selectedSourceIds: [],
    selectedNodeId: null,
    collapsedGroups: {},
  }
}

describe('reconcileSnapshotGroupsWithCategories', () => {
  it('keeps a pending (unapplied) draft group and its organized children', () => {
    const snapshot = makeSnapshot({
      expense: [{
        id: 'group-abc12345',
        name: 'Travel',
        categoryType: 'expense',
        pending: true,
        children: [{ sourceValue: 'Airfare', name: 'Airfare' }],
      }],
    })
    // The user hasn't Applied, so no live category backs the group yet.
    const result = reconcileSnapshotGroupsWithCategories(snapshot, [])

    const travel = result.tree.expense.find(group => group.name === 'Travel')
    expect(travel).toBeTruthy()
    expect(travel.children.map(child => child.sourceValue)).toEqual(['Airfare'])
    expect(result.sourceOrder).not.toContain('Airfare')
  })

  it('drops a group whose live category was deleted and returns its children to the pool', () => {
    const snapshot = makeSnapshot({
      expense: [{
        // A real backend id (was a live group), now absent from existingCategories => deleted live.
        id: '7feb1519-baec-4ac9-acff-0a4aaab6570d',
        name: 'Old Group',
        categoryType: 'expense',
        children: [{ sourceValue: 'Foo', name: 'Foo' }],
      }],
    })
    const result = reconcileSnapshotGroupsWithCategories(snapshot, [])

    expect(result.tree.expense).toHaveLength(0)
    expect(result.sourceOrder).toContain('Foo')
  })

  it('surfaces a live group added on the Categories page as a drop target', () => {
    const snapshot = makeSnapshot({ expense: [] })
    const result = reconcileSnapshotGroupsWithCategories(snapshot, [
      { id: 'g1', parent_id: null, name: 'Groceries', category_type: 'expense' },
    ])
    expect(result.tree.expense.map(group => group.name)).toContain('Groceries')
  })

  it('keeps an empty pending group across reload (scaffold-then-fill workflow)', () => {
    const snapshot = makeSnapshot({
      expense: [{ id: 'group-empty01', name: 'Blank', categoryType: 'expense', pending: true, children: [] }],
    })
    const result = reconcileSnapshotGroupsWithCategories(snapshot, [])
    expect(result.tree.expense.map(group => group.name)).toEqual(['Blank'])
  })

  it('drops a pending group once a live group of the same name exists (post-Apply, no duplicate)', () => {
    const snapshot = makeSnapshot({
      expense: [{ id: 'group-trav01', name: 'Travel', categoryType: 'expense', pending: true, children: [] }],
    })
    // After Apply, the real category exists; the leftover empty pending copy must not duplicate it.
    const result = reconcileSnapshotGroupsWithCategories(snapshot, [
      { id: 'live-travel', parent_id: null, name: 'Travel', category_type: 'expense' },
    ])
    expect(result.tree.expense.map(group => group.name)).toEqual(['Travel'])
    expect(result.tree.expense.map(group => group.id)).toEqual(['live-travel'])
  })
})
