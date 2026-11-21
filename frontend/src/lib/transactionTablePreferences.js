// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo } from 'react'
import { useDeviceLayoutPreference } from './UserPreferencesContext.jsx'

const BASE_TRANSACTION_TABLE_COLUMNS = [
  { key: 'date', width: 96 },
  // When the row posted. Offered where a table lets columns be chosen, and hidden until it is chosen.
  { key: 'posted', width: 96, defaultHidden: true },
  { key: 'merchant', width: 260 },
  { key: 'category', width: 150 },
  { key: 'account', width: 140 },
  { key: 'sourceAccount', width: 150 },
  { key: 'tags', width: 96 },
  { key: 'amount', width: 108 },
  { key: 'runningBalance', width: 112 },
]

function getExpectedColumns({
  showCategory = true, showAccount = true, showSourceAccount = false, showRunningBalance = false, showPostedDate = false,
}) {
  return BASE_TRANSACTION_TABLE_COLUMNS.filter(column => (
    (column.key !== 'posted' || showPostedDate) &&
    (column.key !== 'category' || showCategory) &&
    (column.key !== 'account' || showAccount) &&
    (column.key !== 'sourceAccount' || showSourceAccount) &&
    (column.key !== 'runningBalance' || showRunningBalance)
  ))
}

function defaultEntry(column) {
  return column.defaultHidden
    ? { key: column.key, width: column.width, hidden: true }
    : { key: column.key, width: column.width }
}

// The layout is hideable (`columnVisibility.js`): every column this surface offers, hidden ones included.
export function buildTransactionTableDefaultColumnConfig(options = {}) {
  return getExpectedColumns(options).map(defaultEntry)
}

export function normalizeTransactionTableColumnConfig(value, options = {}) {
  if (!Array.isArray(value)) return null
  const expectedColumns = getExpectedColumns(options)
  const defaultWidthByKey = new Map(expectedColumns.map(column => [column.key, column.width]))
  const seen = new Set()
  // Preserve the incoming column ORDER (so a user reorder sticks), keeping only the columns this
  // surface shows. A saved layout is read for what it *does* say rather than being required to match
  // the current column set exactly: demanding that made every saved layout unreadable the moment a
  // column was added (`tags`), which read as resizes and reorders not sticking at all.
  const normalized = []
  for (const column of value) {
    const key = column?.key
    if (!defaultWidthByKey.has(key) || seen.has(key)) continue
    seen.add(key)
    const width = Number(column?.width) || defaultWidthByKey.get(key)
    normalized.push(column?.hidden === true ? { key, width, hidden: true } : { key, width })
  }
  if (!normalized.length) return null
  // A column the saved layout predates goes in at its canonical position, beside its natural
  // neighbours rather than stranded at the end.
  expectedColumns.forEach((column, canonicalIndex) => {
    if (seen.has(column.key)) return
    normalized.splice(Math.min(canonicalIndex, normalized.length), 0, defaultEntry(column))
  })
  return normalized
}

/*
 * Transaction table geometry is shared product language, but each surface still keeps its
 * own preference key so a user can tune a focused detail drawer differently from a page-level ledger.
 *
 * The stored preference is the single source of truth — there is no local mirror or load/save effect.
 * The visible config is derived by normalizing the stored value against the columns this surface
 * currently shows (so a saved layout that predates a now-hidden column resolves cleanly), falling
 * back to defaults; the returned setter writes straight back through the context.
 */
export function useTransactionTableLayout({
  preferenceKey,
  showCategory = true,
  showAccount = true,
  showSourceAccount = false,
  showRunningBalance = false,
  showPostedDate = false,
}) {
  const defaultColumns = useMemo(
    () => buildTransactionTableDefaultColumnConfig({ showCategory, showAccount, showSourceAccount, showRunningBalance, showPostedDate }),
    [showAccount, showCategory, showSourceAccount, showRunningBalance, showPostedDate],
  )
  const [stored, setStored] = useDeviceLayoutPreference(preferenceKey, null)
  const columns = useMemo(
    () => normalizeTransactionTableColumnConfig(
      stored, { showCategory, showAccount, showSourceAccount, showRunningBalance, showPostedDate },
    ) || defaultColumns,
    [stored, showCategory, showAccount, showSourceAccount, showRunningBalance, showPostedDate, defaultColumns],
  )
  return [columns, setStored]
}
