// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// The maintenance screen behind Settings → Import storage: what each import kept beyond the transactions
// it brought in, and the means to clear it.
//
// It is a screen rather than a control on each card because of what the action is. The thing being
// removed is a *duplicate report* — the per-row record of what an import refused — and on a card
// labelled with a filename, any verb for removing something reads as acting on that file's
// transactions, whichever verb is chosen. A screen fixes what no label on a card could: the object is
// named here, the space is attributed to where it actually is, the consequences are explained in full,
// and more than one import can be dealt with in a pass.
//
// What is held here is only what still means something. The bulk the reports once carried — a source
// restating its own earlier import — is neither written by an import nor kept from before (migration
// v72), so every row this screen offers to remove is one somebody might want: a refusal flagged for
// review, the record an enrichment is undone from, another source's claim, a rejected row. Hence the
// breakdown on every import, and nothing removed by default.
//
// The figures in the confirmation are the server's own count of what it is about to do, never a total
// assembled from what this screen happens to be holding, so the sentence agreed to is the one carried
// out.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { format, subYears } from 'date-fns'
import { api } from '../../lib/api.js'
import { AppConfirmDialog, AppDialog, Button, EmptyState, SelectAllCheckbox } from '../ui.jsx'
import { HistoryAttentionPill } from './importPresentational.jsx'
import { buildDataSourceRows } from '../../lib/importExport/dataSourceRows.js'
import { describeDataSourceRow, formatCoverageRange } from '../../lib/importExport/importHistoryWindow.js'
import { providerLabel } from '../../lib/importSourceFields.js'

const formatBytes = bytes => {
  const n = Number(bytes || 0)
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  if (n >= 1024) return `${Math.round(n / 1024)} KB`
  return `${n} B`
}

const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`

// Card rows and the column header share one inset, which puts a card's checkbox a step in from its
// source's — the source row leads with its collapse toggle, then its checkbox.
const CARD_ROW_PADDING = '6px 10px 6px 54px'

// What an import holds, by what clearing it would cost. The server counts each report row once, so the
// settled duplicates are what is left of the report after the other two.
function describeStored(stored) {
  const duplicates = Math.max(0, stored.report_rows - stored.unreviewed_rows - (stored.enriched_rows || 0))
  return [
    stored.unreviewed_rows > 0 ? `${stored.unreviewed_rows.toLocaleString()} to review` : null,
    stored.enriched_rows > 0 ? plural(stored.enriched_rows, 'enrichment') : null,
    duplicates > 0 ? plural(duplicates, 'duplicate') : null,
    stored.rejected_rows > 0 ? `${stored.rejected_rows.toLocaleString()} rejected` : null,
  ].filter(Boolean).join(' · ')
}

// One row per import that still holds detail, grouped under the source that produced it. A source with
// nothing stored is left out entirely rather than listed as empty — the screen is about where the space
// is, and an exhaustive list of zeroes buries the answer.
function buildGroups(dataSourceRows, storage) {
  return dataSourceRows
    .map(row => {
      // Largest first, like the sources themselves: the question this screen answers is where the
      // space is, not what was imported when — the history on Import / Export is ordered by period.
      const cards = (row.batches || [])
        .map(batch => ({ batch, stored: storage[batch.id] }))
        .filter(entry => entry.stored && (entry.stored.report_rows > 0 || entry.stored.rejected_rows > 0))
        .sort((a, b) => b.stored.bytes - a.stored.bytes)
      const { name, qualifier } = describeDataSourceRow(row, providerLabel)
      return {
        key: row.key,
        label: name,
        qualifier,
        cards,
        bytes: cards.reduce((total, entry) => total + entry.stored.bytes, 0),
        storedRows: cards.reduce(
          (total, entry) => total + entry.stored.report_rows + entry.stored.rejected_rows, 0,
        ),
        unreviewed: cards.reduce((total, entry) => total + entry.stored.unreviewed_rows, 0),
        range: spanOf(cards.map(entry => entry.batch)),
      }
    })
    .filter(group => group.cards.length > 0)
    .sort((a, b) => b.bytes - a.bytes)
}

// The period the listed imports cover between them — like the space beside it, a figure about what this
// screen would clear, so only the imports shown count. One with no recorded span adds nothing.
function spanOf(batches) {
  const spanned = batches.filter(batch => batch.covers_start && batch.covers_end)
  if (spanned.length === 0) return null
  return formatCoverageRange({
    covers_start: spanned.reduce((min, batch) => (batch.covers_start < min ? batch.covers_start : min), spanned[0].covers_start),
    covers_end: spanned.reduce((max, batch) => (batch.covers_end > max ? batch.covers_end : max), spanned[0].covers_end),
  })
}

function CardRow({ entry, checked, onToggle }) {
  const { batch, stored } = entry
  const range = formatCoverageRange(batch)
  return (
    <label
      style={{
        display: 'grid', gridTemplateColumns: '22px minmax(0, 1fr) 150px 80px', gap: 10,
        alignItems: 'center', padding: CARD_ROW_PADDING, fontSize: 12, cursor: 'pointer',
      }}
    >
      <input type="checkbox" checked={checked} onChange={onToggle} />
      <span style={{ minWidth: 0 }}>
        <span
          style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          title={batch.filename}
        >
          {batch.filename}
        </span>
        <span style={{ display: 'block', color: 'var(--muted)', fontSize: 11 }}>{describeStored(stored)}</span>
      </span>
      <span style={{ color: 'var(--muted)' }}>{range || ''}</span>
      <span style={{ color: 'var(--muted)', textAlign: 'right' }}>{formatBytes(stored.bytes)}</span>
    </label>
  )
}

// "Older" by when the import was made, not by the period it covers: what ages is the chance that anyone
// still wants to act on what it refused, and a backfill of old statements made last week has not aged.
// Compared as calendar days, which both shapes `imported_at` arrives in begin with.
const importedBefore = (batch, cutoffDay) => String(batch.imported_at || '').slice(0, 10) < cutoffDay

export function ImportDetailStorageDialog({ onClose }) {
  const [loaded, setLoaded] = useState(null)
  const [selected, setSelected] = useState(() => new Set())
  // For this visit only: a source with dozens of imports can be folded away to bring the others into
  // view, and the screen opens with everything showing, since it is sorted for choosing.
  const [collapsed, setCollapsed] = useState(() => new Set())
  const [preview, setPreview] = useState(null)
  const [busy, setBusy] = useState(false)

  // The cards and sources are read here rather than handed in, so the screen groups imports exactly as
  // the history does without the page that opens it having to hold the history.
  const load = useCallback(async () => {
    const [storage, batches, profiles] = await Promise.all([
      api.getBatchDetailStorage().catch(() => ({})),
      api.listBatches().catch(() => []),
      api.getImportProfiles().catch(() => []),
    ])
    setLoaded({ storage, dataSourceRows: buildDataSourceRows({ profiles, batches }) })
  }, [])
  useEffect(() => { load() }, [load])

  const groups = useMemo(
    () => (loaded ? buildGroups(loaded.dataSourceRows, loaded.storage) : []),
    [loaded],
  )
  const totals = useMemo(() => ({
    bytes: groups.reduce((total, group) => total + group.bytes, 0),
    rows: groups.reduce((total, group) => total + group.storedRows, 0),
  }), [groups])
  const selectedBytes = useMemo(() => groups.reduce(
    (total, group) => total + group.cards.reduce(
      (sum, entry) => sum + (selected.has(entry.batch.id) ? entry.stored.bytes : 0), 0,
    ), 0,
  ), [groups, selected])
  const olderIds = useMemo(() => {
    const cutoffDay = format(subYears(new Date(), 1), 'yyyy-MM-dd')
    return groups.flatMap(group => group.cards)
      .filter(entry => importedBefore(entry.batch, cutoffDay))
      .map(entry => entry.batch.id)
  }, [groups])

  const toggle = ids => setSelected(prev => {
    const next = new Set(prev)
    const adding = ids.some(id => !next.has(id))
    ids.forEach(id => (adding ? next.add(id) : next.delete(id)))
    return next
  })
  const toggleCollapsed = key => setCollapsed(prev => {
    const next = new Set(prev)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    return next
  })

  const askToClear = async () => {
    const result = await api.previewBatchDetailClearing([...selected]).catch(() => null)
    if (result?.cards) setPreview(result)
  }
  const confirmClear = async () => {
    setBusy(true)
    try {
      await api.clearBatchDetail([...selected])
      setPreview(null)
      setSelected(new Set())
      await load()
    } finally {
      setBusy(false)
    }
  }

  return (
    <AppDialog
      title="Free space from duplicate transaction entries"
      onClose={onClose}
      width={760}
      actions={(
        <>
          <Button variant="ghost" onClick={onClose}>Close</Button>
          <Button onClick={askToClear} disabled={selected.size === 0}>
            {`Clear detail${selected.size === 0 ? '' : ` · ${formatBytes(selectedBytes)}`}`}
          </Button>
        </>
      )}
    >
      {/* The explanation leads, because the whole reason this is a screen is that a control could not
          carry it. It says what the record is for before offering to remove it. */}
      <div style={{ fontSize: 13, lineHeight: 1.5, marginBottom: 14 }}>
        <p style={{ margin: '0 0 8px' }}>
          Transaction detail is stored for duplicate transactions. This detail is displayed
          by the duplicate transaction report, allows for <em>Import anyway</em>, and
          is used to apply or undo enrichment. Clearing the stored detail information does not
          affect the current transactions; it removes the ability to view the duplicate
          report, make a different enrichment decision or decide the transaction should really have been
          imported.
        </p>
        <p>The space savings may not be large so it may be worth considering clearing this
          data when it gets to be more than a year old in case it provides useful.
        </p>
        <p style={{ margin: 0, color: 'var(--muted)' }}>
          Imported transactions are not affected.
        </p>
      </div>

      {!loaded ? <EmptyState message="Reading…" /> : groups.length === 0 ? (
        <EmptyState message="No import is holding detail records" />
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 8 }}>
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>
              {plural(totals.rows, 'stored row')} across {plural(groups.reduce((n, g) => n + g.cards.length, 0), 'import')} · {formatBytes(totals.bytes)}
            </span>
            {/* Replaces the selection rather than adding to it, so what is ticked afterwards is exactly
                the set the label names. */}
            <Button small variant="ghost" onClick={() => setSelected(new Set(olderIds))} disabled={olderIds.length === 0}>
              Select imports over a year old
            </Button>
          </div>
          {/* `clip`, not `hidden`, for the rounded corners: `hidden` makes this a scroll container, whose
              minimum height in the dialog body's grid is zero, so the grid squeezed the list to whatever
              height was left and cut off the rest — and with nothing overflowing the body, there was no
              scrollbar to reach it. `clip` crops the same corners without that. */}
          <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'clip' }}>
            <div style={{
              display: 'grid', gridTemplateColumns: '22px minmax(0, 1fr) 150px 80px', gap: 10,
              padding: CARD_ROW_PADDING, fontSize: 11, fontWeight: 600, color: 'var(--muted)',
              borderBottom: '1px solid var(--border)',
            }}>
              <span />
              <span>Import</span>
              <span>Period</span>
              <span style={{ textAlign: 'right' }}>Space used</span>
            </div>
            {groups.map(group => {
              const ids = group.cards.map(entry => entry.batch.id)
              const selectedCount = ids.filter(id => selected.has(id)).length
              const allSelected = selectedCount === ids.length
              const isCollapsed = collapsed.has(group.key)
              return (
                <div key={group.key} style={{ borderBottom: '1px solid color-mix(in srgb, var(--border) 70%, transparent)' }}>
                  <div
                    style={{
                      display: 'grid', gridTemplateColumns: '18px minmax(0, 1fr)', gap: 10,
                      alignItems: 'center', padding: '8px 10px',
                      background: 'color-mix(in srgb, var(--surface2) 45%, transparent)',
                    }}
                  >
                    {/* Outside the label, which selects the whole source on any click inside it. */}
                    <button
                      type="button"
                      onClick={() => toggleCollapsed(group.key)}
                      aria-expanded={!isCollapsed}
                      aria-label={`${isCollapsed ? 'Expand' : 'Collapse'} ${group.label}`}
                      style={{
                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                        width: 18, height: 18, padding: 0, borderRadius: 6,
                        border: '1px solid var(--border)', background: 'var(--surface2)',
                        color: 'var(--muted)', font: 'inherit', fontSize: 11, lineHeight: 1, cursor: 'pointer',
                      }}
                    >
                      {isCollapsed ? '+' : '−'}
                    </button>
                    <label
                      style={{
                        // The import rows' last two columns, so the span and the space sit under theirs.
                        display: 'grid', gridTemplateColumns: '22px minmax(0, 1fr) 150px 80px', gap: 10,
                        alignItems: 'center', fontSize: 13, cursor: 'pointer',
                      }}
                    >
                      {/* Partial selection shows, and is counted, so a folded source cannot hide what
                          the buttons below are about to act on. */}
                      <SelectAllCheckbox
                        checked={allSelected}
                        indeterminate={selectedCount > 0 && !allSelected}
                        onChange={() => toggle(ids)}
                      />
                      <span style={{ fontWeight: 600, minWidth: 0 }}>
                        {group.label}
                        <span style={{ fontWeight: 400, color: 'var(--muted)' }}>
                          {group.qualifier ? ` · ${group.qualifier}` : ''}
                          {' · '}{plural(group.cards.length, 'import')}
                          {selectedCount > 0 && !allSelected ? ` · ${selectedCount.toLocaleString()} selected` : ''}
                        </span>
                        {/* On the source row as well as each import's, so a folded source still says it
                            holds refusals nobody has looked at — the ones a clear would lose unseen. */}
                        {group.unreviewed > 0 ? (
                          <HistoryAttentionPill title={`${plural(group.unreviewed, 'row')} in these imports still flagged for review`}>
                            ⚠ {group.unreviewed.toLocaleString()} to review
                          </HistoryAttentionPill>
                        ) : null}
                      </span>
                      <span style={{ color: 'var(--muted)', fontSize: 12 }}>{group.range || ''}</span>
                      <span style={{ color: 'var(--muted)', textAlign: 'right' }}>{formatBytes(group.bytes)}</span>
                    </label>
                  </div>
                  {isCollapsed ? null : group.cards.map(entry => (
                    <CardRow
                      key={entry.batch.id}
                      entry={entry}
                      checked={selected.has(entry.batch.id)}
                      onToggle={() => toggle([entry.batch.id])}
                    />
                  ))}
                </div>
              )
            })}
          </div>
        </>
      )}

      {preview ? (
        <ClearConfirm
          preview={preview}
          busy={busy}
          onConfirm={confirmClear}
          onCancel={() => setPreview(null)}
        />
      ) : null}
    </AppDialog>
  )
}

// What the clear will do, as separate sentences rather than one clause each: the halves answer different
// questions ("what is lost?" and "what stays?") and the reassuring one goes last, where it is read,
// rather than first where it is skimmed on the way to the button.
function ClearConfirm({ preview, busy, onConfirm, onCancel }) {
  const lines = [
    `The detail stored by ${plural(preview.cards, 'import')} will be cleared, freeing ${formatBytes(preview.bytes)}.`,
    preview.report_rows > 0
      ? `${plural(preview.report_rows, 'duplicate row')} ${preview.report_rows === 1 ? 'goes' : 'go'} permanently${preview.unreviewed_rows > 0 ? `, including ${plural(preview.unreviewed_rows, 'row')} still flagged for review` : ''}.`
      : null,
    preview.enrichment_undos > 0
      ? `${plural(preview.enrichment_undos, 'enrichment')} can no longer be undone.`
      : null,
    preview.rejected_rows > 0
      ? `${plural(preview.rejected_rows, 'rejected row')} will no longer be listed.`
      : null,
    preview.trashed_released > 0
      ? `${plural(preview.trashed_released, 'removed duplicate')} ${preview.trashed_released === 1 ? 'moves' : 'move'} to Trash, where ${preview.trashed_released === 1 ? 'it' : 'they'} can be restored or emptied.`
      : null,
    preview.transactions_kept > 0
      ? `${plural(preview.transactions_kept, 'transaction')} ${preview.transactions_kept === 1 ? 'stays' : 'stay'} in the ledger, and the imports stay in the history.`
      : null,
  ].filter(Boolean)

  return (
    <AppConfirmDialog
      title="Clear stored detail?"
      confirmLabel={busy ? 'Clearing…' : 'Clear detail'}
      confirmVariant="danger"
      confirmDisabled={busy}
      cancelDisabled={busy}
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13 }}>
        {lines.map(line => <span key={line}>{line}</span>)}
        <span style={{ color: 'var(--muted)' }}>This cannot be undone.</span>
      </div>
    </AppConfirmDialog>
  )
}
