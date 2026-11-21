// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useMemo } from 'react'
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

const KNOWN_COLUMN_KEYS = new Set(BASE_TRANSACTION_TABLE_COLUMNS.map(column => column.key))

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

// A column this surface does not offer at the moment (Balance before there is a balance, Posted on an
// account whose rows never post on another day) keeps its saved place, width and visibility through a save
// made while it is absent. The table hands back only the columns it shows, and storing that as it is would
// reset the column on every surface or account where it is offered. Each retained column goes back after
// the column it followed in the saved layout.
export function retainUnofferedColumns(next, stored, offeredKeys) {
  if (!Array.isArray(next) || !Array.isArray(stored)) return next
  const result = [...next]
  const placed = new Set(result.map(column => column?.key))
  let previousKey = null
  for (const column of stored) {
    const key = column?.key
    if (placed.has(key)) {
      previousKey = key
      continue
    }
    if (offeredKeys.has(key) || !KNOWN_COLUMN_KEYS.has(key)) continue
    result.splice(previousKey === null ? 0 : result.findIndex(entry => entry.key === previousKey) + 1, 0, column)
    placed.add(key)
    previousKey = key
  }
  return result
}

/*
 * Transaction table geometry is shared product language, but each surface still keeps its
 * own preference key so a user can tune a focused detail drawer differently from a page-level ledger.
 *
 * The stored preference is the single source of truth — there is no local mirror or load/save effect.
 * The visible config is derived by normalizing the stored value against the columns this surface
 * currently shows (so a saved layout that predates a now-hidden column resolves cleanly), falling
 * back to defaults; the returned setter writes back through the context, keeping what the stored layout
 * says about the columns not offered right now (`retainUnofferedColumns`).
 */
export function useTransactionTableLayout({
  preferenceKey,
  showCategory = true,
  showAccount = true,
  showSourceAccount = false,
  showRunningBalance = false,
  showPostedDate = false,
}) {
  const expectedColumns = useMemo(
    () => getExpectedColumns({ showCategory, showAccount, showSourceAccount, showRunningBalance, showPostedDate }),
    [showAccount, showCategory, showSourceAccount, showRunningBalance, showPostedDate],
  )
  const defaultColumns = useMemo(() => expectedColumns.map(defaultEntry), [expectedColumns])
  const [stored, setStored] = useDeviceLayoutPreference(preferenceKey, null)
  const resolve = useCallback(
    value => normalizeTransactionTableColumnConfig(
      value, { showCategory, showAccount, showSourceAccount, showRunningBalance, showPostedDate },
    ) || defaultColumns,
    [showCategory, showAccount, showSourceAccount, showRunningBalance, showPostedDate, defaultColumns],
  )
  const columns = useMemo(() => resolve(stored), [resolve, stored])
  const setColumns = useCallback(nextOrUpdater => {
    const offeredKeys = new Set(expectedColumns.map(column => column.key))
    return setStored(previous => retainUnofferedColumns(
      typeof nextOrUpdater === 'function' ? nextOrUpdater(resolve(previous)) : nextOrUpdater, previous, offeredKeys,
    ))
  }, [expectedColumns, resolve, setStored])
  return [columns, setColumns]
}
