import { describe, expect, it } from 'vitest'

import {
  REIMBURSABLE_SYSTEM_KEY,
  UNASSIGNED_CATEGORY_SYSTEM_KEY,
  categoryCapabilities,
  categoryKind,
  showsCategoryControls,
  isReimbursableSelection,
} from '../categoryCapabilities.js'

const ORDINARY = { id: 'c1', parent_id: 'g1', name: 'Groceries' }
const UNASSIGNED = { id: 'g0', parent_id: null, system_key: UNASSIGNED_CATEGORY_SYSTEM_KEY }
const REIMBURSABLE = { id: 'g2', parent_id: null, system_key: REIMBURSABLE_SYSTEM_KEY }
const SYNTHETIC = { id: '__uncategorized__', parent_id: 'g1', synthetic_kind: 'uncategorized' }
const SYNTHETIC_GROUP = { id: '__income__', parent_id: null, synthetic_kind: 'uncategorized_income_group' }

describe('categoryKind', () => {
  it('separates the three protected kinds from an ordinary category', () => {
    expect(categoryKind(ORDINARY)).toBe('ordinary')
    expect(categoryKind(UNASSIGNED)).toBe('unassigned')
    expect(categoryKind(REIMBURSABLE)).toBe('reimbursable')
    expect(categoryKind(SYNTHETIC)).toBe('synthetic')
    expect(categoryKind(SYNTHETIC_GROUP)).toBe('synthetic')
  })

  it('reads synthetic before the system key, since a synthetic group carries one', () => {
    // buildSyntheticUncategorizedIncomeGroup stamps the unassigned key onto a row that is not in the
    // database at all. Ordering the checks the other way would classify it as a real protected row.
    expect(categoryKind({ system_key: UNASSIGNED_CATEGORY_SYSTEM_KEY, synthetic_kind: 'uncategorized_income_group' }))
      .toBe('synthetic')
  })

  it('treats a missing category as ordinary rather than throwing', () => {
    expect(categoryKind(null)).toBe('ordinary')
    expect(categoryKind(undefined)).toBe('ordinary')
  })
})

describe('categoryCapabilities', () => {
  it('lets the reimbursable group be renamed and tagged but never deleted, moved or counted', () => {
    // The whole reason the single is-system flag could not be reused: this row answers differently
    // from Unassigned on three of the six axes.
    const capabilities = categoryCapabilities(REIMBURSABLE)
    expect(capabilities).toMatchObject({
      rename: true,
      tags: true,
      acceptDrop: true,
      delete: false,
      move: false,
      editExclusion: false,
    })
  })

  it('holds Unassigned completely still', () => {
    const capabilities = categoryCapabilities(UNASSIGNED)
    expect(Object.entries(capabilities).filter(([key]) => key !== 'systemMark').every(([, value]) => value === false))
      .toBe(true)
  })

  it('leaves an ordinary category entirely open', () => {
    const capabilities = categoryCapabilities(ORDINARY)
    expect(capabilities).toMatchObject({
      rename: true, delete: true, move: true, acceptDrop: true, editExclusion: true, tags: true,
    })
    expect(capabilities.systemMark).toBe(false)
  })

  it('treats a leaf inside the reimbursable group as an ordinary category', () => {
    // The feature keys on the group. Its leaves are the user's to rename, remove and add, and the
    // group's exclusion covers them regardless of what they carry.
    expect(categoryCapabilities({ id: 'l1', parent_id: 'g2', name: 'Awaiting reimbursement' }))
      .toBe(categoryCapabilities(ORDINARY))
  })
})

describe('showsCategoryControls', () => {
  it('shows the strip for the reimbursable group so the disabled checkbox explains itself', () => {
    expect(showsCategoryControls(REIMBURSABLE)).toBe(true)
  })

  it('hides it for rows that can do neither thing it holds', () => {
    expect(showsCategoryControls(UNASSIGNED)).toBe(false)
    expect(showsCategoryControls(SYNTHETIC)).toBe(false)
  })

  it('shows it for an ordinary category', () => {
    expect(showsCategoryControls(ORDINARY)).toBe(true)
  })
})


describe('isReimbursableSelection', () => {
  const group = { id: 'g', system_key: 'reimbursable', parent_id: null }
  const leaf = { id: 'l', parent_id: 'g' }

  it('is true for the holding group and for a leaf under it', () => {
    expect(isReimbursableSelection(group, null)).toBe(true)
    expect(isReimbursableSelection(leaf, group)).toBe(true)
  })

  it('keys on the system key, not the name, so a rename cannot lose it', () => {
    // The group is the user's to rename; the feature has to keep working when they do.
    expect(isReimbursableSelection({ ...group, name: 'Owed to me' }, null)).toBe(true)
    expect(isReimbursableSelection({ id: 'x', name: 'Reimbursable', parent_id: null }, null)).toBe(false)
  })

  it('is false elsewhere', () => {
    expect(isReimbursableSelection({ id: 'o', parent_id: 'other' }, { id: 'other' })).toBe(false)
    expect(isReimbursableSelection(null, group)).toBe(false)
  })
})
