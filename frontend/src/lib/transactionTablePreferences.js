// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo } from 'react'
import { useUserPreference } from './UserPreferencesContext.jsx'

const BASE_TRANSACTION_TABLE_COLUMNS = [
  { key: 'date', width: 96 },
  { key: 'merchant', width: 260 },
  { key: 'category', width: 150 },
  { key: 'account', width: 140 },
  { key: 'sourceAccount', width: 150 },
  { key: 'amount', width: 108 },
]

function getExpectedColumns({ showCategory = true, showAccount = true, showSourceAccount = false }) {
  return BASE_TRANSACTION_TABLE_COLUMNS.filter(column => (
    (column.key !== 'category' || showCategory) &&
    (column.key !== 'account' || showAccount) &&
    (column.key !== 'sourceAccount' || showSourceAccount)
  ))
}

export function buildTransactionTableDefaultColumnConfig(options = {}) {
  return getExpectedColumns(options).map(column => ({ ...column }))
}

export function normalizeTransactionTableColumnConfig(value, options = {}) {
  if (!Array.isArray(value)) return null
  const expectedColumns = getExpectedColumns(options)
  const byKey = new Map(value.map(column => [column?.key, column]))
  const hasAllColumns = expectedColumns.every(column => byKey.has(column.key))
  if (!hasAllColumns || byKey.size !== expectedColumns.length) return null
  const defaultWidthByKey = new Map(expectedColumns.map(column => [column.key, column.width]))
  // Preserve the incoming column ORDER (so a user reorder sticks). Validation above guarantees the
  // exact expected key set for this surface is present, so each entry only needs its width normalized.
  return value.map(column => ({
    key: column.key,
    width: Number(column?.width) || defaultWidthByKey.get(column.key),
  }))
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
}) {
  const defaultColumns = useMemo(
    () => buildTransactionTableDefaultColumnConfig({ showCategory, showAccount, showSourceAccount }),
    [showAccount, showCategory, showSourceAccount],
  )
  const [stored, setStored] = useUserPreference(preferenceKey, null)
  const columns = useMemo(
    () => normalizeTransactionTableColumnConfig(stored, { showCategory, showAccount, showSourceAccount }) || defaultColumns,
    [stored, showCategory, showAccount, showSourceAccount, defaultColumns],
  )
  return [columns, setStored]
}
