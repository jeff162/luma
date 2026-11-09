// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useMemo, useState } from 'react'
import { Button, RefreshButton, FilterChip } from '../../ui.jsx'
import { DetailPanelShell, useDetailPanelChrome, useRestorablePanelGeometry } from '../../detailShared.jsx'
import FeatureExplainer from '../../../help/FeatureExplainer.jsx'
import { RECONCILIATION_REPORTS } from '../../../lib/reconciliationReports.js'
import { useUserPreference } from '../../../lib/UserPreferencesContext.jsx'
import { MatchReport } from '../MatchReport.jsx'
import { ChargePickerDialog } from './ChargePickerDialog.jsx'
import { RECONCILIATION_VENDORS } from './reconciliationVendors.js'

// The shared reconciliation report: how one source's records line up with the ledger rows they pair
// with. Every vendor's report has the same shape, so the shell owns all of it — the floating panel, a
// filter pill per bucket, the kind column, the intersection bulk bar, the MatchReport table and the
// manual pairing window — and a vendor supplies only what differs (reconciliationVendors.js):
//   kinds          { [kind]: { rank, label, stripe, warn?, review?, help } } — rank orders the rows and the
//                  pills, problems first; `warn` marks an alarm bucket, `review` an advisory one
//   buildEntries   (data) → entries, each { id, kind, … }; entryDate(entry) sorts within a kind
//   isAcknowledged (entry) → a row the user marked reviewed: it stays listed but reads as handled
//   rowActions     (entry) → { [action]: true } — the bulk-eligible actions a row offers
//   bulkActions    [{ key, label, title }] in bar order
//   actionCall     (action, entry) → the promise behind an action, shared by a row's button and the bulk bar
//   sortPrefKey    where the header sort the user picked is remembered
//   useColumns     (ctx) → { columns, overlay, bulkControls? } — a hook, so a vendor keeps its own row-level
//                  state. `bulkControls({ selected, disabled, runSelected })` renders vendor controls in the
//                  bulk bar for an action that needs more than a click (a category to set); `runSelected(call)`
//                  runs it as the bar's own actions run, and a string `call` resolves to is shown as the outcome.
//                  A column with `sortValue(entry)` (a string or number; '' or null when the row has none)
//                  sorts by it from its header; one whose cell shows several things lists them instead as
//                  `sortFields` [{ key, label, sortValue }], the first the default, and its header picks one.
//                  A column with neither does not sort. Define the functions once, outside the hook, so the
//                  sorted rows are not recomputed on every render
//   rowFilters     optional [{ key, label, title, test(entry) }] — pills after the kind pills that narrow
//                  the rows by something other than their kind; one is on at a time, alongside the kind
//   facets         optional [{ key, label, title, values(entry) → string[] }] — a labelled line of pills
//                  per facet, one per value present (an entry may carry several). Shown only when it has
//                  two or more values to choose between, since one pill narrows nothing. One value per
//                  facet is on at a time; facets, kind and row filter all apply together
// ctx carries `busy`, `run(call, failMessage)` (one action: clear the error, await, reload), `reload`,
// `openPicker` (the manual pairing window) and `reportError`. The dialog is keyed by vendor where it is
// mounted, since a vendor's hook must not change under a mounted dialog.
//
// Data (the payload), loading/error and reload are owned by ReconciliationViewerContext so the report
// survives route changes; this component makes the per-row calls, then asks the context to reload.
export function ReconciliationReportDialog({
  vendor: vendorKey,
  data,
  loading = false,
  error = '',
  onClose,
  onReload,
  onMinimize,
  stackIndex = 0,
  isTopmost = true,
}) {
  const vendor = RECONCILIATION_VENDORS[vendorKey]
  const report = RECONCILIATION_REPORTS[vendorKey]
  const [activeKind, setActiveKind] = useState(null)   // null = All; otherwise a vendor kind
  const [activeFilter, setActiveFilter] = useState(null) // null = none; otherwise a vendor rowFilters key
  const [activeFacets, setActiveFacets] = useState({})   // facet key → the selected value
  const [actionError, setActionError] = useState('')
  const [selectedIds, setSelectedIds] = useState(() => new Set())
  const [rowBusy, setRowBusy] = useState(false)
  const [pendingBulk, setPendingBulk] = useState(false)
  const [bulkNotice, setBulkNotice] = useState('')     // the last bulk action's outcome, when it has one to tell
  const [picker, setPicker] = useState(null)           // the open pairing window: { dialog, onConfirm, failMessage }
  const [picking, setPicking] = useState(false)
  // null keeps the default order: problems first, then by date within a kind.
  const [sortState, setSortState] = useUserPreference(vendor.sortPrefKey, null)

  // Floating, draggable, resizable panel chrome — non-modal so the user can go inspect a transaction
  // while the report stays open; geometry persists across opens, per vendor.
  const { initialPosition, initialSize, onGestureEnd } = useRestorablePanelGeometry(
    vendor.panelPrefKey, { fallbackWidth: 1180, fallbackHeight: 680 })
  const { pos, size, panelRef, onDragStart, onResizeStart } = useDetailPanelChrome(onClose, {
    forceFloating: true, stackIndex, initialPosition, initialSize, onGestureEnd,
  })

  const busy = rowBusy || picking || pendingBulk

  const run = useCallback(async (call, failMessage) => {
    setRowBusy(true)
    setActionError('')
    try {
      await call()
      onReload?.()
    } catch (e) {
      setActionError(e?.message || failMessage)
    } finally {
      setRowBusy(false)
    }
  }, [onReload])

  const openPicker = useCallback(({ onConfirm, failMessage, ...dialog }) => setPicker({ dialog, onConfirm, failMessage }), [])

  const confirmPicker = async (ids) => {
    if (!picker || !ids.length) return
    setPicking(true)
    setActionError('')
    try {
      await picker.onConfirm(ids)
      setPicker(null)
      onReload?.()
    } catch (e) {
      setActionError(e?.message || picker.failMessage)
    } finally {
      setPicking(false)
    }
  }

  const { columns, overlay, bulkControls } = vendor.useColumns({ data, busy, run, reload: onReload, openPicker, reportError: setActionError })

  // An acknowledged row no longer needs attention, so it drops the warn emphasis, reads muted, and carries
  // its green ✓ Reviewed status here in the Kind cell; the Undo lives with the row's actions.
  const kindRank = useCallback(entry => vendor.kinds[entry.kind].rank, [vendor])
  const kindColumn = { key: 'kind', label: 'Kind', width: 150, sortValue: kindRank, render: (entry) => {
    const meta = vendor.kinds[entry.kind]
    const handled = vendor.isAcknowledged(entry)
    const color = handled ? 'var(--muted)' : meta.warn ? 'var(--warning, #f59e0b)' : meta.review ? meta.stripe : 'var(--muted)'
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
        {/* The label wraps: a bucket named for the shape of its problem outgrows this column, and holding
            it on one line printed it under the next cell rather than clipping it. */}
        <span style={{ color, fontWeight: !handled && (meta.warn || meta.review) ? 600 : 400 }} title={meta.help}>
          {meta.label}
        </span>
        {handled ? (
          <span style={{ fontSize: 11, color: 'var(--success)', fontWeight: 600, whiteSpace: 'nowrap' }} title="Acknowledged — not counted toward the attention total">✓ Reviewed</span>
        ) : null}
      </div>
    )
  } }
  const allColumns = [kindColumn, ...columns].map(col => ({ ...col, sortable: !!(col.sortValue || col.sortFields?.length) }))
  const sortColumn = sortState ? allColumns.find(col => col.key === sortState.key && col.sortable) : null
  const sortValue = sortColumn?.sortFields
    ? (sortColumn.sortFields.find(f => f.key === sortState.field) || sortColumn.sortFields[0]).sortValue
    : sortColumn?.sortValue

  // The picked column decides; a row with nothing in it goes last either way, and ties keep the default
  // order, so sorting by a date column still reads problems first within one day.
  const entries = useMemo(() => {
    const kinds = vendor.kinds
    const byDefault = (a, b) => (kinds[a.kind].rank - kinds[b.kind].rank)
      || String(vendor.entryDate(a)).localeCompare(String(vendor.entryDate(b)))
    const built = vendor.buildEntries(data || {})
    if (!sortValue) return built.sort(byDefault)
    const dir = sortState.dir === 'desc' ? -1 : 1
    const blank = value => value == null || value === ''
    return built.sort((a, b) => {
      const av = sortValue(a); const bv = sortValue(b)
      if (blank(av) || blank(bv)) return (blank(av) - blank(bv)) || byDefault(a, b)
      if (av < bv) return -dir
      if (av > bv) return dir
      return byDefault(a, b)
    })
  }, [vendor, data, sortValue, sortState?.dir])
  // The pill flips the direction of what its column sorts by; the ▾ picks the field and starts it ascending.
  const toggleSort = (key) => setSortState(current => (current?.key === key
    ? { ...current, dir: current.dir === 'asc' ? 'desc' : 'asc' }
    : { key, dir: 'asc' }))
  const pickSortField = (key, field) => setSortState({ key, field, dir: 'asc' })

  const rowFilters = useMemo(() => vendor.rowFilters || [], [vendor])
  // Each facet's values with how many rows carry them, most common first. Counted over every row, as the
  // kind pills are, so a pill's number does not move as the other filters change.
  const facetLines = useMemo(() => (vendor.facets || []).map(facet => {
    const counts = new Map()
    for (const e of entries) for (const value of new Set(facet.values(e))) counts.set(value, (counts.get(value) || 0) + 1)
    const values = [...counts].map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
    return { facet, values }
  }), [vendor, entries])
  const visibleEntries = useMemo(() => {
    const filter = rowFilters.find(f => f.key === activeFilter)
    const facets = (vendor.facets || []).filter(f => activeFacets[f.key] != null)
    return entries.filter(e => (!activeKind || e.kind === activeKind) && (!filter || filter.test(e))
      && facets.every(f => f.values(e).includes(activeFacets[f.key])))
  }, [entries, activeKind, activeFilter, rowFilters, vendor, activeFacets])

  const allVisibleSelected = visibleEntries.length > 0 && visibleEntries.every(e => selectedIds.has(e.id))
  const someVisibleSelected = !allVisibleSelected && visibleEntries.some(e => selectedIds.has(e.id))
  const toggleEntry = (entry) => setSelectedIds(prev => {
    const next = new Set(prev)
    next.has(entry.id) ? next.delete(entry.id) : next.add(entry.id)
    return next
  })
  const toggleSelectAllVisible = () => setSelectedIds(prev => {
    const next = new Set(prev)
    if (visibleEntries.every(e => prev.has(e.id))) visibleEntries.forEach(e => next.delete(e.id))
    else visibleEntries.forEach(e => next.add(e.id))
    return next
  })

  // The intersection of bulk actions across the selected rows — each button shows its applicable count.
  const selectionSummary = useMemo(() => {
    const counts = Object.fromEntries(vendor.bulkActions.map(a => [a.key, 0]))
    let total = 0
    for (const e of visibleEntries) {
      if (!selectedIds.has(e.id)) continue
      total += 1
      const offered = vendor.rowActions(e)
      for (const key of Object.keys(counts)) if (offered[key]) counts[key] += 1
    }
    return { total, counts }
  }, [vendor, visibleEntries, selectedIds])

  // One bulk action over the selection: on success the selection clears and the report reloads. `call`
  // may resolve to a sentence about the outcome, shown until the next bulk action.
  const runSelected = async (call) => {
    setPendingBulk(true)
    setActionError('')
    setBulkNotice('')
    try {
      const notice = await call()
      setSelectedIds(new Set())
      if (typeof notice === 'string') setBulkNotice(notice)
      await onReload?.()
    } catch (e) {
      setActionError(e?.message || 'Bulk action failed')
    } finally {
      setPendingBulk(false)
    }
  }

  // Apply one action to every selected row that offers it. A vendor offers a bulk action only where each
  // row's call is independent of every other selected row's, so the calls can run in parallel.
  const runBulk = (action) => {
    const selected = visibleEntries.filter(e => selectedIds.has(e.id) && vendor.rowActions(e)[action])
    if (!selected.length) return
    return runSelected(async () => {
      await Promise.all(selected.map(entry => vendor.actionCall(action, entry)).filter(Boolean))
    })
  }

  // An "All" pill then one per non-empty kind, in rank order, colour-coded to its stripe.
  const kindPills = useMemo(() => {
    const counts = new Map()
    for (const e of entries) counts.set(e.kind, (counts.get(e.kind) || 0) + 1)
    return Object.keys(vendor.kinds)
      .sort((a, b) => vendor.kinds[a].rank - vendor.kinds[b].rank)
      .filter(kind => counts.get(kind) > 0)
      .map(kind => ({ kind, count: counts.get(kind) }))
  }, [vendor, entries])

  const dialogHeader = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, flex: 1 }}>
      <span onPointerDown={e => e.stopPropagation()} style={{ display: 'inline-flex', flexShrink: 0 }}>
        <FeatureExplainer topic={vendor.explainerTopic} placement="bottom-left" />
      </span>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1 }}>
        <div style={{ fontWeight: 600, fontSize: 15, display: 'flex', alignItems: 'center', gap: 8 }}>
          {report.title}
          {onReload ? (
            <RefreshButton onRefresh={onReload} loading={loading} disabled={busy}
              onPointerDown={e => e.stopPropagation()} />
          ) : null}
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)' }}>{vendor.subtitle}</div>
      </div>
      {onMinimize ? (
        <Button
          size="compact"
          variant="secondary"
          title="Minimize to nav bar (state is preserved — click the pill to restore)"
          onClick={onMinimize}
          onPointerDown={e => e.stopPropagation()}
        >– Minimize</Button>
      ) : null}
    </div>
  )

  return (
    <>
    <DetailPanelShell
      pos={pos}
      size={size}
      panelRef={panelRef}
      onDragStart={onDragStart}
      onResizeStart={onResizeStart}
      onClose={onClose}
      header={dialogHeader}
      isTopmost={isTopmost}
    >
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, margin: '-20px -24px', overflow: 'hidden' }}>
        <div style={{
          display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap',
          padding: '8px 16px', borderBottom: '1px solid var(--border)',
        }}>
          <span style={{ fontSize: 11, color: 'var(--muted)', flexShrink: 0 }}>Show:</span>
          <FilterChip selected={activeKind === null} count={entries.length} onClick={() => setActiveKind(null)} style={{ flexShrink: 0 }}>
            All
          </FilterChip>
          {kindPills.map(({ kind, count }) => {
            const meta = vendor.kinds[kind]
            const active = activeKind === kind
            const accent = meta.stripe
            return (
              <FilterChip
                key={kind}
                title={meta.help}
                selected={active}
                count={count}
                countTone={accent}
                onClick={() => setActiveKind(active ? null : kind)}
                style={{ flexShrink: 0 }}
              >
                {meta.label}
              </FilterChip>
            )
          })}
          {rowFilters.map(filter => {
            const count = entries.filter(filter.test).length
            if (!count && activeFilter !== filter.key) return null
            const active = activeFilter === filter.key
            return (
              <FilterChip
                key={filter.key}
                title={filter.title}
                selected={active}
                count={count}
                onClick={() => setActiveFilter(active ? null : filter.key)}
                style={{ flexShrink: 0, marginLeft: 8 }}
              >
                {filter.label}
              </FilterChip>
            )
          })}
        </div>
        {facetLines.map(({ facet, values }) => {
          const selected = activeFacets[facet.key]
          // A selected value stays offered even if it has gone from the rows, so it can be cleared.
          if (values.length < 2 && selected == null) return null
          const toggle = value => setActiveFacets(prev => ({ ...prev, [facet.key]: prev[facet.key] === value ? null : value }))
          return (
            <div key={facet.key} style={{
              display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap',
              padding: '6px 16px', borderBottom: '1px solid var(--border)',
            }}>
              <span style={{ fontSize: 11, color: 'var(--muted)', flexShrink: 0 }} title={facet.title}>{facet.label}:</span>
              {values.map(({ value, count }) => (
                <FilterChip key={value} selected={selected === value} count={count}
                  onClick={() => toggle(value)} style={{ flexShrink: 0 }}>
                  {value}
                </FilterChip>
              ))}
            </div>
          )
        })}
        {selectionSummary.total > 0 ? (
          <div style={{
            display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap',
            padding: '6px 16px', borderBottom: '1px solid var(--border)',
            background: 'color-mix(in srgb, var(--accent) 7%, var(--surface2))',
          }}>
            <span style={{ fontSize: 11, color: 'var(--muted)', flexShrink: 0 }}>{selectionSummary.total} selected:</span>
            {vendor.bulkActions.map(action => (
              <Button key={action.key} variant="secondary" size="compact"
                disabled={pendingBulk || selectionSummary.counts[action.key] === 0}
                onClick={() => runBulk(action.key)} title={action.title}>
                {action.label} ({selectionSummary.counts[action.key]})
              </Button>
            ))}
            {bulkControls?.({
              selected: visibleEntries.filter(e => selectedIds.has(e.id)),
              disabled: pendingBulk,
              runSelected,
            })}
            <span style={{ flex: 1 }} />
            <Button variant="secondary" size="compact" disabled={pendingBulk} onClick={() => setSelectedIds(new Set())}>
              Clear
            </Button>
          </div>
        ) : bulkNotice ? (
          <div style={{
            display: 'flex', gap: 6, alignItems: 'center',
            padding: '6px 16px', borderBottom: '1px solid var(--border)', fontSize: 12, color: 'var(--muted)',
          }}>
            <span style={{ flex: 1 }}>{bulkNotice}</span>
            <Button variant="secondary" size="compact" onClick={() => setBulkNotice('')}>Dismiss</Button>
          </div>
        ) : null}
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <MatchReport
            columnsPrefKey={vendor.columnsPrefKey}
            columns={allColumns}
            sortState={sortColumn ? sortState : null}
            onHeaderClick={toggleSort}
            onSortField={pickSortField}
            entries={visibleEntries}
            getRowId={(entry) => entry.id}
            getRowStripe={(entry) => (vendor.isAcknowledged(entry)
              ? 'color-mix(in srgb, var(--success) 40%, var(--border))'
              : vendor.kinds[entry.kind].stripe)}
            selectable
            selectedIds={selectedIds}
            onToggleRow={toggleEntry}
            onToggleAll={toggleSelectAllVisible}
            allVisibleSelected={allVisibleSelected}
            someVisibleSelected={someVisibleSelected}
            loading={loading}
            error={error || actionError}
            emptyMessage={entries.length === 0 ? vendor.emptyMessage : 'No rows for this filter.'}
          />
        </div>
      </div>
    </DetailPanelShell>
    {picker ? (
      <ChargePickerDialog
        {...picker.dialog}
        busy={picking}
        onCancel={() => setPicker(null)}
        onConfirm={confirmPicker}
      />
    ) : null}
    {overlay}
    </>
  )
}
