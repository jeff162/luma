// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * A rule's merchant matcher as the two lists the rules API returns: `alternatives`, at least one of which
 * must appear (empty, or two or more), and `filters` (the API's `clauses`), every one of which must also
 * appear. A value seeded from a transaction carries only a `keyword`, which is a single filter. Every
 * surface that shows, searches or edits a matcher reads it through here, so they agree on its shape.
 */

// A lone alternative is a filter, as the backend stores it, so an editor's draft reads the same way the
// saved rule will.
export function ruleMatcherLists(rule) {
  let alternatives = (Array.isArray(rule?.alternatives) ? rule.alternatives : []).filter(Boolean)
  const clauses = Array.isArray(rule?.clauses) ? rule.clauses.filter(Boolean) : []
  let filters = clauses.length || alternatives.length ? clauses : (rule?.keyword ? [rule.keyword] : [])
  if (alternatives.length === 1) {
    filters = [alternatives[0], ...filters]
    alternatives = []
  }
  return { alternatives, filters }
}

// The matcher as a sequence of terms to render: each carries the joiner before it ("or" within the
// alternatives, "and" before a filter) and whether it opens or closes the bracketed alternatives, which
// are bracketed only when filters follow them.
export function ruleMatcherTerms(rule) {
  const { alternatives, filters } = ruleMatcherLists(rule)
  const bracket = alternatives.length > 0 && filters.length > 0
  const terms = alternatives.map((text, i) => ({
    text,
    joiner: i > 0 ? 'or' : null,
    open: bracket && i === 0,
    close: bracket && i === alternatives.length - 1,
  }))
  filters.forEach(text => terms.push({ text, joiner: terms.length ? 'and' : null, open: false, close: false }))
  return terms
}

// The matcher as one line of text: `northgate or nrthgt`, `(northgate or nrthgt) and market`.
export function formatRuleMatcher(rule) {
  return ruleMatcherTerms(rule)
    .map(term => `${term.joiner ? `${term.joiner} ` : ''}${term.open ? '(' : ''}${term.text}${term.close ? ')' : ''}`)
    .join(' ')
}
