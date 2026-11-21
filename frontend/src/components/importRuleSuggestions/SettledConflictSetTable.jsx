// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { TagBadge } from '../TagUi.jsx'
import { ReportArrowButton, SuggestionDispositionActions } from './suggestionPresentational.jsx'
import { formatSuggestionAmountLabel, getStatusPalette } from '../../lib/importRuleSuggestions.js'

/*
 * The settled-view counterpart to ConflictSetCard. Where the pending/conflicts views resolve a conflict
 * set as a unit through an interactive table (winner radio + editable targets), the already-dispositioned
 * views (accepted / deferred / discarded / total) tabulate the same set read-only: one row per member,
 * aligned `Rows` and `Category` columns under a single shared keyword/scope header, instead of stacking N
 * full cards. The per-row action cluster is the same `SuggestionDispositionActions` the card uses, so a
 * row button still acts on just that member (the documented invariant) — only the layout is denser.
 *
 *   - `total` view: a leading column shows each member's status icon (it mixes dispositions).
 *   - single-disposition views: no leading column, unless bulk mode is on, where it hosts the select box.
 *
 * Category and tags are read-only here; changing them stays on the card path / Open Rule Editor, since a
 * settled disposition is rarely re-targeted in place.
 */

// The narrowest this table can be without its rows spilling out of the card: the status column, Rows,
// Category at its floor and a pending member's action cluster, plus the card's padding. Measured in the
// total view, where all four are present, since the action labels fix it rather than the data. The page
// holds its whole column at this width, so every card fits it and nothing shows beside the sticky filters.
export const SETTLED_CONFLICT_TABLE_MIN_WIDTH = 550

const STATUS_META = {
  accepted: { tone: 'accepted', symbol: '✓', label: 'Accepted' },
  skipped: { tone: 'skipped', symbol: '?', label: 'Deferred' },
  discarded: { tone: 'discarded', symbol: '×', label: 'Removed' },
  pending: { tone: 'pending', symbol: '•', label: 'Pending' },
}

function StatusIcon({ status }) {
  const meta = STATUS_META[status] || STATUS_META.pending
  const palette = getStatusPalette(meta.tone)
  return (
    <span
      title={meta.label}
      aria-label={meta.label}
      style={{
        width: 22,
        height: 22,
        borderRadius: 999,
        border: `1px solid ${palette.border}`,
        background: palette.background,
        color: palette.color,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: status === 'discarded' ? 13 : 11.5,
        fontWeight: 700,
        lineHeight: 1,
      }}
    >
      {meta.symbol}
    </span>
  )
}

function formatCategoryChangeHint(reviewAction) {
  const changes = Array.isArray(reviewAction?.category_changes)
    ? reviewAction.category_changes
    : []
  const formerNames = [...new Set(
    changes
      .map(change => String(change.from_category_name || '').trim())
      .filter(Boolean),
  )]
  if (!formerNames.length) return ''
  if (formerNames.length === 1) return `was ${formerNames[0]}`
  return `was ${formerNames.slice(0, 2).join(', ')}${formerNames.length > 2 ? ` +${formerNames.length - 2}` : ''}`
}

export function SettledConflictSetTable({
  members,
  showStatusColumn = false,
  bulkMode = false,
  selectedSuggestionIds,
  getSuggestionKey,
  onToggleSelection,
  getResolvedSuggestion,
  tags = [],
  editingSuggestionId,
  onOpenReport,
  onEditSuggestion,
  runRowStatusAction,
  runRowSaveAction,
  onRejectSuggestionDisposition,
}) {
  if (!members?.length) return null

  const lead = getResolvedSuggestion(members[0])
  const merchant = lead.merchant_label || lead.keyword || 'this merchant'
  const totalRows = members.reduce((sum, m) => sum + (m.txn_count || 0), 0)
  const sorted = [...members].sort((a, b) => (b.txn_count || 0) - (a.txn_count || 0))

  const scopeBits = []
  if (lead.owner_name) scopeBits.push(`owner ${lead.owner_name}`)
  if (lead.account_name) scopeBits.push(`account ${lead.account_name}`)
  const amountLabel = formatSuggestionAmountLabel(lead.amount_min, lead.amount_max)
  if (amountLabel) scopeBits.push(amountLabel)

  // A leading column appears for the status icon (total view) or the bulk-select checkbox.
  const showLeading = showStatusColumn || bulkMode
  const cols = `${showLeading ? '30px ' : ''}46px minmax(150px, 1fr) auto`

  return (
    <div
      data-rule-suggestion-card=""
      data-rule-suggestion-id={String(lead.id)}
      style={{
        border: '1px solid color-mix(in srgb, var(--warning) 30%, var(--border))',
        borderRadius: 14,
        background: 'color-mix(in srgb, var(--surface2) 70%, var(--surface))',
        padding: '14px 16px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
        <span style={{ fontWeight: 700 }}>{merchant}</span>
        <span style={{ fontSize: 12, color: 'var(--muted)', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          {members.length} categories · {totalRows} rows
          {onOpenReport ? <ReportArrowButton onClick={onOpenReport} /> : null}
        </span>
      </div>
      <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 12 }}>
        Matches: merchant contains <strong style={{ color: 'var(--text)' }}>{lead.keyword}</strong>
        {scopeBits.length ? ` · ${scopeBits.join(' · ')}` : ''}
      </div>

      <div style={{ display: 'grid', gap: 6 }}>
        <div style={{
          display: 'grid', gridTemplateColumns: cols, gap: 10, alignItems: 'end',
          fontSize: 10.5, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em',
          padding: '0 2px',
        }}>
          {showLeading ? <span /> : null}
          <span style={{ textAlign: 'right' }}>Rows</span>
          <span>Category</span>
          <span />
        </div>
        {sorted.map(member => {
          const resolved = getResolvedSuggestion(member)
          const key = getSuggestionKey(member.id)
          const categoryLabel = resolved.target_category_name || 'Uncategorized'
          const categoryChangeHint = formatCategoryChangeHint(resolved.review_action || member.review_action)
          const memberTags = (resolved.tag_ids || [])
            .map(tagId => tags.find(item => String(item.id) === String(tagId)))
            .filter(Boolean)
          return (
            <div
              key={member.id}
              data-rule-suggestion-id={String(member.id)}
              style={{
                display: 'grid', gridTemplateColumns: cols, gap: 10, alignItems: 'center',
                padding: '8px 2px', borderTop: '1px solid var(--border)', fontSize: 12.5, lineHeight: 1.2,
              }}
            >
              {showLeading ? (
                <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
                  {bulkMode ? (
                    <input
                      type="checkbox"
                      aria-label="Select this suggestion"
                      checked={selectedSuggestionIds?.includes(key) || false}
                      onChange={() => onToggleSelection?.(member.id)}
                      style={{ width: 16, height: 16, accentColor: 'var(--accent)', cursor: 'pointer' }}
                    />
                  ) : (
                    <StatusIcon status={member.review_status} />
                  )}
                </span>
              ) : null}
              <span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--muted)', textAlign: 'right' }}>{member.txn_count || 0}</span>
              <div style={{ minWidth: 0, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <span title={categoryLabel} style={{ fontWeight: 600, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {categoryLabel}
                </span>
                {categoryChangeHint ? (
                  <span style={{ color: 'var(--muted)', fontSize: 11.5, whiteSpace: 'nowrap' }}>
                    ({categoryChangeHint})
                  </span>
                ) : null}
                {memberTags.map(tag => <TagBadge key={tag.id} tag={tag} />)}
              </div>
              <div style={{ justifySelf: 'end' }}>
                <SuggestionDispositionActions
                  suggestion={member}
                  resolvedSuggestion={resolved}
                  editingSuggestionId={editingSuggestionId}
                  onEditSuggestion={onEditSuggestion}
                  runRowStatusAction={runRowStatusAction}
                  runRowSaveAction={runRowSaveAction}
                  onRejectSuggestionDisposition={onRejectSuggestionDisposition}
                />
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
