// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * A table layout that can hide columns: one stored list of `{ key, width, hidden? }` in display order,
 * covering every column whether shown or not. A hidden column keeps its width and stays behind the column
 * it followed, so showing it again puts it back beside the same neighbour even after the visible columns
 * were reordered. `hidden` is stored only when true, so a layout saved before columns could be hidden
 * reads as everything shown. Shared by the Transactions ledger (`ledgerColumns.js`) and the transaction
 * lists built on `TransactionListTable`.
 */

export function visibleColumns(cols) {
  return cols.filter(col => !col.hidden)
}

// Writes a new order and widths for the visible columns back into the full layout. Each hidden column
// travels with the visible column before it (those leading the list stay first), so it comes back beside
// the same neighbour however the others were moved. `isKnown` drops a key the table no longer has.
export function mergeVisibleColumns(cols, nextVisible, isKnown = () => true) {
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
    if (!isKnown(col.key) || placed.has(col.key)) continue
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

export function setColumnHidden(cols, key, hidden) {
  return cols.map(col => {
    if (col.key !== key) return col
    return hidden ? { key: col.key, width: col.width, hidden: true } : { key: col.key, width: col.width }
  })
}
