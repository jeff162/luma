// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from 'react'
import { api, downloadUrl } from '../lib/api.js'
import { amountFilterIsActive, amountFilterParams, selectionsToParams } from '../lib/filterParams.js'
import { FilterProvider, useFilters } from '../lib/FilterContext.jsx'
import FilterBar from './FilterBar.jsx'
import { AppDialog, Button, Card } from './ui.jsx'
import FeatureExplainer from '../help/FeatureExplainer.jsx'
import { DEFAULT_EXPORT_COLS, EXPORT_COLUMNS } from '../lib/importExport/constants.js'

/*
 * The CSV export, opened from the Transactions page: pick a filter and columns, then download.
 *
 * The page's filter is "what am I looking at now"; an export is "what slice of history do I want a copy
 * of". So the dialog starts from a *copy* of the page's date, chips and amount, in a FilterProvider of its own:
 * adjusting the export never disturbs the filter the rest of the app reads.
 */
export default function ExportTransactionsDialog({ onClose }) {
  const { filters, getRawDate } = useFilters()
  // Read once, when the provider mounts — which is what makes it a copy.
  return (
    <FilterProvider initialDate={getRawDate()} initialSelections={filters.selections} initialAmount={filters.amount}>
      <ExportTransactionsDialogContent onClose={onClose} />
    </FilterProvider>
  )
}

function ExportTransactionsDialogContent({ onClose }) {
  const { filters, getRawDate } = useFilters()
  const [selectedCols, setSelectedCols] = useState(() => new Set(DEFAULT_EXPORT_COLS))
  const [exporting, setExporting] = useState(false)
  const [error, setError] = useState('')
  const date = getRawDate()

  function toggleCol(key) {
    setSelectedCols(prev => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n })
  }

  async function exportCsv() {
    setExporting(true)
    setError('')
    try {
      // One translation of the chip row, shared with the ledger and the dashboard, so an export carries
      // exactly the slice its filter names.
      await downloadUrl(api.exportTransactionsCsv({
        columns: [...selectedCols].join(','),
        date_start: date?.start || undefined,
        date_end: date?.end || undefined,
        ...selectionsToParams(filters.selections),
        ...amountFilterParams(filters.amount),
      }))
      onClose()
    } catch (err) {
      setError(err.message || 'Export failed')
      setExporting(false)
    }
  }

  return (
    <AppDialog
      title={(
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          Export transactions to a .csv file
          <FeatureExplainer topic="csv-export" placement="bottom-left" />
        </span>
      )}
      onClose={onClose}
      width="min(720px, 100%)"
      actions={(
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={exportCsv} disabled={selectedCols.size === 0 || exporting}>Export</Button>
        </>
      )}
    >
      <Card style={{ padding: 0 }}>
        <FilterBar />
      </Card>
      <div style={{ fontSize: 12, color: 'var(--muted)' }}>
        {date || filters.selections.length > 0 || amountFilterIsActive(filters.amount)
          ? 'Only transactions matching the filter above will be exported.'
          : 'No filter set — all transactions will be exported.'}
      </div>
      <div style={{ fontSize: 13, color: 'var(--muted)' }}>Select columns to include:</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
        {EXPORT_COLUMNS.map(col => {
          const inputId = `export-column-${col.key}`
          return (
            <label key={col.key} htmlFor={inputId} style={{ display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer', fontSize: 13 }}>
              <input
                id={inputId}
                name={`export-column-${col.key}`}
                type="checkbox"
                checked={selectedCols.has(col.key)}
                onChange={() => toggleCol(col.key)}
              />
              {col.label}
            </label>
          )
        })}
      </div>
      {error ? <div style={{ fontSize: 13, color: 'var(--danger)' }}>{error}</div> : null}
    </AppDialog>
  )
}
