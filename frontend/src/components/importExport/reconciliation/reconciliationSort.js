// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// The sort fields of a reconciliation column whose cell is a ledger row (TxnCell): the date, the name and
// the amount it shows. `pick(entry)` is the row the cell shows, or the first of a stack. Amount sorts by
// size, so a charge and its refund land together rather than at opposite ends.
export function txnSortFields(pick) {
  return [
    { key: 'date', label: 'Date', sortValue: entry => pick(entry)?.date || '' },
    { key: 'name', label: 'Description', sortValue: entry => (pick(entry)?.name || '').toLowerCase() },
    { key: 'amount', label: 'Amount', sortValue: entry => {
      const amount = pick(entry)?.amount
      return typeof amount === 'number' ? Math.abs(amount) : null
    } },
  ]
}
