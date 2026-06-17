// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: GPL-3.0-or-later

// Modal viewer for the rows an import skipped as possible duplicates, with the
// ability to re-import a selection. It is the reference implementation for the
// pill-header modal transaction table (see collaboration-notes.md): the dialog
// owns a single outer scroll container with PillGridTable's header pinned via
// position: sticky, persists its column geometry through useUserPreference, and
// classifies each skip by which dedupe rule fired so the user can re-include a
// whole rule's rows at once. Driven entirely by props from ImportTab.

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Button,
  FloatingPanel,
  FloatingPanelHeader,
  OverlayBackdrop,
  SelectAllCheckbox,
  Spinner,
} from '../ui.jsx'
import PillGridTable from '../PillGridTable.jsx'
import { useUserPreference } from '../../lib/UserPreferencesContext.jsx'
import { formatTransactionAmount } from '../../lib/moneyDisplay.js'
import { DUPLICATE_ROWS_COLUMNS_PREF_KEY } from '../../lib/importExport/constants.js'

function normalizeDuplicateRowsColumnConfig(savedColumns, defaultColumns) {
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
      const minWidth = Number(defaultColumn.minWidth || 44)
      merged.push({
        ...defaultColumn,
        width: Number.isFinite(requestedWidth) ? Math.max(minWidth, Math.min(640, requestedWidth)) : defaultColumn.width,
      })
      seen.add(key)
    }
  }

  for (const defaultColumn of defaultColumns) {
    if (seen.has(defaultColumn.key)) continue
    merged.push({ ...defaultColumn })
  }

  return merged
}

export function DuplicateRowsDialog({
  rows = [],
  headers = [],
  count = 0,
  title = 'this import',
  loading = false,
  error = '',
  importing = false,
  onClose,
  onImportSelected,
  onImportAll,
}) {
  function renderDuplicateRuleBadge(label) {
    return (
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          padding: '0 6px',
          minHeight: 16,
          borderRadius: 999,
          border: '1px solid color-mix(in srgb, var(--accent2) 18%, var(--border))',
          background: 'color-mix(in srgb, var(--surface2) 76%, var(--surface))',
          color: 'var(--muted)',
          fontSize: 9.5,
          fontWeight: 700,
          letterSpacing: '0.02em',
          textTransform: 'uppercase',
          flexShrink: 0,
        }}
      >
        {label}
      </span>
    )
  }

  const duplicateRuleDefinitions = useMemo(
    () => ({
      exact_match: {
        tag: 'Exact Match',
        description: 'Rows whose stored duplicate hash exactly matches an existing transaction.',
      },
      covered_day: {
        tag: 'Covered Day',
        description: 'Rows that fall on account days already covered by earlier imports, including bounded overlap on the terminal covered day.',
      },
    }),
    [],
  )

  function classifyDuplicateRule(row) {
    const reason = String(row?.reason || '')
    if (reason.startsWith('Matches an existing transaction')) return 'exact_match'
    if (
      reason.startsWith('Falls within the fully covered date range')
      || reason.startsWith('Matches a remaining transaction from the terminal covered day')
    ) {
      return 'covered_day'
    }
    return ''
  }

  const effectiveCount = Math.max(count, rows.length)
  const tableHeaders = headers.length > 0
    ? headers
    : Array.from(new Set(rows.flatMap(row => Object.keys(row?.values || {}))))
  const hasSavedRowValues = tableHeaders.length > 0
  const duplicateDisplayRows = useMemo(
    () => rows.map(row => {
      const matchedTransaction = row?.matched_transaction || null
      const duplicateRuleKey = classifyDuplicateRule(row)
      return {
        ...row,
        duplicateRuleKey,
        duplicateRuleTag: duplicateRuleKey ? duplicateRuleDefinitions[duplicateRuleKey]?.tag || '' : '',
        matchedSummary: matchedTransaction
          ? `${matchedTransaction.date || ''} · ${matchedTransaction.merchant_name || ''} · ${formatTransactionAmount(matchedTransaction.amount)}`
          : (row.reason || `Existing transaction`),
      }
    }),
    [duplicateRuleDefinitions, rows],
  )
  const importableRowNumbers = useMemo(
    () => rows.filter(row => row?.txn_payload).map(row => Number(row.row)).filter(Boolean),
    [rows],
  )
  const importableRowsByRule = useMemo(
    () => Object.fromEntries(
      Object.keys(duplicateRuleDefinitions).map(ruleKey => [
        ruleKey,
        duplicateDisplayRows
          .filter(row => row.duplicateRuleKey === ruleKey && row?.txn_payload)
          .map(row => Number(row.row))
          .filter(Boolean),
      ]),
    ),
    [duplicateDisplayRows, duplicateRuleDefinitions],
  )
  const presentRuleKeys = useMemo(
    () => Object.keys(duplicateRuleDefinitions).filter(ruleKey => importableRowsByRule[ruleKey]?.length > 0),
    [duplicateRuleDefinitions, importableRowsByRule],
  )
  const estimateColumnWidthPx = useMemo(
    () => (values, { header = '', min = 8, max = 22, fallback = 12 } = {}) => {
      const lengths = values
        .map(value => String(value ?? '').trim().length)
        .filter(length => length > 0)
        .sort((a, b) => a - b)
      const percentileLength = lengths.length > 0
        ? lengths[Math.min(lengths.length - 1, Math.floor((lengths.length - 1) * 0.85))]
        : 0
      const target = Math.max(header.length + 1, percentileLength + 1, fallback)
      const clamped = Math.max(min, Math.min(max, target))
      return Math.round(clamped * 8.25)
    },
    [],
  )
  const selectionWidthPx = 40
  const rowWidthPx = 68
  const matchWidthPx = useMemo(
    () => estimateColumnWidthPx(
      duplicateDisplayRows.map(row => row.matchedSummary),
      { header: 'Matches', min: 18, max: 32, fallback: 22 },
    ),
    [duplicateDisplayRows, estimateColumnWidthPx],
  )
  const dataColumnWidths = useMemo(
    () => Object.fromEntries(
      tableHeaders.map(header => [
        header,
        estimateColumnWidthPx(
          duplicateDisplayRows.map(row => row?.values?.[header] ?? ''),
          { header, min: 8, max: 22, fallback: Math.max(10, String(header || '').length + 2) },
        ),
      ]),
    ),
    [duplicateDisplayRows, estimateColumnWidthPx, tableHeaders],
  )
  const defaultColumns = useMemo(
    () => ([
      { key: '__select__', label: '', width: selectionWidthPx, minWidth: selectionWidthPx, align: 'center', resizable: false, draggable: false },
      { key: '__row__', label: 'Row', width: rowWidthPx, minWidth: 52, align: 'start' },
      ...tableHeaders.map(header => ({
        key: `data:${header}`,
        label: header,
        width: dataColumnWidths[header] || 96,
        minWidth: 72,
        align: String(header || '').trim().toLowerCase() === 'amount' ? 'end' : 'start',
      })),
      { key: '__matches__', label: 'Matches', width: matchWidthPx, minWidth: 180, align: 'start' },
    ]),
    [dataColumnWidths, matchWidthPx, tableHeaders],
  )
  const [savedDuplicateColumns, setSavedDuplicateColumns] = useUserPreference(DUPLICATE_ROWS_COLUMNS_PREF_KEY, [])
  const [cols, setCols] = useState(() => normalizeDuplicateRowsColumnConfig(savedDuplicateColumns, defaultColumns))
  const [selectedRows, setSelectedRows] = useState(() => new Set())
  const [ruleStates, setRuleStates] = useState({})
  const [sortState, setSortState] = useState({ key: '__row__', dir: 'asc' })

  useEffect(() => {
    setCols(normalizeDuplicateRowsColumnConfig(savedDuplicateColumns, defaultColumns))
  }, [defaultColumns, savedDuplicateColumns])

  useEffect(() => {
    setSelectedRows(new Set())
    setRuleStates(Object.fromEntries(Object.keys(duplicateRuleDefinitions).map(ruleKey => [ruleKey, true])))
    setSortState({ key: '__row__', dir: 'asc' })
  }, [duplicateRuleDefinitions, importableRowNumbers])

  function toggleSort(columnKey) {
    setSortState(current => (
      current.key === columnKey
        ? { key: columnKey, dir: current.dir === 'asc' ? 'desc' : 'asc' }
        : { key: columnKey, dir: columnKey === '__row__' ? 'asc' : 'asc' }
    ))
  }

  function parseSortableAmount(value) {
    const text = String(value ?? '').trim()
    if (!text) return null
    const negative = text.startsWith('(') && text.endsWith(')')
    const normalized = text.replace(/[$,()]/g, '')
    if (!/^[-+]?\d+(\.\d+)?$/.test(normalized)) return null
    const parsed = Number(normalized)
    if (!Number.isFinite(parsed)) return null
    return negative ? -parsed : parsed
  }

  function parseSortableDate(value) {
    const text = String(value ?? '').trim()
    if (!text) return null
    const parsed = Date.parse(text)
    return Number.isFinite(parsed) ? parsed : null
  }

  const getDuplicateSortValue = useCallback((row, columnKey) => {
    if (columnKey === '__row__') return Number(row.row) || 0
    if (columnKey === '__matches__') return row.matchedSummary || ''
    if (!columnKey.startsWith('data:')) return ''
    const header = columnKey.slice(5)
    const rawValue = row?.values?.[header] ?? ''
    const normalizedHeader = header.trim().toLowerCase()
    if (normalizedHeader === 'amount') {
      return parseSortableAmount(rawValue) ?? String(rawValue)
    }
    if (normalizedHeader === 'date') {
      return parseSortableDate(rawValue) ?? String(rawValue)
    }
    return String(rawValue)
  }, [])

  const sortedDuplicateRows = useMemo(() => {
    const direction = sortState.dir === 'desc' ? -1 : 1
    return [...duplicateDisplayRows].sort((left, right) => {
      const leftValue = getDuplicateSortValue(left, sortState.key)
      const rightValue = getDuplicateSortValue(right, sortState.key)
      if (typeof leftValue === 'number' && typeof rightValue === 'number') {
        if (leftValue === rightValue) return (Number(left.row) || 0) - (Number(right.row) || 0)
        return (leftValue - rightValue) * direction
      }
      const comparison = String(leftValue).localeCompare(String(rightValue), undefined, { numeric: true, sensitivity: 'base' })
      if (comparison === 0) return (Number(left.row) || 0) - (Number(right.row) || 0)
      return comparison * direction
    })
  }, [duplicateDisplayRows, getDuplicateSortValue, sortState])

  const allImportableSelected = importableRowNumbers.length > 0 && importableRowNumbers.every(row => selectedRows.has(row))
  const selectedImportableCount = importableRowNumbers.filter(row => selectedRows.has(row)).length

  function handleColumnUpdate(nextColumns) {
    setCols(nextColumns)
    setSavedDuplicateColumns(nextColumns).catch(() => {})
  }

  function renderGridCell(col, row, rowNumber) {
    if (col.key === '__select__') {
      const importable = !!row?.txn_payload
      return (
        <div style={{ textAlign: 'center' }}>
          {importable ? (
            <input
              type="checkbox"
              checked={selectedRows.has(rowNumber)}
              onChange={event => toggleRowSelection(rowNumber, event.target.checked)}
            />
          ) : (
            <span style={{ color: 'var(--muted)' }}>-</span>
          )}
        </div>
      )
    }
    if (col.key === '__row__') {
      return (
        <div style={{ whiteSpace: 'nowrap', color: 'var(--muted)', fontWeight: 600 }}>
          {row.row}
        </div>
      )
    }
    if (col.key === '__matches__') {
      return (
        <div style={{ display: 'grid', gap: 3 }} title={row.matchedSummary}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
            {row.duplicateRuleTag ? renderDuplicateRuleBadge(row.duplicateRuleTag) : null}
            <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
              {row.matchedSummary}
            </div>
          </div>
          {row.reason && !row.duplicateRuleTag ? (
            <div style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.35 }}>
              {row.reason}
            </div>
          ) : null}
        </div>
      )
    }
    if (col.key.startsWith('data:')) {
      const header = col.key.slice(5)
      const value = String(row?.values?.[header] ?? '')
      return (
        <div title={value} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: col.align === 'end' ? 'right' : 'left' }}>
          {value}
        </div>
      )
    }
    return null
  }

  function toggleAllImportable(checked) {
    setSelectedRows(checked ? new Set(importableRowNumbers) : new Set())
  }

  function toggleRowSelection(rowNumber, checked) {
    setSelectedRows(prev => {
      const next = new Set(prev)
      if (checked) next.add(rowNumber)
      else next.delete(rowNumber)
      return next
    })
  }

  function toggleRuleSelection(ruleKey, keepExcluded) {
    setRuleStates(prev => ({ ...prev, [ruleKey]: keepExcluded }))
    const affectedRows = importableRowsByRule[ruleKey] || []
    setSelectedRows(prev => {
      const next = new Set(prev)
      if (keepExcluded) {
        affectedRows.forEach(rowNumber => next.delete(rowNumber))
      } else {
        affectedRows.forEach(rowNumber => next.add(rowNumber))
      }
      return next
    })
  }

  return (
    <OverlayBackdrop zIndex={1200} tint="rgba(15, 23, 42, 0.42)">
      <FloatingPanel style={{ width: 'min(1280px, 100%)', maxHeight: '80vh', display: 'flex', flexDirection: 'column' }}>
        <FloatingPanelHeader style={{ padding: '16px 20px 14px' }}>
          <div>
            <div style={{ fontSize: 17, fontWeight: 600 }}>
              {effectiveCount} possible duplicate row{effectiveCount === 1 ? '' : 's'} detected in {title}
            </div>
          </div>
        </FloatingPanelHeader>
        <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          {loading ? (
            <div style={{ display: 'grid', placeItems: 'center', minHeight: 180, padding: 18 }}>
              <Spinner />
            </div>
          ) : error ? (
            <div style={{ margin: 18, padding: '12px 14px', borderRadius: 10, border: '1px solid var(--danger)', background: 'color-mix(in srgb, var(--danger) 8%, var(--surface2))', fontSize: 13, color: 'var(--muted)', lineHeight: 1.6 }}>
              {error}
            </div>
          ) : rows.length > 0 ? (
            <>
              <div style={{ padding: '14px 18px 10px', display: 'grid', gap: 10 }}>
                {!hasSavedRowValues ? (
                  <div style={{ padding: '10px 12px', borderRadius: 10, border: '1px solid var(--border)', background: 'color-mix(in srgb, var(--surface2) 36%, var(--surface))', fontSize: 13, color: 'var(--muted)', lineHeight: 1.6 }}>
                    Detailed CSV cell values were not saved for this import, so only the matching transaction and row number are available here.
                  </div>
                ) : null}
                {importableRowNumbers.length === 0 ? (
                  <div style={{ padding: '10px 12px', borderRadius: 10, border: '1px solid var(--border)', background: 'color-mix(in srgb, var(--surface2) 36%, var(--surface))', fontSize: 13, color: 'var(--muted)', lineHeight: 1.6 }}>
                    These duplicate rows were saved without enough transaction payload data to import them from this report.
                  </div>
                ) : (
                  <div style={{ fontSize: 13, color: 'var(--muted)' }}>
                    {selectedImportableCount} selected for import.
                  </div>
                )}
              </div>
              <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
                <div style={{ minWidth: hasSavedRowValues ? undefined : 380, padding: '0 18px 18px' }}>
                  <PillGridTable
                    columns={cols.map(col => (
                      col.key === '__select__'
                        ? {
                          ...col,
                          align: 'center',
                          sortable: false,
                          draggable: false,
                          resizable: false,
                          cellPadding: '0',
                          render: () => (
                            importableRowNumbers.length > 0 ? (
                              <SelectAllCheckbox
                                checked={allImportableSelected}
                                indeterminate={selectedImportableCount > 0 && !allImportableSelected}
                                onChange={event => toggleAllImportable(event.target.checked)}
                                title={allImportableSelected ? 'Deselect all importable' : 'Select all importable'}
                              />
                            ) : null
                          ),
                        }
                        : {
                          ...col,
                          contentPadding: col.key === '__row__' ? '0 7px' : '0 9px',
                          title: col.draggable === false
                            ? col.label
                            : `Click to sort. Drag to move ${col.label || 'column'}`,
                        }
                    ))}
                    onColumnsChange={handleColumnUpdate}
                    sortState={sortState}
                    onSort={toggleSort}
                    headerStyle={{
                      padding: '6px 0',
                      background: 'color-mix(in srgb, var(--surface2) 92%, var(--surface))',
                      position: 'sticky',
                      top: 0,
                      zIndex: 2,
                    }}
                    renderBody={({ columns: activeColumns, gridTemplateColumns }) => (
                      <div style={{ fontSize: 12.5 }}>
                        {sortedDuplicateRows.map((row, index) => {
                          const rowNumber = Number(row.row)
                          return (
                            <div
                              key={`${row.row}:${index}`}
                              style={{
                                display: 'grid',
                                gridTemplateColumns,
                                alignItems: 'center',
                                borderBottom: '1px solid color-mix(in srgb, var(--border) 72%, transparent)',
                              }}
                            >
                              {activeColumns.map(col => (
                                <div
                                  key={`${row.row}:${col.key}`}
                                  style={{
                                    padding: '6px 8px',
                                    minWidth: 0,
                                  }}
                                >
                                  {renderGridCell(col, row, rowNumber)}
                                </div>
                              ))}
                            </div>
                          )
                        })}
                      </div>
                    )}
                  />
                </div>
              </div>
            </>
          ) : (
            <div style={{ margin: 18, padding: '12px 14px', borderRadius: 10, border: '1px solid var(--border)', background: 'color-mix(in srgb, var(--surface2) 36%, var(--surface))', fontSize: 13, color: 'var(--muted)', lineHeight: 1.6 }}>
              Detailed duplicate rows are not available for this import summary.
            </div>
          )}
        </div>
        <div style={{ padding: '14px 18px', borderTop: '1px solid var(--border)', background: 'color-mix(in srgb, var(--surface2) 66%, var(--surface))', display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ display: 'grid', gap: 10, minWidth: 260, flex: '1 1 420px' }}>
            {!loading && !error && presentRuleKeys.length > 0 ? (
              <div style={{ display: 'grid', gap: 8 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', letterSpacing: '0.04em' }}>
                  Exclusion Rules (uncheck to import these rows)
                </div>
                {presentRuleKeys.map(ruleKey => {
                  const ruleDef = duplicateRuleDefinitions[ruleKey]
                  const affectedCount = importableRowsByRule[ruleKey]?.length || 0
                  return (
                    <label key={ruleKey} style={{ display: 'grid', gap: 2, cursor: 'pointer' }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 12.5 }}>
                        <input
                          type="checkbox"
                          checked={ruleStates[ruleKey] !== false}
                          onChange={event => toggleRuleSelection(ruleKey, event.target.checked)}
                        />
                        {renderDuplicateRuleBadge(ruleDef.tag)}
                        <span style={{ color: 'var(--muted)', fontSize: 11.5 }}>
                          {affectedCount} row{affectedCount === 1 ? '' : 's'}
                        </span>
                      </span>
                      <span style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.35, paddingLeft: 24 }}>
                        {ruleDef.description} Uncheck to select those rows for import.
                      </span>
                    </label>
                  )
                })}
              </div>
            ) : null}
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              {!loading && !error && importableRowNumbers.length > 0 ? (
                <>
                  <Button
                    onClick={() => onImportSelected?.(Array.from(selectedRows))}
                    disabled={importing || selectedRows.size === 0}
                  >
                    {importing ? 'Importing…' : `Import selected${selectedRows.size > 0 ? ` (${selectedRows.size})` : ''}`}
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => onImportAll?.()}
                    disabled={importing}
                  >
                    {importing ? 'Importing…' : 'Import all duplicates'}
                  </Button>
                </>
              ) : null}
            </div>
          </div>
          <Button variant="ghost" onClick={onClose}>Close</Button>
        </div>
      </FloatingPanel>
    </OverlayBackdrop>
  )
}
