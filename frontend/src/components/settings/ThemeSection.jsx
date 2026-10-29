// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useUserPreference } from '../../lib/UserPreferencesContext.jsx'
import { THEME_PREF_KEY, THEME_SYSTEM, THEME_CHOICES, THEME_LABELS } from '../../lib/theme.js'

export default function ThemeSection() {
  const [themeChoice, setThemeChoice] = useUserPreference(THEME_PREF_KEY, THEME_SYSTEM)
  return (
    <div role="radiogroup" aria-label="Color theme" style={{ display: 'inline-flex', gap: 4, padding: 4, background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 10 }}>
      {THEME_CHOICES.map(choice => {
        const selected = themeChoice === choice
        return (
          <button
            key={choice}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => setThemeChoice(choice)}
            style={{
              minWidth: 76,
              padding: '6px 14px',
              borderRadius: 7,
              border: 'none',
              cursor: 'pointer',
              fontSize: 13,
              fontWeight: 600,
              background: selected ? 'var(--accent)' : 'transparent',
              color: selected ? '#fff' : 'var(--muted)',
              transition: 'background 0.12s, color 0.12s',
            }}
          >
            {THEME_LABELS[choice]}
          </button>
        )
      })}
    </div>
  )
}
