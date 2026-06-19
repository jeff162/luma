// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: GPL-3.0-or-later

import { useUserPreference } from '../lib/UserPreferencesContext.jsx'
import { HELP_TOPICS_BY_ID } from './content.jsx'
import FeatureExplainer from './FeatureExplainer.jsx'
import { HelpPopoverPanel } from './helpPanel.jsx'
import { useHelpTopicViewer } from './useHelpTopicViewer.jsx'
import { HELP_HINTS_ENABLED_PREF_KEY, HELP_DISMISSED_TIPS_PREF_KEY } from './preferences.js'

/*
 * Context-triggered "explain this" affordance — the counterpart to the always-present
 * `?` (FeatureExplainer). It appears only while the host surface reports a playbook
 * situation as live (`active`), and runs in two stages:
 *
 *   1. Until dismissed, it shows a quiet inline tip callout (the topic's title + summary
 *      + "Read more"), so the guidance meets the user the first time the app recognizes
 *      the situation.
 *   2. Once dismissed it collapses to the persistent `?` popover, so the same guidance
 *      stays one click away for re-reading without nagging.
 *
 * Dismissal is per-tip and persists through the shared user-preference model (local
 * cache + best-effort backend sync), keyed by `tipKey` so one topic anchored at several
 * surfaces can be dismissed independently. Content comes from the same registry as the
 * `?` popover and the /help pages, so the three never drift.
 */

// Stable identity for the unset default so useUserPreference doesn't churn its return value.
const EMPTY_DISMISSED = {}

const CALLOUT_CARD_STYLE = {
  position: 'relative',
  maxWidth: 'min(440px, 100%)',
  background: 'color-mix(in srgb, var(--accent2) 8%, var(--surface))',
  border: '1px solid color-mix(in srgb, var(--accent2) 34%, var(--border))',
  borderRadius: 10,
  boxShadow: '0 6px 18px rgba(15,23,42,0.16)',
  padding: '11px 13px',
  fontSize: 13,
  lineHeight: 1.5,
  color: 'var(--text)',
}

const TIP_ICON = (
  <span
    aria-hidden="true"
    style={{
      flex: '0 0 auto',
      width: 16, height: 16,
      borderRadius: '50%',
      background: 'var(--accent2)',
      color: '#fff',
      fontSize: 11, fontWeight: 700,
      lineHeight: 1,
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      alignSelf: 'center',
    }}
  >i</span>
)

export default function ContextualExplainer({ topic, active, tipKey = topic, placement = 'bottom-left', style, persistentButton = true }) {
  const [hintsEnabled] = useUserPreference(HELP_HINTS_ENABLED_PREF_KEY, true)
  const [dismissedTips, setDismissedTips] = useUserPreference(HELP_DISMISSED_TIPS_PREF_KEY, EMPTY_DISMISSED)
  const { openTopic, viewerNode } = useHelpTopicViewer()
  const entry = HELP_TOPICS_BY_ID[topic]

  if (!active || !entry) return null

  // The proactive callout only shows when hints are globally enabled and this tip hasn't been
  // dismissed; otherwise the guidance stays reachable through the persistent `?`. A host that already
  // provides its own re-access `?` elsewhere can pass `persistentButton={false}` so the dismissed
  // callout simply disappears instead of leaving a second `?` in place.
  if (!hintsEnabled || dismissedTips?.[tipKey]) {
    return persistentButton ? <FeatureExplainer topic={topic} placement={placement} /> : null
  }

  const dismiss = () => setDismissedTips(prev => ({ ...(prev || {}), [tipKey]: true }))

  return (
    <>
      <HelpPopoverPanel
        topic={topic}
        onClose={dismiss}
        onReadMore={() => openTopic(topic)}
        closeLabel="Dismiss tip"
        icon={TIP_ICON}
        role="note"
        style={{ ...CALLOUT_CARD_STYLE, ...style }}
      />
      {viewerNode}
    </>
  )
}
