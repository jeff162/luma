// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useDeviceLayoutPreference } from './UserPreferencesContext.jsx'
import { DEFAULT_DISPLAY_SIZE, DISPLAY_SIZE_PREF_KEY, normalizeDisplaySize } from './displaySize.js'

// The display size for this kind of screen (`lib/deviceLayout.js`): a size that suits a laptop need not
// suit a tablet, or a tablet held the other way. A screen with no size of its own starts from the one
// chosen most recently on any screen.
export function useDisplaySize() {
  const [value, setValue] = useDeviceLayoutPreference(DISPLAY_SIZE_PREF_KEY, DEFAULT_DISPLAY_SIZE)
  return [normalizeDisplaySize(value), setValue]
}
