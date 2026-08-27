// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// Which databases this copy is open on, as the navigation pane states it.
//
// The paths themselves are resolved by the backend (`app_config.data_location`) — only it knows where a
// relative default anchors, and only it can shorten the home prefix. What is left for the client is the
// preference behind the line and the one editorial decision below.

// Per-user, so two people signed into one installation each answer it for their own sidebar. Its
// *default* is the backend's `show_by_default`, which means an untouched preference tracks the current
// installation rather than whatever was true the first time the app was opened.
export const NAV_DATA_LOCATION_PREF_KEY = 'ui.nav.showDataLocation'

function parentDir(path) {
  // Both separators, because the path is the server's and the browser is not necessarily on that OS.
  return String(path || '').replace(/[\\/][^\\/]*$/, '')
}

// What the line's tooltip says. The ledger's own path always; the control database only when it is in a
// *different directory*, since the two normally travel together and repeating the same folder twice
// says nothing. When they have been split apart — the per-file overrides an older installation runs on
// — that is exactly the fact the tooltip exists to carry.
export function describeDataLocation(dataLocation) {
  if (!dataLocation?.db_path) return null
  const { db_path: dbPath, control_db_path: controlDbPath } = dataLocation
  const controlElsewhere = !!controlDbPath && parentDir(controlDbPath) !== parentDir(dbPath)
  return {
    path: dbPath,
    controlPath: controlElsewhere ? controlDbPath : null,
  }
}
