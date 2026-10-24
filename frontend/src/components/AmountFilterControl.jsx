// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/* eslint-disable react-refresh/only-export-components -- the small filter-shape helpers (EMPTY_AMOUNT_FILTER,
   amountFilterIsActive, normalizeAmountFilter) live beside the control that owns them, matching RuleForm/FilterContext */

/*
 * The Transactions ledger's amount filter: a compact toolbar button that opens a popover holding the
 * shared `AmountCondition` control (the same Both/Debits/Credits + Range/Equals + per-bound comparator
 * users know from the rule editor). This is a *page-local* filter — like the ledger search, it narrows
 * only the ledger and never touches the shared FilterBar / Dashboard. Magnitude bounds compare against
 * |amount|; the debit/credit side rides the backend `direction` param, so the sign applies separately.
 */

import { useState, useRef, useEffect } from 'react'
import { AmountCondition, amountConditionSummary } from './RuleForm.jsx'
import { useDismissibleLayer } from '../lib/uiInteractions.js'
import { Button } from './ui.jsx'

// The neutral "no constraint" draft the popover starts from when nothing is set yet.
export const EMPTY_AMOUNT_FILTER = { low: null, lowOp: '>=', high: null, highOp: '<=', side: 'both' }

// A filter is only "active" (and worth carrying as params/a chip) when it constrains something — a
// bound on either side, or a debit/credit restriction. A bare `both` with no bounds is a no-op.
export function amountFilterIsActive(f) {
  return !!f && (f.low != null || f.high != null || (f.side && f.side !== 'both'))
}

// Normalize a draft to what the page should store: an active filter, or null (nothing constrained).
export function normalizeAmountFilter(f) {
  return amountFilterIsActive(f) ? { ...EMPTY_AMOUNT_FILTER, ...f } : null
}

function Popover({ onClose, children }) {
  const ref = useRef(null)
  useDismissibleLayer({ open: true, onClose, refs: [ref] })
  return (
    <div ref={ref} style={{
      position: 'absolute', top: 'calc(100% + 6px)', left: 0, zIndex: 300,
      background: 'var(--surface)',
      border: '1px solid color-mix(in srgb, var(--border) 50%, var(--muted) 50%)',
      borderRadius: 10, boxShadow: '0 12px 32px rgba(0,0,0,0.4)',
      padding: 14, minWidth: 300,
    }}>
      {children}
    </div>
  )
}

export default function AmountFilterControl({ value, onChange }) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(EMPTY_AMOUNT_FILTER)

  // Seed the draft from the committed value every time the popover opens, so a cancelled edit (dismiss
  // without Apply) leaves the active filter untouched.
  useEffect(() => {
    if (open) setDraft(value ? { ...EMPTY_AMOUNT_FILTER, ...value } : EMPTY_AMOUNT_FILTER)
  }, [open, value])

  const active = amountFilterIsActive(value)
  const summary = active
    ? amountConditionSummary(value.low, value.lowOp, value.high, value.highOp, value.side)
    : null

  function apply() {
    onChange(normalizeAmountFilter(draft))
    setOpen(false)
  }
  function clear() {
    onChange(null)
    setOpen(false)
  }

  return (
    <div style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen(v => !v)}
        title="Filter by amount (magnitude, and optionally debit/credit)"
        style={{
          padding: '5px 11px', borderRadius: 8, fontSize: 12, cursor: 'pointer',
          border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
          background: active ? 'color-mix(in srgb, var(--accent) 12%, var(--surface2))' : 'var(--surface2)',
          color: active ? 'var(--accent2)' : 'var(--muted)',
          fontWeight: active ? 500 : 400,
          whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: 6,
        }}
      >
        <span>💲 Amount</span>
        {summary && <span style={{ opacity: 0.85 }}>· {summary}</span>}
      </button>

      {open && (
        <Popover onClose={() => setOpen(false)}>
          <AmountCondition
            low={draft.low} lowOp={draft.lowOp}
            high={draft.high} highOp={draft.highOp}
            side={draft.side}
            onChange={setDraft}
          />
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12,
            borderTop: '1px solid var(--border)', paddingTop: 10 }}>
            <button
              onClick={clear}
              disabled={!active}
              style={{
                background: 'none', border: 'none', fontSize: 13, padding: 0,
                color: active ? 'var(--danger)' : 'var(--muted)',
                cursor: active ? 'pointer' : 'default', opacity: active ? 1 : 0.5,
              }}
            >✕ Clear amount filter</button>
            <Button small onClick={apply}>Apply</Button>
          </div>
        </Popover>
      )}
    </div>
  )
}
