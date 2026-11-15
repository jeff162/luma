// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * One rule rendered compactly, for the surfaces that list rules *about* something rather than for
 * editing them (the stale-rule cleanup, the overlap check). The matcher reads as monospace terms
 * (`RuleMatcherText`); the rule's actions — category, tags, rename, recurring, alert — follow as badges.
 *
 * It works from a rule row alone. Both `/rules` and the rule-display SQL behind the cleanup and overlap
 * endpoints return the resolved `owner_name` / `account_name` / `account_mask` / `category_name`
 * alongside the ids, so nothing here needs the page's owners and accounts arrays — a presenter that had
 * to be handed those lists would render an empty scope when one of them had not loaded yet.
 *
 * `showConditions` is opt-in because the two callers genuinely differ: the cleanup review is asking
 * "is this rule still wanted", where scope is noise, while the overlap check is asking "why do these
 * two contend", where scope is the whole answer.
 */

import { Badge } from './ui.jsx'
import { TagBadge } from './TagUi.jsx'
import { amountConditionSummary } from './RuleForm.jsx'
import { ACCOUNT_TYPE_LABEL } from '../lib/accountTypes.js'
import { ruleMatcherTerms } from '../lib/ruleMatcher.js'
import { isLowPriority } from '../lib/rulePriority.js'

// The rule's scope clauses as plain sentence fragments, in the order the rule form presents them.
function ruleConditionParts(rule) {
  const parts = []
  const amount = amountConditionSummary(rule.amount_min, '>=', rule.amount_max, '<=', rule.debit_credit || 'both')
  if (amount) parts.push(amount)
  if (rule.owner_name) parts.push(`owner is ${rule.owner_name}`)
  if (rule.account_name) parts.push(`account is ${rule.account_name}${rule.account_mask ? ` •••${rule.account_mask}` : ''}`)
  if (rule.account_type) parts.push(`account type is ${ACCOUNT_TYPE_LABEL[rule.account_type] ?? rule.account_type}`)
  if (rule.match_source_text) parts.push('matches source text')
  return parts
}

const joinerStyle = { color: 'var(--muted)', fontWeight: 400 }

// The matcher as monospace terms: alternatives joined by "or" (bracketed when filters follow), then
// filters joined by "and". Shared by every surface that lists rules, so a matcher reads one way. A rule
// with no merchant text matches every merchant in its scope.
export function RuleMatcherText({ rule }) {
  const terms = ruleMatcherTerms(rule)
  if (!terms.length) return <span style={{ fontStyle: 'italic' }}>any merchant</span>
  return (
    <>
      {terms.map((term, i) => (
        <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          {term.joiner ? <span style={joinerStyle}>{term.joiner}</span> : null}
          <span style={{ fontFamily: 'monospace', fontWeight: 500 }}>
            {term.open ? <span style={joinerStyle}>(</span> : null}
            {term.text}
            {term.close ? <span style={joinerStyle}>)</span> : null}
          </span>
        </span>
      ))}
    </>
  )
}

export default function RuleSummary({ rule, showConditions = false }) {
  const conditions = showConditions ? ruleConditionParts(rule) : []
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 13, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '2px 6px' }}>
        <RuleMatcherText rule={rule} />
        {rule.category_name ? <Badge label={rule.category_name} toneKey={rule.category_id || rule.category_name} /> : null}
        {Array.isArray(rule.tags) && rule.tags.map(tag => <TagBadge key={tag.id} tag={tag} />)}
        {rule.clean_name ? <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>renames to “{rule.clean_name}”</span> : null}
        {rule.is_recurring ? <span style={{ fontSize: 11, color: 'var(--muted)' }} title="Tracked as a recurring series">↻ recurring</span> : null}
        {rule.alert ? <span style={{ fontSize: 11, color: 'var(--muted)' }} title={rule.alert_message || 'Raises a task when a matching transaction arrives'}>⚑ alert</span> : null}
        {isLowPriority(rule) ? <span style={{ fontSize: 11, color: 'var(--muted)' }} title="Gives way to normal-priority rules matching the same transaction">low priority</span> : null}
      </div>
      {conditions.length ? (
        <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>{conditions.join(' · ')}</div>
      ) : null}
    </div>
  )
}
