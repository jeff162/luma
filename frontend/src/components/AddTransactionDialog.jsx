// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { api } from '../lib/api.js'
import { formatTransactionAmount } from '../lib/moneyDisplay.js'
import {
  DIRECTIONS,
  buildTransactionPayload,
  signedAmount,
  todayIsoDate,
} from '../lib/manualTransaction.js'
import CategoryPicker from './CategoryPicker.jsx'
import { AppDialog, Button, Input, SegmentedToggle, Spinner } from './ui.jsx'

/*
 * Recording a transaction by hand: cash, a cheque, a charge on an account nothing syncs.
 *
 * **Direction is a control, not a sign the user types.** Amounts are stored with positive meaning money
 * out and displayed the other way round, so asking for a signed number would invert half of what people
 * enter. The toggle answers it explicitly and the derived figure is echoed back beside the amount before
 * saving (`lib/manualTransaction.js`), which is what keeps the inference visible rather than silent.
 *
 * **The category is optional, and leaving it empty is a real answer rather than an unfinished form.**
 * The server runs the user's rules over an uncategorized entry exactly as an import does, so the common
 * case — a payee a rule already knows — is one less box to fill. Filling it in stamps the row manual,
 * which locks it against those same rules, so the choice does mean something.
 *
 * It portals to `<body>` for the same reason the other transaction dialogs do: an overlay mounted inside
 * a page that establishes a containing block is stacked against that ancestor rather than the viewport.
 *
 * Validation lives in `buildTransactionPayload` rather than here so the rules are testable without a
 * DOM, and so the disabled state and the message the user reads can never disagree about why.
 */
export default function AddTransactionDialog({ categories, onAddCategory, onClose, onCreated }) {
  const [accounts, setAccounts] = useState(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [form, setForm] = useState(() => ({
    payee: '',
    accountId: '',
    date: todayIsoDate(),
    amount: '',
    direction: 'out',
    categoryId: null,
    notes: '',
  }))

  useEffect(() => {
    let cancelled = false
    api.getAccounts()
      .then(result => {
        if (cancelled) return
        const usable = (result.accounts || result || []).filter(account => !account.trashed_at)
        setAccounts(usable)
        // Pre-selected only when there is exactly one account, which is the case where there is no
        // choice to make. With several, guessing would put money in the wrong place quietly.
        setForm(prev => (usable.length === 1 ? { ...prev, accountId: usable[0].id } : prev))
      })
      .catch(() => { if (!cancelled) setAccounts([]) })
    return () => { cancelled = true }
  }, [])

  const update = patch => setForm(prev => ({ ...prev, ...patch }))
  const built = buildTransactionPayload(form)
  const preview = signedAmount(form.amount, form.direction)

  async function save() {
    if (!built.ok) {
      setError(built.reason)
      return
    }
    setSaving(true)
    setError('')
    try {
      const created = await api.createTransaction(built.payload)
      onCreated?.(created)
      onClose?.()
    } catch (err) {
      setError(err?.message || 'This transaction could not be saved.')
      setSaving(false)
    }
  }

  return createPortal(
    <AppDialog
      title="Add a transaction"
      description="For anything the app cannot see for itself — cash, a cheque, an account that is not connected."
      onClose={onClose}
      width="min(560px, 100%)"
      actions={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Add transaction'}</Button>
        </>
      }
    >
      {accounts === null ? <Spinner /> : (
        <div style={{ display: 'grid', gap: 12 }}>
          <Input
            value={form.payee}
            onChange={value => update({ payee: value })}
            placeholder="Who it was paid to, or what it was for"
            aria-label="Payee or description"
          />

          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 150px', gap: 6 }}>
            <label style={{ display: 'grid', gap: 4, fontSize: 12, color: 'var(--muted)', minWidth: 0 }}>
              Account
              <select
                value={form.accountId}
                onChange={e => update({ accountId: e.target.value })}
                aria-label="Account"
                style={{ font: 'inherit', fontSize: 13, padding: '7px 8px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', width: '100%', minWidth: 0 }}
              >
                <option value="">Choose an account…</option>
                {accounts.map(account => (
                  <option key={account.id} value={account.id}>
                    {account.display_name || account.name}
                  </option>
                ))}
              </select>
            </label>
            {/* A span rather than a <label>: the shared Input renders its own control, so a wrapping
                label has nothing it can be associated with. The field is named by aria-label. */}
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
          </div>

          <div style={{ display: 'grid', gap: 6 }}>
            <div style={{ justifySelf: 'start' }}>
              <SegmentedToggle
                value={form.direction}
                onChange={value => update({ direction: value })}
                options={DIRECTIONS.map(option => ({ value: option.value, label: option.label }))}
                ariaLabel="Direction"
              />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '150px minmax(0, 1fr)', gap: 8, alignItems: 'center', minWidth: 0 }}>
              <Input
                value={form.amount}
                onChange={value => update({ amount: value })}
                placeholder="0.00"
                aria-label="Amount"
                inputMode="decimal"
                style={{ textAlign: 'right', width: '100%', minWidth: 0 }}
              />
              {/* The derived figure, shown the way the ledger will show it. This is what makes the
                  direction toggle checkable rather than something the user has to trust. */}
              <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>
                {preview === null
                  ? 'Enter an amount'
                  : `Will be recorded as ${formatTransactionAmount(preview)}`}
              </span>
            </div>
          </div>

          <div style={{ display: 'grid', gap: 4, fontSize: 12, color: 'var(--muted)' }}>
            Category (optional — the rules will try if this is left empty)
            <CategoryPicker
              value={form.categoryId}
              categories={categories}
              compact
              showSelectedBadge
              clearable
              onChange={id => update({ categoryId: id })}
              onAddCategory={onAddCategory}
              // The picker portals its dropdown to <body> at 1100, which is behind an AppDialog (1200).
              panelZIndex={1300}
            />
          </div>

          <Input
            value={form.notes}
            onChange={value => update({ notes: value })}
            placeholder="Notes (optional)"
            aria-label="Notes"
          />

          {error ? <div style={{ fontSize: 12.5, color: 'var(--danger)' }}>{error}</div> : null}
        </div>
      )}
    </AppDialog>,
    document.body,
  )
}
