// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect, useMemo, useState } from 'react'
import { api } from './api.js'
import { useAppSession } from './AppSessionContext.jsx'
import { useUserPreferences } from './UserPreferencesContext.jsx'

const BASE_TRANSACTION_TABLE_COLUMNS = [
  { key: 'date', width: 96 },
  { key: 'merchant', width: 260 },
  { key: 'category', width: 150 },
  { key: 'account', width: 140 },
  { key: 'amount', width: 108 },
]

function getExpectedColumns({ showCategory = true, showAccount = true }) {
  return BASE_TRANSACTION_TABLE_COLUMNS.filter(column => (
    (column.key !== 'category' || showCategory) &&
    (column.key !== 'account' || showAccount)
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
  return expectedColumns.map(column => ({
    key: column.key,
    width: Number(byKey.get(column.key)?.width) || column.width,
  }))
}

function getStorageKey(prefix, instanceId, userId) {
  return instanceId && userId ? `${prefix}.${instanceId}.${userId}` : null
}

/*
 * Transaction table geometry is shared product language, but each surface still keeps its
 * own preference key so a user can tune a focused detail drawer differently from a page-level ledger.
 */
export function useTransactionTableLayout({
  storageKeyPrefix,
  preferenceKey,
  showCategory = true,
  showAccount = true,
}) {
  const { dbInstanceId, preferenceSubjectId: userId } = useAppSession()
  const { preferences } = useUserPreferences()
  const defaultColumns = useMemo(
    () => buildTransactionTableDefaultColumnConfig({ showCategory, showAccount }),
    [showAccount, showCategory],
  )
  const [columns, setColumns] = useState(defaultColumns)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    const preferenceColumns = normalizeTransactionTableColumnConfig(preferences?.[preferenceKey], { showCategory, showAccount })
    if (preferenceColumns) {
      setColumns(preferenceColumns)
      setLoaded(true)
      return
    }
    const storageKey = getStorageKey(storageKeyPrefix, dbInstanceId, userId)
    if (storageKey) {
      const savedColumns = normalizeTransactionTableColumnConfig(
        JSON.parse(window.localStorage.getItem(storageKey) || 'null'),
        { showCategory, showAccount },
      )
      if (savedColumns) {
        setColumns(savedColumns)
        setLoaded(true)
        return
      }
    }
    setColumns(defaultColumns)
    setLoaded(true)
  }, [dbInstanceId, defaultColumns, preferenceKey, preferences, showAccount, showCategory, storageKeyPrefix, userId])

  useEffect(() => {
    if (!loaded) return
    const storageKey = getStorageKey(storageKeyPrefix, dbInstanceId, userId)
    if (!storageKey) return
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(columns))
    } catch {
      // Ignore storage failures in environments that block localStorage.
    }
    api.saveUserPreference(preferenceKey, columns).catch(() => {})
  }, [columns, dbInstanceId, loaded, preferenceKey, storageKeyPrefix, userId])

  return [columns, setColumns]
}
