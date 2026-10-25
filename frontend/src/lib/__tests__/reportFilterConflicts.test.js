import { describe, it, expect } from 'vitest'
import { computeReportSpendingConflicts, describeReportConflicts, resolveConflictSelectionIds } from '../reportFilterConflicts.js'

// Flat category fixture: two expense groups + one income group, each with leaves, plus a
// transfers group flagged exclude_from_totals (which the spending report shows only when a chip names it).
const categories = [
  { id: 'g-food', parent_id: null, category_type: 'expense', exclude_from_totals: 0, name: 'Food' },
  { id: 'c-groceries', parent_id: 'g-food', category_type: null, exclude_from_totals: 0, name: 'Groceries' },
  { id: 'c-dining', parent_id: 'g-food', category_type: null, exclude_from_totals: 0, name: 'Dining' },
  { id: 'g-home', parent_id: null, category_type: 'expense', exclude_from_totals: 0, name: 'Home' },
  { id: 'c-rent', parent_id: 'g-home', category_type: null, exclude_from_totals: 0, name: 'Rent' },
  { id: 'g-income', parent_id: null, category_type: 'income', exclude_from_totals: 0, name: 'Paychecks' },
  { id: 'c-salary', parent_id: 'g-income', category_type: null, exclude_from_totals: 0, name: 'Salary' },
  { id: 'g-transfer', parent_id: null, category_type: 'expense', exclude_from_totals: 1, name: 'Transfers' },
  { id: 'c-cardpay', parent_id: 'g-transfer', category_type: null, exclude_from_totals: 1, name: 'Card Payment' },
]

const exclude = (type, id, label) => ({ type, id, label, mode: 'exclude' })
const include = (type, id, label) => ({ type, id, label, mode: 'include' })

describe('computeReportSpendingConflicts — category report', () => {
  const base = { reportKind: 'category', view: 'expense', categories }

  it('flags an excluded category the report breaks down', () => {
    const out = computeReportSpendingConflicts({ ...base, selections: [exclude('category', 'c-groceries', 'Groceries')] })
    expect(out).toEqual([{ facet: 'category', id: 'c-groceries', label: 'Groceries' }])
  })

  it('flags an excluded group (removes all its categories from the flat report)', () => {
    const out = computeReportSpendingConflicts({ ...base, selections: [exclude('group', 'g-food', 'Food')] })
    expect(out).toEqual([{ facet: 'group', id: 'g-food', label: 'Food' }])
  })

  it('ignores include-mode chips (exclusion only)', () => {
    const out = computeReportSpendingConflicts({ ...base, selections: [include('category', 'c-groceries', 'Groceries')] })
    expect(out).toEqual([])
  })

  it('ignores indirect facets (account/owner) even when excluded', () => {
    const out = computeReportSpendingConflicts({ ...base, selections: [exclude('account', 'a1', 'Checking'), exclude('owner', 'o1', 'Mark')] })
    expect(out).toEqual([])
  })

  it('does not flag an exclude_from_totals category the report never shows', () => {
    const out = computeReportSpendingConflicts({ ...base, selections: [exclude('category', 'c-cardpay', 'Card Payment')] })
    expect(out).toEqual([])
  })

  it('flags a leaf of an exclude_from_totals group an include chip brought into the report', () => {
    const out = computeReportSpendingConflicts({
      ...base,
      selections: [include('group', 'g-transfer', 'Transfers'), exclude('category', 'c-cardpay', 'Card Payment')],
    })
    expect(out).toEqual([{ facet: 'category', id: 'c-cardpay', label: 'Card Payment' }])
  })

  it('does not flag an income category while viewing the expense report', () => {
    const out = computeReportSpendingConflicts({ ...base, selections: [exclude('category', 'c-salary', 'Salary')] })
    expect(out).toEqual([])
  })

  it('flags an income category when viewing the income report', () => {
    const out = computeReportSpendingConflicts({ ...base, view: 'income', selections: [exclude('category', 'c-salary', 'Salary')] })
    expect(out).toEqual([{ facet: 'category', id: 'c-salary', label: 'Salary' }])
  })
})

describe('computeReportSpendingConflicts — group report and drill', () => {
  it('top level: flags an excluded group', () => {
    const out = computeReportSpendingConflicts({ reportKind: 'group', view: 'expense', categories, selections: [exclude('group', 'g-home', 'Home')] })
    expect(out).toEqual([{ facet: 'group', id: 'g-home', label: 'Home' }])
  })

  it('drilled into a group: flags an excluded component category of that group', () => {
    const out = computeReportSpendingConflicts({
      reportKind: 'group', view: 'expense', categories,
      selectedGroupId: 'g-food',
      selections: [exclude('category', 'c-dining', 'Dining')],
    })
    expect(out).toEqual([{ facet: 'category', id: 'c-dining', label: 'Dining' }])
  })

  it('drilled into a group: does NOT flag an excluded category from a different group', () => {
    const out = computeReportSpendingConflicts({
      reportKind: 'group', view: 'expense', categories,
      selectedGroupId: 'g-food',
      selections: [exclude('category', 'c-rent', 'Rent')],
    })
    expect(out).toEqual([])
  })
})

describe('computeReportSpendingConflicts — tag report', () => {
  const tagsById = new Map([['t1', { id: 't1', name: 'Business' }], ['t2', { id: 't2', name: 'Reimbursable' }]])
  const base = { reportKind: 'tag', view: 'expense', reportTagIds: ['t1', 't2'], categories, tagsById }

  it('flags an excluded tag the report is built on, using the live tag name', () => {
    const out = computeReportSpendingConflicts({ ...base, selections: [exclude('tag', 't1', 'stale-label')] })
    expect(out).toEqual([{ facet: 'tag', id: 't1', label: 'Business', reason: 'excluded' }])
  })

  it('does not flag an excluded tag the report is not built on', () => {
    const out = computeReportSpendingConflicts({ ...base, selections: [exclude('tag', 't9', 'Other')] })
    expect(out).toEqual([])
  })

  it('flags a report tag MISSING from an active tag-include filter (the asymmetry fix)', () => {
    // Filter includes only t1; the report is built on {t1, t2}, so t2's rows are narrowed away.
    const out = computeReportSpendingConflicts({ ...base, selections: [include('tag', 't1', 'Business')] })
    expect(out).toEqual([{ facet: 'tag', id: 't2', label: 'Reimbursable', reason: 'missing' }])
  })

  it('does NOT flag missing tags when no tag include filter is active', () => {
    // An account include is not "filtering on tags", so every report tag is still present.
    const out = computeReportSpendingConflicts({ ...base, selections: [include('account', 'a1', 'Checking')] })
    expect(out).toEqual([])
  })

  it('does not flag anything when the include filter covers all report tags', () => {
    const out = computeReportSpendingConflicts({ ...base, selections: [include('tag', 't1', 'Business'), include('tag', 't2', 'Reimbursable')] })
    expect(out).toEqual([])
  })

  it('reports both an excluded and a missing report tag together', () => {
    // Include a non-report tag t9 (so we are filtering on tags → t1/t2 both narrowed) and exclude t1.
    const out = computeReportSpendingConflicts({ ...base, selections: [include('tag', 't9', 'Other'), exclude('tag', 't1', 'Business')] })
    expect(out).toEqual([
      { facet: 'tag', id: 't1', label: 'Business', reason: 'excluded' },
      { facet: 'tag', id: 't2', label: 'Reimbursable', reason: 'missing' },
    ])
  })

  it('ignores the synthetic Untagged bucket — an orthogonal axis, not a report tag', () => {
    // An `Untagged` include chip is not "filtering on tags", so it must not flag every report tag as
    // missing; it has no wedge of its own either.
    expect(computeReportSpendingConflicts({ ...base, selections: [include('tag', '__untagged__', 'Untagged')] })).toEqual([])
    // A real excluded report tag is still flagged even alongside a synthetic include chip.
    const out = computeReportSpendingConflicts({ ...base, selections: [include('tag', '__untagged__', 'Untagged'), exclude('tag', 't1', 'Business')] })
    expect(out).toEqual([{ facet: 'tag', id: 't1', label: 'Business', reason: 'excluded' }])
  })

  it('ignores attribute chips entirely — they are a different facet', () => {
    // Recurring used to be a pseudo-tag, which is why the branch above had to screen it out by id
    // shape. As its own facet it never reaches the tag check at all: a recurring row can carry every
    // tag the report is about, so narrowing to one must not read as narrowing the report's tags.
    expect(computeReportSpendingConflicts({ ...base, selections: [include('attribute', 'recurring', 'Recurring')] })).toEqual([])
  })
})

describe('resolveConflictSelectionIds', () => {
  it('drops the offending exclude chip for a category conflict', () => {
    const conflicts = [{ facet: 'category', id: 'c-groceries', label: 'Groceries' }]
    expect(resolveConflictSelectionIds(conflicts, [exclude('category', 'c-groceries', 'Groceries')]))
      .toEqual(['c-groceries'])
  })

  it('clears every tag chip (include and exclude) for any tag-report conflict', () => {
    const conflicts = [{ facet: 'tag', id: 't2', label: 'Reimbursable', reason: 'missing' }]
    const selections = [include('tag', 't1', 'Business'), exclude('tag', 't9', 'Other'), include('account', 'a1', 'Checking')]
    expect(resolveConflictSelectionIds(conflicts, selections).sort()).toEqual(['t1', 't9'])
  })
})

describe('describeReportConflicts', () => {
  it('returns null for no conflicts', () => {
    expect(describeReportConflicts([])).toBeNull()
  })
  it('names a single slice', () => {
    expect(describeReportConflicts([{ facet: 'category', id: 'c', label: 'Groceries' }]))
      .toBe('The current filter excludes Groceries which is part of this report')
  })
  it('joins two, then summarizes the rest', () => {
    const three = [
      { label: 'Groceries' }, { label: 'Dining' }, { label: 'Rent' },
    ]
    expect(describeReportConflicts(three))
      .toBe('The current filter excludes Groceries, Dining and 1 more which is part of this report')
  })
  it('uses the "omits … part of this report" framing when a tag is missing (not excluded)', () => {
    expect(describeReportConflicts([{ facet: 'tag', label: 'Reimbursable', reason: 'missing' }]))
      .toBe('The current filter omits Reimbursable which is part of this report')
  })
})
