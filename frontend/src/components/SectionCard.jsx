// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Card } from './ui.jsx'

// A section panel with an optional collapse toggle. On the Accounts page's Accounts and Owners tabs each
// section is the only thing on its tab, so it is rendered `collapsible={false}`: a static header (no
// toggle) with the content always shown. The collapsible form is what the Connections tab uses, one per
// provider.
//
// The toggle button holds only the −/+ and the title. `headerCenter` (attention counts, some of them
// clickable) and `headerActions` (a "Sync now" that stays reachable while collapsed) are its siblings:
// nested inside a <button> a control is invalid HTML, and its click would collapse the card as well. A
// click on the header's empty space or its summary still toggles, through the row; one that lands on a
// control is that control's alone.
const INTERACTIVE = 'button, a, input, select, textarea, label'

export default function SectionCard({ title, summary = '', headerCenter = null, headerActions = null, expanded, onExpandedChange, collapsible = true, disabled = false, width, children, style }) {
  const open = collapsible ? expanded : true
  const toggle = () => onExpandedChange?.(!open)
  const titleInner = (
    <>
      {collapsible ? <span style={{ fontSize: 12, color: 'var(--muted)' }}>{open ? '−' : '+'}</span> : null}
      <span style={{ fontSize: 14, fontWeight: 600 }}>{title}</span>
    </>
  )
  const titleStyle = { display: 'inline-flex', alignItems: 'center', gap: 8, flexShrink: 0 }
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
          <div
            onClick={collapsible ? event => { if (!event.target.closest(INTERACTIVE)) toggle() } : undefined}
            style={{
              display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 12px', flex: 1, minWidth: 0,
              padding: '12px 16px', cursor: collapsible ? 'pointer' : undefined,
            }}
          >
            {collapsible ? (
              <button type="button" onClick={toggle} aria-expanded={!!open} style={{
                ...titleStyle, background: 'none', border: 'none', padding: 0, color: 'var(--text)',
                font: 'inherit', cursor: 'pointer', textAlign: 'left',
              }}>
                {titleInner}
              </button>
            ) : (
              <span style={titleStyle}>{titleInner}</span>
            )}
            {headerCenter ? (
              <span style={{ display: 'inline-flex', alignItems: 'center', flexShrink: 1, minWidth: 0 }}>
                {headerCenter}
              </span>
            ) : null}
            {summary ? (
              <span style={{ fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap', marginLeft: 'auto' }}>
                {summary}
              </span>
            ) : null}
          </div>
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
