// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// The Export tab of the Import / Export page: pick columns and a filter scope,
// then download a CSV. Export deliberately runs its own FilterProvider rather
// than the app-wide FilterContext — see the note on ExportTab — so adjusting the
// export slice does not disturb the chip the rest of the app reads.

import { useState } from 'react'
import { api } from '../../lib/api.js'
import { FilterProvider, useFilters } from '../../lib/FilterContext.jsx'
import FilterBar from '../FilterBar.jsx'
import { Button, Card } from '../ui.jsx'
import { SectionTitle } from './importPresentational.jsx'
import { DEFAULT_EXPORT_COLS, EXPORT_COLUMNS } from '../../lib/importExport/constants.js'

export function ExportTab() {
  // Export uses a filter scope independent of the app-wide FilterContext: the dashboard/transactions
  // view is "what am I looking at now," while an export is "what slice of history do I want a copy of."
  // A nested FilterProvider with no initial filters keeps the export defaulted to everything and lets
  // the user adjust it without disturbing the chip the rest of the app reads.
  return (
    <FilterProvider>
      <ExportTabContent />
    </FilterProvider>
  )
}

function ExportTabContent() {
  const { filters } = useFilters()
  const [selectedCols, setSelectedCols] = useState(new Set(DEFAULT_EXPORT_COLS))

  function toggleCol(key) {
    setSelectedCols(prev => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n })
  }

  function downloadCsv() {
    const accountSel = filters.selections.filter(s => s.type === 'account').map(s => s.id)
    const ownerSel = filters.selections.filter(s => s.type === 'owner').map(s => s.id)
    const groupSel = filters.selections.filter(s => s.type === 'group').map(s => s.id)
    const categorySel = filters.selections.filter(s => s.type === 'category').map(s => s.id)
    const tagSel = filters.selections.filter(s => s.type === 'tag').map(s => s.id)
    window.open(api.exportTransactionsCsv({
      columns: [...selectedCols].join(','),
      date_start: filters.date?.start || undefined, date_end: filters.date?.end || undefined,
      account_ids: accountSel.length ? accountSel.join(',') : undefined,
      owner_ids: ownerSel.length ? ownerSel.join(',') : undefined,
      group_ids: groupSel.length ? groupSel.join(',') : undefined,
      category_ids: categorySel.length ? categorySel.join(',') : undefined,
      tag_ids: tagSel.length ? tagSel.join(',') : undefined,
    }), '_blank')
  }

  return (
    <div>
      <SectionTitle>Export transactions to a .csv file</SectionTitle>
      <Card style={{ marginBottom: 12, padding: 0 }}>
        <FilterBar />
      </Card>
      <Card>
        <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 14 }}>Select columns to include:</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginBottom: 16 }}>
          {EXPORT_COLUMNS.map(col => (
            <label key={col.key} style={{ display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer', fontSize: 13 }}>
              <input type="checkbox" checked={selectedCols.has(col.key)} onChange={() => toggleCol(col.key)} />{col.label}
            </label>
          ))}
        </div>
        <div style={{ display: 'grid', gap: 8, justifyItems: 'start' }}>
          <Button onClick={downloadCsv} disabled={selectedCols.size === 0}>Generate File</Button>
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>
            {filters.date || filters.selections.length > 0
              ? 'Only transactions matching the filter above will be exported.'
              : 'No filter set — all transactions will be exported.'}
          </div>
        </div>
      </Card>
    </div>
  )
}
