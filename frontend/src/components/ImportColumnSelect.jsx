// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: GPL-3.0-or-later

import { useRef, useState } from 'react'
import { useAnchoredPopupLayout, useDismissiblePopup } from '../lib/uiInteractions.js'

// Mapping fields use one control for three states the user needs to tell apart:
// confirmed mapping, explicit "not mapped", and a likely single-match guess
// that still requires acceptance. That keeps the UI helpful without quietly
// turning inference into a real saved choice.
export default function ImportColumnSelect({
  label,
  headers,
  allHeaders = headers,
  value,
  onChange,
  suggestedValue = '',
  onAcceptSuggestion = null,
  required = false,
  hint = '',
  tone = 'muted',
}) {
  const borderColor = required && !value ? 'var(--danger)' : 'var(--border)'
  const hintColor = tone === 'danger' ? 'var(--danger)' : 'var(--muted)'
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

  const hasDetectedSuggestions = headers.length > 0 && headers.length < allHeaders.length
  const suggestedHeaders = headers
  const remainingHeaders = allHeaders.filter(h => !suggestedHeaders.includes(h))
  const showSuggestedSection = hasDetectedSuggestions && suggestedHeaders.length > 0
  const directHeaders = showSuggestedSection ? remainingHeaders : allHeaders
  const selectedLabel = value
    ? value
    : <span style={{ color: 'var(--muted)' }}>Not mapped</span>
  const showAcceptSuggestion = !value && suggestedValue && typeof onAcceptSuggestion === 'function'

  const triggerStyle = {
    width: '100%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    background: 'var(--surface2)',
    color: 'var(--text)',
    border: `1px solid ${borderColor}`,
    borderRadius: 6,
    padding: '6px 8px',
    fontSize: 13,
    cursor: 'pointer',
    textAlign: 'left',
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

  const menuItemStyle = (active, subtle = false) => ({
    width: '100%',
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: subtle ? '7px 12px' : '8px 12px',
    border: 'none',
    background: active
      ? 'color-mix(in srgb, var(--accent2) 14%, var(--surface2))'
      : subtle
        ? 'color-mix(in srgb, var(--surface2) 75%, transparent)'
        : 'transparent',
    color: subtle ? 'var(--muted)' : 'var(--text)',
    cursor: 'pointer',
    fontSize: 13,
    textAlign: 'left',
  })

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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)' }}>
        {label}{required && <span style={{ color: 'var(--danger)' }}> *</span>}
      </label>
      <div ref={wrapRef} style={{ position: 'relative' }}>
        <button
          type="button"
          onClick={() => setOpen(v => !v)}
          aria-haspopup="listbox"
          aria-expanded={open}
          style={triggerStyle}
        >
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {selectedLabel}
          </span>
          {showAcceptSuggestion ? (
            <span
              role="button"
              tabIndex={0}
              // This lives inside the trigger button, so it stays a focusable
              // span instead of a nested button.
              onClick={event => {
                event.stopPropagation()
                onAcceptSuggestion(suggestedValue)
              }}
              onKeyDown={event => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  event.stopPropagation()
                  onAcceptSuggestion(suggestedValue)
                }
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
              title={`Accept suggested ${label.toLowerCase()} column`}
            >
              Accept {suggestedValue}
            </span>
          ) : null}
          {!value && hint && !showAcceptSuggestion ? (
            <span style={{
              flexShrink: 0,
              fontSize: 11,
              color: hintColor,
              background: 'color-mix(in srgb, var(--surface) 60%, transparent)',
              border: '1px solid var(--border)',
              borderRadius: 999,
              padding: '2px 7px',
            }}>
              {hint}
            </span>
          ) : null}
          <span style={{ fontSize: 10, color: 'var(--muted)', flexShrink: 0 }}>▾</span>
        </button>

        {open && (
          <div ref={listRef} style={listStyle} role="listbox" aria-label={`${label} column options`}>
            <button
              type="button"
              role="option"
              aria-selected={!value}
              style={menuItemStyle(!value)}
              onMouseDown={e => {
                e.preventDefault()
                onChange('')
                setOpen(false)
              }}
            >
              <span style={{ flex: 1, color: 'var(--muted)' }}>Not mapped</span>
              {!value && <span style={{ fontSize: 11, color: 'var(--accent2)' }}>✓</span>}
            </button>

            {showSuggestedSection && (
              <>
                {suggestedHeaders.map(h => (
                  <button
                    key={h}
                    type="button"
                    role="option"
                    aria-selected={value === h}
                    style={menuItemStyle(value === h)}
                    onMouseDown={e => {
                      e.preventDefault()
                      onChange(h)
                      setOpen(false)
                    }}
                  >
                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {h}
                    </span>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, flexShrink: 0, minWidth: 98 }}>
                      <span style={suggestedPillStyle}>Possible</span>
                      <span style={{ width: 12, textAlign: 'center', fontSize: 11, color: 'var(--accent2)', visibility: value === h ? 'visible' : 'hidden' }}>✓</span>
                    </div>
                  </button>
                ))}
              </>
            )}

            {directHeaders.length > 0 && (
              <>
                {showSuggestedSection ? (
                  <div
                    style={{
                      height: 1,
                      background: 'var(--border)',
                      margin: '3px 0',
                    }}
                  />
                ) : null}
                {directHeaders.map(h => (
                  <button
                    key={h}
                    type="button"
                    role="option"
                    aria-selected={value === h}
                    style={menuItemStyle(value === h)}
                    onMouseDown={e => {
                      e.preventDefault()
                      onChange(h)
                      setOpen(false)
                    }}
                  >
                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {h}
                    </span>
                    {value === h && <span style={{ fontSize: 11, color: 'var(--accent2)' }}>✓</span>}
                  </button>
                ))}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
