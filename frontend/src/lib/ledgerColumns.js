// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * The Transactions ledger's columns and its saved layout.
 *
 * The layout is one stored list of `{ key, width, hidden? }` in display order, covering every column
 * whether shown or not. A hidden column keeps its width and stays behind the column it followed, so
 * showing it again puts it back beside the same neighbour even after the visible columns were reordered
 * (`mergeVisibleLedgerColumns`). `hidden` is stored only when true, so a layout saved before
 * columns could be hidden reads as everything shown.
 *
 * A saved layout that predates a column gets that column at its canonical position, shown or hidden as
 * its definition says (`defaultHidden`), so adding a column never discards a customized layout.
 */

export const LEDGER_COLUMN_DEFS = [
  { key: 'date', label: 'Date', defaultWidth: 100, minWidth: 70 },
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
  LEDGER_COLUMN_DEFS.forEach((def, index) => {
    if (keys.includes(def.key)) return
    result.splice(Math.min(index, result.length), 0, defaultEntry(def))
  })
  return result
}

export function visibleLedgerColumns(cols) {
  return cols.filter(col => !col.hidden)
}

// Writes a new order and widths for the visible columns back into the full layout. Each hidden column
// travels with the visible column before it (those leading the list stay first), so it comes back
// beside the same neighbour however the others were moved.
export function mergeVisibleLedgerColumns(cols, nextVisible) {
  const leading = []
  const trailingByKey = new Map()
  let anchor = null
  for (const col of cols) {
    if (!col.hidden) {
      anchor = col.key
      continue
    }
    if (anchor === null) leading.push(col)
    else trailingByKey.set(anchor, [...(trailingByKey.get(anchor) || []), col])
  }
  const placed = new Set(cols.filter(col => col.hidden).map(col => col.key))
  const result = [...leading]
  for (const col of nextVisible) {
    if (!DEF_BY_KEY.has(col.key) || placed.has(col.key)) continue
    placed.add(col.key)
    result.push({ key: col.key, width: col.width }, ...(trailingByKey.get(col.key) || []))
  }
  // A visible column the update left out keeps its place at the end rather than vanishing.
  for (const col of cols) {
    if (col.hidden || placed.has(col.key)) continue
    result.push(col, ...(trailingByKey.get(col.key) || []))
  }
  return result
}

export function setLedgerColumnHidden(cols, key, hidden) {
  return cols.map(col => {
    if (col.key !== key) return col
    return hidden ? { key: col.key, width: col.width, hidden: true } : { key: col.key, width: col.width }
  })
}
