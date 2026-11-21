// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { LinkButton } from './ui.jsx'

// The trail of a Dashboard drill ("Overview › Groceries"). Every step but the last goes back to it;
// `onNavigate` receives the step's index.
export default function Breadcrumb({ items, onNavigate }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, marginBottom: 16 }}>
      {items.map((item, i) => (
        <span key={i} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {i > 0 && <span style={{ color: 'var(--muted)' }}>›</span>}
          {i < items.length - 1 ? (
            <LinkButton onClick={() => onNavigate(i)} style={{ fontSize: 13 }}>{item}</LinkButton>
          ) : (
            <span style={{ color: 'var(--text)', fontWeight: 500 }}>{item}</span>
          )}
        </span>
      ))}
    </div>
  )
}
