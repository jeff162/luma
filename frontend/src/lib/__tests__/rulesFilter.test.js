// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from 'vitest'
import {
  emptyRulesFacets, activeRulesFacetCount, hasActiveRulesFacets,
  ruleMatchesSearch, ruleMatchesFacets, filterRules,
  ruleSectionLetter, buildSectionedRuleItems, presentSectionLetters, sectionHeaderIndexByLetter,
} from '../rulesFilter.js'

const rule = (over = {}) => ({
  id: over.id || 'r', keyword: 'starbucks', clauses: ['starbucks'],
  category_id: null, category_name: null, tag_ids: [], tags: [],
  owner_id: null, account_id: null, account_type: null, clean_name: null,
  is_recurring: 0, match_source_text: 0, ...over,
})

describe('search', () => {
  it('matches the single keyword, case-insensitively', () => {
    expect(ruleMatchesSearch(rule(), 'STAR')).toBe(true)
    expect(ruleMatchesSearch(rule(), 'xyz')).toBe(false)
  })
  it('matches any clause of a multi-clause rule', () => {
    const r = rule({ keyword: 'amazon flash', clauses: ['amazon', 'flash'] })
    expect(ruleMatchesSearch(r, 'flash')).toBe(true)
    expect(ruleMatchesSearch(r, 'amazon')).toBe(true)
  })
  it('empty query matches everything', () => {
    expect(ruleMatchesSearch(rule(), '   ')).toBe(true)
  })
  it('does not match the category or rename (merchant-only search)', () => {
    const r = rule({ category_name: 'Streaming', clean_name: 'Coffee' })
    expect(ruleMatchesSearch(r, 'streaming')).toBe(false)
    expect(ruleMatchesSearch(r, 'coffee')).toBe(false)
  })
})

describe('facets', () => {
  it('category facet is membership', () => {
    expect(ruleMatchesFacets(rule({ category_id: 'c1' }), { ...emptyRulesFacets(), categoryIds: ['c1'] })).toBe(true)
    expect(ruleMatchesFacets(rule({ category_id: 'c2' }), { ...emptyRulesFacets(), categoryIds: ['c1'] })).toBe(false)
  })
  it('tag facet matches on intersection', () => {
    expect(ruleMatchesFacets(rule({ tag_ids: ['t1', 't2'] }), { ...emptyRulesFacets(), tagIds: ['t2'] })).toBe(true)
    expect(ruleMatchesFacets(rule({ tag_ids: ['t1'] }), { ...emptyRulesFacets(), tagIds: ['t2'] })).toBe(false)
  })
  it('boolean facets', () => {
    expect(ruleMatchesFacets(rule({ is_recurring: 1 }), { ...emptyRulesFacets(), recurring: true })).toBe(true)
    expect(ruleMatchesFacets(rule({ is_recurring: 0 }), { ...emptyRulesFacets(), recurring: true })).toBe(false)
    expect(ruleMatchesFacets(rule({ clean_name: 'X' }), { ...emptyRulesFacets(), hasRename: true })).toBe(true)
    expect(ruleMatchesFacets(rule({ clean_name: '' }), { ...emptyRulesFacets(), hasRename: true })).toBe(false)
    expect(ruleMatchesFacets(rule({ category_id: null }), { ...emptyRulesFacets(), noCategory: true })).toBe(true)
    expect(ruleMatchesFacets(rule({ category_id: 'c' }), { ...emptyRulesFacets(), noCategory: true })).toBe(false)
  })
  it('multiple facet groups are AND-combined', () => {
    const f = { ...emptyRulesFacets(), categoryIds: ['c1'], recurring: true }
    expect(ruleMatchesFacets(rule({ category_id: 'c1', is_recurring: 1 }), f)).toBe(true)
    expect(ruleMatchesFacets(rule({ category_id: 'c1', is_recurring: 0 }), f)).toBe(false)
  })
  it('active facet count and hasActive', () => {
    expect(activeRulesFacetCount(emptyRulesFacets())).toBe(0)
    expect(hasActiveRulesFacets(emptyRulesFacets())).toBe(false)
    const f = { ...emptyRulesFacets(), categoryIds: ['c1'], recurring: true }
    expect(activeRulesFacetCount(f)).toBe(2)
    expect(hasActiveRulesFacets(f)).toBe(true)
  })
  it('counts a group facet', () => {
    expect(activeRulesFacetCount({ ...emptyRulesFacets(), groupIds: ['g1'] })).toBe(1)
  })
})

describe('filterRules combines search AND facets', () => {
  const rules = [
    rule({ id: 'a', keyword: 'starbucks', clauses: ['starbucks'], category_id: 'coffee' }),
    rule({ id: 'b', keyword: 'netflix', clauses: ['netflix'], category_id: 'stream', is_recurring: 1 }),
  ]
  it('search only', () => {
    expect(filterRules(rules, 'net', emptyRulesFacets()).map(r => r.id)).toEqual(['b'])
  })
  it('facet only', () => {
    expect(filterRules(rules, '', { ...emptyRulesFacets(), recurring: true }).map(r => r.id)).toEqual(['b'])
  })
  it('search and facet together', () => {
    expect(filterRules(rules, 'star', { ...emptyRulesFacets(), recurring: true })).toEqual([])
  })
})

describe('sectioning', () => {
  it('section letter is the first letter of the keyword, # for non-letters', () => {
    expect(ruleSectionLetter(rule({ keyword: 'netflix' }))).toBe('N')
    expect(ruleSectionLetter(rule({ keyword: '7-eleven' }))).toBe('#')
    expect(ruleSectionLetter(rule({ keyword: '' }))).toBe('#')
  })
  it('builds a header/rule stream with one header per contiguous letter', () => {
    const rules = [
      rule({ id: 'n1', keyword: 'netflix' }),
      rule({ id: 'n2', keyword: 'nordstrom' }),
      rule({ id: 'p1', keyword: 'paypal' }),
    ]
    const items = buildSectionedRuleItems(rules)
    expect(items.map(i => i.type === 'header' ? `#${i.letter}` : i.rule.id))
      .toEqual(['#N', 'n1', 'n2', '#P', 'p1'])
  })
  it('present letters and header index map', () => {
    const rules = [rule({ id: 'n1', keyword: 'netflix' }), rule({ id: 'p1', keyword: 'paypal' })]
    const items = buildSectionedRuleItems(rules)
    expect([...presentSectionLetters(rules)].sort()).toEqual(['N', 'P'])
    expect(sectionHeaderIndexByLetter(items)).toEqual({ N: 0, P: 2 })
  })
})
