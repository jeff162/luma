import { describe, expect, it } from 'vitest'
import {
  getInWindowPendingSuggestionGroups,
  getRuleSuggestionMerchantGroupLabel,
  suggestionSelectionChanged,
} from '../importRuleSuggestions.js'

describe('import rule suggestion grouping', () => {
  it('labels a merchant group by its merchant label, falling back to the keyword', () => {
    expect(getRuleSuggestionMerchantGroupLabel({ merchant_label: 'Riverstone', keyword: 'riverstone renewal' })).toBe('Riverstone')
    expect(getRuleSuggestionMerchantGroupLabel({ keyword: 'riverstone' })).toBe('riverstone')
  })
})

describe('import rule suggestion selection edits', () => {
  const walgreensSuggestion = {
    keyword: 'walgreens',
    owner_id: null,
    account_id: null,
    amount_min: null,
    amount_max: null,
    match_source_text: false,
    target_category_id: 'pharmacy',
    clean_name_suggestion: 'WALGREENS',
  }

  it('treats adding an owner as a selection change that needs regeneration', () => {
    expect(suggestionSelectionChanged(walgreensSuggestion, {
      keyword: 'walgreens',
      owner_id: 2,
      account_id: null,
      amount_min: null,
      amount_max: null,
      match_source_text: false,
      target_category_id: 'pharmacy',
      clean_name: 'WALGREENS',
    })).toBe(true)
  })

  it('does not regenerate for action-only edits', () => {
    expect(suggestionSelectionChanged(walgreensSuggestion, {
      keyword: 'walgreens',
      owner_id: null,
      account_id: null,
      amount_min: null,
      amount_max: null,
      match_source_text: false,
      target_category_id: 'groceries',
      clean_name: 'WALGREENS PHARMACY',
    })).toBe(false)
  })

  it('treats empty optional matcher fields as unchanged null values', () => {
    expect(suggestionSelectionChanged(walgreensSuggestion, {
      keyword: ' walgreens ',
      owner_id: '',
      account_id: '',
      amount_min: '',
      amount_max: '',
      match_source_text: false,
    })).toBe(false)
  })
})

// Group identity comes from the backend (`review_group_id`); these cases cover only how the lens uses it.
describe('import rule suggestion lookback grouping', () => {
  const splitGroupId = 'split:walgreens:__global__:split-root'

  it('keeps an older pending remainder in the active group when a sibling is in-window', () => {
    const groups = getInWindowPendingSuggestionGroups([
      { id: 'refined', review_status: 'pending', review_group_id: splitGroupId, latest_txn_date: '2026-04-26' },
      { id: 'followup', review_status: 'pending', review_group_id: splitGroupId, latest_txn_date: '2022-10-23' },
    ], '2024-06-27')

    expect(groups.has(splitGroupId)).toBe(true)
  })

  it('keeps an older pending remainder active after the recent sibling is accepted', () => {
    const groups = getInWindowPendingSuggestionGroups([
      { id: 'refined', review_status: 'accepted', review_group_id: splitGroupId, latest_txn_date: '2026-04-26' },
      { id: 'followup', review_status: 'pending', review_group_id: splitGroupId, latest_txn_date: '2022-10-23' },
    ], '2024-06-27')

    expect(groups.has(splitGroupId)).toBe(true)
  })

  it('keeps an older pending merchant active while a recent discarded sibling is still visible', () => {
    const groups = getInWindowPendingSuggestionGroups([
      { id: 'national-grid:owner-a', review_status: 'discarded', review_group_id: 'merchant:national grid', latest_txn_date: '2026-03-26' },
      { id: 'national-grid:shared', review_status: 'pending', review_group_id: 'merchant:national grid', latest_txn_date: '2023-12-15' },
    ], '2024-06-27')

    expect(groups.has('merchant:national grid')).toBe(true)
  })

  it('does not let an accepted unrelated group pull a stale pending group into the active lens', () => {
    const groups = getInWindowPendingSuggestionGroups([
      { id: 'recent-accepted', review_status: 'accepted', review_group_id: 'merchant:recent accepted', latest_txn_date: '2026-04-26' },
      { id: 'old-merchant', review_status: 'pending', review_group_id: 'merchant:old merchant', latest_txn_date: '2022-10-23' },
    ], '2024-06-27')

    expect(groups.has('merchant:old merchant')).toBe(false)
    expect(groups.has('merchant:recent accepted')).toBe(false)
  })

  it('leaves a fully stale pending group out of the active lens', () => {
    const groups = getInWindowPendingSuggestionGroups([
      { id: 'old-merchant', review_status: 'pending', review_group_id: 'merchant:old merchant', latest_txn_date: '2022-10-23' },
    ], '2024-06-27')

    expect(groups.has('merchant:old merchant')).toBe(false)
  })
})
