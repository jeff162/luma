// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// The nav-bar restore chip for a minimized detached report viewer (see lib/useDetachedReportViewer.js).
// Extracted from the duplicate report's nav item so every detached report gets the same affordance:
// stashed in the nav bar as a chip (styled as a chip, not a NavLink, so it doesn't read as a permanent
// page entry), click to restore, with an optional attention badge. `tone` themes the chip/badge (defaults
// to the warning colour — the "needs attention" reports).
export function MinimizedReportPill({ label, badgeCount = 0, tone = 'var(--warning)', icon = '↗', title, onRestore }) {
  return (
    <button
      type="button"
      onClick={onRestore}
      title={title}
      style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '6px 10px',
        margin: '4px 0',
        background: `color-mix(in srgb, ${tone} 14%, var(--surface2))`,
        color: 'var(--text)',
        border: `1px solid color-mix(in srgb, ${tone} 40%, var(--border))`,
        borderRadius: 8,
        cursor: 'pointer',
        fontSize: 12,
        textAlign: 'left',
        width: '100%',
        overflow: 'hidden',
      }}
    >
      <span style={{ fontSize: 13, lineHeight: 1, color: tone }}>{icon}</span>
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {label}
      </span>
      {badgeCount > 0 ? (
        <span style={{
          background: tone, color: '#fff',
          fontSize: 10, fontWeight: 700,
          padding: '1px 6px', borderRadius: 99,
          lineHeight: '16px', minWidth: 18, textAlign: 'center',
        }}>
          {badgeCount}
        </span>
      ) : null}
    </button>
  )
}
