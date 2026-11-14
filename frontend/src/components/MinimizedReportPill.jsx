// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { NavIcon } from './navIcons.jsx'
import { VISUALLY_HIDDEN_STYLE } from './ui.jsx'
import { NavPaneHint } from './NavPaneHint.jsx'

// The nav-bar restore chip for a minimized detached report viewer (see lib/useDetachedReportViewer.js).
// Extracted from the duplicate report's nav item so every detached report gets the same affordance:
// stashed in the nav bar as a chip (styled as a chip, not a NavLink, so it doesn't read as a permanent
// page entry), click to restore, with an optional attention badge. `tone` themes the chip/badge (defaults
// to the warning colour — the "needs attention" reports).
//
// In a collapsed nav pane the chip is just `navIcon` with the badge on its corner. Each report passes an
// icon of its own, because several can be stashed at once and the icons are all that tells them apart.
export function MinimizedReportPill({ label, badgeCount = 0, tone = 'var(--warning)', navIcon, collapsed = false, title, onRestore }) {
  const chip = {
    background: `color-mix(in srgb, ${tone} 14%, var(--surface2))`,
    color: 'var(--text)',
    border: `1px solid color-mix(in srgb, ${tone} 40%, var(--border))`,
    borderRadius: 8,
    cursor: 'pointer',
  }
  const badge = badgeCount > 0 ? (
    <span style={{
      background: tone, color: '#fff',
      fontSize: 10, fontWeight: 700,
      padding: collapsed ? '0 4px' : '1px 6px', borderRadius: 99,
      lineHeight: collapsed ? '15px' : '16px', minWidth: collapsed ? 15 : 18, textAlign: 'center',
      ...(collapsed ? { position: 'absolute', top: -5, right: -5 } : null),
    }}>
      {badgeCount}
    </span>
  ) : null

  if (collapsed) {
    return (
      <NavPaneHint collapsed content={title} row describeTrigger>
        <button
          type="button"
          onClick={onRestore}
          style={{
            ...chip,
            position: 'relative',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            width: 40, height: 36, padding: 0, margin: '4px 8px',
          }}
        >
          <span style={{ color: tone }}><NavIcon name={navIcon} /></span>
          <span style={VISUALLY_HIDDEN_STYLE}>{label}</span>
          {badge}
        </button>
      </NavPaneHint>
    )
  }

  return (
    <button
      type="button"
      onClick={onRestore}
      title={title}
      style={{
        ...chip,
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '6px 10px',
        margin: '4px 0',
        fontSize: 12,
        textAlign: 'left',
        width: '100%',
        overflow: 'hidden',
      }}
    >
      <span style={{ fontSize: 13, lineHeight: 1, color: tone }}>↗</span>
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {label}
      </span>
      {badge}
    </button>
  )
}
