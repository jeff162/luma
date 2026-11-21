// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * Recurring series review. An on-demand Scan runs detection (services/recurring_detection.py) and
 * rebuilds the auto-detected series; the user then curates: Confirm accepts a detection, Suppress
 * rejects it as "not recurring" (and stops it being re-proposed), and the cadence picker corrects a
 * misjudged rhythm. "Add manually" declares a series the detector missed, seeded from a transaction.
 *
 * Confirm/suppress/edit all mark a series user-owned so the next Scan preserves the decision — the
 * page's whole job is turning the detector's guesses into a curated list.
 *
 * Above that list sits the signal review section (`RecurringSignals`): what is missing, what changed
 * price, what was just detected, and which rule's amount range a charge has drifted out of — plus the
 * forward view of what is due next. Signals are derived server-side on every read, so the page never
 * patches one in place: any action that could change a finding re-fetches the whole set.
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api } from '../lib/api.js'
import { useOwnerLens } from '../lib/OwnerLensContext.jsx'
import { ownerLensAdmits } from '../lib/ownerLens.js'
import RuleActionModal from '../components/RuleActionModal.jsx'
import {
  PageHeader, Spinner, Button, Select, Input, SearchInput, EmptyState, AppDialog, AppConfirmDialog, SegmentedToggle,
  RefreshButton, FilterChip, IconButton, LinkButton, PencilGlyph} from '../components/ui.jsx'
import TransactionListTable from '../components/TransactionListTable.jsx'
import TransactionDetail from '../components/TransactionDetail.jsx'
import { RecurringSignalsView, RecurringUpcomingView, ResolvedFindingsDialog } from '../components/RecurringSignals.jsx'
import { priceChangeBand, signalTarget } from '../lib/recurringSignals.js'
import RecurringAmountMatchDialog from '../components/RecurringAmountMatchDialog.jsx'
import SplitButton from '../components/SplitButton.jsx'
import { UndoToast } from '../components/CategoryTreePrimitives.jsx'
import { usePagedTransactions } from '../components/detailShared.jsx'
import { getTxnMerchantLabel } from '../components/TransactionRow.jsx'
import ContextualExplainer from '../help/ContextualExplainer.jsx'
import FeatureExplainer from '../help/FeatureExplainer.jsx'
import TransientTextInput from '../components/TransientTextInput.jsx'
import { useUserPreference } from '../lib/UserPreferencesContext.jsx'
import { makeRowReconciler, applyCategoryChange } from '../lib/txnMutations.js'
import { useAfterLedgerChange } from '../contexts/SyncStatusContext.jsx'
import { formatCurrency, formatDate } from '../lib/utils.js'
import { getTransactionAmountColor } from '../lib/moneyDisplay.js'
import { sessionStore } from '../lib/browserStorage.js'

const CADENCE_LABELS = {
  weekly: 'Weekly',
  biweekly: 'Every 2 weeks',
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  semiannual: 'Every 6 months',
  annual: 'Annually',
}
const CADENCE_OPTIONS = Object.entries(CADENCE_LABELS).map(([value, label]) => ({ value, label }))

// Disposition actions that change how a series is characterized — pressing one collapses an open
// drill-down (the user has decided). A cadence edit is deliberately excluded (a tweak, not a decision).
const CHARACTERIZATION_ACTIONS = new Set(['confirm', 'unconfirm', 'suppress', 'end', 'restore', 'delete'])

const STATUS_META = {
  suppressed: { label: 'Suppressed', color: 'var(--muted)' },
  ended: { label: 'Ended', color: 'var(--muted)' },
  manual: { label: 'Manual', color: 'var(--accent2)' },
  confirmed: { label: 'Confirmed', color: 'var(--success, #16a34a)' },
  detected: { label: 'Suggested', color: 'var(--warning)' },
}

function statusKey(series) {
  if (series.status === 'suppressed') return 'suppressed'
  if (series.status === 'ended') return 'ended'
  if (series.source === 'manual') return 'manual'
  if (series.confirmed) return 'confirmed'
  return 'detected'
}

const CATEGORY_ORDER = ['suggested', 'confirmed', 'ended', 'suppressed']
const CATEGORY_LABELS = { suggested: 'Suggested', confirmed: 'Confirmed', ended: 'Ended', suppressed: 'Suppressed' }

// Which filter section a series belongs to. Coarser than the badge's statusKey: a manual series and a
// confirmed auto-detection both live under "confirmed".
function seriesCategory(series) {
  const key = statusKey(series)
  if (key === 'detected') return 'suggested'
  if (key === 'manual') return 'confirmed'
  return key  // confirmed | ended | suppressed
}

// The page's three peer views. Findings and the series they refer to were originally stacked on one
// screen, where they crowded each other out; they are now chosen between. `sessionStorage` remembers the
// choice for the session (matching the Accounts/Import tab convention) while a URL param — the
// Tasks page's `?signal=<kind>` link — wins over it, so a deep link lands where it means to.
const VIEW_SERIES = 'series'
const VIEW_SIGNALS = 'signals'
const VIEW_UPCOMING = 'upcoming'
const VIEW_IDS = [VIEW_SERIES, VIEW_SIGNALS, VIEW_UPCOMING]
const VIEW_STORAGE_KEY = 'ui.recurring.view'

// The page's content column. Named once because it is measured in three places — the header, the
// scrolling body and the drill-down — and three copies of a number are three chances to disagree.
const PAGE_COLUMN = 860

const SORT_OPTIONS = [{ value: 'name', label: 'A–Z' }, { value: 'next_due', label: 'Next due' }]
const DEFAULT_FILTERS = ['suggested', 'confirmed', 'ended']

// Synthetic openSeries id for the all-series report (every row linked to any series). Not a real
// series id, so no SeriesCard ever matches it and the removed-rows section stays series-specific.
const ALL_RECURRING_ID = '__all_recurring__'

// Status is the primary sort key (the sections); this is the secondary key within each section.
function seriesComparator(sortOrder) {
  const byName = (a, b) => String(a.display_name || '').localeCompare(String(b.display_name || ''))
  if (sortOrder === 'next_due') {
    return (a, b) => {
      const ad = a.next_due_date || '', bd = b.next_due_date || ''
      if (ad && bd) return ad.localeCompare(bd) || byName(a, b)  // soonest first; nulls sort last
      if (ad) return -1
      if (bd) return 1
      return byName(a, b)
    }
  }
  return byName
}

// A frozen view snapshot: per-category counts plus the ordered, grouped card layout (section ids in
// CATEGORY_ORDER). Recomputed only on deliberate re-sort triggers (load, scan, filter/sort change) — NOT
// on an in-place status change from a card action, so acting on a card never makes it jump until the
// next natural refresh. Within a section the chosen order is the only one: money-movement series sort in
// among the bills, marked by their badge. They once clustered after the bills to keep a transfer's two
// legs adjacent, which stopped meaning anything when a pair became one series owning both legs — and it
// read as those series having been left out of the order.
function orderBucket(items, sortOrder) {
  return [...items].sort(seriesComparator(sortOrder)).map(s => s.id)
}

const lensedSeries = (list, lens) => list.filter(s => ownerLensAdmits(s.owner_ids, lens))

function buildLayout(list, selected, sortOrder) {
  const counts = { suggested: 0, confirmed: 0, ended: 0, suppressed: 0 }
  const buckets = { suggested: [], confirmed: [], ended: [], suppressed: [] }
  for (const s of list) {
    const cat = seriesCategory(s)
    counts[cat] += 1
    buckets[cat].push(s)
  }
  const sections = CATEGORY_ORDER
    .filter(cat => selected.has(cat) && buckets[cat].length > 0)
    .map(cat => ({ key: cat, label: CATEGORY_LABELS[cat], count: buckets[cat].length, ids: orderBucket(buckets[cat], sortOrder) }))
  return { counts, sections }
}

// The "Not recurring" split button on detected cards: the main action rejects the detection, and the
// caret offers "Mark canceled" (ended) for a series that was real but has stopped.
function NotRecurringSplit({ onSuppress, onEnd }) {
  return (
    <SplitButton
      onClick={onSuppress}
      menuLabel="More options"
      menuItems={[{ label: 'Mark canceled', onClick: onEnd }]}
    >
      Not recurring
    </SplitButton>
  )
}

function StatusBadge({ series }) {
  const meta = STATUS_META[statusKey(series)]
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5, fontWeight: 600, color: meta.color }}>
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: meta.color, flexShrink: 0 }} />
      {meta.label}
    </span>
  )
}

function AmountDisplay({ series }) {
  // A paired movement carries a magnitude and shows its direction as the from → to block below, so
  // the in/out word is dropped: money leaving one of the user's own accounts for another is neither.
  const direction = series.counterpart_account_id ? '' : ((series.expected_amount ?? 0) >= 0 ? 'out' : 'in')
  const variable = series.amount_min != null && series.amount_max != null
    && Math.abs(series.amount_max - series.amount_min) > 0.005
  return (
    <span style={{ fontSize: 17, fontWeight: 700, letterSpacing: '-0.01em', color: getTransactionAmountColor(series.expected_amount) }}>
      {variable ? '~' : ''}{formatCurrency(series.expected_amount)}
      <span style={{ color: 'var(--muted)', fontWeight: 500, marginLeft: 5, fontSize: 12 }}>{direction}</span>
    </span>
  )
}

// The two accounts one movement of money runs between, in place of the single account line a one-legged
// series shows. The receiving leg's own descriptor is named only when it differs from the card's title —
// the two banks routinely word the same payment differently ("WDRL … ONLINE PMT" against "ELECTRONIC
// PAYMENT RECEIVED"), and dropping it would leave the card claiming a name that appears on neither
// statement.
function TransferLegs({ series }) {
  if (!series.counterpart_account_id) return null
  const moves = series.transfer_count
  return (
    <div
      style={{ marginTop: 6, fontSize: 12.5 }}
      title={moves ? `${moves} movement${moves === 1 ? '' : 's'}, each recorded once in either account` : undefined}
    >
      <div>{series.account_name || 'Unknown account'}</div>
      <div style={{ paddingLeft: 13, display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' }}>
        <span style={{ color: 'var(--muted)' }} aria-hidden="true">↳</span>
        <span>{series.counterpart_account_name || 'Unknown account'}</span>
      </div>
    </div>
  )
}

function SeriesCard({ series, onAction, onOpenReport, onEditRule, active }) {
  const ruleBacked = series.source === 'rule' && series.rule_id
  const [hover, setHover] = useState(false)
  const [editingName, setEditingName] = useState(false)
  const [nameDraft, setNameDraft] = useState(series.display_name || '')
  const startRename = () => { setNameDraft(series.display_name || ''); setEditingName(true) }
  const commitName = () => {
    const v = (nameDraft || '').trim()
    setEditingName(false)
    if (v && v !== series.display_name) onAction('rename', series, v)
  }
  const suppressed = series.status === 'suppressed'
  const ended = series.status === 'ended'
  const dormant = suppressed || ended
  const detected = series.source !== 'manual' && !series.confirmed && !suppressed && !ended
  const accent = STATUS_META[statusKey(series)].color
  const canOpen = series.occurrence_count > 0
  const variable = series.amount_min != null && series.amount_max != null
    && Math.abs(series.amount_max - series.amount_min) > 0.005

  return (
    <div
      data-series-id={series.id}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        position: 'relative',
        borderRadius: 14,
        border: `1px solid ${active ? 'color-mix(in srgb, var(--accent) 45%, var(--border))' : 'color-mix(in srgb, var(--border) 80%, transparent)'}`,
        background: 'var(--surface)',
        padding: '15px 18px 15px 20px',
        marginBottom: 10,
        opacity: dormant ? 0.72 : 1,
        boxShadow: active
          ? '0 6px 22px rgba(0,0,0,0.12)'
          : hover ? '0 5px 18px rgba(0,0,0,0.09)' : '0 1px 2px rgba(0,0,0,0.04)',
        transform: hover && !active ? 'translateY(-1px)' : 'none',
        transition: 'box-shadow 0.16s, transform 0.16s, border-color 0.16s',
        // No overflow:hidden — it would clip the "Not recurring" caret menu. The hover transform makes
        // this card a stacking context, so lift it above later cards while hovered so an open menu
        // (and the card's own shadow) render over the following card instead of behind it.
        zIndex: hover ? 30 : undefined,
      }}
    >
      {/* Soft status accent along the left edge — a hint of color without a boxy chip. Inset past the
          14px corner radius so its square ends stay clear of the card's rounded corners. */}
      <span style={{ position: 'absolute', left: 0, top: 14, bottom: 14, width: 3, borderRadius: 3, background: `color-mix(in srgb, ${accent} 60%, transparent)` }} />

      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 260px', minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5, minWidth: 0 }}>
            {editingName ? (
              <TransientTextInput
                value={nameDraft}
                onChange={setNameDraft}
                onCommit={commitName}
                onCancel={() => setEditingName(false)}
                restoreOnEscape
                aria-label="Series name"
                style={{
                  fontSize: 15, fontWeight: 650, padding: '2px 6px', borderRadius: 6, minWidth: 200,
                  border: '1px solid var(--border)', background: 'var(--surface2)', color: 'var(--text)',
                }}
              />
            ) : (
              <>
                <span style={{ fontSize: 15.5, fontWeight: 650 }}>{series.display_name}</span>
                <IconButton
                  size="compact"
                  onClick={startRename}
                  aria-label="Rename series"
                  title="Rename"
                  style={{ opacity: hover ? 0.7 : 0, transition: 'opacity 0.15s' }}
                >
                  <PencilGlyph />
                </IconButton>
              </>
            )}
            <StatusBadge series={series} />
            {series.money_movement && (
              <span
                title="Money movement — a transfer or card payment, excluded from spending totals"
                style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', display: 'inline-flex', alignItems: 'center', gap: 3 }}
              >
                ⊘ money movement
              </span>
            )}
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
            <span>{series.category_name || 'Uncategorized'}</span>
            {ruleBacked ? <><span style={{ opacity: 0.5 }}>·</span><span title="Membership is defined by a rule — edit the rule to change which transactions belong">rule-based</span></> : null}
            {series.account_name && !series.counterpart_account_id
              ? <><span style={{ opacity: 0.5 }}>·</span><span>{series.account_name}</span></> : null}
            <span style={{ opacity: 0.5 }}>·</span>
            {canOpen ? (
              <LinkButton
                onClick={() => onOpenReport(series)}
                style={{ fontSize: 12.5, fontWeight: 600, textDecoration: active ? 'underline' : undefined }}
              >
                {series.occurrence_count} transaction{series.occurrence_count === 1 ? '' : 's'}
              </LinkButton>
            ) : (
              <span>{series.occurrence_count} transactions</span>
            )}
            {detected && series.confidence != null ? (
              <><span style={{ opacity: 0.5 }}>·</span><span>{Math.round(series.confidence * 100)}% match</span></>
            ) : null}
          </div>
          <TransferLegs series={series} />
        </div>
        <div style={{ flex: '0 0 auto', textAlign: 'right' }}>
          <AmountDisplay series={series} />
          <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 3 }}>
            {CADENCE_LABELS[series.cadence] || series.cadence}
            {series.last_txn_date ? <span style={{ opacity: 0.85 }}> · last {formatDate(series.last_txn_date)}</span> : null}
            {series.next_due_date ? <span style={{ opacity: 0.85 }}> · next ~{formatDate(series.next_due_date)}</span> : null}
          </div>
          {variable ? (
            <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 1 }}>
              {formatCurrency(series.amount_min)}–{formatCurrency(series.amount_max)}
            </div>
          ) : null}
          {series.amount_mode === 'fixed' ? (
            <div
              title={series.expected_min != null
                ? `Only charges near ${formatCurrency(series.expected_min)}–${formatCurrency(series.expected_max)} belong to this series`
                : 'Only charges near this amount belong to this series'}
              style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 1 }}
            >
              matched by amount{series.expected_min != null ? ' · set' : ''}
            </div>
          ) : null}
        </div>
      </div>

      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, marginTop: 13, paddingTop: 12,
        borderTop: '1px solid color-mix(in srgb, var(--border) 60%, transparent)', flexWrap: 'wrap',
      }}>
        {dormant ? (
          <>
            {ended && series.next_due_date ? (
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>Kept for history · resumes if it recurs again</span>
            ) : null}
            <span style={{ flex: 1 }} />
            <Button size="compact" variant="secondary" onClick={() => onAction('restore', series)}>{ended ? 'Reactivate' : 'Restore'}</Button>
            <Button size="compact" variant="secondary" tone="danger" onClick={() => onAction('delete', series)}>Delete</Button>
          </>
        ) : (
          <>
            <span style={{ fontSize: 12.5, color: 'var(--muted)', display: 'inline-flex', alignItems: 'center', gap: 7 }}>
              Cadence
              <Select
                value={series.cadence}
                onChange={(v) => onAction('cadence', series, v)}
                options={CADENCE_OPTIONS}
                style={{
                  minWidth: 112, padding: '3px 6px', fontSize: 12, borderRadius: 6,
                  border: '1px solid color-mix(in srgb, var(--border) 70%, transparent)',
                }}
                aria-label="Cadence"
              />
            </span>
            {ruleBacked ? null : (
              <Button size="compact" variant="secondary" onClick={() => onAction('amountMatch', series)}>
                Amount{series.amount_mode === 'fixed' ? ' ✓' : ''}
              </Button>
            )}
            <span style={{ flex: 1 }} />
            {detected ? (
              <>
                <NotRecurringSplit
                  onSuppress={() => onAction('suppress', series)}
                  onEnd={() => onAction('end', series)}
                />
                <Button size="compact" onClick={() => onAction('confirm', series)}>Confirm</Button>
              </>
            ) : (
              <>
                {ruleBacked ? <Button size="compact" variant="secondary" onClick={() => onEditRule(series)}>Edit rule</Button> : null}
                {/* Only an auto series has a detector pile to go back to; the other two sources are
                    undone where they were declared (delete, or the rule's own checkbox). */}
                {series.source === 'auto' && !dormant ? (
                  <Button size="compact" variant="secondary" onClick={() => onAction('unconfirm', series)}>Back to suggested</Button>
                ) : null}
                <Button size="compact" variant="secondary" onClick={() => onAction('suppress', series)}>Not recurring</Button>
                <Button size="compact" variant="secondary" onClick={() => onAction('end', series)}>Mark ended</Button>
                <Button size="compact" variant="secondary" tone="danger" onClick={() => onAction('delete', series)}>Delete</Button>
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}

// A collapsed list of transactions the user removed from this series (an 'excluded' override). It is the
// durable counterpart to the removal toast: a mistake noticed later is recoverable here, each with an
// "Add back" that clears the override so the row re-matches and rejoins on the next scan.
function RemovedSection({ excluded, onAddBack }) {
  const [open, setOpen] = useState(false)
  if (!excluded || excluded.length === 0) return null
  return (
    <div style={{ flexShrink: 0, borderTop: '1px solid var(--border)', marginTop: 8, paddingTop: 8 }}>
      <button
        onClick={() => setOpen(v => !v)}
        style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', fontSize: 12, fontWeight: 600, padding: '2px 0', display: 'inline-flex', alignItems: 'center', gap: 6 }}
      >
        <span style={{ fontSize: 9 }}>{open ? '▾' : '▸'}</span>
        {excluded.length} removed from this series
      </button>
      {open ? (
        <div style={{ maxHeight: 168, overflowY: 'auto', marginTop: 6 }}>
          {excluded.map(txn => (
            <div key={txn.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '6px 2px', borderBottom: '1px solid color-mix(in srgb, var(--border) 60%, transparent)' }}>
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13 }}>
                {getTxnMerchantLabel(txn)}
              </span>
              <span style={{ color: 'var(--muted)', fontSize: 12, flexShrink: 0 }}>
                {formatDate(txn.date)} · {formatCurrency(txn.amount)}
              </span>
              <Button size="compact" variant="secondary" onClick={() => onAddBack(txn)} style={{ flexShrink: 0 }}>
                Add back
              </Button>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

// The drill-down uses the shared TransactionListTable (pill header, shared row cells + row menu), so it
// looks and edits exactly like every other transaction list in the app rather than being a one-off.
// The drill-down's surface spans the page (its own background and top border make it a distinct
// docked panel), but its *content* sits in the same column as the list above — otherwise the panel's
// title and table start at the page edge while the cards start at the column, and the page reads as
// three different left margins stacked on each other.
function ReportPanel({ series, rows, excluded, total, categories, loading, onClose, onCategorySave, onRowsChange, onOpenTxnDetail, onTrashed, onAddBack, onMembershipChange, paging, sortState, onSort }) {
  // The column goes on an element *inside* the padding, never on the padded element itself — putting a
  // maxWidth on a padded box measures the column inside the padding and shifts it by that amount.
  const column = { maxWidth: PAGE_COLUMN, margin: '0 auto', width: '100%' }
  return (
    <div style={{
      flex: '1 1 0%', minHeight: 0, display: 'flex', flexDirection: 'column',
      borderTop: '1px solid var(--border)', background: 'var(--surface2)',
    }}>
      {/* The divider spans the panel; the title inside it sits in the page column. */}
      <div style={{ flexShrink: 0, padding: '12px 32px', borderBottom: '1px solid var(--border)' }}>
        <div style={{ ...column, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 650, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {series.display_name}
            </div>
            <div style={{ fontSize: 12, color: 'var(--muted)' }}>
              {loading ? 'Loading…' : `${total} matching transaction${total === 1 ? '' : 's'}`}
            </div>
          </div>
          <IconButton size="large" onClick={onClose} aria-label="Close matching transactions">
            ×
          </IconButton>
        </div>
      </div>
      {/* Both boxes stay flex columns so the table's fillHeight still resolves against the panel. */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', padding: '0 32px 20px' }}>
        <div style={{ ...column, flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {loading && rows.length === 0 ? (
          <Spinner />
        ) : (
          <TransactionListTable
            rows={rows}
            categories={categories}
            fillHeight
            onCategorySave={onCategorySave}
            onTransactionOpenDetail={onOpenTxnDetail}
            onRowsChange={onRowsChange}
            onTrashed={onTrashed}
            onMembershipChange={onMembershipChange}
            showMerchantReport={false}
            emptyMessage="No linked transactions. Run a scan to (re)link matches."
            paging={paging}
            sortState={sortState}
            onSort={onSort}
          />
        )}
        <RemovedSection excluded={excluded} onAddBack={onAddBack} />
        </div>
      </div>
    </div>
  )
}

function ManualAddDialog({ onClose, onCreated }) {
  const [term, setTerm] = useState('')
  const [results, setResults] = useState([])
  const [searching, setSearching] = useState(false)
  const [searchedTerm, setSearchedTerm] = useState('')  // the term the current results reflect ('' = no search has run)
  const [selected, setSelected] = useState(null)
  const [cadence, setCadence] = useState('monthly')
  const [saving, setSaving] = useState(false)
  const reqRef = useRef(0)

  // Search as the user types (debounced) so there's no hidden "press Search" step — the previous panel
  // showed "No matching transactions" the instant a character was typed, before any search had run, which
  // read as broken. A per-request token guards against a slow earlier response landing after a newer one.
  useEffect(() => {
    const q = term.trim()
    if (!q) { setResults([]); setSearchedTerm(''); setSearching(false); return undefined }
    setSearching(true)
    const token = ++reqRef.current
    const handle = setTimeout(() => {
      api.getTransactions({ search: q, limit: 20 })
        .then(r => { if (token === reqRef.current) { setResults(r.transactions || []); setSearchedTerm(q); setSearching(false) } })
        .catch(() => { if (token === reqRef.current) { setResults([]); setSearchedTerm(q); setSearching(false) } })
    }, 250)
    return () => clearTimeout(handle)
  }, [term])

  async function create() {
    if (!selected) return
    setSaving(true)
    try {
      await api.createRecurring({ transaction_id: selected.id, cadence })
      onCreated()
    } finally {
      setSaving(false)
    }
  }

  const trimmed = term.trim()
  // "Still resolving" covers both the in-flight fetch and the debounce gap before it (term typed but the
  // results don't yet reflect it), so the zero-results message can never flash while a search is pending.
  const resolving = searching || (trimmed && searchedTerm !== trimmed)
  const anchorLabel = selected ? (selected.display_name || selected.merchant_name || selected.raw_name) : null

  return (
    <AppDialog
      title="Add a recurring series"
      onClose={onClose}
      width="min(520px, 100%)"
      actions={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!selected || saving} onClick={create}>
            {saving ? 'Adding…' : 'Add series'}
          </Button>
        </>
      }
    >
      <div style={{ padding: '4px 2px' }}>
        <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 12 }}>
          Pick one transaction as the <b style={{ color: 'var(--text)' }}>anchor</b> — its payee, category,
          and amount seed the series, and every matching transaction is linked immediately. Then choose how
          often it recurs.
        </div>
        <div style={{ marginBottom: 12 }}>
          <Input
            value={term}
            onChange={setTerm}
            placeholder="Search by payee…"
            aria-label="Search transactions by payee"
            style={{ width: '100%' }}
            autoFocus
          />
        </div>
        <div style={{ maxHeight: 260, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 8 }}>
          {resolving ? (
            <div style={{ padding: 16 }}><Spinner /></div>
          ) : results.length === 0 ? (
            <div style={{ padding: 16, fontSize: 13, color: 'var(--muted)' }}>
              {trimmed ? `No transactions match "${trimmed}".` : 'Type a payee name to find an anchor transaction.'}
            </div>
          ) : results.map(txn => {
            const isSel = selected?.id === txn.id
            const name = txn.display_name || txn.merchant_name || txn.raw_name
            return (
              <div
                key={txn.id}
                onClick={() => setSelected(txn)}
                style={{
                  padding: '9px 12px', cursor: 'pointer', display: 'flex', justifyContent: 'space-between',
                  gap: 12, borderBottom: '1px solid var(--border)',
                  background: isSel ? 'color-mix(in srgb, var(--accent) 12%, var(--surface))' : 'transparent',
                }}
              >
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</div>
                  <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <span>{txn.category_name || 'Uncategorized'}</span>
                    {txn.recurring_series_id ? (
                      <span style={{ color: 'var(--accent2)' }} title="Already part of a recurring series">· ↻ already in a series</span>
                    ) : null}
                  </div>
                </div>
                <span style={{ color: 'var(--muted)', fontSize: 12.5, flexShrink: 0, textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {formatDate(txn.date)}<br />{formatCurrency(txn.amount)}
                </span>
              </div>
            )
          })}
        </div>
        {selected ? (
          <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 12 }}>
            New series from <b style={{ color: 'var(--text)' }}>{anchorLabel}</b>
            {' · '}{selected.category_name || 'Uncategorized'}
            {' · '}{formatCurrency(selected.amount)}
          </div>
        ) : null}
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 14, fontSize: 13 }}>
          Recurs
          <Select value={cadence} onChange={setCadence} options={CADENCE_OPTIONS} style={{ minWidth: 150 }} aria-label="Recurrence cadence" />
        </span>
      </div>
    </AppDialog>
  )
}

function FilterPill({ label, count, on, onClick }) {
  return <FilterChip selected={on} count={count} onClick={onClick}>{label}</FilterChip>
}

// Ends the status pills. Nothing selected shows nothing, so picking one status would otherwise mean unticking
// each of the others. It stays in place and does nothing when nothing is selected, so the row does not shift
// as it comes and goes.
function DeselectAllPill({ disabled, onClick }) {
  return (
    <Button
      size="compact"
      variant="quiet"
      onClick={disabled ? undefined : onClick}
      aria-disabled={disabled || undefined}
      title={disabled ? 'No statuses are selected' : 'Deselect every status'}
      style={{ opacity: disabled ? 0.45 : 1 }}
    >
      Deselect all
    </Button>
  )
}

// Secondary-sort toggle (status stays the primary key). Small segmented control near the pills.
function SortToggle({ value, onChange }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--muted)' }}>
      Sort
      <SegmentedToggle size="compact" ariaLabel="Sort" value={value} onChange={onChange} options={SORT_OPTIONS} />
    </span>
  )
}

export default function Recurring() {
  const [allSeries, setAllSeries] = useState(null)  // full data; updated in place on card actions
  // Filter selection and sort order are per-user preferences (remembered across sessions).
  const [filterList, setFilterList] = useUserPreference('ui.recurring.filters', DEFAULT_FILTERS)
  const [sortOrder, setSortOrder] = useUserPreference('ui.recurring.sort', 'name')
  const [search, setSearch] = useState('')  // transient, not persisted
  const selected = useMemo(
    () => new Set(Array.isArray(filterList) ? filterList : DEFAULT_FILTERS),
    [filterList],
  )
  const [layout, setLayout] = useState(null)        // frozen snapshot: { counts, sections } (see buildLayout)
  const [scanning, setScanning] = useState(false)
  const [scanSummary, setScanSummary] = useState(null)
  const [adding, setAdding] = useState(false)
  const [categories, setCategories] = useState([])
  // The bottom drill-down. The member list pages through the shared usePagedTransactions (server-side
  // sort, no fetch cap) so a high-frequency series with hundreds of occurrences isn't truncated at 500;
  // the removed-from-series rows are a small user-curated set fetched alongside. `refreshReport` re-fetches
  // both for the same open series (e.g. after a scan shifts membership); `reportNonce` is what the removals
  // fetch keys on, and the members reload through `usePagedTransactions().reload`, which keeps the reader's place.
  const [openSeries, setOpenSeries] = useState(null)
  const [reportNonce, setReportNonce] = useState(0)
  const [excluded, setExcluded] = useState([])
  const [payeeDetail, setPayeeDetail] = useState(null)  // txn opened in the shared TransactionDetail panel
  const [ruleModal, setRuleModal] = useState(null)  // { mode:'edit', ruleId } for a rule-backed series
  const [amountMatchSeries, setAmountMatchSeries] = useState(null)  // series whose amount matching is being edited
  const [deleteTarget, setDeleteTarget] = useState(null)            // series awaiting delete confirmation
  const [amountMatchSuggestion, setAmountMatchSuggestion] = useState(null)  // a band proposed by a price-change finding
  const [searchParams, setSearchParams] = useSearchParams()
  // Signals are derived server-side; the page holds only the last fetch and what the user is looking at.
  const [signalData, setSignalData] = useState(null)
  const [signalKind, setSignalKind] = useState('all')
  const [view, setViewState] = useState(() => {
    const stored = sessionStore.get(VIEW_STORAGE_KEY)
    return VIEW_IDS.includes(stored) ? stored : VIEW_SERIES
  })
  const [resolvedSignals, setResolvedSignals] = useState(null)    // dismissed signals; null = resolved list closed
  const [signalUndo, setSignalUndo] = useState(null)              // { key, kind } of the last dismissal
  const [excludeUndo, setExcludeUndo] = useState(null)            // the charge a finding last excluded from its series
  const [confirmUndo, setConfirmUndo] = useState(null)            // { id, name } of the last accepted series
  // Transfers the scan would not pair because two transactions match equally well (`ambiguous`), and the
  // answers already given (`resolved`). Shown in *Needs attention* and its resolved list.
  const [transferReview, setTransferReview] = useState(null)
  const [tieBusyId, setTieBusyId] = useState(null)
  const [tieUndo, setTieUndo] = useState(null)                    // the transfer answer last given

  // The owner lens keeps the series holding a lens owner's rows (`lib/ownerLens.js`). It narrows what the
  // layout is built from, so the status counts and sections agree with the cards shown, and the
  // all-series report. A single series' report is left whole, because its count is a fact about the series.
  const { lens: ownerLens, params: ownerLensParams } = useOwnerLens()

  // The drill-down serves two shapes through one paged list: a single series (recurring_series_id) and
  // the all-series report (recurring_only — every row linked to any series). The second is flagged by a
  // synthetic marker on `openSeries` rather than a separate panel, so both land in the same report with
  // the same row editing.
  const membersLoadPage = useCallback((offset, limit, sort) => {
    const base = { limit, offset, sort_by: sort.key, sort_dir: sort.dir }
    if (openSeries?._all) return api.getTransactions({ recurring_only: true, ...ownerLensParams, ...base })
    // A suppressed series owns no rows: suppress nulls their `recurring_series_id`, because that column
    // is the app-wide "is recurring" flag and a rejected series must not light up the ↻ marker or the
    // recurring filter. So the rows it was about have to come from somewhere else.
    //
    // The snapshot taken at suppression is that somewhere, and it is exact — the same rows the count
    // beside the link was computed from. Matching is the fallback, not the plan: membership is the
    // detector's judgement (a rhythm fit over one charge per date) and no predicate restates it.
    if (openSeries?.status === 'suppressed') {
      if (openSeries.suppressed_member_ids?.length) {
        return api.getTransactions({ ids: openSeries.suppressed_member_ids.join(','), ...base })
      }
      // Suppressed before the snapshot existed. Match on the series' whole identity rather than its
      // payee alone — category and account scope are what it was detected *as*, and dropping them was
      // why one of these listed eleven rows for a three-charge series, most of them unrelated business
      // with the same counterparty. The amount band is deliberately left out: it discriminates two
      // price points of one payee, which is a question about which series a row joins, not about which
      // rows this series concerns. The count reconciles to whatever this returns.
      return api.getTransactions({
        payees: openSeries.display_name,
        category_ids: openSeries.category_id || undefined,
        account_ids: openSeries.account_id || undefined,
        ...base,
      })
    }
    return api.getTransactions({ recurring_series_id: openSeries?.id, ...base })
  }, [openSeries, ownerLensParams])
  const membersPaged = usePagedTransactions({
    activeKey: openSeries ? `recurring:${openSeries.id}${openSeries._all ? `|${ownerLensParams.owner_lens || ''}` : ''}` : null,
    loadPage: membersLoadPage,
    sortPreferenceKey: 'ui.recurring.members.sort',
  })
  const reloadMembers = membersPaged.reload
  const refreshReport = useCallback(() => {
    setReportNonce(n => n + 1)
    reloadMembers()
  }, [reloadMembers])
  // Reconcile after an inline edit / row-menu action operates on the paged member rows in place.
  const setReportRows = membersPaged.setRows

  // The card's count is a stored statistic; the report's total is what the fetch actually found. Where
  // they differ the report is the honest one — it is the rows on screen — so opening a series corrects
  // the number beside it rather than leaving a link that promises three and shows four. This is the
  // safety net under the snapshot: an exact snapshot makes the two agree already, and everything else
  // (a series suppressed before snapshots, a payee whose rows have since changed) settles here instead
  // of drifting silently. Local only — `occurrence_count` on the server is the detector's own stat and a
  // match count is not it.
  const openSeriesId = openSeries?._all ? null : openSeries?.id
  const reportTotal = membersPaged.total
  useEffect(() => {
    if (!openSeriesId || membersPaged.loading) return
    setAllSeries(prev => (prev || []).map(x => (
      x.id === openSeriesId && x.occurrence_count !== reportTotal
        ? { ...x, occurrence_count: reportTotal }
        : x
    )))
  }, [openSeriesId, reportTotal, membersPaged.loading])

  useEffect(() => { api.getCategories().then(setCategories).catch(() => {}) }, [])

  const loadTransferReview = useCallback(
    () => api.getTransferReview().then(setTransferReview).catch(() => setTransferReview(null)),
    [],
  )
  useEffect(() => { loadTransferReview() }, [loadTransferReview])

  // The removed-from-series rows re-fetch alongside the members whenever the open series (or refresh
  // nonce) changes. It stays a single fetch with an explicit `limit: 0` (all): removals are a bounded,
  // user-curated set, so fetching the whole set is honest here rather than a magic cap that could hide
  // some — the case the limit: 0 opt-in exists for.
  useEffect(() => {
    // The all-series report has no single series to fetch removals for — an 'excluded' override is
    // per-series, so the removed-rows section only applies to a real single-series drill-down.
    if (!openSeries || openSeries._all) { setExcluded([]); return undefined }
    let live = true
    api.getTransactions({ recurring_excluded_series_id: openSeries.id, limit: 0 })
      .then(resp => { if (live) setExcluded(resp.transactions || []) })
      .catch(() => { if (live) setExcluded([]) })
    return () => { live = false }
  }, [openSeries, reportNonce])

  const applyCategoryToRow = useCallback((txnId, patch) => {
    setReportRows(prev => prev.map(t => (t.id === txnId
      ? { ...t, ...patch }
      : t)))
  }, [setReportRows])

  const saveCategory = useCallback((txnId, catId, catObj) => {
    const cat = catObj || categories.find(c => c.id === catId) || null
    applyCategoryChange(txnId, cat, (patch, id) => applyCategoryToRow(id, patch))
  }, [categories, applyCategoryToRow])

  // load/scan/filter-toggle rebuild the layout snapshot; in-place card updates deliberately do not. The
  // ref lets load() rebuild with the current selection without taking `selected` as a dep (which would
  // re-run the mount effect on every filter change).
  const selectedRef = useRef(selected); selectedRef.current = selected
  const sortRef = useRef(sortOrder); sortRef.current = sortOrder
  const allSeriesRef = useRef(allSeries); allSeriesRef.current = allSeries
  const lensRef = useRef(ownerLens); lensRef.current = ownerLens

  const load = useCallback(() =>
    api.getRecurringSeries(true).then(r => {
      const list = r.series || []
      setAllSeries(list)
      setLayout(buildLayout(lensedSeries(list, lensRef.current), selectedRef.current, sortRef.current))
    }), [])

  useEffect(() => { load() }, [load])

  const setView = useCallback((next) => {
    setViewState(next)
    sessionStore.set(VIEW_STORAGE_KEY, next)
  }, [])

  // Signals recompute from the ledger on every read, so anything that could change one — an action on a
  // series, a scan, a rule edit — just re-fetches rather than trying to patch a row in place.
  const loadSignals = useCallback(
    () => api.getRecurringSignals(undefined, ownerLensParams).then(setSignalData).catch(() => {}),
    [ownerLensParams],
  )
  useEffect(() => { loadSignals() }, [loadSignals])

  // Every transfer answer changes how rows pair, and the server rescans after each, so everything the page
  // shows is downstream of it. These reload rather than patching in place, which makes them deliberate
  // re-sorts, unlike a card action.
  const answerTransfer = useCallback(async (payingId, act) => {
    setTieBusyId(payingId)
    try {
      await act()
      await load()
      loadSignals()
      await loadTransferReview()
    } finally {
      setTieBusyId(null)
    }
  }, [load, loadSignals, loadTransferReview])

  const pairTie = (tie, receivingId) => answerTransfer(tie.row.id, async () => {
    await api.decideTransferPair(tie.row.id, receivingId)
    setTieUndo({ payingId: tie.row.id, paired: true })
  })
  const dismissTie = (tie) => answerTransfer(tie.row.id, async () => {
    await api.decideTransferPair(tie.row.id, null)
    setTieUndo({ payingId: tie.row.id, paired: false })
  })
  const restoreTie = (payingId) => {
    setTieUndo(null)
    return answerTransfer(payingId, () => api.restoreTransferDecision({ paying_txn_id: payingId }))
  }
  const dismissTieToast = useCallback(() => setTieUndo(null), [])

  // A transfer row carries only what the question needs, so the detail panel gets the whole transaction.
  async function openTxnById(id) {
    const txn = (await api.getTransactions({ ids: id, limit: 1 }).catch(() => null))?.transactions?.[0]
    if (txn) setPayeeDetail(txn)
  }

  // Landing from a Tasks card (?signal=<kind>) opens the findings view with that kind preselected, then
  // strips the param so the view and the filter are the user's to change from there.
  const landedSignalRef = useRef(null)
  useEffect(() => {
    const wanted = searchParams.get('signal')
    if (!wanted || landedSignalRef.current === wanted) return
    landedSignalRef.current = wanted
    // `transfer_ties` names the section above the series findings, not a kind, so it leaves them unfiltered.
    setSignalKind(wanted === 'transfer_ties' ? 'all' : wanted)
    setView(VIEW_SIGNALS)
    const next = new URLSearchParams(searchParams); next.delete('signal')
    setSearchParams(next, { replace: true })
  }, [searchParams, setSearchParams, setView])

  // Rebuild the frozen layout when the filter or sort changes (deliberate re-sorts — this also picks up
  // the persisted values once preferences finish loading). Keyed on selection/sort, NOT allSeries, so an
  // in-place card update never triggers a re-sort. Reads current data via a ref.
  useEffect(() => {
    if (allSeriesRef.current) setLayout(buildLayout(lensedSeries(allSeriesRef.current, ownerLens), selected, sortOrder))
  }, [selected, sortOrder, ownerLens])

  function togglePill(cat) {
    const next = new Set(selected)
    if (next.has(cat)) next.delete(cat); else next.add(cat)
    setFilterList([...next])  // persist; the effect above rebuilds the layout
  }

  function deselectAll() {
    setFilterList([])
  }

  const openReport = useCallback((s) => {
    // Toggle: clicking the count of the already-open series closes the drill-down; a different card
    // switches to it. Selecting a series keys the paged member fetch (usePagedTransactions) and the
    // removed-rows effect, which load on their own — the list renders and edits like every other list.
    setOpenSeries(prev => (prev && prev.id === s.id ? null : s))
  }, [])

  // The all-series report: a synthetic marker driving the same drill-down over every series-linked row
  // (recurring_only). Toggles closed when it's already the open view.
  const openAllReport = useCallback(() => {
    setOpenSeries(prev => (prev && prev._all
      ? null
      : { id: ALL_RECURRING_ID, display_name: 'All recurring transactions', _all: true }))
  }, [])

  // A row left ('excluded') or rejoined ('clear') a series. The row itself lingers in the report, but the
  // counts are facts about the series, not about which rows are on screen, so they follow at once: the
  // card takes the server's recomputed series, the report total moves by the same amount the series'
  // count did (exact for the all-series report too, and for a movement series whose count is in legs),
  // and the row moves between the members and the removed-from-series section.
  const applyMembershipChange = useCallback(({ txnId, row, seriesId, state, series }) => {
    const before = (allSeriesRef.current || []).find(x => x.id === seriesId)
    if (series) setAllSeries(prev => (prev || []).map(x => (x.id === series.id ? series : x)))
    if (!openSeries || (!openSeries._all && openSeries.id !== seriesId)) return
    const delta = series && before
      ? series.occurrence_count - before.occurrence_count
      : (state === 'excluded' ? -1 : 1)
    if (delta) membersPaged.setTotal(prev => Math.max(0, prev + delta))
    if (openSeries._all) return
    if (state === 'excluded' && row) setExcluded(prev => [row, ...prev.filter(t => t.id !== txnId)])
    else if (state === 'clear') setExcluded(prev => prev.filter(t => t.id !== txnId))
  }, [membersPaged, openSeries])

  // Undo a removal from inside the drill-down (the durable path for a mistake noticed after the toast is
  // gone): clear the exclude override, then move the row from the removed list back into members in place.
  // A row removed from this same report is still lingering there, so it is patched rather than added twice.
  const addBackToSeries = useCallback((txn) => {
    const seriesId = openSeries?.id
    const row = {
      ...txn,
      recurring_series_id: seriesId,
      recurring_series_name: openSeries?.display_name || null,
      recurring_excluded_series_id: null,
      recurring_excluded_series_name: null,
    }
    membersPaged.setRows(prev => (prev.some(t => t.id === txn.id)
      ? prev.map(t => (t.id === txn.id ? { ...t, ...row } : t))
      : [row, ...prev]))
    api.setRecurringMembership(seriesId, txn.id, 'clear')
      .then(series => applyMembershipChange({ txnId: txn.id, row, seriesId, state: 'clear', series }))
      .catch(() => {})
  }, [membersPaged, openSeries, applyMembershipChange])

  // When the drill-down opens (or switches series) the list area shrinks, which can hide the card that
  // was clicked. Scroll it back into view with block:'nearest' so the list shifts up by the minimum
  // needed — the clicked card stays visible just above the report, even for the last few rows.
  //
  // The scroll is owed until the card is actually rendered, then paid once. A series opened from a link
  // or a finding may not have a card on screen yet — its section's pill is being switched on, or the
  // Series view isn't the one showing — so the attempt repeats as the layout and view change rather than
  // firing once into nothing. Paying it once is what keeps a later pill toggle from jumping back here.
  const listRef = useRef(null)
  const openId = openSeries?.id || null
  const scrollOwedRef = useRef(null)
  useEffect(() => { scrollOwedRef.current = openId }, [openId])
  useEffect(() => {
    if (!openId || scrollOwedRef.current !== openId) return
    const node = listRef.current?.querySelector(`[data-series-id="${openId}"]`)
    if (!node) return
    scrollOwedRef.current = null
    requestAnimationFrame(() => node.scrollIntoView({ block: 'nearest', behavior: 'smooth' }))
  }, [openId, layout, view])

  // Landing from a transaction's "Part of <series>" link (?series=<id>): open that series' drill-down
  // once, then strip the param so closing it doesn't re-trigger. The link wins over the saved pill
  // selection: if the series' section is filtered out, its pill is switched on (and saved, like any pill
  // click) so the card the link is about is on screen; the other pills are left as they were.
  const landedRef = useRef(null)
  useEffect(() => {
    const wanted = searchParams.get('series')
    if (!wanted || !allSeries || landedRef.current === wanted) return
    const s = allSeries.find(x => x.id === wanted)
    if (!s) return
    landedRef.current = wanted
    setView(VIEW_SERIES)
    const section = seriesCategory(s)
    if (!selectedRef.current.has(section)) setFilterList([...selectedRef.current, section])
    openReport(s)
    const next = new URLSearchParams(searchParams); next.delete('series')
    setSearchParams(next, { replace: true })
  }, [allSeries, searchParams, openReport, setSearchParams, setView, setFilterList])

  async function scan() {
    setScanning(true)
    setScanSummary(null)
    try {
      const summary = await api.scanRecurring()
      await load()  // a scan is a deliberate re-sort
      loadSignals()  // membership and next_due move, so every signal is restated
      setScanSummary(summary)
      if (openSeries) refreshReport()  // membership may have shifted → re-fetch members
    } finally {
      setScanning(false)
    }
  }

  // Card actions update just the acted-on series in place (no re-sort), so a recategorized card stays
  // put until the next load/scan/filter change. Delete removes it; that's a removal, not a reorder.
  async function handleAction(kind, s, value) {
    const id = s.id
    let updated
    if (kind === 'confirm') {
      updated = await api.confirmRecurring(id)
      // Accepting is one click and the card leaves the Suggested pile immediately, so the slip
      // is invisible the moment it happens. The toast is the cheap way back; the row menu's
      // "Back to suggested" is the one for noticing later.
      setConfirmUndo({ id, name: s.display_name || s.payee_key })
    }
    else if (kind === 'unconfirm') { updated = await api.unconfirmRecurring(id); setConfirmUndo(null) }
    else if (kind === 'suppress') {
      // Suppressing a rule-backed series unchecks its rule and removes it outright (the backend returns
      // {deleted:true}); a derived series just flips to suppressed and is returned serialized. Either
      // half of a pair can be the rule-backed one, so `deleted_ids` names whatever actually went.
      const res = await api.suppressRecurring(id)
      if (res && res.deleted) setAllSeries(prev => (prev || []).filter(x => x.id !== id))
      else updated = res
    }
    else if (kind === 'end') updated = await api.endRecurring(id)
    else if (kind === 'restore') updated = await api.restoreRecurring(id)
    else if (kind === 'cadence') updated = await api.updateRecurring(id, { cadence: value })
    // Opened from the card, so no proposal is in play — clear any left from a previous finding, or the
    // dialog would open on a band proposed for a different charge.
    else if (kind === 'amountMatch') { setAmountMatchSuggestion(null); setAmountMatchSeries(s); return }
    else if (kind === 'rename') updated = await api.updateRecurring(id, { display_name: value })
    // Delete asks first (see `deleteSeries`): it is the one card action with no way back.
    else if (kind === 'delete') { setDeleteTarget(s); return }
    if (updated) setAllSeries(prev => (prev || []).map(x => (x.id === updated.id ? updated : x)))
    // A characterization change means the user is done inspecting → collapse the drill-down. A cadence
    // tweak is not a characterization change, so it leaves the report open.
    if (CHARACTERIZATION_ACTIONS.has(kind)) setOpenSeries(null)
    loadSignals()  // confirming, ending or suppressing a series resolves the signals about it
  }

  // --- Signal actions ------------------------------------------------------------------------------
  // Each one is an existing endpoint plus a re-fetch; the signal itself is derived, so there is nothing
  // local to reconcile.

  const seriesById = (id) => (allSeries || []).find(x => x.id === id) || null

  // Deleting a series is not undoable and has no trash: an auto series loses its curation (name,
  // cadence, removals) and comes back from the next scan as a suggestion, a hand-added one is gone, and a
  // rule-backed one turns off its rule's recurring flag. The confirmation says which, since the card
  // offers Not recurring and Mark ended beside it as the non-destructive answers.
  async function deleteSeries() {
    const s = deleteTarget
    setDeleteTarget(null)
    if (!s) return
    await api.deleteRecurring(s.id)
    setAllSeries(prev => (prev || []).filter(x => x.id !== s.id))
    setOpenSeries(prev => (prev && prev.id === s.id ? null : prev))
    loadSignals()
  }

  // A finding's Details: the same card the Series view shows, acting through the same handlers.
  const renderSeriesCard = (seriesId) => {
    const s = seriesById(seriesId)
    return s ? (
      <SeriesCard
        series={s}
        onAction={handleAction}
        onOpenReport={openReport}
        onEditRule={(series) => setRuleModal({ mode: 'edit', ruleId: series.rule_id })}
        active={openSeries?.id === s.id}
      />
    ) : null
  }

  async function dismissSignal(signal, { oneOff = false } = {}) {
    await api.dismissRecurringSignal(signal.key, signal.kind, { oneOff })
    setSignalUndo({ key: signal.key, kind: signal.kind, oneOff, baseline: signal.baseline_amount })
    loadSignals()
  }

  // A finding's charge taken out of its series: the same scan-durable exclusion as the row menu's "Remove
  // from recurring series". The series' stats change with it, so the findings and any open report reload
  // rather than patching in place, and the finding itself goes because its charge no longer belongs.
  async function excludeSignalCharge(signal) {
    const updated = await api.setRecurringMembership(signal.series_id, signal.txn_id, 'excluded')
    if (updated) setAllSeries(prev => (prev || []).map(x => (x.id === updated.id ? updated : x)))
    setExcludeUndo({
      seriesId: signal.series_id, txnId: signal.txn_id, seriesName: signal.series_name,
      amount: signal.amount, date: signal.txn_date,
    })
    loadSignals()
    refreshReport()
  }

  async function undoExcludeCharge() {
    const snap = excludeUndo
    if (!snap) return
    setExcludeUndo(null)
    const updated = await api.setRecurringMembership(snap.seriesId, snap.txnId, 'clear')
    if (updated) setAllSeries(prev => (prev || []).map(x => (x.id === updated.id ? updated : x)))
    loadSignals()
    refreshReport()
  }

  async function restoreSignal(key) {
    await api.restoreRecurringSignal(key)
    setSignalUndo(null)
    loadSignals()
    if (resolvedSignals) {
      api.getDismissedRecurringSignals().then(r => setResolvedSignals(r.signals || [])).catch(() => {})
    }
  }

  function signalSeriesAction(kind, signal) {
    const series = seriesById(signal.series_id)
    if (series) handleAction(kind, series)
  }

  // Opens *in place*, under whichever view is showing. Sending the user to the series list instead was
  // worse in both directions: it took them away from the finding they were working through, and the
  // list's own filter can exclude the very series being opened (a Confirmed series while only Suggested
  // is selected), so the drill-down would describe a card that was nowhere on screen.
  // Opens the series the finding's headline names, which is every kind of finding this view carries.
  function openSignalTarget(signal) {
    const target = signalTarget(signal)
    if (!target) return
    const series = seriesById(target.id)
    if (series) openReport(series)
  }

  // Refresh re-reads **everything the page can show**, not just the series list. It used to call `load()`
  // alone, which meant that from the *Needs attention* or *Upcoming* view — where the series list is not
  // even on screen — the button reloaded something invisible and left the findings and any open
  // drill-down exactly as they were. That reads as "the edit I just made did not take": the findings are
  // derived on read, so they were already correct on the server and only this page had not asked again.
  const refreshAll = useCallback(() => {
    refreshReport()  // an open drill-down re-fetches its rows too
    // Returned so the refresh control turns for as long as the page's own reads take.
    return Promise.all([load(), loadSignals(), loadTransferReview()])
  }, [load, loadSignals, loadTransferReview, refreshReport])
  // A sync rescans the payees it touched before it returns, so the series, findings and pairings it brought
  // in are already on the server by the time this fires.
  useAfterLedgerChange(() => { refreshAll().catch(() => {}) })

  // Accepting a price change is deliberately *not* a one-click apply, the way widening a rule's bound is
  // on the Rules page. A bound has one right answer — take in this charge — while a series' band has two
  // ends and the finding cannot tell which should move: a bill that rose because everything rose wants both
  // carried up, one new outlier wants a single bound moved, and the same holds downward when a utility
  // posts its cheapest month yet. So it opens the band editor on the proposal rather than writing it.
  function acceptPriceChange(signal) {
    const band = priceChangeBand(signal)
    const series = seriesById(signal.series_id)
    if (!band || !series) return
    const direction = band.movedBound === 'high' ? 'above' : 'below'
    setAmountMatchSeries(series)
    setAmountMatchSuggestion({
      low: band.low,
      high: band.high,
      note: `${formatCurrency(Math.abs(signal.amount))} on ${formatDate(signal.txn_date)} is ${direction} this series’ range, so it is not matching. The ${band.movedBound === 'high' ? 'upper' : 'lower'} end has been moved to take it in.`,
    })
  }

  // UndoToast keys its auto-dismiss timer on this callback, so it has to be stable — an inline arrow
  // restarts the countdown on every render and the toast never closes on its own.
  const dismissUndoToast = useCallback(() => setSignalUndo(null), [])
  const dismissExcludeToast = useCallback(() => setExcludeUndo(null), [])

  async function showResolved() {
    setResolvedSignals([])
    loadTransferReview()
    const r = await api.getDismissedRecurringSignals().catch(() => ({ signals: [] }))
    setResolvedSignals(r.signals || [])
  }

  // The drill-down docks below whichever view is showing, so a finding can be inspected without leaving
  // the list of findings.
  const drillOpen = !!openSeries
  const signalCounts = signalData?.counts || {}
  const transferTies = transferReview?.ambiguous || []
  const resolvedTies = transferReview?.resolved || []
  // Open transfers to match count towards the view's badge with the series findings: both are a decision
  // the view is waiting on.
  const anomalyCount = (signalData?.anomaly_count || 0) + transferTies.length
  const upcomingCount = signalCounts.upcoming || 0

  const byId = new Map((allSeries || []).map(s => [s.id, s]))
  // Search is a live display filter over the frozen layout — it narrows which cards show (and hides
  // now-empty sections) without reordering, so cards never jump while typing.
  const term = search.trim().toLowerCase()
  const matchesSearch = (s) => !term
    || [
      s.display_name, s.category_name, s.account_name,
      // A movement runs between two accounts, and searching for either has to find the card for it.
      s.counterpart_account_name,
    ].some(v => String(v || '').toLowerCase().includes(term))
  // A finding or an upcoming charge is about a series, so it matches when its series does — the same fields,
  // including a movement's second account, which the finding does not carry itself.
  const matchesSignal = (signal) => {
    if (!term) return true
    const series = byId.get(signal.series_id)
    if (series) return matchesSearch(series)
    return [signal.series_name, signal.category_name, signal.account_name]
      .some(v => String(v || '').toLowerCase().includes(term))
  }
  const visibleSections = (layout?.sections || [])
    .map(sec => ({ ...sec, visibleIds: sec.ids.filter(id => { const s = byId.get(id); return s && matchesSearch(s) }) }))
    .filter(sec => sec.visibleIds.length > 0)
  const showHeaders = visibleSections.length > 1

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {/* Page padding on the outer element, the content column on an inner one — the same two-step the
          scrolling body and the drill-down use below. Putting `maxWidth` on the *padded* element instead
          measures the column inside the padding, so a centred header sits 32px in from a centred list of
          the same nominal width and reads as a stray indent. */}
      <div style={{ padding: '32px 32px 0', flexShrink: 0 }}>
        <div style={{ maxWidth: PAGE_COLUMN, margin: '0 auto' }}>
          <PageHeader
            title="Recurring Transactions"
            help={<FeatureExplainer topic="recurring-transactions" placement="bottom-left" />}
           
            refresh={<RefreshButton onRefresh={refreshAll} title="Refresh — reload everything on this page" />}
            titleAdornment={allSeries && allSeries.length > 0 && (
              // The standard report ↗ next to the title opens a transaction report of every recurring row
              // (all series). Toggles closed when it's already the open view.
              <IconButton
                tone="accent"
                pressed={!!openSeries?._all}
                onClick={openAllReport}
                aria-label="Open a report of all recurring transactions"
                title={openSeries?._all ? 'Close the recurring transactions report' : 'Open a report of all recurring transactions'}
                style={{ fontSize: 17 }}
              >↗</IconButton>
            )}
          >
            {/* "+New" rather than "Add manually": the page names what is created (see ui-patterns). */}
            <Button variant="secondary" onClick={() => setAdding(true)}>+New</Button>
            {/* Quiet: import, sync, edits and the app-load catch-up keep detection current, so this is
                a manual override rather than the page's main action. */}
            <Button variant="secondary" onClick={scan} disabled={scanning}>
              {scanning ? 'Scanning…' : 'Scan for recurring'}
            </Button>
          </PageHeader>
          <div style={{ fontSize: 12.5, color: 'var(--muted)', margin: '4px 0 10px' }}>
            {scanSummary
              ? `Scan complete — ${scanSummary.inserted} new, ${scanSummary.preserved} kept${scanSummary.resumed ? `, ${scanSummary.resumed} resumed` : ''}.`
              : 'Detects subscriptions, bills, and taxes that recur on a schedule. Confirm the ones that look right; mark the rest "not recurring."'}
          </div>
          {/* The first-visit tip. Dismissed, it leaves nothing behind: the topic's `?` is beside the title. */}
          <ContextualExplainer
            topic="recurring-transactions"
            active={allSeries !== null}
            tipKey="recurring-intro"
            placement="bottom-left"
            persistentButton={false}
            style={{ marginBottom: 10 }}
          />
          {/* Above the view selector because it narrows whichever view is showing — which is also what lets
              each view's own pills sit directly above the rows they select. */}
          <div style={{ marginBottom: 10 }}>
            <SearchInput
              value={search}
              onChange={setSearch}
              placeholder="Search merchant, category, or account…"
              aria-label="Search recurring transactions"
              wrapperStyle={{ maxWidth: 340 }}
              style={{ padding: '5px 10px', fontSize: 13 }}
            />
          </div>
          {/* The view selector. The badge lives on the control rather than inside the view it names —
              a count only visible after switching cannot tell anyone to switch. */}
          <div style={{ marginBottom: 10 }}>
            <SegmentedToggle
              value={view}
              onChange={setView}
              ariaLabel="Recurring view"
              options={[
                { value: VIEW_SERIES, label: 'Series' },
                {
                  value: VIEW_SIGNALS,
                  label: 'Needs attention',
                  badge: anomalyCount || null,
                  badgeTone: 'warning',
                },
                { value: VIEW_UPCOMING, label: 'Upcoming', badge: upcomingCount || null },
              ]}
            />
          </div>
          {/* Status pills and sort apply to the series list alone, so they travel with it. */}
          {view === VIEW_SERIES ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 8, flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                {CATEGORY_ORDER.map(cat => (
                  <FilterPill
                    key={cat}
                    label={CATEGORY_LABELS[cat]}
                    count={layout?.counts?.[cat] ?? 0}
                    on={selected.has(cat)}
                    onClick={() => togglePill(cat)}
                  />
                ))}
                <DeselectAllPill disabled={selected.size === 0} onClick={deselectAll} />
              </div>
              <SortToggle value={sortOrder} onChange={setSortOrder} />
            </div>
          ) : null}
        </div>
      </div>

      {/* Split: the series list stays visible above while the drill-down opens below. Whichever view is
          selected owns this whole scrolling region, which is what keeps a long list of findings from
          crowding out the series they refer to — they no longer share a viewport at all. */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {/* When a report is open the list shrinks to its content but is capped so a long series list can't
            crowd out the report; the report (flex:1 below) then fills all remaining space — so a short
            list (even one series) yields a large report instead of a fixed small strip. */}
        <div ref={listRef} style={{ flex: drillOpen ? '0 1 auto' : '1 1 auto', maxHeight: drillOpen ? '50%' : undefined, minHeight: 0, overflowY: 'auto', padding: '4px 32px 24px' }}>
          <div style={{ maxWidth: PAGE_COLUMN, margin: '0 auto' }}>
            {view === VIEW_SIGNALS ? (
              signalData === null ? <Spinner /> : (
                <RecurringSignalsView
                  signals={signalData.signals || []}
                  counts={signalData.counts || {}}
                  resolvedCount={(signalData.dismissed_count || 0) + resolvedTies.length}
                  kind={signalKind}
                  onKindChange={setSignalKind}
                  activeSeriesId={openSeries?.id || null}
                  onDismiss={dismissSignal}
                  onSeriesAction={signalSeriesAction}
                  onOpenSeries={openSignalTarget}
                  onAcceptPrice={acceptPriceChange}
                  onExcludeCharge={excludeSignalCharge}
                  onShowResolved={showResolved}
                  ties={transferTies}
                  tieBusyId={tieBusyId}
                  onPairTie={pairTie}
                  onDismissTie={dismissTie}
                  onOpenTxn={openTxnById}
                  matches={matchesSignal}
                  renderSeries={renderSeriesCard}
                />
              )
            ) : view === VIEW_UPCOMING ? (
              signalData === null ? <Spinner /> : (
                <RecurringUpcomingView
                  signals={signalData.signals || []}
                  horizonDays={signalData.horizon_days || 30}
                  matches={matchesSignal}
                />
              )
            ) : allSeries === null ? (
              <Spinner />
            ) : allSeries.length === 0 ? (
              <EmptyState message="No recurring series found yet. Detection runs automatically as transactions arrive." />
            ) : visibleSections.length === 0 ? (
              <EmptyState message={selected.size === 0
                ? 'No statuses are selected. Choose one above to see its series.'
                : term ? 'No series match your search.' : 'No series match the selected filters.'}
              />
            ) : (
              visibleSections.map(section => (
                <div key={section.key}>
                  {showHeaders && (
                    <div style={{
                      fontSize: 11.5, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase',
                      color: 'var(--muted)', margin: '16px 2px 8px',
                    }}>
                      {section.label} <span style={{ opacity: 0.7 }}>({section.visibleIds.length})</span>
                    </div>
                  )}
                  {section.visibleIds.map(id => {
                    const s = byId.get(id)
                    return s ? (
                      <SeriesCard
                        key={id}
                        series={s}
                        onAction={handleAction}
                        onOpenReport={openReport}
                        onEditRule={(series) => setRuleModal({ mode: 'edit', ruleId: series.rule_id })}
                        active={openSeries?.id === id}
                      />
                    ) : null
                  })}
                </div>
              ))
            )}
          </div>
        </div>

        {drillOpen && (
          <ReportPanel
            series={openSeries}
            rows={membersPaged.rows}
            excluded={excluded}
            total={membersPaged.total}
            categories={categories}
            loading={membersPaged.loading}
            onClose={() => setOpenSeries(null)}
            onCategorySave={saveCategory}
            onRowsChange={membersPaged.setRows}
            onOpenTxnDetail={setPayeeDetail}
            onTrashed={txnId => { membersPaged.setTotal(prev => Math.max(0, prev - 1)); setPayeeDetail(prev => (prev && prev.id === txnId ? null : prev)) }}
            onAddBack={addBackToSeries}
            onMembershipChange={applyMembershipChange}
            paging={membersPaged.paging}
            sortState={membersPaged.sortState}
            onSort={membersPaged.onSort}
          />
        )}
      </div>

      {adding && (
        <ManualAddDialog
          onClose={() => setAdding(false)}
          onCreated={() => { setAdding(false); load() }}
        />
      )}

      {ruleModal && (
        <RuleActionModal
          state={ruleModal}
          onClose={() => setRuleModal(null)}
          // Editing the rule can change the series' membership/cadence/name, so reload the list, the
          // findings judged against it, and any open report of its transactions.
          onSaved={() => { setRuleModal(null); load(); loadSignals(); refreshReport() }}
        />
      )}

      {amountMatchSeries && (
        <RecurringAmountMatchDialog
          series={amountMatchSeries}
          suggested={amountMatchSuggestion}
          onClose={() => { setAmountMatchSeries(null); setAmountMatchSuggestion(null) }}
          onSave={async (payload) => {
            // The edit changes which rows the series owns, so the server re-runs membership and returns
            // the series with its new count — patch it in rather than re-fetching the whole list.
            const updated = await api.updateRecurring(amountMatchSeries.id, payload)
            setAllSeries(prev => (prev || []).map(x => (x.id === updated.id ? updated : x)))
            loadSignals()  // a membership change can resolve or raise a finding about this series
            if (openSeries?.id === updated.id) refreshReport()  // and changes the open report's rows
          }}
        />
      )}

      {deleteTarget && (
        <AppConfirmDialog
          title={`Delete “${deleteTarget.display_name || deleteTarget.payee_key}”?`}
          description={deleteTarget.source === 'rule'
            ? 'This turns off Recurring series on the rule that defines it; turning that back on re-creates the series. If recurring was the rule’s only action, the rule moves to the rules trash, where restoring it brings the series back.'
            : deleteTarget.source === 'manual'
              ? 'A series added by hand is not found again by a scan. Getting it back means adding it again.'
              : 'The next scan finds it again as a suggestion, without its name, cadence or removed transactions. To stop it being suggested, choose Not recurring instead.'}
          confirmLabel="Delete series"
          cancelLabel="Keep series"
          confirmVariant="danger"
          borderColor="var(--danger)"
          onConfirm={deleteSeries}
          onCancel={() => setDeleteTarget(null)}
        />
      )}

      {resolvedSignals !== null && (
        <ResolvedFindingsDialog
          signals={resolvedSignals}
          ties={resolvedTies}
          loading={false}
          onRestoreSignal={(signal) => restoreSignal(signal.key)}
          onRestoreTie={(tie) => restoreTie(tie.paying_txn_id)}
          onClose={() => setResolvedSignals(null)}
        />
      )}

      {confirmUndo && (
        <UndoToast
          title="Series confirmed"
          description={`${confirmUndo.name} is now tracked. Undo puts it back in Suggested.`}
          onUndo={async () => { await handleAction('unconfirm', { id: confirmUndo.id }); setConfirmUndo(null) }}
          onDismiss={() => setConfirmUndo(null)}
        />
      )}

      {signalUndo && (
        <UndoToast
          title={signalUndo.oneOff ? 'Dismissed as a one-off' : 'Signal dismissed'}
          description={signalUndo.oneOff
            ? `${formatCurrency(signalUndo.baseline)} is still the expected amount. Later charges are checked against it, so this amount arriving again is reported.`
            : 'It stays hidden; a new finding about the same series still appears.'}
          onUndo={() => restoreSignal(signalUndo.key)}
          onDismiss={dismissUndoToast}
        />
      )}

      {tieUndo && (
        <UndoToast
          title={tieUndo.paired ? 'Transfer matched' : 'Transfer dismissed'}
          description={tieUndo.paired
            ? 'The pair can now count towards a series.'
            : 'Its transactions stay matched by merchant name.'}
          onUndo={() => restoreTie(tieUndo.payingId)}
          onDismiss={dismissTieToast}
        />
      )}

      {excludeUndo && (
        <UndoToast
          title="Excluded from series"
          description={`${formatCurrency(Math.abs(excludeUndo.amount))} on ${formatDate(excludeUndo.date)} is no longer part of ${excludeUndo.seriesName || 'the series'}, and stays out after future scans.`}
          onUndo={undoExcludeCharge}
          onDismiss={dismissExcludeToast}
        />
      )}

      {payeeDetail && (
        <TransactionDetail
          txn={payeeDetail}
          categories={categories}
          onClose={() => setPayeeDetail(null)}
          onReconcile={makeRowReconciler(setReportRows)}
          forceFloating
          stackIndex={1}
        />
      )}
    </div>
  )
}
