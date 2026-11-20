// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// Shared column-geometry preference for PillGridTable-hosted tables. Persists the user's column order
// and widths per kind of screen (`useDeviceLayoutPreference`), and merges a saved config over
// freshly-computed defaults: keep only known keys (in the saved order), clamp persisted widths to each
// column's min and a sane max, and insert any default column the saved config didn't carry (e.g. one
// added since the user last customized). Lives in one place so every resizable/reorderable pill table behaves the same
// — the matching-imported-transactions report and the duplicate-rows dialog both consume it.

import { useEffect, useState } from 'react'
import { useDeviceLayoutPreference } from './UserPreferencesContext.jsx'

const MAX_PERSISTED_COLUMN_WIDTH = 640
const FALLBACK_MIN_COLUMN_WIDTH = 44

export function normalizeColumnConfig(savedColumns, defaultColumns) {
  if (!Array.isArray(defaultColumns) || defaultColumns.length === 0) return []

  const defaultByKey = new Map(defaultColumns.map(column => [column.key, column]))
  const seen = new Set()
  const merged = []

  if (Array.isArray(savedColumns)) {
    for (const savedColumn of savedColumns) {
      const key = savedColumn?.key
      if (!defaultByKey.has(key) || seen.has(key)) continue
      const defaultColumn = defaultByKey.get(key)
      const requestedWidth = Number(savedColumn?.width)
      const minWidth = Number(defaultColumn.minWidth || FALLBACK_MIN_COLUMN_WIDTH)
      merged.push({
        ...defaultColumn,
        // A fixed column keeps its own width; the floor below is for columns a person resizes.
        width: defaultColumn.resizable !== false && Number.isFinite(requestedWidth)
          ? Math.max(minWidth, Math.min(MAX_PERSISTED_COLUMN_WIDTH, requestedWidth))
          : defaultColumn.width,
      })
      seen.add(key)
    }
  }

  // A column added since the config was saved goes in after the column it follows by default, so it
  // lands where it was designed to sit rather than past a trailing gutter.
  defaultColumns.forEach((defaultColumn, index) => {
    if (seen.has(defaultColumn.key)) return
    const previousKey = defaultColumns[index - 1]?.key
    merged.splice(merged.findIndex(column => column.key === previousKey) + 1, 0, { ...defaultColumn })
    seen.add(defaultColumn.key)
  })

  return merged
}

// Returns `[columns, onColumnsChange]` ready to spread into PillGridTable: `columns` is the merged
// config (saved-over-defaults), `onColumnsChange` commits a reorder/resize locally and persists it.
// `defaultColumns` should be a stable reference (memoize it in the caller) since it re-merges on change.
export function useColumnPreference(prefKey, defaultColumns) {
  const [savedColumns, setSavedColumns] = useDeviceLayoutPreference(prefKey, [])
  const [columns, setColumns] = useState(() => normalizeColumnConfig(savedColumns, defaultColumns))

  useEffect(() => {
    setColumns(normalizeColumnConfig(savedColumns, defaultColumns))
  }, [savedColumns, defaultColumns])

  function onColumnsChange(nextColumns) {
    setColumns(nextColumns)
    setSavedColumns(nextColumns).catch(() => {})
  }

  return [columns, onColumnsChange]
}
