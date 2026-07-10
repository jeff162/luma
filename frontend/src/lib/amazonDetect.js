// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * Detect an AZAD Amazon order-history export from its CSV header, mirroring the backend
 * `services/amazon_import.sniff_kind`. This lets a file dropped on the general CSV importer be routed
 * to the Amazon import flow instead of the column-mapping flow. Header markers only — no row data is
 * inspected, and the two exports are disjoint (the items file uniquely carries ASIN/description/price,
 * the orders file payments/total).
 */

const ORDERS_MARKERS = ['payments', 'total']
const ITEMS_MARKERS = ['asin', 'description', 'price']

// Returns 'orders' | 'items' | null for a CSV header line (the first row of the file).
export function sniffAmazonExportKind(headerLine) {
  if (!headerLine) return null
  const cols = new Set(
    headerLine.replace(/^\uFEFF/, '').split(',').map(c => c.trim().toLowerCase()),
  )
  if (ITEMS_MARKERS.every(m => cols.has(m))) return 'items'
  if (ORDERS_MARKERS.every(m => cols.has(m))) return 'orders'
  return null
}

export function isAmazonExportHeader(headerLine) {
  return sniffAmazonExportKind(headerLine) !== null
}
