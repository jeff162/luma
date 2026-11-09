// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { api } from '../lib/api.js'
import { formatTransactionAmount, getTransactionAmountColor } from '../lib/moneyDisplay.js'
import {
  expectedTotalInputValue,
  purchaseDisplayLabel,
  signedExpectedTotal,
} from '../lib/purchaseLinks.js'
import { AppConfirmDialog, Button, Input, Spinner, IconButton } from './ui.jsx'
import FloatingDialog from './FloatingDialog.jsx'
import { formatDate } from '../lib/utils.js'

/*
 * The multi-payment purchase editor: its payments, its figures, and the repairs — drop a payment that
 * was linked by mistake, or ungroup the lot.
 *
 * **One editor, two ways in**, the same rule the split editor follows: the ledger row's `🔗` marker opens it, and so does the transaction detail panel's purchase
 * summary. Making it a dialog rather than an inline section in the panel is what allows that — the row
 * has nowhere to inline an editor, and two implementations of one editor is the drift this repo keeps
 * finding in its own history.
 *
 * **It floats, and its confirmations portal to the body beside it.** Floating, so the ledger can be read
 * while payments are added; one of its hosts is a *ledger row*, and a `position: fixed` overlay inside a
 * table is positioned and stacked against whatever ancestor established a containing block, not the
 * viewport (`FloatingDialog` portals itself for that reason). The confirmations sit beside the dialog
 * rather than inside it, so they stack above it like any other modal.
 *
 * **Fields are explicit-submit; the payment actions are immediate.** Three fields are a form, so a
 * click-away must not persist a half-typed invoice total. Removing a payment and ungrouping act at
 * once, because each is a single deliberate click with its own confirm — and, crucially, **neither
 * touches the transactions themselves**, which is why neither is styled as danger: the payments stay
 * exactly as they are and re-linking undoes it.
 *
 * The form is seeded once and deliberately **not** reset from a reload. Removing a payment refetches
 * the purchase, and re-seeding there would silently discard a name the user had already typed.
 */
export default function PurchaseEditorDialog({ txnId, onClose, onSaved }) {
  const [purchase, setPurchase] = useState(null)
  const [loading, setLoading] = useState(true)
  const [form, setForm] = useState(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [pendingRemoval, setPendingRemoval] = useState(null)
  const [ungrouping, setUngrouping] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    api.getTransactionPurchase(txnId)
      .then(result => {
        if (cancelled) return
        const record = result.purchase || null
        setPurchase(record)
        // Seeded once, on the load that opened the dialog. See the header.
        setForm(form => form || (record ? {
          label: record.label || '',
          reference: record.reference || '',
          expectedTotal: expectedTotalInputValue(record.expected_total),
        } : null))
      })
      .catch(err => { if (!cancelled) setError(err?.message || 'This purchase could not be loaded.') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [txnId])

  const payments = purchase?.payments || []

  function settle(next) {
    setPurchase(next)
    onSaved?.(next)
    if (!next) onClose?.()
  }

  async function saveFields() {
    setSaving(true)
    setError('')
    try {
      const updated = await api.updatePurchase(purchase.id, {
        label: form.label,
        reference: form.reference,
        expected_total: signedExpectedTotal(form.expectedTotal, payments),
      })
      setPurchase(updated)
      onSaved?.(updated)
      onClose?.()
    } catch (err) {
      setError(err?.message || 'The purchase could not be saved.')
      setSaving(false)
    }
  }

  async function confirmRemoval() {
    const target = pendingRemoval
    setPendingRemoval(null)
    if (!target) return
    setError('')
    try {
      const result = await api.removePurchasePayment(purchase.id, target.txn_id)
      settle(result.purchase || null)
    } catch (err) {
      setError(err?.message || 'The payment could not be removed.')
    }
  }

  async function confirmUngroup() {
    setUngrouping(false)
    setError('')
    try {
      await api.deletePurchase(purchase.id)
      settle(null)
    } catch (err) {
      setError(err?.message || 'The purchase could not be ungrouped.')
    }
  }

  // Ordinals number the *live* payments — a trashed one is not one of the N the purchase is made of,
  // which is the same rule the row marker and the server follow (services/purchase_links.py).
  let liveIndex = 0
  const numbered = payments.map(payment => ({ ...payment, ordinal: payment.trashed ? null : ++liveIndex }))

  // Shown against the *typed* total rather than the saved one, so the arithmetic answers the figure on
  // screen while it is being entered — including the sign the magnitude is being given.
  const previewExpected = form ? signedExpectedTotal(form.expectedTotal, payments) : null
  const unaccounted = previewExpected === null || purchase === null
    ? null
    : Math.round((previewExpected - purchase.linked_total) * 100) / 100

  return createPortal(
    <>
    <FloatingDialog
      panelKey="ui.purchaseEditor.panel"
      title={purchase ? purchaseDisplayLabel(purchase) : 'Purchase'}
      description={
        purchase
          ? 'These payments are one purchase. Nothing about the transactions themselves is changed by grouping them, and removing one leaves it exactly as it is.'
          : undefined
      }
      onClose={onClose}
      width={560}
      actions={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>{purchase ? 'Cancel' : 'Close'}</Button>
          {purchase ? (
            <Button onClick={saveFields} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
          ) : null}
        </>
      }
    >
      {loading ? <Spinner /> : null}

      {!loading && !purchase ? (
        <div style={{ fontSize: 13, color: 'var(--muted)' }}>
          {error || 'This transaction is no longer part of a purchase.'}
        </div>
      ) : null}

      {purchase && form ? (
        <div style={{ display: 'grid', gap: 12 }}>
          <div style={{ display: 'grid', gap: 6 }}>
            <Input
              value={form.label}
              onChange={value => setForm(prev => ({ ...prev, label: value }))}
              placeholder="What was bought"
              aria-label="Purchase name"
            />
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 150px', gap: 6 }}>
              <Input
                value={form.reference}
                onChange={value => setForm(prev => ({ ...prev, reference: value }))}
                placeholder="Invoice or order number"
                aria-label="Invoice or order number"
              />
              <Input
                value={form.expectedTotal}
                onChange={value => setForm(prev => ({ ...prev, expectedTotal: value }))}
                placeholder="Expected total"
                aria-label="Expected total"
                inputMode="decimal"
                style={{ textAlign: 'right' }}
              />
            </div>
          </div>

          <div style={{ display: 'grid', gap: 3 }}>
            {numbered.map(payment => (
              <PaymentRow
                key={payment.txn_id}
                payment={payment}
                isThisRow={payment.txn_id === txnId}
                onRemove={() => setPendingRemoval(payment)}
              />
            ))}
          </div>

          <div style={{ display: 'grid', gap: 2, fontSize: 12.5, borderTop: '1px solid var(--border)', paddingTop: 6 }}>
            <TotalLine label={`Linked (${purchase.payment_count})`} amount={purchase.linked_total} />
            {previewExpected === null ? null : <TotalLine label="Expected" amount={previewExpected} muted />}
            {unaccounted === null ? null : (
              unaccounted === 0
                ? <div style={{ color: 'var(--success)' }}>Fully accounted for</div>
                // "Unaccounted" rather than "remaining": the gap may be a payment not made yet or one
                // made and not linked, and nothing in the ledger can tell which.
                : <TotalLine label="Unaccounted" amount={unaccounted} emphasis />
            )}
          </div>

          <div>
            <Button
              variant="secondary"
              onClick={() => setUngrouping(true)}
              title="Keep every payment exactly as it is, but stop treating them as one purchase"
            >Ungroup this purchase</Button>
          </div>

          {error ? <div style={{ fontSize: 12.5, color: 'var(--danger)' }}>{error}</div> : null}
        </div>
      ) : null}

    </FloatingDialog>
      {pendingRemoval ? (
        <AppConfirmDialog
          title="Remove this payment from the purchase?"
          description={
            payments.length - 1 < 2
              ? 'That leaves only one payment, so the purchase is ungrouped entirely. Both transactions stay exactly as they are.'
              : 'The transaction stays exactly as it is — it just stops counting toward this purchase.'
          }
          confirmLabel="Remove"
          onConfirm={confirmRemoval}
          onCancel={() => setPendingRemoval(null)}
        />
      ) : null}

      {ungrouping ? (
        <AppConfirmDialog
          title={`Ungroup ${purchaseDisplayLabel(purchase)}?`}
          description="Every payment stays exactly as it is; they just stop being treated as one purchase."
          confirmLabel="Ungroup"
          onConfirm={confirmUngroup}
          onCancel={() => setUngrouping(false)}
        />
      ) : null}
    </>,
    document.body,
  )
}

function PaymentRow({ payment, isThisRow, onRemove }) {
  return (
    <div
      style={{
        display: 'grid', gridTemplateColumns: '24px 84px minmax(0, 1fr) 100px 22px',
        gap: 8, alignItems: 'center', fontSize: 12.5,
        padding: '4px 8px', borderRadius: 6,
        // The row the editor was opened from is marked, so the list answers "which of these am I
        // looking at?" without the reader comparing dates against the ledger behind the dialog.
        background: isThisRow ? 'color-mix(in srgb, var(--accent) 10%, var(--surface2))' : 'var(--surface2)',
        opacity: payment.trashed ? 0.55 : 1,
      }}
      title={payment.trashed ? 'This payment is in the trash and is not counted' : `${payment.payee} · ${payment.account_name}`}
    >
      <span style={{ color: 'var(--muted)' }}>{payment.trashed ? '—' : payment.ordinal}</span>
      <span style={{ color: 'var(--muted)' }}>{formatDate(payment.date)}</span>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {payment.payee}
      </span>
      <span style={{
        textAlign: 'right',
        color: payment.trashed ? 'var(--muted)' : getTransactionAmountColor(payment.amount),
        textDecoration: payment.trashed ? 'line-through' : 'none',
      }}>
        {formatTransactionAmount(payment.amount)}
      </span>
      <IconButton onClick={onRemove} aria-label="Remove this payment from the purchase">
        ×
      </IconButton>
    </div>
  )
}

function TotalLine({ label, amount, muted = false, emphasis = false }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', color: muted ? 'var(--muted)' : 'var(--text)' }}>
      <span>{label}</span>
      <span style={{ fontWeight: emphasis ? 600 : 400 }}>{formatTransactionAmount(amount)}</span>
    </div>
  )
}
