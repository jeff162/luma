// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: GPL-3.0-or-later

import { useRef, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useDismissibleLayer } from '../lib/uiInteractions.js'
import { HELP_TOPICS_BY_ID } from './content.jsx'

/*
 * Inline explainer affordance for a feature surface. Renders a small `?` button that
 * opens a popover showing the topic's one-line summary and a "Read more" link to the
 * standalone Help page. Both surfaces consume the same content registry so popover
 * and Help-page text cannot drift.
 */
export default function FeatureExplainer({ topic, label = 'About this feature', placement = 'bottom-right' }) {
  const [open, setOpen] = useState(false)
  const popoverRef = useRef(null)
  const buttonRef = useRef(null)
  const location = useLocation()
  const entry = HELP_TOPICS_BY_ID[topic]

  useDismissibleLayer({
    open,
    onClose: () => setOpen(false),
    refs: [popoverRef, buttonRef],
  })

  if (!entry) return null

  const positionStyle = placement === 'bottom-left'
    ? { top: '100%', left: 0 }
    : { top: '100%', right: 0 }

  return (
    <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen(value => !value)}
        title={label}
        aria-label={label}
        style={{
          width: 18, height: 18,
          borderRadius: '50%',
          background: open ? 'var(--accent2)' : 'var(--surface2)',
          color: open ? '#fff' : 'var(--muted)',
          border: '1px solid color-mix(in srgb, var(--accent2) 20%, var(--border))',
          cursor: 'pointer',
          fontSize: 11, fontWeight: 700,
          lineHeight: 1, padding: 0,
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        }}
      >?</button>
      {open && (
        <div
          ref={popoverRef}
          role="dialog"
          style={{
            position: 'absolute', zIndex: 540,
            ...positionStyle, marginTop: 6,
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 10,
            boxShadow: '0 12px 32px rgba(15,23,42,0.32)',
            padding: '12px 14px',
            width: 'min(340px, calc(100vw - 32px))',
            fontSize: 13,
            lineHeight: 1.5,
            color: 'var(--text)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
            <div style={{ fontSize: 13, fontWeight: 600, flex: 1 }}>{entry.title}</div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              style={{
                background: 'none', border: 'none',
                color: 'var(--muted)', cursor: 'pointer',
                fontSize: 16, lineHeight: 1, padding: 0,
              }}
              aria-label="Close"
            >&times;</button>
          </div>
          <div style={{ color: 'var(--muted)' }}>{entry.summary}</div>
          <div style={{ marginTop: 8, textAlign: 'right' }}>
            <Link
              to={`/help/${entry.id}`}
              state={{ from: `${location.pathname}${location.search}${location.hash}` }}
              onClick={() => setOpen(false)}
              style={{ fontSize: 12, color: 'var(--accent2)' }}
            >
              Read more &rarr;
            </Link>
          </div>
        </div>
      )}
    </span>
  )
}
