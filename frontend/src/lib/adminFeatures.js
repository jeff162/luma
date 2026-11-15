// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * Whether to show what manages the installation, the one question every surface that lists an
 * administrator's control asks. `canAdminister` is the client's reading of the server's
 * `require_admin_or_local` — whether those controls would work — and this narrows only what is shown.
 *
 * With sign-in protection off everyone can administer, and some people would rather not see it, so a
 * per-user preference hides it. The preference is a display choice, never a guard: the server enforces
 * whatever this answers. It is read only while sign-in is off, so a value left from then can never hide
 * anything from an administrator once roles exist, and it is kept for when sign-in is turned off again.
 * `shows_admin_features` in `backend/authorization.py` is the server's copy, for the reminders and counts
 * it decides.
 */

import { useAppSession } from './AppSessionContext.jsx'
import { useUserPreference } from './UserPreferencesContext.jsx'

export const SHOW_ADMIN_FEATURES_PREF_KEY = 'ui.showAdminFeatures'

export function useShowAdminFeaturesPreference() {
  return useUserPreference(SHOW_ADMIN_FEATURES_PREF_KEY, true)
}

export function useShowsAdminFeatures() {
  const { authEnabled, canAdminister } = useAppSession()
  const [showAdminFeatures] = useShowAdminFeaturesPreference()
  return authEnabled ? canAdminister : showAdminFeatures !== false
}
