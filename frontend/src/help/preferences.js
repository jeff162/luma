// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// Shared preference keys for the help/hints system, so the explainer, the Help-page manage control,
// and the first-run welcome toggle all read and write the same values.
//
//  - HELP_HINTS_ENABLED_PREF_KEY: global on/off for the proactive first-use tip callouts. When off,
//    ContextualExplainer skips the callout and shows only the persistent `?` (guidance stays reachable).
//  - HELP_DISMISSED_TIPS_PREF_KEY: per-tip dismissal map ({ [tipKey]: true }). Resetting hints clears it.
export const HELP_HINTS_ENABLED_PREF_KEY = 'ui.help.hintsEnabled'
export const HELP_DISMISSED_TIPS_PREF_KEY = 'ui.help.dismissedTips'
