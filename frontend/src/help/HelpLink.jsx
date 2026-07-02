// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Link, useLocation } from 'react-router-dom'
import { useHelpNav } from './helpNav.jsx'

/*
 * Cross-link between help topics. Behaves two ways depending on where the topic body is rendered:
 *
 *  - Inside the in-place help viewer dialog (HelpNavContext present), it switches the dialog's
 *    topic in place rather than navigating the page behind it, so a "Read more" opened over a
 *    floating panel keeps the user in context.
 *  - On the standalone /help route (no context), it routes like a normal link and forwards the
 *    original "Back to <page>" source path so the back affordance survives multiple hops.
 *
 * Use this for any internal link inside a topic body in content.jsx.
 */
export default function HelpLink({ to, children, ...rest }) {
  const helpNav = useHelpNav()
  const location = useLocation()

  if (helpNav) {
    const topicId = String(to).replace(/^\/help\//, '')
    return (
      <a
        href={to}
        onClick={event => { event.preventDefault(); helpNav.navigate(topicId) }}
        style={{ color: 'var(--accent2)', cursor: 'pointer' }}
        {...rest}
      >
        {children}
      </a>
    )
  }

  const from = location.state?.from
  // Stamp the current topic path as the destination's one-step "back" target, so a topic reached via
  // a cross-link can offer to unwind to the one it came from. `from` (the original feature origin) is
  // still forwarded for the index's "Return to <page>" affordance. The back action itself pops history,
  // so a multi-hop trail (A→B→C) unwinds one topic at a time.
  return (
    <Link to={to} state={{ ...(from ? { from } : {}), back: location.pathname }} {...rest}>
      {children}
    </Link>
  )
}
