// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState, useEffect, useCallback } from 'react'
import { api } from '../../lib/api.js'
import { txnMutations } from '../../lib/txnMutations.js'
import { Card, Button, Spinner, EmptyState, AppConfirmDialog } from '../ui.jsx'
import { RuleMatcherText } from '../RuleSummary.jsx'
import { BackupHistoryEntry } from '../administration/BackupHistoryList.jsx'

// Whether a trashed transaction was removed by import reconciliation (an Amazon merge or per-copy
// discard) rather than deleted directly by the user — the discriminator between the two
// transaction-trash sections below. Module-level so the filter identities are stable.
const isReconRemoval = (item) =>
  item.dedupe_resolved_by === 'amazon_merge' || item.dedupe_resolved_by === 'amazon_discard'
const isDirectDelete = (item) => !isReconRemoval(item)

// Timeframe options for the Empty-trash chooser. Values match backend/routers/transactions.py
// `_TRASH_OLDER_THAN`; the cutoff is measured on `trashed_at` (age in the trash). `all` empties the
// whole section — the button's long-standing meaning — and `ago` is the human phrase for the confirm copy.
const TRASH_TIMEFRAMES = [
  { value: 'all', label: 'Everything', ago: null },
  { value: '1m', label: 'Older than 1 month', ago: '1 month' },
  { value: '3m', label: 'Older than 3 months', ago: '3 months' },
  { value: '6m', label: 'Older than 6 months', ago: '6 months' },
  { value: '1y', label: 'Older than 1 year', ago: '1 year' },
]

// The "how much to erase" radio group shown inside the Empty-trash confirm dialog. Defaults to
// Everything; narrower picks purge only rows trashed at least that long ago.
function TrashTimeframeChooser({ value, onChange, disabled, name }) {
  return (
    <div role="radiogroup" aria-label="How much to erase" style={{ display: 'grid', gap: 6, marginTop: 6 }}>
      {TRASH_TIMEFRAMES.map(tf => {
        const selected = value === tf.value
        return (
          <label
            key={tf.value}
            style={{
              display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px',
              border: `1px solid ${selected ? 'var(--accent)' : 'var(--border)'}`, borderRadius: 10,
              cursor: disabled ? 'default' : 'pointer', fontSize: 14,
              background: selected ? 'color-mix(in srgb, var(--accent) 10%, transparent)' : 'var(--surface2)',
            }}
          >
            <input type="radio" name={name} value={tf.value} checked={selected} disabled={disabled}
              onChange={() => onChange(tf.value)} />
            {tf.label}
          </label>
        )
      })}
    </div>
  )
}

// Confirm-dialog body for emptying a transaction-trash section: an extent line reflecting the chosen
// timeframe, then the section-specific `note` (its sibling-protection + irreversibility caveats).
// `noun` names the section's rows ("deleted transaction", "removed duplicate copy").
function trashEmptyDescription(timeframe, noun, note) {
  const tf = TRASH_TIMEFRAMES.find(t => t.value === timeframe) || TRASH_TIMEFRAMES[0]
  const extent = tf.ago
    ? `This permanently removes every ${noun} trashed more than ${tf.ago} ago.`
    : `This permanently removes every ${noun} listed here.`
  return `${extent} ${note}`
}

// Load / restore / empty plumbing shared by the two transaction-trash sections. `filter` selects the
// section's slice of the trash; `scope` keeps its Empty button from deleting the other section's rows.
// `onChanged` reports a restore or an emptying to the page, which shows each section's count.
function useTrashedTransactions(filter, scope, onChanged) {
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [workingId, setWorkingId] = useState('')
  const [emptying, setEmptying] = useState(false)
  const [error, setError] = useState('')
  const [confirmEmpty, setConfirmEmpty] = useState(false)
  const [timeframe, setTimeframe] = useState('all')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const rows = await api.getTrashedTransactions(scope)
      setItems((Array.isArray(rows) ? rows : []).filter(filter))
      setError('')
    } catch (err) {
      setError(err.message || 'Failed to load trashed transactions')
    } finally {
      setLoading(false)
    }
  }, [filter, scope])

  useEffect(() => { load() }, [load])

  async function restoreItem(txnId) {
    setWorkingId(txnId)
    setError('')
    try {
      await txnMutations.restoreTransaction(txnId)
      await load()
      onChanged?.()
    } catch (err) {
      setError(err.message || 'Failed to restore transaction')
    } finally {
      setWorkingId('')
    }
  }

  // Open the confirm dialog, always starting the chooser back at Everything so a narrow pick from a
  // previous empty doesn't silently carry over into the next one.
  function openConfirm() {
    setTimeframe('all')
    setConfirmEmpty(true)
  }

  async function emptyTrash() {
    setConfirmEmpty(false)
    setEmptying(true)
    setError('')
    try {
      await api.emptyTransactionTrash(scope, timeframe)
      await load()
      onChanged?.()
    } catch (err) {
      setError(err.message || 'Failed to empty trash')
    } finally {
      setEmptying(false)
    }
  }

  return { items, loading, workingId, emptying, error, confirmEmpty, setConfirmEmpty, openConfirm, timeframe, setTimeframe, restoreItem, emptyTrash }
}

// One trashed transaction, shared by both sections (they differ only in list structure around it).
function TrashedTxnRow({ item, first = false, working, emptying, onRestore }) {
  const merchant = item.display_name || item.merchant_name || item.raw_name || '—'
  const account = item.account_display_name || item.account_name || '—'
  const amount = Number(item.amount) || 0
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1fr) auto auto',
        gap: 16,
        alignItems: 'center',
        padding: '10px 14px',
        borderTop: first ? 'none' : '1px solid var(--border)',
        background: 'var(--surface2)',
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {merchant}
        </div>
        <div style={{ marginTop: 2, fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>
          {item.date} · {account}{item.category_name ? ` · ${item.category_name}` : ''} · Trashed {item.trashed_at || 'recently'}
        </div>
      </div>
      <div style={{ fontSize: 13, fontWeight: 600, color: amount < 0 ? 'var(--success)' : 'var(--text)', whiteSpace: 'nowrap' }}>
        {amount < 0 ? '+' : ''}{amount.toFixed(2)}
      </div>
      <Button onClick={() => onRestore(item.id)} disabled={working === item.id || emptying}>
        {working === item.id ? 'Restoring…' : 'Restore'}
      </Button>
    </div>
  )
}

// The section lists a page of the most recent; `count` is the whole bucket, so a longer one says the
// list is not all of it.
function ListedOfCount({ listed, count }) {
  if (!(count > listed)) return null
  return (
    <div style={{ fontSize: 12, color: 'var(--muted)' }}>
      Showing the {listed.toLocaleString()} most recently trashed of {count.toLocaleString()}.
    </div>
  )
}

export function TransactionsTrashSection({ count, onChanged }) {
  // Transactions deleted directly (the transactions page, detail panels, bulk edit) — the import
  // source isn't meaningful for these, so it's a flat list. Duplicate copies removed by import
  // reconciliation live in the sibling DuplicateTransactionsTrashSection. Restoration just clears
  // the `trashed_at` flag; emptying drops this section's records permanently.
  const t = useTrashedTransactions(isDirectDelete, 'deleted', onChanged)

  return (
    <>
      {t.confirmEmpty ? (
        <AppConfirmDialog
          title="Empty transaction trash?"
          description={trashEmptyDescription(t.timeframe, 'deleted transaction', 'Removed duplicates have their own section and are not touched. Restored history will not be recoverable afterward.')}
          confirmLabel="Empty trash"
          confirmVariant="danger"
          borderColor="color-mix(in srgb, var(--danger) 35%, var(--border))"
          onConfirm={t.emptyTrash}
          onCancel={() => t.setConfirmEmpty(false)}
          width="min(620px, 100%)"
        >
          <TrashTimeframeChooser name="empty-deleted-trash" value={t.timeframe} onChange={t.setTimeframe} />
        </AppConfirmDialog>
      ) : null}

      <Card style={{ display: 'grid', gap: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.6, maxWidth: 620 }}>
            Transactions you&apos;ve sent to the trash live here until you restore them or empty the trash.
          </div>
          <Button
            variant="secondary"
            onClick={t.openConfirm}
            disabled={t.emptying || t.loading || t.items.length === 0}
          >
            {t.emptying ? 'Emptying…' : 'Empty trash'}
          </Button>
        </div>

        {t.loading && t.items.length === 0 ? <Spinner /> : t.items.length === 0 ? (
          <EmptyState message="No transactions in trash." />
        ) : (
          <div style={{ border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
            {t.items.map((item, index) => (
              <TrashedTxnRow key={item.id} item={item} first={index === 0}
                working={t.workingId} emptying={t.emptying} onRestore={t.restoreItem} />
            ))}
          </div>
        )}

        <ListedOfCount listed={t.items.length} count={count} />

        {t.error ? (
          <div style={{ fontSize: 12, color: 'var(--danger)' }}>{t.error}</div>
        ) : null}
      </Card>
    </>
  )
}

export function DuplicateTransactionsTrashSection({ count, onChanged }) {
  // Duplicate charge copies removed by import reconciliation (Merge → keep one / per-copy Discard),
  // organized by the file each copy came from — that provenance is the whole reason these sit apart
  // from ordinary deletes. Groups collapse for scanning; a lone file starts open. Restore brings a
  // copy back, and the reconciliation report simply re-derives its grouping.
  const t = useTrashedTransactions(isReconRemoval, 'duplicates', onChanged)
  const [openGroups, setOpenGroups] = useState(null)   // null = default (a lone group starts open)

  const groups = []
  const byFile = new Map()
  for (const item of t.items) {   // items arrive most-recently-trashed first; rows keep that order
    const label = item.source_filename || 'Unknown file'
    if (!byFile.has(label)) { byFile.set(label, []); groups.push(label) }
    byFile.get(label).push(item)
  }
  const effectiveOpen = openGroups ?? new Set(groups.length === 1 ? groups : [])
  const toggleGroup = (label) => {
    const next = new Set(effectiveOpen)
    if (next.has(label)) next.delete(label)
    else next.add(label)
    setOpenGroups(next)
  }

  return (
    <>
      {t.confirmEmpty ? (
        <AppConfirmDialog
          title="Empty removed-duplicates trash?"
          description={trashEmptyDescription(t.timeframe, 'removed duplicate copy', 'Deleted transactions have their own section and are not touched. The record of what was merged or discarded goes with them.')}
          confirmLabel="Empty trash"
          confirmVariant="danger"
          borderColor="color-mix(in srgb, var(--danger) 35%, var(--border))"
          onConfirm={t.emptyTrash}
          onCancel={() => t.setConfirmEmpty(false)}
          width="min(620px, 100%)"
        >
          <TrashTimeframeChooser name="empty-duplicates-trash" value={t.timeframe} onChange={t.setTimeframe} />
        </AppConfirmDialog>
      ) : null}

      <Card style={{ display: 'grid', gap: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.6, maxWidth: 620 }}>
            Duplicate charge copies removed on the Amazon reconciliation report (Merge → keep one, or a
            per-copy Discard), grouped by the file they were imported from. Restore brings a copy back.
          </div>
          <Button
            variant="secondary"
            onClick={t.openConfirm}
            disabled={t.emptying || t.loading || t.items.length === 0}
          >
            {t.emptying ? 'Emptying…' : 'Empty trash'}
          </Button>
        </div>

        {t.loading && t.items.length === 0 ? <Spinner /> : t.items.length === 0 ? (
          <EmptyState message="No removed duplicates in trash." />
        ) : groups.map(label => {
          const open = effectiveOpen.has(label)
          const rows = byFile.get(label)
          return (
            <div key={label} style={{ border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
              <button
                type="button"
                onClick={() => toggleGroup(label)}
                style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '9px 14px', background: 'var(--surface)', border: 'none', cursor: 'pointer', color: 'var(--text)', fontSize: 12.5, textAlign: 'left' }}
              >
                <span style={{ color: 'var(--muted)' }}>{open ? '▾' : '▸'}</span>
                <span style={{ fontWeight: 600 }}>{label}</span>
                <span style={{ color: 'var(--muted)', fontWeight: 400 }}>({rows.length})</span>
              </button>
              {open ? rows.map(item => (
                <TrashedTxnRow key={item.id} item={item}
                  working={t.workingId} emptying={t.emptying} onRestore={t.restoreItem} />
              )) : null}
            </div>
          )
        })}

        <ListedOfCount listed={t.items.length} count={count} />

        {t.error ? (
          <div style={{ fontSize: 12, color: 'var(--danger)' }}>{t.error}</div>
        ) : null}
      </Card>
    </>
  )
}

export function RulesTrashSection({ onChanged }) {
  // Trashed categorization rules (from the Rules page delete / stale-rule cleanup). Restore brings a rule
  // back to active (refused if an active rule now shares its matcher); purge removes it for good.
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [workingId, setWorkingId] = useState('')
  const [emptying, setEmptying] = useState(false)
  const [error, setError] = useState('')
  const [confirmEmpty, setConfirmEmpty] = useState(false)

  async function load() {
    setLoading(true)
    try {
      setItems(await api.getRuleTrash())
      setError('')
    } catch (err) {
      setError(err.message || 'Failed to load rules trash')
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [])

  async function restore(id) {
    setWorkingId(id); setError('')
    try { await api.restoreRule(id); await load(); onChanged?.() }
    catch (err) { setError(err.message || 'Failed to restore rule') }
    finally { setWorkingId('') }
  }
  async function purge(id) {
    setWorkingId(id); setError('')
    try { await api.purgeRule(id); await load(); onChanged?.() }
    catch (err) { setError(err.message || 'Failed to remove rule') }
    finally { setWorkingId('') }
  }
  async function emptyTrash() {
    setConfirmEmpty(false); setEmptying(true); setError('')
    try { await api.purgeAllTrashedRules(); await load(); onChanged?.() }
    catch (err) { setError(err.message || 'Failed to empty rules trash') }
    finally { setEmptying(false) }
  }

  return (
    <>
      {confirmEmpty ? (
        <AppConfirmDialog
          title="Empty rules trash?"
          description="This permanently deletes every trashed rule. Their past categorizations stay as they are; the rules themselves can’t be restored afterward."
          confirmLabel="Empty rules trash"
          confirmVariant="danger"
          borderColor="color-mix(in srgb, var(--danger) 35%, var(--border))"
          onConfirm={emptyTrash}
          onCancel={() => setConfirmEmpty(false)}
          width="min(620px, 100%)"
        />
      ) : null}

      <Card style={{ display: 'grid', gap: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.6, maxWidth: 620 }}>
            Rules removed from the Rules page (or by the stale-rule cleanup) can be restored here, or removed for good.
          </div>
          <Button variant="secondary" onClick={() => setConfirmEmpty(true)} disabled={emptying || loading || items.length === 0}>
            {emptying ? 'Emptying…' : 'Empty rules trash'}
          </Button>
        </div>
        {error ? <div style={{ fontSize: 12, color: 'var(--danger)' }}>{error}</div> : null}
        {loading && items.length === 0 ? <Spinner /> : items.length === 0 ? (
          <EmptyState message="No trashed rules." />
        ) : (
          <div style={{ border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
            {items.map((rule, index) => (
              <div key={rule.id} style={{
                display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 16, alignItems: 'center',
                padding: '10px 14px', borderTop: index === 0 ? 'none' : '1px solid var(--border)', background: 'var(--surface2)',
              }}>
                <div style={{ minWidth: 0, fontSize: 13, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '2px 6px' }}>
                  <RuleMatcherText rule={rule} />
                  {rule.category_name ? <span style={{ color: 'var(--muted)' }}>→ {rule.category_name}</span> : null}
                </div>
                <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                  <Button variant="secondary" onClick={() => restore(rule.id)} disabled={workingId === rule.id}>Restore</Button>
                  <Button variant="secondary" tone="danger" onClick={() => purge(rule.id)} disabled={workingId === rule.id}>
                    Remove
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </>
  )
}

export function BackupHistoryTrashSection({ onChanged }) {
  // Backup history entries moved to the trash from Settings → Backup / Restore, for a backup that
  // was not kept. Restore puts one back in the history; emptying removes them for good.
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [workingId, setWorkingId] = useState('')
  const [emptying, setEmptying] = useState(false)
  const [error, setError] = useState('')
  const [confirmEmpty, setConfirmEmpty] = useState(false)

  async function load() {
    setLoading(true)
    try {
      setItems((await api.getBackupHistoryTrash()).backups || [])
      setError('')
    } catch (err) {
      setError(err.message || 'Failed to load the backup history trash')
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [])

  async function restore(id) {
    setWorkingId(id); setError('')
    try { setItems((await api.restoreBackupHistoryEntry(id)).backups || []); onChanged?.() }
    catch (err) { setError(err.message || 'Failed to restore the backup history entry') }
    finally { setWorkingId('') }
  }
  async function emptyTrash() {
    setConfirmEmpty(false); setEmptying(true); setError('')
    try { setItems((await api.emptyBackupHistoryTrash()).backups || []); onChanged?.() }
    catch (err) { setError(err.message || 'Failed to empty the backup history trash') }
    finally { setEmptying(false) }
  }

  return (
    <>
      {confirmEmpty ? (
        <AppConfirmDialog
          title="Empty backup history trash?"
          description="This permanently deletes every trashed backup history entry. The backup files themselves are not affected."
          confirmLabel="Empty backup history trash"
          confirmVariant="danger"
          borderColor="color-mix(in srgb, var(--danger) 35%, var(--border))"
          onConfirm={emptyTrash}
          onCancel={() => setConfirmEmpty(false)}
          width="min(620px, 100%)"
        />
      ) : null}

      <Card style={{ display: 'grid', gap: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.6, maxWidth: 620 }}>
            Backup history entries removed on the Backup / Restore page can be restored here.
          </div>
          <Button variant="secondary" onClick={() => setConfirmEmpty(true)} disabled={emptying || loading || items.length === 0}>
            {emptying ? 'Emptying…' : 'Empty backup history trash'}
          </Button>
        </div>
        {error ? <div style={{ fontSize: 12, color: 'var(--danger)' }}>{error}</div> : null}
        {loading && items.length === 0 ? <Spinner /> : items.length === 0 ? (
          <EmptyState message="No trashed backup history entries." />
        ) : (
          <div style={{ border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden', padding: '0 14px', background: 'var(--surface2)' }}>
            {items.map((row, index) => (
              <BackupHistoryEntry
                key={row.id}
                row={row}
                first={index === 0}
                actions={(
                  <Button onClick={() => restore(row.id)} disabled={workingId === row.id || emptying}>
                    {workingId === row.id ? 'Restoring…' : 'Restore'}
                  </Button>
                )}
              />
            ))}
          </div>
        )}
      </Card>
    </>
  )
}
