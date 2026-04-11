// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: GPL-3.0-or-later

import { useRef, useState } from 'react'
import { useAnchoredPopupLayout, useDismissiblePopup } from '../lib/uiInteractions.js'

// Account mapping is one user decision expressed three different ways: use a
// CSV column, force every imported row into one existing account, or create one
// new account for the whole file. Keeping those modes in one picker makes the
// tradeoff explicit and prevents separate controls from drifting out of sync.
export default function ImportAccountHandlingPicker({
  headers,
  allHeaders = headers,
  accounts,
  colAccount,
  accountId,
  singleAccountNew,
  suggestedColumn = '',
  onAcceptSuggestedColumn = null,
  isRequired,
  hint,
  allowCreateNew = true,
  onChange,
}) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef(null)
  const listRef = useRef(null)
  const { openUp } = useDismissiblePopup({
    open,
    setOpen,
    anchorRef: wrapRef,
    popupRef: listRef,
    placementDeps: [headers.length, allHeaders.length],
    preferredPopupHeight: 320,
  })
  const popupLayout = useAnchoredPopupLayout({
    open,
    anchorRef: wrapRef,
    openUp,
    minWidth: 220,
  })

  const selectedAccount = accounts.find(a => a.id === accountId)
  let closedLabel = <span style={{ color: 'var(--muted)' }}>— Select account or column —</span>
  if (colAccount) {
    closedLabel = (
      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: 11, color: 'var(--accent2)', fontWeight: 600, letterSpacing: '0.03em' }}>↔ Column</span>
        <span>{colAccount}</span>
      </span>
    )
  } else if (selectedAccount) {
    closedLabel = (
      <span>{selectedAccount.name}{selectedAccount.mask ? ` ···${selectedAccount.mask}` : ''}</span>
    )
  } else if (singleAccountNew?.enabled) {
    closedLabel = (
      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: 11, color: 'var(--accent2)', fontWeight: 600, letterSpacing: '0.03em' }}>＋ New</span>
        <span>{singleAccountNew.name?.trim() || 'Create new account'}</span>
      </span>
    )
  }

  const triggerStyle = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    background: 'var(--surface2)',
    color: 'var(--text)',
    border: `1px solid ${isRequired ? 'var(--danger)' : 'var(--border)'}`,
    borderRadius: 6,
    padding: '6px 8px',
    fontSize: 13,
    cursor: 'pointer',
    userSelect: 'none',
    gap: 6,
  }

  const groupLabel = {
    padding: '5px 10px 2px',
    fontSize: 10,
    fontWeight: 700,
    color: 'var(--muted)',
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    borderTop: '1px solid var(--border)',
  }

  const itemStyle = active => ({
    padding: '4px 12px',
    fontSize: 13,
    cursor: 'pointer',
    background: active ? 'var(--surface2)' : 'transparent',
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  })

  const hasDetectedSuggestions = headers.length > 0 && headers.length < allHeaders.length
  const suggestedHeaders = headers
  const remainingHeaders = allHeaders.filter(h => !suggestedHeaders.includes(h))
  const showSuggestedSection = hasDetectedSuggestions && suggestedHeaders.length > 0
  const directHeaders = showSuggestedSection ? remainingHeaders : suggestedHeaders
  const suggestedPillStyle = {
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

  const listStyle = {
    position: 'fixed',
    zIndex: 720,
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 8,
    boxShadow: '0 4px 16px rgba(0,0,0,0.25)',
    overflowY: 'auto',
    ...(popupLayout || {}),
  }
  const showAcceptSuggestion = !colAccount && !accountId && !singleAccountNew?.enabled && suggestedColumn && typeof onAcceptSuggestedColumn === 'function'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)' }}>
        Account <span style={{ color: 'var(--danger)' }}>*</span>
      </label>
      <div ref={wrapRef} style={{ position: 'relative' }}>
        <div style={triggerStyle} onClick={() => setOpen(v => !v)}>
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {closedLabel}
          </span>
          {showAcceptSuggestion ? (
            <button
              type="button"
              onClick={event => {
                event.stopPropagation()
                onAcceptSuggestedColumn(suggestedColumn)
              }}
              style={{
                flexShrink: 0,
                fontSize: 11,
                color: 'var(--accent2)',
                background: 'color-mix(in srgb, var(--accent2) 10%, var(--surface2))',
                border: '1px solid color-mix(in srgb, var(--accent2) 30%, var(--border))',
                borderRadius: 999,
                padding: '2px 7px',
                cursor: 'pointer',
                lineHeight: 1.2,
              }}
              title="Accept suggested account column"
            >
              Accept {suggestedColumn}
            </button>
          ) : null}
          {!colAccount && !accountId && !singleAccountNew?.enabled && hint && !showAcceptSuggestion ? (
            <span style={{
              flexShrink: 0,
              fontSize: 11,
              color: 'var(--muted)',
              background: 'color-mix(in srgb, var(--surface) 60%, transparent)',
              border: '1px solid var(--border)',
              borderRadius: 999,
              padding: '2px 7px',
            }}>
              {hint}
            </span>
          ) : null}
          <span style={{ fontSize: 10, color: 'var(--muted)', flexShrink: 0 }}>▾</span>
        </div>

        {open && (
          <div ref={listRef} style={listStyle}>
            <div
              style={itemStyle(!colAccount && !accountId && !singleAccountNew?.enabled)}
              onMouseDown={e => {
                e.preventDefault()
                onChange({ acct: '', createNew: false })
                setOpen(false)
              }}
            >
              <span style={{ color: 'var(--muted)' }}>— Select account or column —</span>
            </div>

            {allHeaders.length > 0 && (
              <>
                <div style={groupLabel}>Map rows from a column in the file</div>
                {showSuggestedSection && suggestedHeaders.map(h => (
                  <div
                    key={h}
                    style={itemStyle(colAccount === h)}
                    onMouseDown={e => {
                      e.preventDefault()
                      onChange({ col: h, createNew: false })
                      setOpen(false)
                    }}
                  >
                    <span style={{ fontSize: 11, color: 'var(--accent2)', fontWeight: 600, flexShrink: 0 }}>↔</span>
                    <span>{h}</span>
                    <span style={suggestedPillStyle}>Possible</span>
                    {colAccount === h && <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--accent2)' }}>✓</span>}
                  </div>
                ))}
                {directHeaders.map(h => (
                  <div
                    key={h}
                    style={itemStyle(colAccount === h)}
                    onMouseDown={e => {
                      e.preventDefault()
                      onChange({ col: h, createNew: false })
                      setOpen(false)
                    }}
                  >
                    <span style={{ fontSize: 11, color: 'var(--accent2)', fontWeight: 600, flexShrink: 0 }}>↔</span>
                    <span>{h}</span>
                    {colAccount === h && <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--accent2)' }}>✓</span>}
                  </div>
                ))}
              </>
            )}

            <>
              <div style={{ ...groupLabel, borderTop: '1px solid var(--border)' }}>Map transactions-&gt;single account</div>
              {accounts.map(a => (
                <div
                  key={a.id}
                  style={itemStyle(accountId === a.id)}
                  onMouseDown={e => {
                    e.preventDefault()
                    onChange({ acct: a.id, createNew: false })
                    setOpen(false)
                  }}
                >
                  <span style={{ flex: 1 }}>{a.name}{a.mask ? ` ···${a.mask}` : ''}</span>
                  {accountId === a.id && <span style={{ fontSize: 11, color: 'var(--accent2)' }}>✓</span>}
                </div>
              ))}
              {allowCreateNew ? (
                <div
                  style={itemStyle(!!singleAccountNew?.enabled)}
                  onMouseDown={e => {
                    e.preventDefault()
                    onChange({ acct: '', createNew: true })
                    setOpen(false)
                  }}
                >
                  <span style={{ fontSize: 11, color: 'var(--accent2)', fontWeight: 600, flexShrink: 0 }}>＋</span>
                  <span style={{ flex: 1 }}>Create new account…</span>
                  {singleAccountNew?.enabled && <span style={{ fontSize: 11, color: 'var(--accent2)' }}>✓</span>}
                </div>
              ) : null}
            </>
          </div>
        )}
      </div>
    </div>
  )
}
