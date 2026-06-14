// The imported-category scope settings must agree across the import preview, saved-profile summaries,
// and the per-batch settings dialog. extractImportedCategorySettings is the cross-shape reconciler
// (direct key vs nested column_map vs flat batch fields), and the scope tokens identify the
// owner/account buckets the dedupe + categorization scope keys off — both are easy to break silently.

import { describe, it, expect } from 'vitest'
import {
  getBlankImportedCategorySettings,
  normalizeImportedCategorySettings,
  extractImportedCategorySettings,
  dedupeStringList,
  getFixedAccountCategoryScopeToken,
  getNewAccountCategoryScopeToken,
  summarizeImportedCategorySettings,
} from '../importedCategorySettings.js'
import {
  IMPORTED_CATEGORY_SCOPE_ALL,
  IMPORTED_CATEGORY_SCOPE_FILTERED,
  IMPORTED_CATEGORY_SETTINGS_KEY,
  IMPORTED_CATEGORY_SCOPE_ALL_LABEL,
} from '../constants.js'

describe('dedupeStringList', () => {
  it('trims, drops empties, dedupes, and preserves first-seen order', () => {
    expect(dedupeStringList([' a ', 'b', 'a', '', '  ', 'b', 'c'])).toEqual(['a', 'b', 'c'])
    expect(dedupeStringList(null)).toEqual([])
  })
})

describe('normalizeImportedCategorySettings', () => {
  it('coerces an unknown scope_mode to ALL and dedupes the lists', () => {
    const n = normalizeImportedCategorySettings({ scope_mode: 'bogus', owner_ids: ['x', 'x'], unassigned_account_tokens: ['t', ' t '] })
    expect(n.scope_mode).toBe(IMPORTED_CATEGORY_SCOPE_ALL)
    expect(n.owner_ids).toEqual(['x'])
    expect(n.unassigned_account_tokens).toEqual(['t'])
  })

  it('preserves FILTERED scope and tolerates a non-object', () => {
    expect(normalizeImportedCategorySettings({ scope_mode: IMPORTED_CATEGORY_SCOPE_FILTERED }).scope_mode)
      .toBe(IMPORTED_CATEGORY_SCOPE_FILTERED)
    expect(normalizeImportedCategorySettings(undefined)).toEqual(getBlankImportedCategorySettings())
  })
})

describe('extractImportedCategorySettings precedence', () => {
  const filtered = { scope_mode: IMPORTED_CATEGORY_SCOPE_FILTERED, owner_ids: ['o1'], unassigned_account_tokens: [] }

  it('prefers the direct settings key', () => {
    const out = extractImportedCategorySettings({ [IMPORTED_CATEGORY_SETTINGS_KEY]: filtered })
    expect(out.scope_mode).toBe(IMPORTED_CATEGORY_SCOPE_FILTERED)
    expect(out.owner_ids).toEqual(['o1'])
  })

  it('falls back to the nested column_map key', () => {
    const out = extractImportedCategorySettings({ column_map: { [IMPORTED_CATEGORY_SETTINGS_KEY]: filtered } })
    expect(out.owner_ids).toEqual(['o1'])
  })

  it('falls back to the flat per-batch fields', () => {
    const out = extractImportedCategorySettings({
      imported_category_scope_mode: IMPORTED_CATEGORY_SCOPE_FILTERED,
      imported_category_owner_ids: ['o2', 'o2'],
      imported_category_unassigned_account_tokens: ['tok'],
    })
    expect(out.scope_mode).toBe(IMPORTED_CATEGORY_SCOPE_FILTERED)
    expect(out.owner_ids).toEqual(['o2'])
    expect(out.unassigned_account_tokens).toEqual(['tok'])
  })

  it('returns the blank default for an empty/invalid source', () => {
    expect(extractImportedCategorySettings(null)).toEqual(getBlankImportedCategorySettings())
  })
})

describe('scope token generators', () => {
  it('fixed-account token is prefixed and empty-safe', () => {
    expect(getFixedAccountCategoryScopeToken('acc-1')).toMatch(/acc-1$/)
    expect(getFixedAccountCategoryScopeToken('  ')).toBe('')
  })

  it('new-account token lowercases and collapses whitespace so labels resolve to one bucket', () => {
    expect(getNewAccountCategoryScopeToken('  My   Checking ')).toBe(getNewAccountCategoryScopeToken('my checking'))
    expect(getNewAccountCategoryScopeToken('')).toBe('')
  })
})

describe('summarizeImportedCategorySettings', () => {
  const choices = [
    { key: 'owner:o1', label: 'Alice' },
    { key: 'owner:o2', label: 'Bob' },
    { key: 'account:t1', label: 'Checking' },
  ]

  it('shows the all-scope label in ALL mode (or nothing when hidden)', () => {
    expect(summarizeImportedCategorySettings({ scope_mode: IMPORTED_CATEGORY_SCOPE_ALL }, choices)).toBe(IMPORTED_CATEGORY_SCOPE_ALL_LABEL)
    expect(summarizeImportedCategorySettings({ scope_mode: IMPORTED_CATEGORY_SCOPE_ALL }, choices, { hideAllScopeLabel: true })).toBe('')
  })

  it('lists the COMPLEMENT (excluded) of the included keys in FILTERED mode', () => {
    const out = summarizeImportedCategorySettings(
      { scope_mode: IMPORTED_CATEGORY_SCOPE_FILTERED, owner_ids: ['o1'], unassigned_account_tokens: ['t1'] },
      choices,
    )
    // included = Alice + Checking; complement = Bob
    expect(out).toBe('Excluding: Bob')
  })

  it('is empty when everything is included, and prompts when nothing is chosen with no choices', () => {
    const allIncluded = summarizeImportedCategorySettings(
      { scope_mode: IMPORTED_CATEGORY_SCOPE_FILTERED, owner_ids: ['o1', 'o2'], unassigned_account_tokens: ['t1'] },
      choices,
    )
    expect(allIncluded).toBe('')
    expect(summarizeImportedCategorySettings({ scope_mode: IMPORTED_CATEGORY_SCOPE_FILTERED }, [])).toMatch(/No owners or unassigned accounts/)
  })
})
