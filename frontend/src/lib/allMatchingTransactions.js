// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { api, downloadUrl } from './api.js'

// The most rows `GET /transactions` returns in one request (its `limit` is `le=1000`). Asking for more is
// refused outright rather than truncated, so a caller that sends `limit: total` works only until the
// ledger passes this size.
export const TRANSACTIONS_REQUEST_MAX_ROWS = 1000

// The copy's columns, in the copy's order, so a download taken past the copy limit reads like the copy.
const SHARE_EXPORT_COLUMNS = 'date,merchant_name,category,account,amount'

/*
 * Every row a paged transaction query matches, fetched a page at a time in the query's own order — for an
 * action that reaches past what a paged list has loaded (copying a whole filtered list). `fetchPage(offset,
 * limit)` resolves to a `GET /transactions` response. `limit: 0` would do it in one request but is reserved
 * for scopes known to be small, which a filtered ledger is not.
 *
 * `maxRows` stops it at the first that many rows, in the same order.
 *
 * The walk stops on an empty page as well as at `total`, since a row removed mid-walk shrinks the result
 * underneath it and would otherwise leave it asking for a page that can never fill.
 */
export async function walkTransactionPages(fetchPage, { pageSize = TRANSACTIONS_REQUEST_MAX_ROWS, maxRows = Infinity } = {}) {
  const rows = []
  let total = Infinity
  while (rows.length < Math.min(total, maxRows)) {
    const response = await fetchPage(rows.length, Math.min(pageSize, maxRows - rows.length))
    const page = response?.transactions || []
    total = response?.total ?? 0
    if (page.length === 0) break
    rows.push(...page)
  }
  return rows
}

// `walkTransactionPages` over the list endpoint for a filter object (sort included).
export function fetchAllMatchingTransactions(params, options) {
  return walkTransactionPages((offset, limit) => api.getTransactions({ ...params, limit, offset }), options)
}

// The rows a filter object (sort included) matches, as a CSV download. The export takes the list feed's
// own filter and order, so the file holds exactly the rows the same filter lists.
export function downloadMatchingTransactions(params) {
  return downloadUrl(api.exportTransactionsCsv({ ...params, columns: SHARE_EXPORT_COLUMNS }))
}
