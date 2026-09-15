import { describe, it, expect } from 'vitest'
import { periodReportKey, periodReportParams } from '../periodReportScope.js'

const base = { start: '2026-01-01', end: '2026-12-31', view: 'spending' }

describe('periodReportParams', () => {
  it('lists the whole frame when no slice is given', () => {
    expect(periodReportParams({ ...base, accountId: 'acct', ownerIds: 'o1' })).toEqual({
      date_start: '2026-01-01', date_end: '2026-12-31', account_id: 'acct', owner_ids: 'o1', view: 'spending',
    })
  })

  it('narrows a category slice by category and a group slice by group', () => {
    expect(periodReportParams({ ...base, scope: { kind: 'category', id: 'cat-1', name: 'Groceries' } }))
      .toMatchObject({ category_ids: 'cat-1' })
    const group = periodReportParams({ ...base, scope: { kind: 'group', id: 'grp-1', name: 'Living' } })
    expect(group).toMatchObject({ group_ids: 'grp-1' })
    expect(group).not.toHaveProperty('category_ids')
  })

  it('replaces an include filter of the same kind, so the report is the slice and not the filter', () => {
    // The page's filter includes two categories; the row the report was opened from is one of them.
    const params = periodReportParams({
      ...base,
      filters: { category_ids: 'cat-1,cat-2', exclude_tag_ids: 'tag-9', group_ids: 'grp-1' },
      scope: { kind: 'category', id: 'cat-1', name: 'Groceries' },
    })
    expect(params.category_ids).toBe('cat-1')
    // Everything else still narrows it.
    expect(params.exclude_tag_ids).toBe('tag-9')
    expect(params.group_ids).toBe('grp-1')
  })

  it('keeps the frame even if a filter object carries a stray view', () => {
    expect(periodReportParams({ ...base, view: 'income', filters: { view: 'spending' } }).view).toBe('income')
  })
})

describe('periodReportKey', () => {
  it('tells a sliced report apart from the whole-frame report for the same range', () => {
    const whole = periodReportKey(base)
    const sliced = periodReportKey({ ...base, scope: { kind: 'group', id: 'grp-1', name: 'Living' } })
    expect(sliced).not.toBe(whole)
    expect(periodReportKey({ ...base, scope: { kind: 'group', id: 'grp-1', name: 'Renamed' } })).toBe(sliced)
  })
})
