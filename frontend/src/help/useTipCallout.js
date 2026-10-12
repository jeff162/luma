// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback } from 'react'
import { useUserPreference } from '../lib/UserPreferencesContext.jsx'
import { HELP_HINTS_ENABLED_PREF_KEY, HELP_DISMISSED_TIPS_PREF_KEY } from './preferences.js'

// Stable identity for the unset default so useUserPreference doesn't churn its return value.
const EMPTY_DISMISSED = {}

// Whether a contextual tip is still at its callout stage — hints on, and this tip not yet dismissed —
// and the dismissal that ends it. `ContextualExplainer` renders from this; a host reads it too when the
// `?` a dismissed tip leaves behind belongs somewhere other than where the callout stood.
export function useTipCallout(tipKey) {
  const [hintsEnabled] = useUserPreference(HELP_HINTS_ENABLED_PREF_KEY, true)
  const [dismissedTips, setDismissedTips] = useUserPreference(HELP_DISMISSED_TIPS_PREF_KEY, EMPTY_DISMISSED)
  const dismiss = useCallback(
    () => setDismissedTips(prev => ({ ...(prev || {}), [tipKey]: true })),
    [setDismissedTips, tipKey],
  )
  return { showing: !!hintsEnabled && !dismissedTips?.[tipKey], dismiss }
}
