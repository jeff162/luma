// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: GPL-3.0-or-later

export function getSharedPillStyle({ tone = 'default' } = {}) {
  const palettes = {
    default: {
      border: '1px solid color-mix(in srgb, var(--border) 82%, transparent)',
      background: 'color-mix(in srgb, var(--surface2) 58%, var(--surface))',
      boxShadow: '0 4px 12px rgba(15, 23, 42, 0.12)',
    },
    accent: {
      border: '1px solid color-mix(in srgb, var(--accent) 24%, var(--border))',
      background: 'linear-gradient(180deg, color-mix(in srgb, var(--accent) 16%, var(--surface2)), color-mix(in srgb, var(--accent) 6%, var(--surface)))',
      boxShadow: '0 6px 14px rgba(15, 23, 42, 0.14)',
    },
    selected: {
      border: '1px solid color-mix(in srgb, white 70%, var(--accent))',
      background: 'linear-gradient(180deg, color-mix(in srgb, var(--accent) 22%, var(--surface2)), color-mix(in srgb, var(--accent) 10%, var(--surface)))',
      boxShadow: '0 0 0 1px color-mix(in srgb, white 8%, transparent), 0 8px 18px rgba(15, 23, 42, 0.18)',
    },
  }
  const palette = palettes[tone] || palettes.default
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    padding: '6px 10px',
    borderRadius: 999,
    border: palette.border,
    background: palette.background,
    boxShadow: palette.boxShadow,
  }
}

export function getSharedPillLabelStyle({ italic = false, muted = false } = {}) {
  return {
    fontSize: 12,
    fontWeight: 500,
    color: muted ? 'var(--muted)' : 'var(--text)',
    fontStyle: italic ? 'italic' : 'normal',
    lineHeight: 1.2,
    whiteSpace: 'nowrap',
  }
}

export function getSharedPillRemoveButtonStyle() {
  return {
    background: 'none',
    border: 'none',
    color: 'var(--muted)',
    cursor: 'pointer',
    fontSize: 12,
    lineHeight: 1,
    padding: 0,
    flexShrink: 0,
  }
}

export function getSharedPillCornerRemoveButtonStyle() {
  return {
    position: 'absolute',
    top: -6,
    right: -6,
    width: 16,
    height: 16,
    padding: 0,
    borderRadius: 999,
    border: '1px solid color-mix(in srgb, var(--border) 78%, white 8%)',
    background: 'color-mix(in srgb, var(--surface) 82%, transparent)',
    color: 'var(--muted)',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    fontSize: 11,
    fontWeight: 700,
    lineHeight: 1,
    boxShadow: '0 3px 8px rgba(15, 23, 42, 0.12)',
  }
}
