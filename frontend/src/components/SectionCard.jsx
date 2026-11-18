// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Card } from './ui.jsx'

// A section panel with an optional collapse toggle. On the Accounts page's Accounts and Owners tabs each
// section is the only thing on its tab, so it is rendered `collapsible={false}`: a static header (no
// toggle) with the content always shown. The collapsible form is what the Connections tab uses, one per
// provider.
// `headerActions` are controls that live in the header but must NOT toggle the card — a "Sync now" that
// stays reachable while collapsed. They cannot be part of `headerInner`: a collapsible header *is* a
// <button>, so nesting one inside it is invalid HTML and every click would also collapse the card. They
// are rendered as a sibling of the toggle, inside a flex row that the toggle grows to fill.
export default function SectionCard({ title, summary = '', headerCenter = null, headerActions = null, expanded, onExpandedChange, collapsible = true, disabled = false, width, children, style }) {
  const open = collapsible ? expanded : true
  const headerInner = (
    <>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        {collapsible ? <span style={{ fontSize: 12, color: 'var(--muted)' }}>{open ? '−' : '+'}</span> : null}
        <span style={{ fontSize: 14, fontWeight: 600 }}>{title}</span>
      </span>
      {headerCenter ? (
        <span style={{ display: 'inline-flex', alignItems: 'center', flexShrink: 1, minWidth: 0 }}>
          {headerCenter}
        </span>
      ) : null}
      {summary ? (
        <span style={{
          fontSize: 12,
          color: 'var(--muted)',
          whiteSpace: 'nowrap',
          marginLeft: 'auto',
        }}>
          {summary}
        </span>
      ) : null}
    </>
  )
  const headerStyle = {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '4px 12px',
    width: '100%',
    background: 'none',
    border: 'none',
    padding: '12px 16px',
    color: 'var(--text)',
    textAlign: 'left',
  }
  // A header with nothing in it would just be empty chrome — skip it.
  const hasHeader = collapsible || title || summary || headerCenter || headerActions
  return (
    <Card style={{
      width: typeof width === 'number' ? `${width}px` : (width || 'fit-content'),
      maxWidth: '100%',
      opacity: disabled ? 0.55 : 1,
      pointerEvents: disabled ? 'none' : 'auto',
      padding: 0,
      ...style,
    }}>
      {hasHeader ? (
        <div style={{ display: 'flex', alignItems: 'center', width: '100%' }}>
          {collapsible ? (
            <button type="button" onClick={() => onExpandedChange?.(!open)}
              style={{ ...headerStyle, cursor: 'pointer', flex: 1, minWidth: 0 }}>
              {headerInner}
            </button>
          ) : (
            <div style={{ ...headerStyle, flex: 1, minWidth: 0 }}>{headerInner}</div>
          )}
          {headerActions ? (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '0 16px 0 8px', flexShrink: 0 }}>
              {headerActions}
            </span>
          ) : null}
        </div>
      ) : null}
      {open ? (
        <div style={hasHeader ? { borderTop: '1px solid var(--border)' } : undefined}>
          {children}
        </div>
      ) : null}
    </Card>
  )
}
