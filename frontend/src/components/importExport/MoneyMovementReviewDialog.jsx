// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from 'react'
import { Button, DialogActions, FloatingPanel, FloatingPanelHeader, OverlayBackdrop } from '../ui.jsx'

/*
 * Review (and later edit) which PayPal transaction `Type` values are money movement, routing the checked
 * ones to the excluded "Money movement" category. Money-movement types are pre-checked on a first pass;
 * a re-opened review reflects the current state via each proposal's `already_ruled`. Checking a new type
 * creates its (account-scoped) rule; unchecking one that was ruled removes it — so this is the "changed
 * my mind" surface too. The user always decides; nothing is auto-applied. `onApply({ add, remove })`.
 */
export function MoneyMovementReviewDialog({ proposals = [], onApply, onClose, onOpenReport, applying = false, editing = false }) {
  // Start checked = every type already routed to Money movement, plus (on the post-import auto-review, not
  // when re-editing) the fragment-suggested ones. `already_ruled` must be included in BOTH modes: an
  // approved type that isn't fragment-suggested would otherwise start unchecked, land in the `remove`
  // delta, and get its rule silently deleted on Apply.
  const initial = new Set(proposals.filter(p => p.already_ruled || (!editing && p.money_movement)).map(p => p.type))
  const [checked, setChecked] = useState(() => new Set(initial))
  if (!proposals.length) return null

  function toggle(type) {
    setChecked(prev => {
      const next = new Set(prev)
      if (next.has(type)) next.delete(type)
      else next.add(type)
      return next
    })
  }

  // The delta the backend needs: newly checked (create rules), and previously-ruled now unchecked (remove).
  const ruled = new Set(proposals.filter(p => p.already_ruled).map(p => p.type))
  const add = [...checked].filter(type => !ruled.has(type))
  const remove = [...ruled].filter(type => !checked.has(type))
  const changeCount = add.length + remove.length

  return (
    <OverlayBackdrop zIndex={1200} tint="rgba(15, 23, 42, 0.38)">
      <FloatingPanel style={{ width: 'min(600px, 100%)' }}>
        <FloatingPanelHeader style={{ padding: '16px 20px' }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 600 }}>PayPal money movement</div>
            <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4, lineHeight: 1.5 }}>
              Route the transaction types that are money movement — deposits, withdrawals, currency
              conversions, holds — into the excluded <strong>Money movement</strong> category so they are
              kept out of spending totals. Rules are scoped to this PayPal account and also apply to
              matching transactions already in your ledger; unchecking a type removes its rule.
            </div>
          </div>
        </FloatingPanelHeader>
        <div style={{ padding: 12, display: 'grid', gap: 2, maxHeight: '55vh', overflowY: 'auto' }}>
          {proposals.map(proposal => (
            <div
              key={proposal.type}
              style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 6,
                fontSize: 13,
                background: checked.has(proposal.type) ? 'color-mix(in srgb, var(--accent) 7%, transparent)' : 'transparent',
              }}
            >
              <label style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 0, cursor: 'pointer' }}>
                <input type="checkbox" checked={checked.has(proposal.type)} onChange={() => toggle(proposal.type)} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {proposal.type}
                </span>
                {proposal.money_movement ? (
                  <span title="Auto-detected as money movement by its type, so it's pre-checked" style={{ fontSize: 11, color: 'var(--accent2)', flexShrink: 0 }}>suggested</span>
                ) : null}
              </label>
              {/* Count = rows the rule affects; `extra_count` = rows carrying this type that already have an
                  imported/manual category (the rule leaves those alone). The ↗ pill opens a report of both,
                  matching the launch affordance used on import cards. */}
              {onOpenReport ? (
                <button
                  type="button"
                  onClick={() => onOpenReport(proposal.type, proposal.already_ruled)}
                  title="Show these transactions"
                  aria-label={`Show ${proposal.type} transactions`}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0, fontSize: 11,
                    padding: '2px 7px', borderRadius: 99, cursor: 'pointer', whiteSpace: 'nowrap',
                    background: 'var(--surface2)', color: 'var(--muted)', border: '1px solid var(--border)',
                  }}
                >
                  <span>
                    {proposal.count} row{proposal.count === 1 ? '' : 's'}
                    {proposal.extra_count ? ` · ${proposal.extra_count} not affected` : ''}
                  </span>
                  <span style={{ color: 'var(--accent2)', fontSize: 10, lineHeight: 1 }} aria-hidden="true">↗</span>
                </button>
              ) : (
                <span style={{ fontSize: 11, color: 'var(--muted)', flexShrink: 0, whiteSpace: 'nowrap' }}>
                  {proposal.count} row{proposal.count === 1 ? '' : 's'}
                  {proposal.extra_count ? ` · ${proposal.extra_count} not affected` : ''}
                </span>
              )}
            </div>
          ))}
        </div>
        <DialogActions>
          <Button variant="ghost" onClick={onClose} disabled={applying}>{editing ? 'Cancel' : 'Not now'}</Button>
          <Button onClick={() => onApply?.({ add, remove })} disabled={applying || changeCount === 0}>
            {applying ? 'Applying…' : (changeCount === 0 ? 'No changes' : `Apply (${changeCount} change${changeCount === 1 ? '' : 's'})`)}
          </Button>
        </DialogActions>
      </FloatingPanel>
    </OverlayBackdrop>
  )
}
