// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Tooltip, ROW_HOVER_OPEN_DELAY_MS } from '../../ui.jsx'
import { MerchantOriginHoverCard } from '../../OriginFields.jsx'
import { TransactionMatchCell } from '../TransactionMatchCell.jsx'

// Cells shared by the reconciliation reports. A ledger row arrives as the backend's txn summary
// ({ id, date, amount, name, account, …origin fields }) and renders as a TransactionMatchCell with the
// ledger's origin-fields card on hover — the full "where did this come from" detail, which is what tells
// near-identical copies apart.

function toRecord(txn) {
  if (!txn) return null
  return { date: txn.date, merchant: txn.name, amount: txn.amount, account_name: txn.account }
}

function withOriginHover(txn, child) {
  return (
    // `interactive` so the pointer can move into the card — its rows can carry a followable link, which a
    // close-on-leave tooltip would make unreachable. The dwell keeps these cells from strobing a card at
    // every row that scrolls under a resting cursor.
    <Tooltip content={<MerchantOriginHoverCard txn={txn} />} maxWidth={380} triggerStyle={{ minWidth: 0 }} interactive openDelay={ROW_HOVER_OPEN_DELAY_MS}>
      {child}
    </Tooltip>
  )
}

export function TxnCell({ txn }) {
  if (!txn) return <TransactionMatchCell record={null} />
  return withOriginHover(txn, <div><TransactionMatchCell record={toRecord(txn)} /></div>)
}

// A read-only vertical stack of rows — a record paired with several charges, or a suggested set.
export function TxnStack({ charges }) {
  if (!charges || charges.length === 0) return <TransactionMatchCell record={null} />
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {charges.map(c => (
        <div key={c.id}>{withOriginHover(c, <div><TransactionMatchCell record={toRecord(c)} /></div>)}</div>
      ))}
    </div>
  )
}
