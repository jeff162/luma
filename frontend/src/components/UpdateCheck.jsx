// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * Settings -> About: whether a newer version has been released (`backend/services/update_check.py`).
 *
 * - The answer is install-wide and every user can read it; switching the automatic check on and asking
 *   on demand are for whoever administers the install, so the controls are rendered only for them.
 * - Opening the panel reads what the server last learned and asks nothing of the network. Only "Check
 *   now" and the load-time call (`App.jsx`) can cause a request, which is what keeps this page inside
 *   the rule its license link already follows: nothing is fetched from anywhere without being asked.
 * - A check that could not reach the release list says so here, because someone pressed a button and is
 *   owed an answer. The automatic one fails silently.
 */

import { RELEASES_URL } from '../lib/appConfig.js'
import { useBusyIndicator } from '../lib/useBusyIndicator.js'
import { useRelativeTimestamp } from '../lib/useRelativeTimestamp.js'
import { Button, Toggle } from './ui.jsx'

export function UpdateCheckStatus({ status }) {
  const checked = useRelativeTimestamp(status?.last_checked_at)
  if (status?.available_version) {
    return (
      <>
        Version {status.available_version} is available on the{' '}
        <a href={RELEASES_URL} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>releases page</a>.
      </>
    )
  }
  if (!checked.label) return null
  return <span title={checked.absolute || undefined}>No newer version · checked {checked.label}</span>
}

export function UpdateCheckControls({ check }) {
  const { status, checking, saving, notice, setEnabled, checkNow } = check
  const announceChecking = useBusyIndicator(checking)
  if (!status) return null
  return (
    <div style={{ display: 'grid', gap: 8, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
        <Toggle
          checked={!!status.enabled}
          onChange={setEnabled}
          disabled={saving}
          label="Check for a new version automatically"
        />
        <Button variant="secondary" disabled={checking} onClick={checkNow}>
          {announceChecking ? 'Checking…' : 'Check now'}
        </Button>
      </div>
      <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.55 }}>
        Periodically query GitHub to fetch the project&rsquo;s
        latest version number. A task is posted when a new release is available. The request carries nothing
        about this installation or its data although like all internet requests, it does
        carry the ip address of the client.
      </div>
      {notice ? <div role="alert" style={{ fontSize: 12, color: 'var(--danger)' }}>{notice}</div> : null}
    </div>
  )
}
