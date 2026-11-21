// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from 'react'
import { createPortal } from 'react-dom'
import { api } from '../../lib/api.js'
import { onEnter } from '../../lib/formKeys.js'
import { AppDialog, Button, Input } from '../ui.jsx'

/*
 * The first date net worth counts an account from. It changes only here: a balance entered before it later
 * does not move it. `current` is the date set now, or null.
 */
export default function NetWorthStartDialog({ accountId, current, suggested, onClose, onSaved }) {
  const [value, setValue] = useState(current || suggested || '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function save(next) {
    setBusy(true)
    setError('')
    try {
      await api.updateAccount(accountId, { net_worth_from: next })
      onSaved?.()
      onClose()
    } catch (err) {
      setError(err?.message || 'The date could not be saved.')
      setBusy(false)
    }
  }
  return createPortal(
    <AppDialog
      title="Count in net worth from"
      description="Net worth leaves the account out before this date. Its transactions and balances are unchanged."
      onClose={onClose}
      width="min(420px, 100%)"
      actions={(
        <>
          {current ? (
            <Button variant="secondary" onClick={() => save('')} disabled={busy}>Count all of it</Button>
          ) : null}
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={() => save(value.trim())} disabled={busy || !value.trim()}>Save</Button>
        </>
      )}
    >
      <div style={{ display: 'grid', gap: 4, fontSize: 12, color: 'var(--muted)' }}>
        <span>Date</span>
        <Input value={value} onChange={setValue} onKeyDown={onEnter(() => value.trim() && save(value.trim()))}
          placeholder="YYYY-MM-DD" aria-label="Date" autoFocus style={{ width: 160 }} />
        {error ? <span role="alert" style={{ color: 'var(--danger)' }}>{error}</span> : null}
      </div>
    </AppDialog>,
    document.body,
  )
}
