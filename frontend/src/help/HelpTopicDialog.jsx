// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link, useLocation } from 'react-router-dom'
import { HELP_TOPICS_BY_ID } from './content.jsx'
import { HelpNavContext } from './helpNav.jsx'
import { HELP_BODY_CSS } from './helpBody.js'
import { scrollToHelpAnchor } from './helpAnchors.js'

/*
 * In-place help viewer. Renders a topic's full body in a portal'd overlay above everything
 * (z-index past the floating-panel stack), so "Read more" from an inline explainer shows the
 * guidance *on top of* a floating dialog like the duplicate-detection report instead of
 * navigating the page hidden behind it. The user keeps their place; closing the overlay returns
 * to exactly what they were doing. Topic cross-links switch the dialog in place via HelpNavContext,
 * scrolling to the heading they name when the link carries an anchor (helpAnchors.js).
 * The viewer already shows the full body, so its footer links to the /help *index* (a distinct, useful
 * destination) rather than this topic's own /help page, which would just repeat the same text.
 *
 * `data-modal-overlay` marks this as the active modal layer so DetailPanelShell yields Escape to it
 * (the dialog owns Escape while open) — matching the app's shared modal-over-panel convention.
 *
 * The `useHelpTopicViewer` hook that hosts this dialog lives in its own module so each explainer
 * can open it inline.
 */
export default function HelpTopicDialog({ topicId, onClose }) {
  // Topic and anchor move together: a cross-link picks both at once, and the anchor must not outlive
  // the topic it was chosen for (a later plain link would otherwise inherit the previous jump).
  const [current, setCurrent] = useState({ id: topicId, anchor: null })
  const location = useLocation()
  // Where the viewer was opened from (the route behind the overlay), so the Help index can offer a
  // "Return to <page>" link back. /help origins are ignored by the Help page's own guard.
  const fromPath = `${location.pathname}${location.search}${location.hash}`
  useEffect(() => { setCurrent({ id: topicId, anchor: null }) }, [topicId])

  // The overlay is the scroll container and survives an in-place topic switch, so each new body
  // starts at its own top unless the link asked for a heading inside it.
  const overlayRef = useRef(null)
  const bodyRef = useRef(null)
  useLayoutEffect(() => {
    const cleanup = current.anchor ? scrollToHelpAnchor(bodyRef.current, current.anchor) : null
    if (!cleanup && overlayRef.current) overlayRef.current.scrollTop = 0
    return cleanup ?? undefined
  }, [current])

  useEffect(() => {
    function onKeyDown(event) {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      onClose?.()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [onClose])

  const entry = HELP_TOPICS_BY_ID[current.id]
  if (!entry) return null
  const Body = entry.body

  return createPortal(
    <div
      ref={overlayRef}
      data-modal-overlay
      onMouseDown={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 2000,
        background: 'rgba(15, 23, 42, 0.5)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        overflowY: 'auto', padding: '6vh 16px 24px',
      }}
    >
      <style>{HELP_BODY_CSS}</style>
      <div
        role="dialog"
        aria-modal="true"
        data-browser-context-passthrough="true"
        onMouseDown={event => event.stopPropagation()}
        style={{
          width: 'min(680px, 100%)',
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 14,
          boxShadow: '0 24px 64px rgba(15, 23, 42, 0.42)',
          padding: '20px 24px',
          color: 'var(--text)',
          fontSize: 14,
          lineHeight: 1.6,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 10 }}>
          <h2 style={{ fontSize: 18, fontWeight: 700, flex: 1, margin: 0 }}>{entry.title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              background: 'none', border: 'none', color: 'var(--muted)',
              cursor: 'pointer', fontSize: 22, lineHeight: 1, padding: '0 4px',
            }}
          >&times;</button>
        </div>
        <HelpNavContext.Provider value={{ navigate: (id, anchor = null) => setCurrent({ id, anchor }) }}>
          <div className="help-body" ref={bodyRef}><Body /></div>
        </HelpNavContext.Provider>
        <div style={{ marginTop: 16, textAlign: 'right' }}>
          <Link
            to="/help"
            state={{ from: fromPath }}
            onClick={onClose}
            style={{ fontSize: 12, color: 'var(--accent2)' }}
          >
            All help topics &rarr;
          </Link>
        </div>
      </div>
    </div>,
    document.body,
  )
}
