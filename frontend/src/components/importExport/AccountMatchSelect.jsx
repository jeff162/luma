// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useRef, useState } from 'react'
import { useAnchoredPopupLayout, useDismissiblePopup } from '../../lib/uiInteractions.js'
import { getAccountOptionLabel } from '../../lib/importExport/importAccountMatching.js'

/*
 * The account picker for a mapping row: "which account does this source account become?"
 *
 * Deliberately the same control as `ImportColumnSelect`, because it is the same problem one domain over.
 * A row usually has a few accounts it plausibly already is, buried in a list of every account there is —
 * so the count rides the closed trigger, and the candidates are hoisted to the top of the open list
 * behind a "Possible" pill with a divider under them. That control reads as unremarkable in use, which
 * is the point.
 *
 * **This picker answers exactly one question, and creating a new account is not it.** Every entry here
 * maps the source to an account that exists (or that a sibling row is creating); picking one is the
 * whole interaction, with nothing further to ask. Creating a *new* account is the row's `+New` button,
 * because that path may still have a question attached — whether the new account should be nested under
 * one of these — and that question needs a surface with room for it (`PossibleAccountMatchChooserDialog`).
 * Folding "New account" in here as a list entry put a second, differently-shaped question inside a
 * picker and buried it under every account in the ledger.
 *
 * Candidates come from `findAccountMatchCandidates`. What counts as a candidate is that function's
 * business, not this component's — this one renders however many it is handed, which is what lets the
 * matching rule widen without touching any of this.
 */
export default function AccountMatchSelect({
  value = '',
  createNew = false,
  options = [],
  candidates = [],
  accountsById = null,
  onSelectAccount,
  onClear,
  // Accounts that do not exist yet because another row of the *same* import is creating them — the CSV
  // grid's "New in this import" group. `[{ value, label }]`, opaque to this component: the caller knows
  // what its own placeholder value means and is handed it back unchanged. Empty for the connection grid,
  // whose rows cannot create an account for each other.
  inFlightOptions = [],
  onSelectInFlight,
  width = 170,
  name = '',
}) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef(null)
  const listRef = useRef(null)
  const { openUp } = useDismissiblePopup({
    open,
    setOpen,
    anchorRef: wrapRef,
    popupRef: listRef,
    placementDeps: [options.length, candidates.length],
    preferredPopupHeight: 320,
  })
  const popupLayout = useAnchoredPopupLayout({ open, anchorRef: wrapRef, openUp, minWidth: 220 })

  const candidateIds = new Set(candidates.map(a => a?.id).filter(Boolean))
  // Candidates are shown once, at the top. An account appearing in both sections would read as two
  // different choices that happen to share a name — the same defect the root-collapsing in
  // `findAccountMatchCandidates` exists to prevent, reintroduced at the render.
  const otherOptions = options.filter(a => !candidateIds.has(a?.id))
  const showCandidates = candidates.length > 0 && !value && !createNew
  const selected = value ? options.find(a => a?.id === value) : null

  const selectedLabel = createNew
    ? 'New account'
    : selected
      ? getAccountOptionLabel(selected, accountsById)
      : <span style={{ color: 'var(--muted)' }}>— Select —</span>

  const menuItemStyle = (active) => ({
    width: '100%',
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '7px 10px',
    border: 'none',
    background: active ? 'color-mix(in srgb, var(--accent2) 14%, var(--surface2))' : 'transparent',
    color: 'var(--text)',
    cursor: 'pointer',
    fontSize: 12,
    textAlign: 'left',
  })

  const possiblePillStyle = {
    flexShrink: 0,
    fontSize: 10,
    fontWeight: 700,
    color: 'var(--accent2)',
    background: 'color-mix(in srgb, var(--accent2) 10%, var(--surface2))',
    border: '1px solid color-mix(in srgb, var(--accent2) 35%, var(--border))',
    borderRadius: 999,
    padding: '2px 7px',
    letterSpacing: '0.02em',
    lineHeight: 1.1,
  }

  const divider = <div style={{ height: 1, background: 'var(--border)', margin: '3px 0' }} />

  // Section headings appear only when there is more than one kind of thing in the list. With just
  // "Possible" and the rest, the pill and the divider already say everything a heading would, and the
  // headings would be pure furniture on the common case.
  const showHeadings = inFlightOptions.length > 0
  const heading = (text) => (
    <div style={{
      padding: '6px 10px 3px', fontSize: 10, fontWeight: 700, letterSpacing: '0.05em',
      textTransform: 'uppercase', color: 'var(--muted)',
    }}>{text}</div>
  )

  function choose(fn) {
    return (event) => {
      event.preventDefault()
      fn()
      setOpen(false)
    }
  }

  return (
    <div ref={wrapRef} style={{ position: 'relative', width, maxWidth: '100%' }}>
      <button
        id={name || undefined}
        type="button"
        onClick={() => setOpen(v => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6,
          background: 'var(--surface2)', color: 'var(--text)', border: '1px solid var(--border)',
          borderRadius: 6, padding: '5px 6px', fontSize: 12, cursor: 'pointer', textAlign: 'left',
        }}
      >
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {selectedLabel}
        </span>
        {/* The count, not the names. One candidate names itself on the row's accept chip; several cannot
            fit and, more to the point, should not try — "3 possible" is a prompt to open the list and
            look, which is the decision that actually needs making. */}
        {showCandidates ? (
          <span style={{ ...possiblePillStyle, fontWeight: 600 }}>
            {candidates.length} possible
          </span>
        ) : null}
        <span style={{ fontSize: 10, color: 'var(--muted)', flexShrink: 0 }}>▾</span>
      </button>

      {open && (
        <div
          ref={listRef}
          role="listbox"
          aria-label="Account for this source account"
          style={{
            position: 'fixed', zIndex: 720, background: 'var(--surface)',
            border: '1px solid var(--border)', borderRadius: 8,
            boxShadow: '0 4px 16px rgba(0,0,0,0.25)', overflowY: 'auto',
            ...(popupLayout || {}),
          }}
        >
          {onClear ? (
            <button
              type="button" role="option" aria-selected={!value && !createNew}
              style={menuItemStyle(!value && !createNew)}
              onMouseDown={choose(() => onClear())}
            >
              <span style={{ flex: 1, color: 'var(--muted)' }}>— Select —</span>
            </button>
          ) : null}

          {showCandidates ? candidates.map(account => (
            <button
              key={account.id}
              type="button" role="option" aria-selected={value === account.id}
              style={menuItemStyle(value === account.id)}
              onMouseDown={choose(() => onSelectAccount?.(account))}
            >
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {getAccountOptionLabel(account, accountsById)}
              </span>
              <span style={possiblePillStyle}>Possible</span>
            </button>
          )) : null}

          {showCandidates && (otherOptions.length || inFlightOptions.length) ? divider : null}

          {inFlightOptions.length ? (
            <>
              {showHeadings ? heading('New in this import') : null}
              {inFlightOptions.map(option => (
                <button
                  key={option.value}
                  type="button" role="option" aria-selected={false}
                  style={menuItemStyle(false)}
                  onMouseDown={choose(() => onSelectInFlight?.(option))}
                >
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    + {option.label}
                  </span>
                </button>
              ))}
            </>
          ) : null}

          {showHeadings && otherOptions.length ? heading('Existing accounts') : null}

          {otherOptions.map(account => (
            <button
              key={account.id}
              type="button" role="option" aria-selected={value === account.id}
              style={menuItemStyle(value === account.id)}
              onMouseDown={choose(() => onSelectAccount?.(account))}
            >
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {getAccountOptionLabel(account, accountsById)}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
