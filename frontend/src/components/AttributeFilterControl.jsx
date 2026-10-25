// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * The Transactions ledger's attribute quick filter — the single button that replaced the separate
 * "Uncategorized only" and "Needs review" toggles. An import report (`ImportBatchDetail`) carries the same
 * control, so a file's rows narrow with the same words and the same server predicate as the ledger's.
 *
 * It is deliberately **single-select**, which is what separates it from the FilterBar's Attributes tab.
 * This is the control for finding something quickly ("show me what needs review", "which rows have a
 * receipt"), so picking one attribute must never mean unpicking another first, and the button can be
 * named for what it filters on — the way both buttons it replaces were. Combining an attribute with
 * other conditions is the FilterBar's job, where the same vocabulary is multi-select and takes "is not".
 *
 * The split-button shape preserves the ergonomics of the two toggles it replaces: the body turns the
 * filter on and off while *keeping* the choice, so the ledger can be flipped between filtered and
 * unfiltered without re-picking, and the caret changes which attribute that is. A page-local filter,
 * like the ledger search — it narrows this ledger and never touches the shared FilterBar.
 *
 * **There is no "clear".** A choice that is switched off already shows everything, so clearing would be
 * a second control for a state the body button reaches in one click — and it would leave the button
 * with nothing to name itself after. The page therefore seeds a default choice rather than an empty
 * one; `Only…` is only ever the pre-load state, before the vocabulary has arrived.
 */

import { useState, useRef } from 'react'
import { useDismissibleLayer } from '../lib/uiInteractions.js'

export default function AttributeFilterControl({ attributes, value, active, onChange }) {
  const [open, setOpen] = useState(false)
  const popoverRef = useRef(null)
  const wrapRef = useRef(null)
  useDismissibleLayer({ open, onClose: () => setOpen(false), refs: [popoverRef, wrapRef] })

  const options = attributes || []
  const selected = options.find(a => a.key === value) || null
  // Until something is picked there is nothing to toggle, so the whole button opens the picker.
  const on = active && !!selected

  function pick(key) {
    // Picking always turns the filter on: reaching into the menu is itself the request to apply it,
    // and landing on a chosen-but-inert filter would read as the control having failed.
    onChange({ attribute: key, active: true })
    setOpen(false)
  }

  const accent = on ? 'var(--accent)' : 'var(--border)'
  const zoneStyle = {
    padding: '4px 11px', fontSize: 12, cursor: 'pointer', border: 'none',
    background: 'none', color: on ? 'var(--accent2)' : 'var(--muted)', fontWeight: on ? 500 : 400,
  }

  return (
    <div ref={wrapRef} style={{ position: 'relative', display: 'inline-flex' }}>
      <div style={{
        display: 'inline-flex', alignItems: 'stretch', borderRadius: 6, overflow: 'hidden',
        border: `1px solid ${accent}`,
        background: on ? 'color-mix(in srgb, var(--accent) 12%, var(--surface2))' : 'var(--surface2)',
      }}>
        <button
          type="button"
          onClick={() => (selected ? onChange({ attribute: value, active: !active }) : setOpen(v => !v))}
          title={selected
            ? (on ? `Showing only: ${selected.label} — click to show everything` : `Show only ${selected.label}`)
            : 'Filter the ledger to one kind of transaction'}
          style={zoneStyle}
        >
          {selected ? `${on ? '✕ ' : ''}${selected.label}` : 'Only…'}
        </button>
        {selected && (
          <button
            type="button"
            onClick={() => setOpen(v => !v)}
            aria-label="Choose what to filter on"
            title="Choose what to filter on"
            style={{ ...zoneStyle, padding: '4px 7px', borderLeft: `1px solid ${accent}` }}
          >
            ▾
          </button>
        )}
      </div>

      {open && (
        <div ref={popoverRef} role="menu" aria-label="Filter the ledger by attribute" style={{
          position: 'absolute', top: 'calc(100% + 6px)', right: 0, zIndex: 300,
          background: 'var(--surface)',
          border: '1px solid color-mix(in srgb, var(--border) 50%, var(--muted) 50%)',
          borderRadius: 10, boxShadow: '0 12px 32px rgba(0,0,0,0.4)',
          padding: '6px 0', minWidth: 260, maxHeight: 320, overflowY: 'auto',
        }}>
          {options.length === 0 ? (
            <div style={{ padding: '10px 14px', fontSize: 13, color: 'var(--muted)' }}>None.</div>
          ) : options.map(attribute => (
            <div
              key={attribute.key}
              role="menuitemradio"
              aria-checked={attribute.key === value}
              onClick={() => pick(attribute.key)}
              title={attribute.description}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
                padding: '6px 14px', cursor: 'pointer', fontSize: 13,
                background: attribute.key === value
                  ? 'color-mix(in srgb, var(--accent) 22%, var(--surface2))'
                  : 'transparent',
              }}
            >
              <span>{attribute.label}</span>
              {attribute.key === value && <span style={{ color: 'var(--accent2)', fontSize: 11 }}>✓</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
