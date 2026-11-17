// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from 'react'
import { api } from '../../lib/api.js'
import { useAppSession } from '../../lib/AppSessionContext.jsx'
import { Button } from '../ui.jsx'

// The answer to a restore from another system about one source's folder: the path came from the machine
// the backup was made on, so it is either right here (**Use here**) or it is not (**Clear**). Renders
// nothing once answered, and nothing for someone who may not set a folder. Every surface listing a
// watched source shows it beside the restore's notice: the CSV data-source rows, the Amazon source rows
// and the watched-folders panel.
export default function RestoredFolderDecision(props) {
  return props.profile?.watch_restore_pending ? <PendingDecision {...props} /> : null
}

function PendingDecision({ profile, onSettled, style }) {
  const { canAdminister } = useAppSession()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  if (!canAdminister) return null

  async function settle(use) {
    setBusy(true)
    setError('')
    try {
      await api.settleRestoredWatchFolder(profile.id, use)
      await onSettled?.()
    } catch (e) {
      setError(e.message || 'That did not work.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', ...style }}>
      <Button size="compact" variant="secondary" disabled={busy} onClick={() => settle(true)}
        title="Watch this folder on this machine">
        Use here
      </Button>
      <Button size="compact" variant="quiet" disabled={busy} onClick={() => settle(false)}
        title="Remove this folder from the data source">
        Clear
      </Button>
      {error ? <span role="alert" style={{ fontSize: 11, color: 'var(--danger)' }}>{error}</span> : null}
    </span>
  )
}
