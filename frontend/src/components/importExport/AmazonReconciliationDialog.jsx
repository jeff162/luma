// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import React, { useCallback, useEffect, useState } from 'react'
import { api } from '../../lib/api.js'
import { AppDialog, Spinner, EmptyState, Select, Button } from '../ui.jsx'
import { formatTransactionAmount } from '../../lib/moneyDisplay.js'
import FeatureExplainer from '../../help/FeatureExplainer.jsx'

// The Amazon reconciliation report for one import batch: how the imported orders line up with the card
// charges in the ledger. Three buckets (see routers/import_export/amazon.amazon_reconciliation):
//   • matched            — an order and the card charge it excluded
//   • amazon_unmatched   — a cash order whose card charge wasn't found (candidate for a manual link)
//   • payment_unmatched  — Amazon-looking ledger charges no order accounts for (heuristic reverse scan)
// Mirrors the duplicate report's role: surface the reconciliation so the user can see and correct it.

function TxnRow({ txn, muted }) {
  if (!txn) return null
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, padding: '5px 0', fontSize: 13 }}>
      <span style={{ color: 'var(--muted)', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>{txn.date}</span>
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: muted ? 'var(--muted)' : 'var(--text)' }}>
        {txn.name}
      </span>
      {txn.account ? <span style={{ color: 'var(--muted)', flexShrink: 0, fontSize: 12 }}>{txn.account}</span> : null}
      <span style={{ fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>{formatTransactionAmount(txn.amount)}</span>
    </div>
  )
}

function Section({ title, count, tone, help, children }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <span style={{ width: 8, height: 8, borderRadius: 8, background: tone, flexShrink: 0 }} />
        <span style={{ fontWeight: 600, color: 'var(--text)', fontSize: 13 }}>{title}</span>
        <span style={{ color: 'var(--muted)', fontSize: 13 }}>({count})</span>
      </div>
      {help ? <div style={{ color: 'var(--muted)', fontSize: 12, margin: '0 0 6px 16px' }}>{help}</div> : null}
      <div style={{ marginLeft: 16 }}>{children}</div>
    </div>
  )
}

export function AmazonReconciliationDialog({ batchId, onClose }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [picks, setPicks] = useState({})   // link_id → chosen charge txn id
  const [linking, setLinking] = useState(false)

  const load = useCallback((signal) => {
    api.getAmazonReconciliation(batchId)
      .then(d => { if (!signal?.aborted) { setData(d); setError('') } })
      .catch(e => { if (!signal?.aborted) setError(e?.message || 'Could not load the report') })
  }, [batchId])

  useEffect(() => {
    const ctrl = new AbortController()
    load(ctrl.signal)
    return () => ctrl.abort()
  }, [load])

  const matched = data?.matched || []
  const amazonUnmatched = data?.amazon_unmatched || []
  const paymentUnmatched = data?.payment_unmatched || []

  // The unaccounted Amazon charges are the natural manual-link targets for the unmatched orders.
  const chargeOptions = [
    { value: '', label: paymentUnmatched.length ? 'Link to a charge…' : 'No candidate charges' },
    ...paymentUnmatched.map(c => ({ value: c.id, label: `${c.date}  ${formatTransactionAmount(c.amount)}  ${c.name}`.trim() })),
  ]

  const linkCharge = async (linkId) => {
    const chargeTxnId = picks[linkId]
    if (!chargeTxnId) return
    setLinking(true)
    try {
      await api.linkAmazonCharge({ link_id: linkId, charge_txn_id: chargeTxnId })
      setPicks(prev => { const next = { ...prev }; delete next[linkId]; return next })
      load()
    } catch (e) {
      setError(e?.message || 'Could not link the charge')
    } finally {
      setLinking(false)
    }
  }

  return (
    <AppDialog
      title="Amazon reconciliation"
      description="How this import's orders line up with the card charges in your ledger."
      width="min(680px, 100%)"
      onClose={onClose}
      actions={<button onClick={onClose} style={{ background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 8, padding: '8px 16px', cursor: 'pointer', fontSize: 14 }}>Done</button>}
    >
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 4 }}>
        <FeatureExplainer topic="amazon-reconciliation" />
      </div>
      {error ? (
        <div style={{ color: 'var(--danger)', fontSize: 13 }}>{error}</div>
      ) : !data ? (
        <Spinner />
      ) : (matched.length + amazonUnmatched.length + paymentUnmatched.length) === 0 ? (
        <EmptyState message="Nothing to reconcile for this import." />
      ) : (
        <>
          <Section
            title="Matched" count={matched.length} tone="var(--success, #22c55e)"
            help="Each order was linked to the card charge it paid, and that charge is excluded from totals."
          >
            {matched.map(m => (
              <div key={m.link_id} style={{ padding: '6px 0', borderTop: '1px solid var(--border)' }}>
                <TxnRow txn={m.order} />
                <div style={{ marginLeft: 16 }}><TxnRow txn={m.charge} muted /></div>
              </div>
            ))}
          </Section>

          <Section
            title="Orders with no card charge found" count={amazonUnmatched.length} tone="#f59e0b"
            help="These orders are counted, but no matching charge was found to exclude — an untracked card, or a match we missed. Check your funding sources, or link one by hand from the unaccounted charges below."
          >
            {amazonUnmatched.map(m => (
              <div key={m.link_id} style={{ borderTop: '1px solid var(--border)', paddingBottom: 6 }}>
                <TxnRow txn={m.order} />
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginLeft: 16, marginTop: 2 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <Select
                      value={picks[m.link_id] || ''}
                      onChange={v => setPicks(prev => ({ ...prev, [m.link_id]: v }))}
                      options={chargeOptions}
                      aria-label="Charge to link"
                      disabled={linking || !paymentUnmatched.length}
                    />
                  </div>
                  <Button small onClick={() => linkCharge(m.link_id)} disabled={linking || !picks[m.link_id]}>Link</Button>
                </div>
              </div>
            ))}
          </Section>

          <Section
            title="Amazon charges with no order" count={paymentUnmatched.length} tone="#94a3b8"
            help="Charges in your ledger that look like Amazon, on the cards Amazon uses, in this import's date range, that no imported order accounts for. Possibly purchases the export didn't cover — informational."
          >
            {paymentUnmatched.map(t => (
              <div key={t.id} style={{ borderTop: '1px solid var(--border)' }}><TxnRow txn={t} muted /></div>
            ))}
          </Section>
        </>
      )}
    </AppDialog>
  )
}
