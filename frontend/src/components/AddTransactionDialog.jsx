// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { api } from '../lib/api.js'
import { txnMutations } from '../lib/txnMutations.js'
import { formatTransactionAmount } from '../lib/moneyDisplay.js'
import {
  DIRECTIONS,
  buildTransactionPayload,
  signedAmount,
} from '../lib/manualTransaction.js'
import { localIsoDate } from '../lib/utils.js'
import CategoryPicker from './CategoryPicker.jsx'
import SplitEditorDialog from './SplitEditorDialog.jsx'
import { AppDialog, Button, Input, SegmentedToggle, Spinner, Tooltip } from './ui.jsx'

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
 *
 * **A transaction that spans categories is split as it is entered**, through the same editor the ledger
 * uses, opened on the typed amount with no transaction behind it (see `SplitEditorDialog`). Its items
 * are held here rather than saved, so nothing is written until this form's own button — and the two
 * requests that then follow (create, then split) are sequenced so a failed split leaves the created row
 * retriable rather than duplicated.
 */
export default function AddTransactionDialog({ categories, onAddCategory, onClose, onCreated }) {
  const [accounts, setAccounts] = useState(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  // The items this transaction is to be divided into, before it exists. Null until the split editor is
  // used; an empty split is not a state the editor can hand back.
  const [splitParts, setSplitParts] = useState(null)
  const [splitOpen, setSplitOpen] = useState(false)
  // The row this dialog already created, when the split that was to follow it failed. Pressing the
  // button again then retries the split alone — without this a second press would enter the
  // transaction twice.
  const createdRef = useRef(null)
  const [form, setForm] = useState(() => ({
    payee: '',
    accountId: '',
    date: localIsoDate(),
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
      const created = createdRef.current || await txnMutations.createTransaction(built.payload)
      createdRef.current = created
      if (splitParts?.length) {
        const saved = await txnMutations.saveSplit(created.id, splitParts)
        onCreated?.({ ...created, is_split: true, split_parts: saved.parts, split_part_count: saved.parts.length })
      } else {
        onCreated?.(created)
      }
      onClose?.()
    } catch (err) {
      // Named for which half failed, because the two leave the form in different states: the
      // transaction is already in the ledger in the second, and pressing the button again finishes it.
      setError(createdRef.current
        ? `The transaction was entered, but its items could not be saved: ${err?.message || 'please try again.'}`
        : (err?.message || 'This transaction could not be saved.'))
      setSaving(false)
    }
  }

  return createPortal(
    <>
      <AppDialog
        title="Add a transaction"
        description="For anything the app cannot see for itself — cash, a cheque, an account that is not connected."
        onClose={onClose}
        width="min(560px, 100%)"
        actions={
          <>
            <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
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
              {splitParts?.length
                ? 'Categories'
                : 'Category (optional — the rules will try if this is left empty)'}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                {splitParts?.length ? (
                  // The same marker a split row carries in the ledger, and it leads back to the editor
                  // the same way — a split's categories are set in one place whatever surface opened it.
                  <Button variant="secondary" onClick={() => setSplitOpen(true)}>
                    Split ({splitParts.length})
                  </Button>
                ) : (
                  <div style={{ minWidth: 0, flex: '1 1 220px' }}>
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
                )}
                {splitParts?.length ? null : (
                  <Tooltip describeTrigger content={preview === null
                    ? 'Enter an amount first — a split divides it'
                    : 'Divide this amount across several categories'}
                  >
                    <Button
                      variant="secondary"
                      onClick={() => setSplitOpen(true)}
                      // There is nothing to divide until an amount is entered, and the editor's whole
                      // interaction model is allocating against that figure.
                      disabled={preview === null}
                    >Split…</Button>
                  </Tooltip>
                )}
              </div>
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
      </AppDialog>
      {/* A sibling of the dialog rather than a child of its body: an overlay nested inside a scrolling
          panel is placed against that panel, and both dialogs share a stacking level, so the one
          mounted later is the one on top. */}
      {splitOpen ? (
        <SplitEditorDialog
          // No id: a draft, so the editor neither reads nor writes anything — it hands its items back
          // here. The amount is the one the form is showing, in the ledger's own convention.
          txn={{
            amount: preview,
            display_name: form.payee || 'New transaction',
            category_id: form.categoryId,
            is_split: !!splitParts?.length,
            parts: splitParts || [],
          }}
          categories={categories}
          onAddCategory={onAddCategory}
          onClose={() => setSplitOpen(false)}
          onSaved={result => setSplitParts(result.is_split ? result.parts : null)}
        />
      ) : null}
    </>,
    document.body,
  )
}
