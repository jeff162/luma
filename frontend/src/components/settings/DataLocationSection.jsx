// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Toggle } from '../ui.jsx'
import { useUserPreference } from '../../lib/UserPreferencesContext.jsx'
import { NAV_DATA_LOCATION_PREF_KEY } from '../../lib/dataLocation.js'

// Whether the navigation pane names the database this copy is open on. Offered only where the line can
// appear: the server sends `dataLocation` to an admin or local session alone, so its absence keeps the
// switch and the line on that one rule. A per-user preference rather than a setting, since a stored
// setting would come with an environment variable able to outrank the switch.
export default function DataLocationSection({ dataLocation }) {
  const [showDataLocation, setShowDataLocation] = useUserPreference(
    NAV_DATA_LOCATION_PREF_KEY, !!dataLocation?.show_by_default,
  )
  return (
    <Toggle
      checked={showDataLocation}
      onChange={setShowDataLocation}
      label="Show the data location in the navigation pane"
    />
  )
}
