// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from 'react'
import { createPortal } from 'react-dom'
import { api } from '../../lib/api.js'
import { formatAmountInput } from '../../lib/displayFormat.js'
import { onEnter } from '../../lib/formKeys.js'
import { BALANCE_SIDES, buildBalancePayload, defaultBalanceSide } from '../../lib/manualBalance.js'
import { formatSignedMoneyAmount } from '../../lib/moneyDisplay.js'
import { formatDate, localIsoDate } from '../../lib/utils.js'
import { AppDialog, Button, Input, SegmentedToggle } from '../ui.jsx'

/*
 * Entering an account's balance by hand: for an account nothing reports one for, or to set one right.
 *
 * The entry is a stated balance like a provider's, so the account's balance today is carried forward
 * from it through the transactions after its date (`docs/data-model.md` → *Account balances*). Opened on
 * an entry made by hand, it edits that entry and can remove it; otherwise it starts a new one for today.
 * A connection's figure is not editable here, since its next sync would restate it.
 */
export default function AccountBalanceDialog({ account, onClose, onSaved }) {
  const balance = account.balance
  const editing = balance?.source === 'manual' && balance.account_id === account.id ? balance : null
  const today = localIsoDate()
  const [form, setForm] = useState(() => ({
    date: editing?.as_of_date || today,
    amount: editing ? formatAmountInput(Math.abs(editing.stated), { cents: true }) : '',
    side: editing ? (editing.stated < 0 ? 'owed' : 'held') : defaultBalanceSide(account.type),
  }))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const built = buildBalancePayload(form, today)
  const update = patch => { setForm(prev => ({ ...prev, ...patch })); setError('') }

  async function run(request) {
    setBusy(true)
    setError('')
    try {
      await request()
      onSaved?.()
      onClose?.()
    } catch (err) {
      setError(err?.message || 'The balance could not be saved.')
      setBusy(false)
    }
  }

  function save() {
    if (!built.ok) { setError(built.reason); return }
    run(async () => {
      // Moving an entry to another day replaces it rather than leaving the old day's figure behind.
      if (editing && editing.as_of_date !== built.date) await api.removeManualBalance(account.id, editing.as_of_date)
      await api.setManualBalance(account.id, built.date, built.balance)
    })
  }

  return createPortal(
    <AppDialog
      title={`Balance of ${account.display_name || account.name}`}
      description={account.connection_id
        ? "The connection's next reported balance overwrites any changes."
        : 'Reflects transactions which have occurred since the last update.'}
      onClose={onClose}
      width="min(420px, 100%)"
      footerAlign={editing ? 'between' : 'end'}
      actions={
        <>
          {editing ? (
            <Button variant="secondary" tone="danger" disabled={busy}
              onClick={() => run(() => api.removeManualBalance(account.id, editing.as_of_date))}>
              Remove
            </Button>
          ) : null}
          <div style={{ display: 'flex', gap: 8 }}>
            <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save'}</Button>
          </div>
        </>
      }
    >
      <div style={{ display: 'grid', gridTemplateColumns: '130px auto', gap: 10, alignItems: 'end' }}>
        <div style={{ display: 'grid', gap: 4, fontSize: 12, color: 'var(--muted)', minWidth: 0 }}>
          <span>Date</span>
          <Input
            value={form.date}
            onChange={value => update({ date: value })}
            placeholder="YYYY-MM-DD"
            aria-label="Date"
            style={{ width: '100%', minWidth: 0 }}
          />
        </div>
        <div style={{ justifySelf: 'start' }}>
          <SegmentedToggle
            value={form.side}
            onChange={value => update({ side: value })}
            options={BALANCE_SIDES}
            ariaLabel="Held or owed"
          />
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '130px minmax(0, 1fr)', gap: 10, alignItems: 'center' }}>
        <Input
          value={form.amount}
          onChange={value => update({ amount: value })}
          onKeyDown={onEnter(save)}
          placeholder="0.00"
          aria-label="Balance"
          inputMode="decimal"
          autoFocus
          style={{ textAlign: 'right', width: '100%', minWidth: 0 }}
        />
        <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>
          {built.ok ? `${formatSignedMoneyAmount(built.balance)} at the end of ${formatDate(built.date)}` : null}
        </span>
      </div>
      {error ? <div style={{ fontSize: 12.5, color: 'var(--danger)' }}>{error}</div> : null}
    </AppDialog>,
    document.body,
  )
}
