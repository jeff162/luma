// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

const BADGE_THEMES = [
  { bg: '#eef2ff', border: '#c7d2fe', text: '#3730a3' },
  { bg: '#ecfeff', border: '#a5f3fc', text: '#155e75' },
  { bg: '#f0fdf4', border: '#bbf7d0', text: '#166534' },
  { bg: '#fff7ed', border: '#fed7aa', text: '#9a3412' },
  { bg: '#fff1f2', border: '#fecdd3', text: '#9f1239' },
  { bg: '#faf5ff', border: '#e9d5ff', text: '#7e22ce' },
  { bg: '#fefce8', border: '#fde68a', text: '#854d0e' },
  { bg: '#eff6ff', border: '#bfdbfe', text: '#1d4ed8' },
  { bg: '#f0fdfa', border: '#99f6e4', text: '#115e59' },
  { bg: '#fdf2f8', border: '#fbcfe8', text: '#9d174d' },
]

function hashString(input) {
  const text = String(input || '')
  let hash = 0
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) - hash) + text.charCodeAt(i)
    hash |= 0
  }
  return Math.abs(hash)
}

export function getCategoryBadgeTheme(key) {
  // Hashing keeps badge colors stable for a given category key without storing presentation state anywhere.
  return BADGE_THEMES[hashString(key) % BADGE_THEMES.length]
}
