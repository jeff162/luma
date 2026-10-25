// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * The other half of a file's report: the rows the file offered and the import did not take. It sits
 * beside the imported ledger in `ImportBatchDetail` because the question it answers — "the file had
 * more in it than this" — is asked while looking at what did arrive, and because the file itself is
 * gone by then, so the stored rows (`import_batch_rejected_row`) are the only remaining record.
 *
 * Sorting and searching are client-side, which the server's per-batch cap is what makes safe: the
 * whole list arrives in one fetch, so a sort reaches every row rather than the page on screen. When
 * that cap bound, the header says so — the counts it compares against are the import's own exact
 * totals, not a count of what was kept.
 *
 * Duplicates are counted here and listed elsewhere. They are reviewable — restored, imported anyway,
 * enriched — and that belongs in the duplicate report; a second read-only rendering of them here
 * would be a list with nothing to do about it (the same reason the imported side only counts the
 * rows removed as duplicates).
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../../lib/api.js'
import { Button, SearchInput, Spinner, LinkButton } from '../ui.jsx'
import PillGridTable from '../PillGridTable.jsx'
import { useColumnPreference } from '../../lib/useColumnPreference.js'
import { formatTransactionAmount } from '../../lib/moneyDisplay.js'
import { NOT_IMPORTED_ROWS_COLUMNS_PREF_KEY } from '../../lib/importExport/constants.js'
import FeatureExplainer from '../../help/FeatureExplainer.jsx'

// Every reason a row can be left out, in the order the filter pills offer them: the ones that mean
// something went wrong first, then the ones the user asked for. `trailing_text` stands for a whole
// suspected footer, which is why its pill counts rows while the list holds a single entry for them.
const NOT_IMPORTED_KINDS = [
  { key: 'validation_error', label: 'Validation error' },
  { key: 'currency', label: 'Other currency' },
  { key: 'zero_amount', label: 'Zero amount' },
  { key: 'trailing_text', label: 'Trailing text' },
  { key: 'account_skipped', label: 'Skipped account' },
]
const KIND_LABELS = Object.fromEntries(NOT_IMPORTED_KINDS.map(kind => [kind.key, kind.label]))
// The one kind whose stored row count is deliberately not its row total, so it is left out of the
// comparison that decides whether the list is partial.
const COLLAPSED_KIND = 'trailing_text'

function parseSortableAmount(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function sortValue(row, columnKey) {
  if (columnKey === '__row__') return Number(row.row) || 0
  if (columnKey === '__reason__') return `${KIND_LABELS[row.kind] || ''} ${row.reason || ''}`
  if (columnKey === '__date__') return String(row.date || '')
  if (columnKey === '__description__') return String(row.description || '')
  if (columnKey === '__amount__') return parseSortableAmount(row.amount) ?? Number.NEGATIVE_INFINITY
  if (columnKey.startsWith('data:')) return String(row?.values?.[columnKey.slice(5)] ?? '')
  return ''
}

function matchesSearch(row, needle) {
  if (!needle) return true
  const haystack = [
    row.reason,
    KIND_LABELS[row.kind],
    row.date,
    row.description,
    row.amount == null ? '' : String(row.amount),
    ...Object.values(row?.values || {}),
  ].join(' ').toLowerCase()
  return haystack.includes(needle)
}

export default function ImportBatchNotImported({ batchId, seedKind = null, onOpenDuplicates }) {
  const [report, setReport] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [kindFilter, setKindFilter] = useState(seedKind)
  const [search, setSearch] = useState('')
  const [sortState, setSortState] = useState({ key: '__row__', dir: 'asc' })

  useEffect(() => { setKindFilter(seedKind) }, [seedKind])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    api.getBatchNotImported(batchId)
      .then(result => { if (!cancelled) setReport(result) })
      .catch(err => { if (!cancelled) setError(err?.message || 'Could not load what this file left out.') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [batchId])

  const rows = useMemo(() => report?.rows || [], [report])
  const totals = report?.totals || {}
  const extraHeaders = useMemo(() => report?.extra_headers || [], [report])
  // What the import counted, against what is listed. The collapsed footer entry is excluded from both
  // sides: one stored row standing for forty is the design rather than a loss.
  const listedTotal = NOT_IMPORTED_KINDS.reduce(
    (sum, kind) => (kind.key === COLLAPSED_KIND ? sum : sum + (Number(totals[kind.key]) || 0)), 0,
  )
  const listedRows = rows.filter(row => row.kind !== COLLAPSED_KIND).length
  const omittedCount = Math.max(0, listedTotal - listedRows)

  const visibleRows = useMemo(() => {
    const needle = search.trim().toLowerCase()
    const filtered = rows.filter(row => (
      (!kindFilter || row.kind === kindFilter) && matchesSearch(row, needle)
    ))
    const direction = sortState.dir === 'desc' ? -1 : 1
    return filtered.sort((left, right) => {
      const leftValue = sortValue(left, sortState.key)
      const rightValue = sortValue(right, sortState.key)
      if (typeof leftValue === 'number' && typeof rightValue === 'number') {
        if (leftValue === rightValue) return (Number(left.row) || 0) - (Number(right.row) || 0)
        return (leftValue - rightValue) * direction
      }
      const comparison = String(leftValue).localeCompare(String(rightValue), undefined, { numeric: true, sensitivity: 'base' })
      if (comparison === 0) return (Number(left.row) || 0) - (Number(right.row) || 0)
      return comparison * direction
    })
  }, [rows, kindFilter, search, sortState])

  const defaultColumns = useMemo(() => ([
    { key: '__row__', label: 'Row', width: 68, minWidth: 52, align: 'start' },
    { key: '__reason__', label: 'Not imported because', width: 260, minWidth: 160, align: 'start' },
    { key: '__date__', label: 'Date', width: 110, minWidth: 80, align: 'start' },
    { key: '__description__', label: 'Description', width: 260, minWidth: 120, align: 'start' },
    { key: '__amount__', label: 'Amount', width: 110, minWidth: 80, align: 'end' },
    ...extraHeaders.map(header => ({
      key: `data:${header}`,
      label: header,
      width: 140,
      minWidth: 72,
      align: 'start',
    })),
  ]), [extraHeaders])
  const [cols, handleColumnUpdate] = useColumnPreference(NOT_IMPORTED_ROWS_COLUMNS_PREF_KEY, defaultColumns)

  const toggleSort = useCallback((columnKey) => {
    setSortState(current => (
      current.key === columnKey
        ? { key: columnKey, dir: current.dir === 'asc' ? 'desc' : 'asc' }
        : { key: columnKey, dir: 'asc' }
    ))
  }, [])

  function renderCell(col, row) {
    if (col.key === '__row__') {
      return <div style={{ whiteSpace: 'nowrap', color: 'var(--muted)', fontWeight: 600 }}>{row.row}</div>
    }
    if (col.key === '__reason__') {
      return (
        <div style={{ display: 'grid', gap: 2, minWidth: 0 }} title={row.reason}>
          <span style={{ fontWeight: 600, fontSize: 11.5, color: 'var(--muted)', letterSpacing: '0.02em', textTransform: 'uppercase' }}>
            {KIND_LABELS[row.kind] || row.kind}
          </span>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{row.reason}</span>
        </div>
      )
    }
    if (col.key === '__amount__') {
      // The amount the ledger would have stored, so the column reads the same way as the imported
      // list; a row that never parsed one shows nothing rather than a zero it does not mean.
      return (
        <div style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
          {row.amount == null ? '—' : formatTransactionAmount(row.amount)}
        </div>
      )
    }
    const value = col.key === '__date__'
      ? row.date
      : col.key === '__description__'
        ? row.description
        : row?.values?.[col.key.slice(5)]
    const text = String(value ?? '')
    return (
      <div title={text} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {text || '—'}
      </div>
    )
  }

  if (loading) return <Spinner />
  if (error) {
    return (
      <div style={{ padding: '12px 14px', borderRadius: 10, border: '1px solid var(--danger)', background: 'color-mix(in srgb, var(--danger) 8%, var(--surface2))', fontSize: 13, color: 'var(--muted)' }}>
        {error}
      </div>
    )
  }

  const duplicateCount = Number(report?.duplicate_count) || 0
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, flex: 1, minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Search these rows…"
          aria-label="Search the rows this file left out"
          wrapperStyle={{ flex: '0 1 300px', minWidth: 200 }}
          style={{ fontSize: 13 }}
        />
        <FeatureExplainer topic="not-imported-rows" placement="bottom-left" />
        {NOT_IMPORTED_KINDS.filter(kind => (Number(totals[kind.key]) || 0) > 0).map(kind => (
          <Button
            key={kind.key}
            variant={kindFilter === kind.key ? 'primary' : 'secondary'}
            onClick={() => setKindFilter(current => (current === kind.key ? null : kind.key))}
          >
            {kind.label} ({totals[kind.key]})
          </Button>
        ))}
      </div>
      {omittedCount > 0 ? (
        <div style={{ flex: '0 0 auto', padding: '7px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'color-mix(in srgb, var(--surface2) 40%, var(--surface))', fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.5 }}>
          {/* States the fact and stops. The cap is only one of the reasons a file's record can be
              partial — a batch imported before the rows were stored at all has whatever its snapshot
              held — so naming a cause here would be wrong on exactly the files most likely to show
              this line. The help topic explains the cap. */}
          {listedRows} of {listedTotal} rows are kept for this file. The rest were counted but not
          stored.
        </div>
      ) : null}
      {duplicateCount > 0 ? (
        <div style={{ flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 12.5, color: 'var(--muted)' }}>
          <span>
            {duplicateCount} further row{duplicateCount === 1 ? ' was' : 's were'} held as duplicates.
          </span>
          {onOpenDuplicates ? (
            <LinkButton onClick={onOpenDuplicates} style={{ fontSize: 12.5 }}>
              Review them in the duplicate report ↗
            </LinkButton>
          ) : null}
        </div>
      ) : null}
      {visibleRows.length === 0 ? (
        <div style={{ padding: '12px 14px', borderRadius: 10, border: '1px solid var(--border)', background: 'color-mix(in srgb, var(--surface2) 36%, var(--surface))', fontSize: 13, color: 'var(--muted)' }}>
          {rows.length === 0
            ? 'No record of the rows this file left out was kept — it was imported before they were stored.'
            : 'No rows match the current search or filter.'}
        </div>
      ) : (
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
          <PillGridTable
            columns={cols.map(col => ({
              ...col,
              contentPadding: col.key === '__row__' ? '0 7px' : '0 9px',
              title: col.draggable === false ? col.label : `Click to sort. Drag to move ${col.label || 'column'}`,
            }))}
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
                {visibleRows.map((row, index) => (
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
                      <div key={`${row.row}:${col.key}`} style={{ padding: '6px 8px', minWidth: 0 }}>
                        {renderCell(col, row)}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}
          />
        </div>
      )}
    </div>
  )
}
