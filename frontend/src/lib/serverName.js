// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// How the navigation pane shows the name the server goes by (`APP_NAME`, with its optional colour).
//
// - The interface's own name is fixed when it is built, so a renamed server would otherwise show the
//   change nowhere. A name that differs gets a line of its own under the wordmark.
// - A colour is the server asking to be told apart at a glance, so it shows even when the name is the
//   interface's own: the wordmark itself takes the colour rather than repeating the name beneath it.
// - Shown to every session, whatever the data-location preference, because which copy this is matters
//   to every user of two copies.

import { APP_NAME } from './appConfig.js'

// The other half of `APP_NAME_COLORS` in `backend/runtime_config.py`. Theme variables rather than
// values, so each stays legible in every theme.
export const SERVER_NAME_COLORS = {
  red: 'var(--danger)',
  green: 'var(--success)',
  yellow: 'var(--warning)',
  blue: 'var(--accent)',
}

// `{ line, color }`, or null when there is nothing to show. `line` is the name for its own line, null
// when the name is the wordmark's; `color` is a CSS colour for whichever of the two shows it.
export function describeServerName(serverName) {
  const name = String(serverName?.name || '').trim()
  if (!name) return null
  const color = SERVER_NAME_COLORS[serverName.color] || null
  const line = name === APP_NAME ? null : name
  return line || color ? { line, color } : null
}
