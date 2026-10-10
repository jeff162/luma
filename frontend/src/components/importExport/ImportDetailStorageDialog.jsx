// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// The maintenance screen behind the Import / Export history's "Free up import space" action: what each
// import kept beyond the transactions it brought in, and the means to clear it.
//
// It is a screen rather than a control on each card because of what the action is. The thing being
// removed is a *duplicate report* — the per-row record of what an import refused — and on a card
// labelled with a filename, any verb for removing something reads as acting on that file's
// transactions, whichever verb is chosen. A screen fixes what no label on a card could: the object is
// named here, the space is attributed to where it actually is, the consequences are explained in full,
// and more than one import can be dealt with in a pass.
//
// The figures in the confirmation are the server's own count of what it is about to do, never a total
// assembled from what this screen happens to be holding, so the sentence agreed to is the one carried
// out.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../../lib/api.js'
import { AppConfirmDialog, AppDialog, Button, EmptyState } from '../ui.jsx'
import { describeDataSourceRow, formatCoverageRange } from '../../lib/importExport/importHistoryWindow.js'
import { providerLabel } from '../../lib/importSourceFields.js'

const formatBytes = bytes => {
  const n = Number(bytes || 0)
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  if (n >= 1024) return `${Math.round(n / 1024)} KB`
  return `${n} B`
}

const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`

// One row per import that still holds detail, grouped under the source that produced it. A source with
// nothing stored is left out entirely rather than listed as empty — the screen is about where the space
// is, and an exhaustive list of zeroes buries the answer.
function buildGroups(dataSourceRows, storage) {
  return dataSourceRows
    .map(row => {
      // Largest first, like the sources themselves: the question this screen answers is where the
      // space is, not what was imported when — the history next door is ordered by period.
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
      }
    })
    .filter(group => group.cards.length > 0)
    .sort((a, b) => b.bytes - a.bytes)
}

function CardRow({ entry, checked, onToggle }) {
  const { batch, stored } = entry
  const range = formatCoverageRange(batch)
  return (
    <label
      style={{
        display: 'grid', gridTemplateColumns: '22px minmax(0, 1fr) 150px 110px', gap: 10,
        alignItems: 'center', padding: '6px 10px 6px 26px', fontSize: 12, cursor: 'pointer',
      }}
    >
      <input type="checkbox" checked={checked} onChange={onToggle} />
      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={batch.filename}>
        {batch.filename}
      </span>
      <span style={{ color: 'var(--muted)' }}>{range || ''}</span>
      <span style={{ color: 'var(--muted)', textAlign: 'right' }}>
        {plural(stored.report_rows + stored.rejected_rows, 'row')} · {formatBytes(stored.bytes)}
      </span>
    </label>
  )
}

export function ImportDetailStorageDialog({ dataSourceRows, onClose, onCleared }) {
  const [storage, setStorage] = useState(null)
  const [selected, setSelected] = useState(() => new Set())
  const [preview, setPreview] = useState(null)
  const [restatementPreview, setRestatementPreview] = useState(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setStorage(await api.getBatchDetailStorage().catch(() => ({})))
  }, [])
  useEffect(() => { load() }, [load])

  const groups = useMemo(
    () => (storage ? buildGroups(dataSourceRows, storage) : []),
    [dataSourceRows, storage],
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

  const toggle = ids => setSelected(prev => {
    const next = new Set(prev)
    const adding = ids.some(id => !next.has(id))
    ids.forEach(id => (adding ? next.add(id) : next.delete(id)))
    return next
  })

  const askToClear = async () => {
    const result = await api.previewBatchDetailClearing([...selected]).catch(() => null)
    if (result?.cards) setPreview(result)
  }
  // Counted on demand rather than alongside the space figures, which the screen reads on open: deciding
  // whether a stored row is a restatement means parsing its cells and its match, and paying for that
  // across every import to answer a question nobody has asked yet is the wrong trade.
  const askToRemoveRestatements = async () => {
    const result = await api.previewBatchRestatements([...selected]).catch(() => null)
    if (result?.cards) setRestatementPreview(result)
    else setRestatementPreview({ cards: 0 })
  }
  const runAndRefresh = async action => {
    setBusy(true)
    try {
      await action()
      setPreview(null)
      setRestatementPreview(null)
      setSelected(new Set())
      await load()
      await onCleared?.()
    } finally {
      setBusy(false)
    }
  }
  const confirmClear = () => runAndRefresh(() => api.clearBatchDetail([...selected]))
  const confirmRemoveRestatements = () => runAndRefresh(() => api.removeBatchRestatements([...selected]))

  return (
    <AppDialog
      title="Free space from duplicate transaction entries"
      onClose={onClose}
      width={760}
      actions={(
        <>
          <Button variant="ghost" onClick={onClose}>Close</Button>
          {/* Two removals with different objects, so neither label is a verb alone: one takes the rows
              that would not be stored at all today, the other takes the report entire. */}
          <Button variant="ghost" onClick={askToClear} disabled={selected.size === 0}>
            {`Clear all detail${selected.size === 0 ? '' : ` · ${formatBytes(selectedBytes)}`}`}
          </Button>
          <Button onClick={askToRemoveRestatements} disabled={selected.size === 0}>
            Remove rows already in the ledger
          </Button>
        </>
      )}
    >
      {/* The explanation leads, because the whole reason this is a screen is that a control could not
          carry it. It says what the record is for before offering to remove it. */}
      <div style={{ fontSize: 13, lineHeight: 1.5, marginBottom: 14 }}>
        <p style={{ margin: '0 0 8px' }}>
          Every import stores a record of the rows it refused as duplicates. This record is
          what the duplicates view shows, what makes <em>Import anyway</em> possible, and what
          is used to apply or undo enrichment. Rejected rows (e.g. for a skipped account or
          an unreadable date) are also part of this record. Clearing frees this space.
        </p>
        <p style={{ margin: '0 0 8px' }}>
          Most of what is held is a source restating its own earlier import — a re-export covering a
          period already imported. An import does not record those any more, because the transaction
          each one duplicates is in the ledger. <em>Remove rows already in the ledger</em> takes those
          out of imports made before that change, leaving every refusal that still needs a look and
          every match from a different source.
        </p>
        <p style={{ margin: 0, color: 'var(--muted)' }}>
          Imported transactions are not affected.
        </p>
      </div>

      {!storage ? <EmptyState message="Reading…" /> : groups.length === 0 ? (
        <EmptyState message="No import is holding detail records" />
      ) : (
        <>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8 }}>
            {plural(totals.rows, 'stored row')} across {plural(groups.reduce((n, g) => n + g.cards.length, 0), 'import')} · {formatBytes(totals.bytes)}
          </div>
          <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
            <div style={{
              display: 'grid', gridTemplateColumns: '22px minmax(0, 1fr) 150px 110px', gap: 10,
              padding: '6px 10px 6px 26px', fontSize: 11, fontWeight: 600, color: 'var(--muted)',
              borderBottom: '1px solid var(--border)',
            }}>
              <span />
              <span>Import</span>
              <span>Period</span>
              <span style={{ textAlign: 'right' }}>Space used</span>
            </div>
            {groups.map(group => {
              const ids = group.cards.map(entry => entry.batch.id)
              const allSelected = ids.every(id => selected.has(id))
              return (
                <div key={group.key} style={{ borderBottom: '1px solid color-mix(in srgb, var(--border) 70%, transparent)' }}>
                  <label
                    style={{
                      display: 'grid', gridTemplateColumns: '22px minmax(0, 1fr) 110px', gap: 10,
                      alignItems: 'center', padding: '8px 10px', fontSize: 13, cursor: 'pointer',
                      background: 'color-mix(in srgb, var(--surface2) 45%, transparent)',
                    }}
                  >
                    <input type="checkbox" checked={allSelected} onChange={() => toggle(ids)} />
                    <span style={{ fontWeight: 600, minWidth: 0 }}>
                      {group.label}
                      <span style={{ fontWeight: 400, color: 'var(--muted)' }}>
                        {group.qualifier ? ` · ${group.qualifier}` : ''}
                        {' · '}{plural(group.cards.length, 'import')}
                      </span>
                    </span>
                    <span style={{ color: 'var(--muted)', textAlign: 'right' }}>{formatBytes(group.bytes)}</span>
                  </label>
                  {group.cards.map(entry => (
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

      {restatementPreview ? (
        <RestatementConfirm
          preview={restatementPreview}
          busy={busy}
          onConfirm={confirmRemoveRestatements}
          onCancel={() => setRestatementPreview(null)}
        />
      ) : null}
    </AppDialog>
  )
}

// The narrower removal's confirmation. Same two questions in the same order as the clear's — what is
// lost, then what stays — but the answer to the second is the reason to prefer this one, so it is
// stated even when nothing is kept, rather than dropped as an empty clause.
function RestatementConfirm({ preview, busy, onConfirm, onCancel }) {
  const nothingToDo = !preview.cards
  const lines = nothingToDo ? [
    'Nothing in the selected imports was stored as a restatement. Every row they hold is a refusal that still needs a look, a match claimed by a different source, or an enrichment that can still be undone.',
  ] : [
    `${plural(preview.rows, 'row')} recorded only because a source restated its own earlier import ${preview.rows === 1 ? 'goes' : 'go'} permanently, freeing ${formatBytes(preview.bytes)}.`,
    preview.rows_kept > 0
      ? `${plural(preview.rows_kept, 'row')} ${preview.rows_kept === 1 ? 'stays' : 'stay'} in the reports${preview.flagged_kept > 0 ? `, including ${plural(preview.flagged_kept, 'row')} still flagged for review` : ''}.`
      : 'The reports keep nothing else — every row in them was a restatement.',
    `The ${plural(preview.cards, 'import')} ${preview.cards === 1 ? 'keeps its card' : 'keep their cards'}, every transaction, and a count of what was already held.`,
  ].filter(Boolean)

  return (
    <AppConfirmDialog
      title={nothingToDo ? 'Nothing to remove' : 'Remove rows already in the ledger?'}
      confirmLabel={nothingToDo ? 'OK' : busy ? 'Removing…' : 'Remove rows'}
      confirmVariant={nothingToDo ? 'primary' : 'danger'}
      confirmDisabled={busy}
      cancelDisabled={busy}
      onConfirm={nothingToDo ? onCancel : onConfirm}
      onCancel={onCancel}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13 }}>
        {lines.map(line => <span key={line}>{line}</span>)}
        {nothingToDo ? null : <span style={{ color: 'var(--muted)' }}>This cannot be undone.</span>}
      </div>
    </AppConfirmDialog>
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
