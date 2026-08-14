// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// The import mapping table's amounts come from the backend (`POST /import-export/preview/amounts`),
// which runs the import's own `parse_amount`. The client deliberately owns no amount parsing: it used
// to, and the two implementations disagreed on `single_unsigned` rows (the direction column was
// ignored, so every row rendered as a credit), on `DR`/`CR` suffixes, and on blank two-column cells —
// a preview that was wrong precisely where a preview matters. See `docs/architecture.md` (import flow).
//
// What lives here is the plumbing around that call: build the request from the current mapping, fetch
// it debounced as the mapping is edited, and merge the answer back onto the rendered rows by position.

import { useEffect, useMemo, useState } from 'react'

import { api } from '../api.js'

// Long enough that dragging through a column dropdown or retyping a skip-rows count settles into one
// request, short enough that the amounts land while the user is still looking at the mapping.
export const PREVIEW_AMOUNTS_DEBOUNCE_MS = 250

// Build the request body, or null when there is nothing to ask about — no rows, or not one of the
// amount-bearing columns mapped yet. This is only a "don't call the server for nothing" check; which
// columns a convention actually requires is the server's rule, and a half-configured mapping is
// answered there with nulls rather than second-guessed here.
export function buildPreviewAmountsRequest({ rows, amountConvention, columnMap }) {
  if (!rows?.length) return null
  const { amount = null, debit = null, credit = null, direction = null } = columnMap || {}
  if (!amount && !debit && !credit) return null
  return {
    rows,
    amount_convention: amountConvention,
    column_map: { amount, debit, credit, direction },
  }
}

// Merge server amounts onto preview rows by position. A missing entry — no response yet, a short
// response, or a failed request — stays null, which the table renders as the raw cell or an em dash
// rather than a number that might not be what the import will store.
export function mergePreviewAmounts(rows, amounts) {
  if (!amounts) return rows
  return rows.map((row, i) => ({ ...row, amount: amounts[i] ?? null }))
}

// Signed amounts for `rows` under the current convention and column mapping, or null when nothing has
// been fetched for that mapping yet. The serialized request doubles as the effect key: it is at most
// ten small rows, and it refires on exactly the changes that can change an amount.
export function usePreviewAmounts(rows, amountConvention, columnMap) {
  const [amounts, setAmounts] = useState(null)
  const { amount, debit, credit, direction } = columnMap || {}

  const requestKey = useMemo(() => {
    const request = buildPreviewAmountsRequest({
      rows,
      amountConvention,
      columnMap: { amount, debit, credit, direction },
    })
    return request ? JSON.stringify(request) : null
  }, [rows, amountConvention, amount, debit, credit, direction])

  useEffect(() => {
    if (!requestKey) {
      setAmounts(null)
      return
    }
    let cancelled = false
    // Debounced because the mapping dropdowns can change several times in a second. The previous
    // amounts stay on screen while a request is in flight rather than blanking on every change.
    const timer = setTimeout(async () => {
      try {
        const result = await api.previewAmounts(JSON.parse(requestKey))
        if (!cancelled) setAmounts(result?.amounts || [])
      } catch {
        // Fall back to showing the raw cell rather than a number that may not match the import.
        if (!cancelled) setAmounts([])
      }
    }, PREVIEW_AMOUNTS_DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [requestKey])

  return amounts
}
