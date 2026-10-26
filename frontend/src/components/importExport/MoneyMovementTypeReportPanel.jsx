// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useState } from 'react'
import { api } from '../../lib/api.js'
import { Spinner, FloatingPanel, FloatingPanelHeader, IconButton, OverlayBackdrop } from '../ui.jsx'
import TransactionListTable from '../TransactionListTable.jsx'

/*
 * Drill-down for one PayPal money-movement `Type`, opened from the review's per-type arrow. It fetches
 * every transaction on the data source's accounts that carries this Type (the same scope the review's
 * count uses) and splits them into two groups so the count and the outcome line up visibly:
 *
 *   - **Affected** — the rule-eligible rows (`category_overridden = 0`) that match this type. When the type
 *     is already a money-movement rule these sit in the excluded "Money movement" category; when it isn't
 *     (the user opened the report for an ordinary type), they carry whatever category they have and a
 *     money-movement rule *would* claim them — so the heading is worded conditionally rather than claiming
 *     "in Money movement" for a type that isn't ruled.
 *   - **Not affected** — rows whose category was set by hand (`category_overridden = 1`). The rule
 *     deliberately never overrides those (see recategorize's manual protection), so they keep the category
 *     a hand-edit gave them — which is why a Type's total row count can exceed how many actually moved to
 *     Money movement. A trusted import's category is not protected: a matching rule takes it. Each row
 *     shows that category, and opening it reveals its Origin/source.
 *
 * Stacked above the review dialog (a second FloatingPanel), matching the drill-down affordance used
 * elsewhere rather than turning the count into a link.
 */
export function MoneyMovementTypeReportPanel({ type, alreadyRuled = false, accountIds = [], categories = [], onClose }) {
  const [rows, setRows] = useState(null)   // null = loading

  useEffect(() => {
    let live = true
    setRows(null)
    api.getTransactions({
      account_ids: (accountIds || []).join(','),
      import_evidence_type: type,
      limit: 1000,
    })
      .then(data => { if (live) setRows(Array.isArray(data?.transactions) ? data.transactions : (data || [])) })
      .catch(() => { if (live) setRows([]) })
    return () => { live = false }
  }, [type, accountIds])

  const affected = (rows || []).filter(r => !r.category_overridden)
  const notAffected = (rows || []).filter(r => r.category_overridden)

  return (
    <OverlayBackdrop zIndex={1300} tint="rgba(15, 23, 42, 0.30)" onClick={onClose}>
      <FloatingPanel style={{ width: 'min(860px, 100%)', maxHeight: 'calc(100vh - 120px)', display: 'flex', flexDirection: 'column' }} onClick={e => e.stopPropagation()}>
        <FloatingPanelHeader style={{ padding: '16px 20px' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 16, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{type}</div>
            <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4 }}>Transactions on this source carrying this PayPal type</div>
          </div>
          <IconButton size="large" aria-label="Close" onClick={onClose}>×</IconButton>
        </FloatingPanelHeader>

        <div style={{ padding: '8px 16px 16px', overflowY: 'auto' }}>
          {rows === null ? (
            <Spinner />
          ) : rows.length === 0 ? (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>No transactions found for this type.</div>
          ) : (
            <>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', margin: '4px 2px 4px' }}>
                {alreadyRuled
                  ? `Affected by the rule · ${affected.length} in Money movement`
                  : `Rule-eligible · ${affected.length} match this type`}
              </div>
              {!alreadyRuled && affected.length ? (
                <div style={{ fontSize: 11, color: 'var(--muted)', margin: '0 2px 6px', lineHeight: 1.5 }}>
                  A money-movement rule for this type would move these to Money movement.
                </div>
              ) : null}
              {affected.length ? (
                <TransactionListTable
                  rows={affected}
                  categories={categories}
                  showAccount={false}
                  showMerchantReport={false}
                  maxHeight={280}
                  emptyMessage="None."
                />
              ) : (
                <div style={{ fontSize: 12, color: 'var(--muted)', padding: '2px 2px 10px' }}>None — no rule-eligible rows carry this type.</div>
              )}

              {notAffected.length ? (
                <>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', margin: '16px 2px 4px' }}>
                    Not affected · {notAffected.length} keep a manual category
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--muted)', margin: '0 2px 6px', lineHeight: 1.5 }}>
                    These already have a category set by hand, which the money-movement rule doesn&apos;t
                    override. Open a row to see where its category came from.
                  </div>
                  <TransactionListTable
                    rows={notAffected}
                    categories={categories}
                    showAccount={false}
                    showMerchantReport={false}
                    maxHeight={280}
                    emptyMessage="None."
                  />
                </>
              ) : null}
            </>
          )}
        </div>
      </FloatingPanel>
    </OverlayBackdrop>
  )
}
