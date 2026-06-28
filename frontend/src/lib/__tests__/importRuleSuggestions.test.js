import { describe, expect, it } from 'vitest'
import {
  getInWindowPendingSuggestionGroups,
  getRuleSuggestionMerchantGroupKey,
  getRuleSuggestionMerchantGroupLabel,
  getRuleSuggestionSplitRootIds,
  suggestionSelectionChanged,
} from '../importRuleSuggestions.js'

describe('import rule suggestion grouping', () => {
  it('keeps refined keyword variants in the same displayed merchant group', () => {
    const broad = {
      id: 'american-express-credit-card',
      merchant_label: 'Riverstone',
      keyword: 'riverstone',
    }
    const refined = {
      id: 'american-express-membership',
      merchant_label: 'Riverstone',
      keyword: 'riverstone renewal',
    }

    expect(getRuleSuggestionMerchantGroupKey(refined)).toBe(getRuleSuggestionMerchantGroupKey(broad))
    expect(getRuleSuggestionMerchantGroupLabel(refined)).toBe('Riverstone')
  })

  it('keeps one conflict set together even when sampled merchant labels differ', () => {
    const conflictGroupId = '7-eleven:fa82f180-0ca2-4e85-991b-3f723d20b874'
    const broadSibling = {
      id: '7-eleven-general',
      merchant_label: '7-Eleven',
      keyword: '7-eleven',
    }
    const firstConflictMember = {
      id: '7-eleven-gas',
      merchant_label: '7-Eleven Store 402',
      keyword: '7-eleven',
      conflict_group_id: conflictGroupId,
    }
    const secondConflictMember = {
      id: '7-eleven-food',
      merchant_label: '7-Eleven',
      keyword: '7-eleven',
      conflict_group_id: conflictGroupId,
    }

    expect(getRuleSuggestionMerchantGroupKey(firstConflictMember)).toBe(getRuleSuggestionMerchantGroupKey(secondConflictMember))
    expect(getRuleSuggestionMerchantGroupKey(firstConflictMember)).toBe(getRuleSuggestionMerchantGroupKey(broadSibling))
  })

  it('falls back to keyword when no merchant label is available', () => {
    expect(getRuleSuggestionMerchantGroupKey({ id: 'one', keyword: '  Stop   & Shop  ' })).toBe('keyword:stop & shop')
  })

  it('keeps a refined split and its follow-up together even when display labels differ', () => {
    const refined = {
      id: 'walgreens:__global__:split-root',
      review_status: 'pending',
      merchant_label: 'Walgreens',
      keyword: 'walgreens',
      latest_txn_date: '2026-04-26',
      pending_override: true,
    }
    const followup = {
      id: 'walgreens:__global__:split-root:followup:walgreens:__global__:split-root',
      review_status: 'pending',
      merchant_label: 'WALGREENS #13081',
      keyword: 'walgreens',
      latest_txn_date: '2022-10-23',
    }
    const splitRootIds = getRuleSuggestionSplitRootIds([refined, followup])

    expect(getRuleSuggestionMerchantGroupKey(refined, splitRootIds)).toBe(getRuleSuggestionMerchantGroupKey(followup, splitRootIds))
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

describe('import rule suggestion lookback grouping', () => {
  it('keeps an older pending remainder in the active merchant group when a sibling is in-window', () => {
    const groups = getInWindowPendingSuggestionGroups([
      {
        id: 'walgreens:__global__:split-root',
        review_status: 'pending',
        merchant_label: 'Walgreens',
        keyword: 'walgreens',
        owner_id: 'frances',
        latest_txn_date: '2026-04-26',
        pending_override: true,
      },
      {
        id: 'walgreens:__global__:split-root:followup:walgreens:__global__:split-root',
        review_status: 'pending',
        merchant_label: 'WALGREENS #13081',
        keyword: 'walgreens',
        owner_id: 'jeff',
        latest_txn_date: '2022-10-23',
      },
    ], '2024-06-27')

    expect(groups.has('split:walgreens:__global__:split-root')).toBe(true)
  })

  it('keeps an older pending split remainder active after the recent sibling is accepted', () => {
    const groups = getInWindowPendingSuggestionGroups([
      {
        id: 'walgreens:__global__:split-root',
        review_status: 'accepted',
        merchant_label: 'Walgreens',
        keyword: 'walgreens',
        owner_id: 'frances',
        latest_txn_date: '2026-04-26',
        pending_override: true,
      },
      {
        id: 'walgreens:__global__:split-root:followup:walgreens:__global__:split-root',
        review_status: 'pending',
        merchant_label: 'WALGREENS #13081',
        keyword: 'walgreens',
        owner_id: 'jeff',
        latest_txn_date: '2022-10-23',
      },
    ], '2024-06-27')

    expect(groups.has('split:walgreens:__global__:split-root')).toBe(true)
  })

  it('keeps an older pending merchant active while a recent same-merchant sibling is still visible', () => {
    const groups = getInWindowPendingSuggestionGroups([
      {
        id: 'national-grid:jeff',
        review_status: 'discarded',
        merchant_label: 'National Grid',
        keyword: 'national grid',
        owner_id: 'jeff',
        latest_txn_date: '2026-03-26',
      },
      {
        id: 'national-grid:shared',
        review_status: 'pending',
        merchant_label: 'National Grid',
        keyword: 'national grid',
        owner_id: 'shared',
        latest_txn_date: '2023-12-15',
      },
    ], '2024-06-27')

    expect(groups.has('merchant:national grid')).toBe(true)
  })

  it('does not let an accepted unrelated merchant pull a stale pending merchant into the active lens', () => {
    const groups = getInWindowPendingSuggestionGroups([
      {
        id: 'recent-accepted',
        review_status: 'accepted',
        merchant_label: 'Recent Accepted',
        keyword: 'recent accepted',
        latest_txn_date: '2026-04-26',
      },
      {
        id: 'old-merchant',
        review_status: 'pending',
        merchant_label: 'Old Merchant',
        keyword: 'old merchant',
        latest_txn_date: '2022-10-23',
      },
    ], '2024-06-27')

    expect(groups.has('merchant:old merchant')).toBe(false)
    expect(groups.has('merchant:recent accepted')).toBe(false)
  })

  it('leaves a fully stale pending merchant group out of the active lens', () => {
    const groups = getInWindowPendingSuggestionGroups([
      {
        id: 'old-merchant',
        review_status: 'pending',
        merchant_label: 'Old Merchant',
        keyword: 'old merchant',
        latest_txn_date: '2022-10-23',
      },
    ], '2024-06-27')

    expect(groups.has('merchant:old merchant')).toBe(false)
  })
})
