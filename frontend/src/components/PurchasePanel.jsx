// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../lib/api.js'
import { formatTransactionAmount } from '../lib/moneyDisplay.js'
import { paymentPositionLabel, purchaseDisplayLabel, purchaseRowSummary } from '../lib/purchaseLinks.js'
import PurchaseEditorDialog from './PurchaseEditorDialog.jsx'

/*
 * The transaction detail panel's statement that this row is one payment of a larger purchase.
 *
 * **A summary, not an editor.** Editing lives in `PurchaseEditorDialog`, which the ledger row's `🔗`
 * marker also opens — the same "one editor per surface, two ways in" shape the split editor follows,
 * and the reason this panel does not inline one: a row has nowhere to inline an editor, so a second
 * implementation here is drift waiting to happen. It mirrors what this panel already does for splits,
 * where the category is shown and a `Split…` button opens the dialog.
 *
 * **It renders nothing at all when the transaction is not part of a purchase.** An always-present empty
 * section would sit on every row in the ledger to serve the handful that are grouped, and the place
 * someone realizes two rows belong together is the ledger, where the bulk action lives.
 *
 * `onPurchaseChange` reports the current summary so the host can keep the ledger row's marker in step
 * without refetching the page. Like `DocumentsPanel`'s, it **must be a stable reference** — the report
 * patches the host's row, which re-renders this panel, so an inline arrow would restart the fetch on
 * every one of those renders and loop between loading and loaded.
 */
export default function PurchasePanel({ txnId, onPurchaseChange }) {
  const [purchase, setPurchase] = useState(null)
  const [editing, setEditing] = useState(false)

  // Held in a ref rather than depended on: this is a notification, not an input to the fetch. See the
  // same rule (and the loop it prevents) in DocumentsPanel.
  const notifyRef = useRef(onPurchaseChange)
  notifyRef.current = onPurchaseChange

  const publish = useCallback((next) => {
    setPurchase(next)
    notifyRef.current?.(next)
  }, [])

  useEffect(() => {
    let cancelled = false
    api.getTransactionPurchase(txnId)
      .then(result => { if (!cancelled) publish(result.purchase || null) })
      .catch(() => { if (!cancelled) publish(null) })
    return () => { cancelled = true }
  }, [txnId, publish])

  if (!purchase) return null

  const summary = purchaseRowSummary(purchase, txnId)
  const { expected_total: expected, linked_total: linked } = purchase

  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        Purchase
      </div>

      {/* The whole summary is the control, like the row's marker is: there is one thing to do with a
          purchase from here and a separate "Edit…" beside a line that is already a link would be two
          affordances for it. */}
      <button
        type="button"
        onClick={() => setEditing(true)}
        title="Open this purchase — its payments, its totals, and how to change them"
        style={{
          display: 'grid', gap: 3, width: '100%', textAlign: 'left', cursor: 'pointer',
          background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6,
          padding: '6px 8px', color: 'var(--text)', font: 'inherit',
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 600 }}>
          {purchaseDisplayLabel(purchase)}
          {purchase.reference ? (
            <span style={{ fontWeight: 400, color: 'var(--muted)', marginLeft: 6 }}>{purchase.reference}</span>
          ) : null}
        </span>
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>
          {paymentPositionLabel(summary)}
          {' · '}
          {expected === null || expected === undefined
            ? `${formatTransactionAmount(linked)} linked`
            : `${formatTransactionAmount(linked)} of ${formatTransactionAmount(expected)}`}
        </span>
      </button>

      {editing ? (
        <PurchaseEditorDialog
          txnId={txnId}
          onClose={() => setEditing(false)}
          onSaved={publish}
        />
      ) : null}
    </div>
  )
}
