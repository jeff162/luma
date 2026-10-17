// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * Pure helpers for the Rules page's search + facet filter + A–Z sectioning. Kept free of React/DOM so the
 * matching semantics are unit-testable and the page component stays thin.
 *
 * Two independent narrowing tools, mirroring the Transactions page's split:
 *   - `search` — free text matched ONLY against the rule's merchant matcher (keyword / clauses). This is
 *     the "find my Starbucks rule" path; category/tags deliberately stay out of it so it can't flood.
 *   - `facets` — a structured subset filter (category / tag / owner / account / account type + boolean
 *     flags). Search runs within the faceted subset.
 * Both are AND-combined; within a multi-value facet, membership is OR.
 */

import { ruleMatcherLists } from './ruleMatcher.js'

// The rail shows every letter always (present ones are active, absent ones dim). '#' collects rules whose
// keyword starts with a digit or symbol; it sorts last, matching where such keywords land in keyword-ASC.
export const RAIL_LETTERS = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ', '#']

export function emptyRulesFacets() {
  return {
    categoryIds: [],
    // Selected category *groups*. A group selection matches any rule assigning a leaf under it; the page
    // expands groupIds to their leaf ids and unions them into the category match (see filterRules usage),
    // so ruleMatchesFacets itself only ever sees leaf categoryIds.
    groupIds: [],
    tagIds: [],
    ownerIds: [],
    accountIds: [],
    accountTypes: [],
    recurring: false,
    hasRename: false,
    matchSourceText: false,
    noCategory: false, // tag/rename-only rules (no category assigned)
  }
}

export function activeRulesFacetCount(facets) {
  const f = facets || {}
  return (
    (f.categoryIds?.length ? 1 : 0) +
    (f.groupIds?.length ? 1 : 0) +
    (f.tagIds?.length ? 1 : 0) +
    (f.ownerIds?.length ? 1 : 0) +
    (f.accountIds?.length ? 1 : 0) +
    (f.accountTypes?.length ? 1 : 0) +
    (f.recurring ? 1 : 0) +
    (f.hasRename ? 1 : 0) +
    (f.matchSourceText ? 1 : 0) +
    (f.noCategory ? 1 : 0)
  )
}

export function hasActiveRulesFacets(facets) {
  return activeRulesFacetCount(facets) > 0
}

// The text a search query is matched against: every text in the rule's merchant matcher. Merchant
// only — never the category/rename/tags, which are facet concerns.
export function ruleSearchHaystack(rule) {
  const { alternatives, filters } = ruleMatcherLists(rule)
  return [...alternatives, ...filters].join(' ').toLowerCase()
}

export function ruleMatchesSearch(rule, query) {
  const q = (query || '').trim().toLowerCase()
  if (!q) return true
  return ruleSearchHaystack(rule).includes(q)
}

export function ruleMatchesFacets(rule, facets) {
  const f = facets || {}
  if (f.categoryIds?.length && !f.categoryIds.includes(rule.category_id)) return false
  if (f.tagIds?.length && !(rule.tag_ids || []).some(id => f.tagIds.includes(id))) return false
  if (f.ownerIds?.length && !f.ownerIds.includes(rule.owner_id)) return false
  if (f.accountIds?.length && !f.accountIds.includes(rule.account_id)) return false
  if (f.accountTypes?.length && !f.accountTypes.includes(rule.account_type)) return false
  if (f.recurring && !rule.is_recurring) return false
  if (f.hasRename && !(rule.clean_name && String(rule.clean_name).trim())) return false
  if (f.matchSourceText && !rule.match_source_text) return false
  if (f.noCategory && rule.category_id) return false
  return true
}

export function filterRules(rules, query, facets) {
  return (rules || []).filter(rule => ruleMatchesSearch(rule, query) && ruleMatchesFacets(rule, facets))
}

// The A–Z section a rule falls under — the first letter of its (derived) keyword, which is also the
// backend's sort key, so walking the pre-sorted list yields contiguous sections.
export function ruleSectionLetter(rule) {
  const keyword = String(rule.keyword || '').trim()
  const first = keyword ? keyword[0].toUpperCase() : '#'
  return /[A-Z]/.test(first) ? first : '#'
}

// Flatten a (pre-sorted) rule list into a mixed stream of section headers and rules, for a single
// windowed list: [{ type:'header', letter }, { type:'rule', rule }, …].
export function buildSectionedRuleItems(rules) {
  const items = []
  let current = null
  for (const rule of rules || []) {
    const letter = ruleSectionLetter(rule)
    if (letter !== current) {
      items.push({ type: 'header', letter })
      current = letter
    }
    items.push({ type: 'rule', rule })
  }
  return items
}

// Letters that have at least one rule in the given set — active (jumpable) letters in the rail.
export function presentSectionLetters(rules) {
  const present = new Set()
  for (const rule of rules || []) present.add(ruleSectionLetter(rule))
  return present
}

// Map of letter -> item index of its header, so the rail can scrollToIndex a section.
export function sectionHeaderIndexByLetter(items) {
  const map = {}
  items.forEach((item, index) => {
    if (item.type === 'header') map[item.letter] = index
  })
  return map
}
