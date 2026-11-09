import { describe, it, expect } from 'vitest'
import { planHidingProbes, hidingNoteText, hidingActionLabel } from '../searchHidingProbe.js'

describe('planHidingProbes', () => {
  it('returns no probes when nothing subtractive is active', () => {
    expect(planHidingProbes({ quick_filter: 'amain' })).toEqual([])
  })

  it('returns no probes without a narrowing intent, even with a date filter', () => {
    // Just a date window, no search/include/needs_review: dropping it only surfaces unrelated rows.
    expect(planHidingProbes({ date_start: '2026-01-01', date_end: '2026-06-30' })).toEqual([])
  })

  it('probes the date drop when a search + date filter are active', () => {
    const params = { quick_filter: 'amain', date_start: '2026-01-01', date_end: '2026-06-30' }
    const probes = planHidingProbes(params)
    expect(probes).toHaveLength(1)
    expect(probes[0].cause).toBe('date')
    expect(probes[0].params).toEqual({ quick_filter: 'amain' })
  })

  it('treats an include facet as narrowing intent (no search needed)', () => {
    const params = { category_ids: 'c-food', date_start: '2026-01-01', date_end: '2026-06-30' }
    const probes = planHidingProbes(params)
    expect(probes).toHaveLength(1)
    expect(probes[0]).toEqual({ cause: 'date', params: { category_ids: 'c-food' } })
  })

  it('treats needs_review as narrowing intent', () => {
    const params = { needs_review: true, exclude_payees: 'Amazon' }
    const probes = planHidingProbes(params)
    expect(probes).toHaveLength(1)
    expect(probes[0].cause).toBe('exclude')
    expect(probes[0].params).toEqual({ needs_review: true })
  })

  it('probes date, then exclude, then both when all are active', () => {
    const params = {
      quick_filter: 'amain',
      date_start: '2026-01-01', date_end: '2026-06-30',
      exclude_payees: 'Amazon', exclude_tag_ids: 't1',
    }
    const probes = planHidingProbes(params)
    expect(probes.map(p => p.cause)).toEqual(['date', 'exclude', 'filters'])
    // date probe keeps excludes; exclude probe keeps date; combined drops both.
    expect(probes[0].params).toEqual({ quick_filter: 'amain', exclude_payees: 'Amazon', exclude_tag_ids: 't1' })
    expect(probes[1].params).toEqual({ quick_filter: 'amain', date_start: '2026-01-01', date_end: '2026-06-30' })
    expect(probes[2].params).toEqual({ quick_filter: 'amain' })
  })

  it('ignores empty-string / null constraint values', () => {
    expect(planHidingProbes({ quick_filter: 'x', date_start: '', date_end: '', exclude_tag_ids: null })).toEqual([])
  })

  it('does not mutate the input params', () => {
    const params = { quick_filter: 'amain', date_start: '2026-01-01', date_end: '2026-06-30' }
    planHidingProbes(params)
    expect(params).toEqual({ quick_filter: 'amain', date_start: '2026-01-01', date_end: '2026-06-30' })
  })
})

describe('hidingNoteText / hidingActionLabel', () => {
  it('has text and a matching action for each cause', () => {
    for (const cause of ['date', 'exclude', 'filters']) {
      expect(hidingNoteText(cause)).toEqual(expect.any(String))
      expect(hidingActionLabel(cause)).toEqual(expect.any(String))
    }
  })
  it('returns null for an unknown cause', () => {
    expect(hidingNoteText('nope')).toBeNull()
    expect(hidingActionLabel('nope')).toBeNull()
  })
})
