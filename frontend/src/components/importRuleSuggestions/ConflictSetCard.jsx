// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: GPL-3.0-or-later

import { useRef, useState } from 'react'
import { Button } from '../ui.jsx'
import CategoryPicker from '../CategoryPicker.jsx'
import { ReportArrowButton, SuggestionPill } from './suggestionPresentational.jsx'
import { formatSuggestionAmountLabel } from '../../lib/importRuleSuggestions.js'

/*
 * One card for a whole conflict set (a merchant filed under several categories). The set is resolved as
 * a unit through two distinct category columns rather than a per-member keep/recategorize toggle:
 *
 *   - "Imported Category" is the input fact — the category those imported rows currently carry. Read-only.
 *   - "Target Category" is the output — where those rows should end up. An always-editable pill on every
 *     row, defaulting to the imported category.
 *
 * Exactly one row's radio marks the winner: its target becomes the rule (`merchant contains keyword ->
 * target`). Every other row's target then resolves its disposition by *comparison*, with no extra knob:
 *
 *   - target == the winner's category  -> the rule owns those rows (reclaimed on save);
 *   - target != the winner's category  -> kept as a manual exception at that target (default = unchanged
 *     imported category; or any category the user picks — "keep these, but as something else").
 *
 * With no winner the card just settles every row to its target as a manual decision (the old "keep all,
 * no rule"). `onApply(winnerId)` and `onDefer()` are orchestrated by the page against the accept / rule-
 * apply / disposition endpoints in one combined undo entry; targets ride on each member's resolved
 * `target_category_id`, written through `onSetMemberCategory`. Per-row drill-in stays Phase 2.
 */
export function ConflictSetCard({ members, onApply, onDefer, onOpenReport, onEditRule, onEditMatch, categories, onSetMemberCategory, onCategoryCreated, applying = false }) {
  const [winnerId, setWinnerId] = useState(null)
  // Which row's target pill is currently swapped to the picker (one at a time, same toggle the single
  // suggestion cards use). Held by member id rather than a boolean so any row is independently editable.
  const [editingMemberId, setEditingMemberId] = useState(null)
  const [catPickerToken, setCatPickerToken] = useState(0)
  const catPickerOpenedRef = useRef(false)

  if (!members?.length) return null

  const lead = members[0]
  const merchant = lead.merchant_label || lead.keyword || 'this merchant'
  const totalRows = members.reduce((sum, m) => sum + (m.txn_count || 0), 0)
  const sorted = [...members].sort((a, b) => (b.txn_count || 0) - (a.txn_count || 0))
  const winner = members.find(m => m.id === winnerId) || null
  const winnerCategoryId = winner ? winner.target_category_id : null
  const winnerLabel = winner?.target_category_name || 'the rule'
  const others = sorted.filter(m => m.id !== winnerId)
  // With a winner chosen, split the remaining rows by whether their target now matches the rule's
  // category (governed by the rule) or stays at a different category (kept as a manual exception), so
  // the footer can describe the actual outcome of Apply rather than a generic "unless changed" hint.
  const othersOnRule = others.filter(m => String(m.target_category_id || '') === String(winnerCategoryId || ''))
  const othersKept = others.filter(m => String(m.target_category_id || '') !== String(winnerCategoryId || ''))
  const ruleRowCount = (winner?.txn_count || 0) + othersOnRule.reduce((sum, m) => sum + (m.txn_count || 0), 0)
  const keptSummary = (() => {
    const byTarget = new Map()
    for (const m of othersKept) {
      const key = m.target_category_id || '__none__'
      const entry = byTarget.get(key) || { label: m.target_category_name || null, rows: 0 }
      entry.rows += m.txn_count || 0
      byTarget.set(key, entry)
    }
    return [...byTarget.values()].map(entry => (
      entry.label
        ? `${entry.rows} row${entry.rows === 1 ? '' : 's'} stay as ${entry.label}`
        : `${entry.rows} row${entry.rows === 1 ? '' : 's'} cleared`
    )).join(', ')
  })()
  // Has the user retargeted any row off its imported category? With no winner, Discard still settles each
  // row to its (possibly edited) target, so the label calls that out when there's an actual change to apply.
  const anyTargetEdited = members.some(
    m => String(m.target_category_id || '') !== String(m.imported_category_id || ''),
  )

  const scopeBits = []
  if (lead.owner_name) scopeBits.push(`owner ${lead.owner_name}`)
  if (lead.account_name) scopeBits.push(`account ${lead.account_name}`)
  const amountLabel = formatSuggestionAmountLabel(lead.amount_min, lead.amount_max)
  if (amountLabel) scopeBits.push(amountLabel)

  function pickWinner(id) {
    // Clicking the already-selected category clears the winner (radios don't normally toggle, but here
    // it's the only way back to "no rule" after a pick).
    setEditingMemberId(null)
    setWinnerId(prev => (prev === id ? null : id))
  }
  function beginEditCategory(member) {
    catPickerOpenedRef.current = false
    setEditingMemberId(member.id)
    setCatPickerToken(token => token + 1)
  }
  function setTarget(member, categoryId) {
    onSetMemberCategory?.(member, categoryId)
    setEditingMemberId(null)
  }
  function changeAllOthersToWinner() {
    if (!winnerCategoryId) return
    for (const member of others) onSetMemberCategory?.(member, winnerCategoryId)
  }

  // Size the two category columns to the longest label they hold (capped) so the per-row action column
  // sits right beside the Target category instead of pinned to the card's far edge — selecting a winner
  // then puts "use rule" / "revert" next to the category rather than a full card-width away. The
  // trailing flex spacer soaks up the remaining width (the deliberate blank space on the right). Both
  // the radio (Save rule) and Rows columns stay narrow and fixed. Categories still truncate with hover
  // titles if a name exceeds the cap.
  const catColWidth = (labels, { min = 150, max = 300 } = {}) => {
    const longest = labels.reduce((maxLen, label) => Math.max(maxLen, String(label || '').length), 0)
    return Math.round(Math.max(min, Math.min(max, longest * 7.2 + 26)))
  }
  const importedColWidth = catColWidth(['Imported category', ...members.map(m => m.imported_category_name || 'Uncategorized')])
  // Target also hosts the inline category picker when editing, so give it a slightly higher floor.
  const targetColWidth = catColWidth(['Target category', ...members.map(m => m.target_category_name || 'Uncategorized')], { min: 180 })
  const cols = `42px 46px ${importedColWidth}px ${targetColWidth}px 116px minmax(0, 1fr)`

  const segBtn = (active, tone = 'accent') => {
    const accent = tone === 'danger' ? 'var(--danger)' : 'var(--accent)'
    const activeText = tone === 'danger' ? 'var(--danger)' : 'var(--accent2)'
    return {
      border: `1px solid ${active ? `color-mix(in srgb, ${accent} 55%, var(--border))` : 'var(--border)'}`,
      background: active ? `color-mix(in srgb, ${accent} 14%, var(--surface2))` : 'var(--surface2)',
      color: active ? activeText : 'var(--muted)',
      borderRadius: 7, padding: '3px 9px', cursor: 'pointer', fontSize: 11.5, fontWeight: 600, whiteSpace: 'nowrap',
    }
  }
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
        <span>
          Matches: merchant contains <strong style={{ color: 'var(--text)' }}>{lead.keyword}</strong>
          {scopeBits.length ? ` · ${scopeBits.join(' · ')}` : ''}
        </span>
        {onEditMatch ? (
          <button
            type="button"
            onClick={() => onEditMatch?.(members)}
            style={{
              ...segBtn(false),
              marginLeft: 7,
              padding: '2px 7px',
              fontSize: 10.5,
              verticalAlign: 'middle',
            }}
            title="Edit the selection criteria for this conflict set"
          >
            Edit match criteria
          </button>
        ) : null}
      </div>

      <div style={{ display: 'grid', gap: 6 }}>
        <div style={{
          display: 'grid', gridTemplateColumns: cols, gap: 10, alignItems: 'end',
          fontSize: 10.5, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em',
          padding: '0 2px',
        }}>
          <span style={{ lineHeight: 1.15 }}>Save<br />rule</span>
          <span style={{ textAlign: 'right' }}>Rows</span>
          <span>Imported category</span>
          <span>Target category</span>
          <span />
        </div>
        {sorted.map(member => {
          const isWinner = member.id === winnerId
          const importedLabel = member.imported_category_name || 'Uncategorized'
          const targetLabel = member.target_category_name || 'Uncategorized'
          const toWinner = Boolean(winner) && !isWinner && String(member.target_category_id || '') === String(winnerCategoryId || '')
          return (
            <div
              key={member.id}
              data-rule-suggestion-id={String(member.id)}
              style={{
                display: 'grid', gridTemplateColumns: cols, gap: 10, alignItems: 'center',
                padding: '6px 2px 3px', borderTop: '1px solid var(--border)', fontSize: 12.5, lineHeight: 1.2,
              }}
            >
              <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
                <input
                  type="radio"
                  name={`winner-${lead.conflict_group_id || lead.id}`}
                  aria-label={`Build the rule from ${importedLabel} (click again to clear)`}
                  checked={isWinner}
                  onChange={() => { }}
                  onClick={() => pickWinner(member.id)}
                  style={{ cursor: 'pointer', accentColor: 'var(--accent)', margin: 0 }}
                />
              </span>
              <span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--muted)', textAlign: 'right' }}>{member.txn_count || 0}</span>
              <div title={importedLabel} style={{ minWidth: 0, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {importedLabel}
              </div>
              <div style={{ minWidth: 0, display: 'flex', alignItems: 'center' }}>
                {editingMemberId === member.id && onSetMemberCategory ? (
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <CategoryPicker
                      value={member.target_category_id}
                      categories={categories}
                      onChange={categoryId => setTarget(member, categoryId)}
                      onCategoryCreated={onCategoryCreated}
                      compact
                      clearable
                      openToken={catPickerToken}
                      onOpenChange={open => {
                        if (open) { catPickerOpenedRef.current = true; return }
                        if (catPickerOpenedRef.current) { setEditingMemberId(null); catPickerOpenedRef.current = false }
                      }}
                    />
                  </div>
                ) : onSetMemberCategory ? (
                  <SuggestionPill
                    label={targetLabel}
                    title={targetLabel}
                    maxWidth="100%"
                    tone={isWinner ? 'accent' : 'muted'}
                    onMouseDown={() => beginEditCategory(member)}
                  />
                ) : (
                  <div title={targetLabel} style={{ fontWeight: 600, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {targetLabel}
                  </div>
                )}
              </div>
              <div style={{ minWidth: 0, justifySelf: 'start' }}>
                {isWinner ? (
                  <button
                    type="button"
                    onClick={() => onEditRule?.(member.id)}
                    style={segBtn(false)}
                    title="Edit this rule (rename, tags, scope)"
                  >
                    Edit rule
                  </button>
                ) : !winner ? null : toWinner ? (
                  <button
                    type="button"
                    onClick={() => setTarget(member, member.imported_category_id)}
                    style={segBtn(false)}
                    title={`Revert these to ${importedLabel} instead of ${winnerLabel}`}
                  >
                    ↩ revert
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => setTarget(member, winnerCategoryId)}
                    style={segBtn(false, 'danger')}
                    title={`Change these to ${winnerLabel}`}
                  >
                    use rule
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>

      <div style={{ borderTop: '1px solid var(--border)', marginTop: 10, paddingTop: 10 }}>
        {!winner ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12, color: 'var(--muted)', flex: '1 1 240px' }}>
              Discard if you do not want to build a rule and the existing transactions will keep the categories as assigned above.
            </span>
            <Button small variant="ghost" onClick={onDefer} disabled={applying}>Defer</Button>
            <Button small onClick={() => onApply(null)} disabled={applying}>
              {anyTargetEdited ? 'Discard & Apply Changes' : 'Discard'}
            </Button>
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12, color: 'var(--muted)', flex: '1 1 200px' }}>
              {othersKept.length === 0 ? (
                <>All <strong style={{ color: 'var(--text)' }}>{totalRows}</strong> matching row{totalRows === 1 ? '' : 's'} will be categorized as <strong style={{ color: 'var(--text)' }}>{winnerLabel}</strong>.</>
              ) : (
                <>Rule <strong style={{ color: 'var(--text)' }}>{winnerLabel}</strong> applies to {ruleRowCount} of {totalRows} rows; {keptSummary}.</>
              )}
            </span>
            {others.length > 1 && othersKept.length > 0 ? (
              <button type="button" onClick={changeAllOthersToWinner} style={segBtn(false)}>change all to {winnerLabel}</button>
            ) : null}
            <Button small variant="ghost" onClick={onDefer} disabled={applying}>Defer</Button>
            <Button small onClick={() => onApply(winnerId)} disabled={applying}>Apply</Button>
          </div>
        )}
      </div>
    </div>
  )
}
