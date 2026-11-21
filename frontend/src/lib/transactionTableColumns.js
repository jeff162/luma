// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// The columns `TransactionListTable` can show, and what a host needs to know about them: a column's label
// for the column choice, and the width the shown columns need.

export const TRANSACTION_TABLE_COLUMN_DEFS = {
  date: { key: 'date', label: 'Date', defaultWidth: 96, minWidth: 82 },
  // When the row posted, or its one date where the source gave only one. Hidden until chosen.
  posted: { key: 'posted', label: 'Posted', defaultWidth: 96, minWidth: 82, defaultHidden: true },
  merchant: { key: 'merchant', label: 'Merchant', defaultWidth: 260, minWidth: 150 },
  category: { key: 'category', label: 'Category', defaultWidth: 150, minWidth: 110 },
  account: { key: 'account', label: 'Account', defaultWidth: 140, minWidth: 110 },
  // The original (source) account a row came from. Distinct from `account`, which shows the
  // effective/top-level account — identical for every row inside a merged-account report and so
  // surfaced only there (see AccountDetail), where it tells the merged children apart.
  sourceAccount: { key: 'sourceAccount', label: 'Account', defaultWidth: 150, minWidth: 110 },
  // The note/tag/status markers (see TransactionMarkersCell). Not sortable — there is no single
  // meaningful order across a mix of tags, notes, and status flags. Left-aligned like the other
  // text columns; overflow past its width is clipped by the cell wrapper.
  tags: { key: 'tags', label: 'Tags', defaultWidth: 96, minWidth: 44, sortable: false },
  amount: { key: 'amount', label: 'Amount', defaultWidth: 96, minWidth: 72, align: 'end' },
  // The account's balance just after the row (`running_balance`, from the server). Not sortable: it
  // follows the date order, so sorting by date is sorting by it.
  runningBalance: { key: 'runningBalance', label: 'Balance', defaultWidth: 112, minWidth: 84, align: 'end', sortable: false },
}

// A column's header label, for a host listing the columns (the column choice).
export function transactionColumnLabel(key) {
  return TRANSACTION_TABLE_COLUMN_DEFS[key]?.label || key
}

// The width a table needs to show `columns` (the shown entries of its layout) without scrolling sideways:
// the columns, the bulk-select column while it shows, the rows' side padding and the scroller's border.
export function transactionTableWidth(columns, { bulkActive = false } = {}) {
  const columnsWidth = columns.reduce((sum, column) => sum + (Number(column.width) || 0), 0)
  return columnsWidth + (bulkActive ? 40 : 0) + 14 * 2 + 2
}
