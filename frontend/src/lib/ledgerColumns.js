// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * The Transactions ledger's columns and its saved layout.
 *
 * The layout is a hideable-column layout (`columnVisibility.js`): every column in display order, hidden
 * or not.
 *
 * A saved layout that predates a column gets that column after the one it follows by default, shown or
 * hidden as its definition says (`defaultHidden`), so adding a column never discards a customized layout.
 */

import { mergeVisibleColumns, setColumnHidden, visibleColumns } from './columnVisibility.js'

export const LEDGER_COLUMN_DEFS = [
  { key: 'date', label: 'Date', defaultWidth: 100, minWidth: 70 },
  // When the row posted, or its one date where the source gave only one.
  { key: 'posted', label: 'Posted', defaultWidth: 100, minWidth: 70, defaultHidden: true },
  { key: 'merchant', label: 'Merchant', defaultWidth: 220, minWidth: 120 },
  { key: 'category', label: 'Category', defaultWidth: 150, minWidth: 100 },
  // The import file a row came from. Not sortable: the list feed has no sort on it.
  { key: 'source', label: 'Source', defaultWidth: 160, minWidth: 100, sortable: false, defaultHidden: true },
  { key: 'account', label: 'Account', defaultWidth: 150, minWidth: 100 },
  // Note/tag/status markers (see TransactionMarkersCell). Not sortable — no single meaningful order
  // across a mix of tags, notes, and status flags.
  { key: 'tags', label: 'Tags', defaultWidth: 90, minWidth: 44, sortable: false },
  { key: 'amount', label: 'Amount', defaultWidth: 92, minWidth: 70 },
]

const DEF_BY_KEY = new Map(LEDGER_COLUMN_DEFS.map(def => [def.key, def]))

export function getLedgerColumnDef(key) {
  return DEF_BY_KEY.get(key)
}

function defaultEntry(def) {
  return def.defaultHidden
    ? { key: def.key, width: def.defaultWidth, hidden: true }
    : { key: def.key, width: def.defaultWidth }
}

export function defaultLedgerColumns() {
  return LEDGER_COLUMN_DEFS.map(defaultEntry)
}

export function normalizeLedgerColumns(cfg) {
  if (!Array.isArray(cfg)) return null
  const keys = cfg.map(col => col?.key)
  // A corrupt or foreign layout (duplicate or unrecognized keys) falls back to the defaults.
  if (new Set(keys).size !== keys.length) return null
  if (!keys.every(key => DEF_BY_KEY.has(key))) return null
  const result = cfg.map(col => {
    const width = Number(col.width) || DEF_BY_KEY.get(col.key).defaultWidth
    return col.hidden === true ? { key: col.key, width, hidden: true } : { key: col.key, width }
  })
  // After the column it follows by default, so it lands beside that neighbour however the layout was
  // reordered (a new Posted column beside Date).
  LEDGER_COLUMN_DEFS.forEach((def, index) => {
    if (result.some(col => col.key === def.key)) return
    const previousKey = LEDGER_COLUMN_DEFS[index - 1]?.key
    result.splice(result.findIndex(col => col.key === previousKey) + 1, 0, defaultEntry(def))
  })
  return result
}

export function visibleLedgerColumns(cols) {
  return visibleColumns(cols)
}

export function mergeVisibleLedgerColumns(cols, nextVisible) {
  return mergeVisibleColumns(cols, nextVisible, key => DEF_BY_KEY.has(key))
}

export function setLedgerColumnHidden(cols, key, hidden) {
  return setColumnHidden(cols, key, hidden)
}
