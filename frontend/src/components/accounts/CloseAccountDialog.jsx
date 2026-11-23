// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from 'react'
import { createPortal } from 'react-dom'
import { api } from '../../lib/api.js'
import { onEnter } from '../../lib/formKeys.js'
import { localIsoDate } from '../../lib/utils.js'
import { AppDialog, Button, Input } from '../ui.jsx'

/*
 * Closing an account: the last day it was open. Nothing is removed; the date is what a later transaction is
 * judged against (`services/closed_accounts.py`). Reopening needs no date, so it is the row menu's own entry.
 * A group's top account closes the whole group, which `memberCount` (its other accounts) says.
 */
export default function CloseAccountDialog({ account, memberCount = 0, onClose, onSaved }) {
  const [value, setValue] = useState(localIsoDate())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const name = account.display_name || account.name
  async function save() {
    const next = value.trim()
    if (!next) return
    setBusy(true)
    setError('')
    try {
      await api.updateAccount(account.id, { closed_on: next })
      onSaved?.()
      onClose()
    } catch (err) {
      setError(err?.message || 'The account could not be closed.')
      setBusy(false)
    }
  }
  return createPortal(
    <AppDialog
      title={`Close ${name}`}
      description={`${memberCount ? 'This closes the whole group of accounts. To retire only this account, make another one the primary first. ' : ''}The transactions remain. A transaction arriving via a data connection will still be imported.`}
      onClose={onClose}
      width="min(440px, 100%)"
      actions={(
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={save} disabled={busy || !value.trim()}>Close account</Button>
        </>
      )}
    >
      <div style={{ display: 'grid', gap: 4, fontSize: 12, color: 'var(--muted)' }}>
        <span>Last day open</span>
        <Input value={value} onChange={setValue} onKeyDown={onEnter(save)}
          placeholder="YYYY-MM-DD" aria-label="Last day open" autoFocus style={{ width: 160 }} />
        {error ? <span role="alert" style={{ color: 'var(--danger)' }}>{error}</span> : null}
      </div>
    </AppDialog>,
    document.body,
  )
}
