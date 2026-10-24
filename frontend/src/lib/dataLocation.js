// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// Which databases this copy is open on, as the navigation pane states it.
//
// The paths themselves are resolved by the backend (`app_config.data_location`) — only it knows where a
// relative default anchors, and only it can shorten the home prefix. What is left for the client is the
// preference behind the line and the one editorial decision below.

import { APP_NAME } from './appConfig.js'
import { useUserPreference } from './UserPreferencesContext.jsx'

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

// What the pane should say about the data location, or null when it says nothing: the location is
// unknown to this session or the preference hides it. Also behind the collapsed pane's Luma icon, whose
// hover text carries the same statement.
//
// Read in a component rather than by the shell, which renders above `UserPreferencesProvider` — the same
// reason `ThemeController` is its own component. The backend's `show_by_default` is passed as the
// preference *default*, so an untouched preference follows the installation (moving the databases later
// makes the line appear on its own) while an explicit choice, either way, wins from then on.
export function useShownDataLocation(dataLocation) {
  const [showDataLocation] = useUserPreference(
    NAV_DATA_LOCATION_PREF_KEY, !!dataLocation?.show_by_default,
  )
  const described = describeDataLocation(dataLocation)
  if (!described || !showDataLocation) return null
  const serverName = String(dataLocation.app_name || '').trim()
  return { ...described, serverName: serverName && serverName !== APP_NAME ? serverName : null }
}
