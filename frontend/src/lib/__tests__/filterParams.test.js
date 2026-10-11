import { describe, it, expect } from 'vitest'
import { FILTER_FACETS, selectionsOfType, selectionsToParams } from '../filterParams.js'

/*
 * The chip row is the only place a filter selection lives, and this module is the only translation of
 * it into API parameters. What these guard is the pair of things that were previously re-decided at
 * each of four call sites: that a chip's *mode* picks which parameter it lands in, and that the payee
 * facet keeps its two differences (keyed by label, joined with a pipe) wherever it is read.
 */

const sel = (type, id, extra = {}) => ({ type, id, label: id, value: id, ...extra })

describe('selectionsToParams', () => {
  it('sends nothing for an empty chip row', () => {
    const params = selectionsToParams([])
    for (const facet of FILTER_FACETS) {
      expect(params[facet.include]).toBeUndefined()
      expect(params[facet.exclude]).toBeUndefined()
    }
  })

  it('treats a chip with no explicit mode as include', () => {
    // addSelection defaults mode to 'include', but a selection built elsewhere may omit it entirely;
    // defaulting the other way would silently invert what the user picked.
    expect(selectionsToParams([sel('tag', 't1')]).tag_ids).toBe('t1')
    expect(selectionsToParams([sel('tag', 't1')]).exclude_tag_ids).toBeUndefined()
  })

  it('routes each mode to its own parameter, for every facet', () => {
    for (const facet of FILTER_FACETS) {
      const key = facet.valueKey || 'id'
      const included = sel(facet.type, 'keep', { mode: 'include' })
      const excluded = sel(facet.type, 'drop', { mode: 'exclude' })
      const params = selectionsToParams([included, excluded])
      expect(params[facet.include]).toBe(included[key])
      expect(params[facet.exclude]).toBe(excluded[key])
    }
  })

  it('joins several values within one facet', () => {
    const params = selectionsToParams([
      sel('category', 'c1', { mode: 'include' }),
      sel('category', 'c2', { mode: 'include' }),
    ])
    expect(params.category_ids).toBe('c1,c2')
  })

  it('keys payees by label and joins them with a pipe', () => {
    // Both differences matter: the chips carry canonicalized merchant names rather than ids, and a
    // payee name may legitimately contain a comma, which is why this facet is not comma-separated.
    const params = selectionsToParams([
      { type: 'payee', id: 'payee:Acme, Inc.', label: 'Acme, Inc.', mode: 'include' },
      { type: 'payee', id: 'payee:Beta', label: 'Beta', mode: 'include' },
    ])
    expect(params.payees).toBe('Acme, Inc.|Beta')
  })

  it('carries the synthetic bucket ids through untouched', () => {
    // Uncategorized / Untagged / Recurring are resolved by the backend's membership builders; the
    // frontend must not special-case or drop them on the way out.
    const params = selectionsToParams([
      sel('category', '__uncategorized_expense__', { mode: 'include' }),
      sel('tag', '__untagged__', { mode: 'exclude' }),
    ])
    expect(params.category_ids).toBe('__uncategorized_expense__')
    expect(params.exclude_tag_ids).toBe('__untagged__')
  })

  it('ignores chips of other facets when reading one', () => {
    const selections = [sel('account', 'a1', { mode: 'include' }), sel('owner', 'o1', { mode: 'include' })]
    expect(selectionsOfType(selections, 'account').map(s => s.id)).toEqual(['a1'])
    expect(selectionsOfType(selections, 'account', { exclude: true })).toEqual([])
  })
})
