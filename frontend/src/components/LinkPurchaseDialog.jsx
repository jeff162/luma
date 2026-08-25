// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo, useState } from 'react'
import { api } from '../lib/api.js'
import { formatTransactionAmount, getTransactionAmountColor } from '../lib/moneyDisplay.js'
import {
  livePaymentsTotal,
  planPurchaseLink,
  purchaseDisplayLabel,
  signedExpectedTotal,
  suggestPurchaseLabel,
} from '../lib/purchaseLinks.js'
import { getTxnMerchantLabel } from './TransactionRow.jsx'
import { AppDialog, Button, Input } from './ui.jsx'

/*
 * "These payments are one purchase" — the dialog behind the ledger's bulk action.
 *
 * **Which of the two things it does is decided from the rows, not asked.** The list feed already
 * carries each row's purchase, so a selection that touches an existing purchase adds to it (finding a
 * third instalment later is the ordinary way a purchase grows) and one that touches none creates a new
 * one. A selection spanning two purchases has no honest reading — merging them would be a decision
 * nobody asked for — so it is refused with the reason instead. `planPurchaseLink` owns that call.
 *
 * **The payments are listed, not counted.** Grouping is a claim about specific transactions, and a
 * bulk selection is easy to get wrong by one row; a running total under the list is what makes an
 * accidental extra payment visible before it is saved rather than after.
 *
 * The expected total is typed as a plain magnitude and shown back signed, in the ledger's own
 * convention, right under the payments it is being compared against — so the inference that gives it a
 * direction is on screen rather than hidden behind the save.
 */
export default function LinkPurchaseDialog({ rows, onClose, onLinked }) {
  const plan = useMemo(() => planPurchaseLink(rows), [rows])
  const [label, setLabel] = useState(() => suggestPurchaseLabel(rows))
  const [reference, setReference] = useState('')
  const [expectedTotal, setExpectedTotal] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const linking = plan.mode === 'blocked' ? [] : plan.rows
  // The figure to compare an expected total against is the whole purchase, so adding to an existing one
  // counts what is already linked as well as what is being added.
  const alreadyLinked = plan.mode === 'add' ? (plan.purchase.linked_total || 0) : 0
  const selectionTotal = livePaymentsTotal(linking.map(row => ({ amount: row.amount }))) + alreadyLinked
  const signedTotal = signedExpectedTotal(expectedTotal, [{ amount: selectionTotal }])

  async function save() {
    setSaving(true)
    setError('')
    try {
      const txnIds = linking.map(row => row.id)
      const purchase = plan.mode === 'add'
        ? await api.addPurchasePayments(plan.purchase.id, txnIds)
        : await api.createPurchase({
          txn_ids: txnIds,
          label,
          reference,
          expected_total: signedTotal,
        })
      onLinked?.(purchase)
    } catch (err) {
      setError(err?.message || 'The payments could not be grouped.')
      setSaving(false)
    }
  }

  const adding = plan.mode === 'add'
  return (
    <AppDialog
      title={adding ? `Add to ${purchaseDisplayLabel(plan.purchase)}` : 'Link as one purchase'}
      description={
        plan.mode === 'blocked'
          ? plan.reason
          : adding
            ? 'These payments join the purchase the others are already part of. Nothing about any transaction changes — they simply count toward one purchase.'
            : 'Several payments for one thing — a deposit and a balance, or an instalment plan. Nothing about the transactions changes; they just count toward one purchase.'
      }
      onClose={onClose}
      width="min(560px, 100%)"
      actions={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
          {plan.mode === 'blocked' ? null : (
            <Button onClick={save} disabled={saving}>
              {saving ? 'Linking…' : (adding ? 'Add payments' : 'Link purchase')}
            </Button>
          )}
        </>
      }
    >
      {plan.mode === 'blocked' ? null : (
        <div style={{ display: 'grid', gap: 12 }}>
          {adding ? null : (
            <div style={{ display: 'grid', gap: 6 }}>
              <Input
                value={label}
                onChange={setLabel}
                placeholder="What was bought (optional)"
                aria-label="Purchase name"
              />
              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 150px', gap: 6 }}>
                <Input
                  value={reference}
                  onChange={setReference}
                  placeholder="Invoice or order number"
                  aria-label="Invoice or order number"
                />
                <Input
                  value={expectedTotal}
                  onChange={setExpectedTotal}
                  placeholder="Expected total"
                  aria-label="Expected total"
                  inputMode="decimal"
                  style={{ textAlign: 'right' }}
                />
              </div>
            </div>
          )}

          <div style={{ display: 'grid', gap: 3 }}>
            {linking.map(row => (
              <div
                key={row.id}
                style={{
                  display: 'grid', gridTemplateColumns: '78px minmax(0, 1fr) 100px',
                  gap: 8, alignItems: 'center', fontSize: 12.5,
                  padding: '4px 8px', borderRadius: 6, background: 'var(--surface2)',
                }}
              >
                <span style={{ color: 'var(--muted)' }}>{row.date}</span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {getTxnMerchantLabel(row)}
                </span>
                <span style={{ textAlign: 'right', color: getTransactionAmountColor(row.amount) }}>
                  {formatTransactionAmount(row.amount)}
                </span>
              </div>
            ))}
          </div>

          <div style={{ display: 'grid', gap: 2, fontSize: 12.5, borderTop: '1px solid var(--border)', paddingTop: 6 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: 'var(--muted)' }}>
                {adding ? 'Purchase total once added' : `Purchase total (${linking.length} payments)`}
              </span>
              <span style={{ fontWeight: 600 }}>{formatTransactionAmount(selectionTotal)}</span>
            </div>
            {signedTotal === null ? null : (
              <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--muted)' }}>
                <span>Expected</span>
                <span>{formatTransactionAmount(signedTotal)}</span>
              </div>
            )}
          </div>

          {error ? <div style={{ fontSize: 12.5, color: 'var(--danger)' }}>{error}</div> : null}
        </div>
      )}
    </AppDialog>
  )
}
