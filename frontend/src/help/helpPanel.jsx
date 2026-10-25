// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Link, useLocation } from 'react-router-dom'
import { HELP_TOPICS_BY_ID } from './content.jsx'
import { IconButton, LinkButton } from '../components/ui.jsx'

/*
 * Shared help panel: a topic's title, one-line summary, and "Read more" link to
 * /help/:id. Both help affordances render it — the always-present `?` popover
 * (FeatureExplainer) and the context-triggered tip callout (ContextualExplainer) —
 * so the two share one source of copy and link behavior. The caller supplies the
 * container chrome via `style` (a floating popover card vs. an inline tip callout)
 * and what the close control does (hide vs. persist a dismissal).
 */

export function HelpPopoverPanel({
  topic,
  onClose,
  onReadMore,
  closeLabel = 'Close',
  icon = null,
  containerRef,
  style,
  role = 'dialog',
}) {
  const location = useLocation()
  const entry = HELP_TOPICS_BY_ID[topic]
  if (!entry) return null
  // "Read more" opens the full body in the in-place viewer when the host provides one (so it lands
  // above floating panels); otherwise it falls back to routing to the standalone /help page.
  const readMore = onReadMore ? (
    <LinkButton onClick={onReadMore} style={{ fontSize: 12 }}>
      Read more &rarr;
    </LinkButton>
  ) : (
    <Link
      to={`/help/${entry.id}`}
      state={{ from: `${location.pathname}${location.search}${location.hash}` }}
      onClick={onClose || undefined}
      style={{ fontSize: 12, color: 'var(--accent2)' }}
    >
      Read more &rarr;
    </Link>
  )
  return (
    <div ref={containerRef} role={role} style={style}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
        {icon}
        <div style={{ fontSize: 13, fontWeight: 600, flex: 1 }}>{entry.title}</div>
        {onClose ? (
          <IconButton onClick={onClose} aria-label={closeLabel} style={{ fontSize: 16 }}>&times;</IconButton>
        ) : null}
      </div>
      <div style={{ color: 'var(--muted)' }}>{entry.summary}</div>
      <div style={{ marginTop: 8, textAlign: 'right' }}>
        {readMore}
      </div>
    </div>
  )
}
