// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { api } from '../lib/api.js'
import { useSyncStatus } from '../contexts/SyncStatusContext.jsx'
import { notifyAccountsChanged } from '../App.jsx'
import { Card, Button, Spinner, Select, Input, PasswordInput, AppDialog, AppConfirmDialog, AppNoticeDialog, AppTextEntryDialog, DialogActions, OverlayBackdrop } from '../components/ui.jsx'
import AccountDetail from '../components/AccountDetail.jsx'
import { SourceAccountChip, OutcomeChip } from '../components/importExport/SourceAccountChip.jsx'
import { useBatchDetailPanels } from '../components/importExport/useBatchDetailPanels.jsx'
import PillTableHeader from '../components/PillTableHeader.jsx'
import TagPickerWithCreate from '../components/TagPickerWithCreate.jsx'
import FeatureExplainer from '../help/FeatureExplainer.jsx'
import { useDismissibleLayer, useDismissiblePopup, useTransientTextEdit } from '../lib/uiInteractions.js'
import TransientTextInput from '../components/TransientTextInput.jsx'
import { VaultPassphraseDialog } from '../components/VaultPassphraseDialog.jsx'
import { SENSITIVE_FIELD_PROPS } from '../lib/sensitiveFields.js'
import { VaultSettingsDialog } from '../components/VaultSettingsDialog.jsx'
import { useVaultPasskeyUnlock, VAULT_PASSKEY_LABEL } from '../lib/useVaultPasskeyUnlock.js'
import { providerSummaryLine } from '../lib/connectionSummary.js'
import ConnectionAccountMapDialog from '../components/accounts/ConnectionAccountMapDialog.jsx'
import { EditedTransactionsWarning } from '../components/EditedTransactionsWarning.jsx'
import { ActionMenu, ActionMenuButton } from '../components/ActionMenu.jsx'
import { ACCOUNT_TYPES } from '../lib/accountTypes.js'
import { formatTimestamp } from '../lib/utils.js'
import { useAppSession } from '../lib/AppSessionContext.jsx'
import { useUserPreferences, useUserPreference } from '../lib/UserPreferencesContext.jsx'
import { useColumnPreference } from '../lib/useColumnPreference.js'
import { useVaultGate } from '../lib/useVaultGate.js'

const ACCOUNTS_SECTIONS_PREF_KEY = 'ui.accounts.sections'
const ACCOUNTS_SECTIONS_STORAGE_KEY_PREFIX = 'luma.accounts.sections'
const LEGACY_ACCOUNT_OWNERS_PREF_KEY = 'ui.accounts.accountOwnersExpanded'
const LEGACY_ACCOUNT_OWNERS_STORAGE_KEY_PREFIX = 'luma.accounts.accountOwnersExpanded'
const ACCOUNTS_COLLAPSED_PREF_KEY = 'ui.accounts.collapsedGroups'
const ACCOUNTS_COLLAPSED_STORAGE_KEY_PREFIX = 'luma.accounts.collapsedGroups'
const ACCOUNTS_SORT_PREF_KEY = 'ui.accounts.sort'
const ACCOUNTS_SORT_STORAGE_KEY_PREFIX = 'luma.accounts.sort'
const ACCOUNTS_COLUMNS_PREF_KEY = 'ui.accounts.columns'

// Account-list column geometry. Name is the fluid filler (`minmax(0, 1fr)`) so the table always fits
// its container with no horizontal scrollbar — resizing Type/Owner/Tags reflows Name. Only those three
// carry a numeric (px) width and are user-resizable; the drag-handle and delete gutters stay fixed.
// Widths/order persist via the shared useColumnPreference model. Order MUST match the header config and
// the cell order rendered by AccountRow/DraftAccountRow.
//
// Why Name has no resize grip: a fluid (`fr`) column has no fixed edge to drag, so the grip convention
// (right edge of each column) has nothing to grab — you widen Name indirectly by shrinking the others.
// Now that the table lives on its own tab, if direct Name resizing is ever wanted, give Name a numeric
// px width and let the table scroll horizontally when over-widened (the Transactions-ledger model);
// that trades the always-fits guarantee for a draggable Name edge.
const ACCOUNT_COLUMN_DEFAULTS = [
  { key: 'drag', width: 22 },
  { key: 'name', width: 'minmax(0, 1fr)' },
  { key: 'type', width: 110, minWidth: 90 },
  { key: 'owner', width: 116, minWidth: 96 },
  { key: 'tags', width: 112, minWidth: 84 },
  { key: 'actions', width: 28 },
]
const ACCOUNT_RESIZABLE_COLUMN_KEYS = new Set(['type', 'owner', 'tags'])

// Numeric widths render as pixels; string widths (the Name filler) pass through so the column flexes.
function buildAccountGridTemplate(columns) {
  return columns
    .map(column => (typeof column.width === 'number' ? `${column.width}px` : column.width))
    .join(' ')
}

const ACCOUNT_ROW_CHILD_INDENT = 28
const ACCOUNT_ROW_GAP = 10
const ACCOUNT_ROW_PADDING = '3px 10px'
const ACCOUNT_CONTROL_HEIGHT = 22
const ACCOUNT_DETACH_DROP_ZONE_WIDTH = 84
// The account list is the only thing on its own tab now, so it isn't constrained to share a width with
// the sparse Owners/Connections panels — give it modestly more room for long account names.
const ACCOUNTS_SECTION_BASE_WIDTH = 720
// In-page tabs (mirroring the Import/Export page). The active tab is session-scoped: it sticks while the
// app is open but resets to Accounts next launch (a within-session convenience, not a durable preference).
const ACCOUNT_TABS = [['accounts', 'Accounts'], ['owners', 'Owners'], ['connections', 'Connections']]
const ACCOUNTS_TAB_STORAGE_KEY = 'luma.accounts.tab'
const ACCOUNT_TYPE_ORDER = Object.fromEntries(ACCOUNT_TYPES.map((type, index) => [type.value, index]))
const ACCOUNT_SORT_KEYS = ['name', 'type', 'owner']
const DEFAULT_ACCOUNT_SORT_DIRECTIONS = { name: 'asc', type: 'asc', owner: 'asc' }
const ACCOUNT_SECTION_DEFAULTS = {
  accountList: false,
  dataSources: false,
  accountOwners: false,
}


// "Shared" only becomes an assignable owner when there are multiple personal owners; otherwise it would just duplicate the sole-owner default.
function isSharedOwner(owner) {
  return !!owner?.is_shared || (owner?.name || '').trim().toLowerCase() === 'shared'
}

// Two accounts are owner-compatible if they share the same owner, or if either owner is the
// shared owner — a shared account can be grouped with any personal account of the same type
// since shared ownership often reflects a life-stage change, not a permanent categorization.
function ownersAreCompatible(source, target, owners) {
  const sourceOwnerId = source?.owner_id || ''
  const targetOwnerId = target?.owner_id || ''
  if (sourceOwnerId === targetOwnerId) return true
  const sourceOwner = owners.find(o => o.id === sourceOwnerId)
  const targetOwner = owners.find(o => o.id === targetOwnerId)
  return isSharedOwner(sourceOwner) || isSharedOwner(targetOwner)
}

function hasSameMergeFields(source, target, owners) {
  return ownersAreCompatible(source, target, owners) && (source?.type || '') === (target?.type || '')
}

function getPersonalOwners(owners) {
  return owners.filter(owner => !isSharedOwner(owner))
}

function getAssignableOwners(owners) {
  const personalOwners = getPersonalOwners(owners)
  if (personalOwners.length <= 1) return personalOwners
  const sharedOwner = owners.find(isSharedOwner)
  return sharedOwner ? [...personalOwners, sharedOwner] : personalOwners
}

function getAccountsSectionsStorageKey(dbInstanceId, userId) {
  return dbInstanceId && userId
    ? `${ACCOUNTS_SECTIONS_STORAGE_KEY_PREFIX}.${dbInstanceId}.${userId}`
    : ''
}

function getLegacyAccountOwnersStorageKey(dbInstanceId, userId) {
  return dbInstanceId && userId
    ? `${LEGACY_ACCOUNT_OWNERS_STORAGE_KEY_PREFIX}.${dbInstanceId}.${userId}`
    : ''
}

function getAccountsCollapsedStorageKey(dbInstanceId, userId) {
  return dbInstanceId && userId
    ? `${ACCOUNTS_COLLAPSED_STORAGE_KEY_PREFIX}.${dbInstanceId}.${userId}`
    : ''
}

function getAccountsSortStorageKey(dbInstanceId, userId) {
  return dbInstanceId && userId
    ? `${ACCOUNTS_SORT_STORAGE_KEY_PREFIX}.${dbInstanceId}.${userId}`
    : ''
}

function isObjectLike(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function getSectionExpanded(sectionState, sectionKey) {
  return sectionState?.[sectionKey] ?? ACCOUNT_SECTION_DEFAULTS[sectionKey] ?? true
}

function formatCountSummary(count, singular, plural = `${singular}s`) {
  if (!count) return `No ${plural}`
  return `${count} ${count === 1 ? singular : plural}`
}

function normalizeSortDirection(value) {
  return value === 'desc' ? 'desc' : 'asc'
}

function normalizeAccountSortDirections(value, fallbackDir = 'asc') {
  const nextDirections = { ...DEFAULT_ACCOUNT_SORT_DIRECTIONS }
  if (isObjectLike(value)) {
    for (const key of ACCOUNT_SORT_KEYS) {
      if (value[key]) nextDirections[key] = normalizeSortDirection(value[key])
    }
  }
  nextDirections.type = normalizeSortDirection(nextDirections.type || fallbackDir)
  return nextDirections
}

function compareAccountNames(a, b) {
  return (a.name || '').localeCompare(b.name || '')
}

function buildAccountSortComparator(sortKey, sortDir) {
  return (a, b) => {
    const nameCmp = compareAccountNames(a, b)
    const typeCmp = (ACCOUNT_TYPE_ORDER[a.type] ?? 99) - (ACCOUNT_TYPE_ORDER[b.type] ?? 99)
    const ownerCmp = (a.owner_name || '').localeCompare(b.owner_name || '')
    const dir = sortDir === 'asc' ? 1 : -1
    if (sortKey === 'type') return dir * (typeCmp || ownerCmp || nameCmp)
    if (sortKey === 'owner') return dir * (ownerCmp || typeCmp || nameCmp)
    return dir * (nameCmp || typeCmp || ownerCmp)
  }
}

function orderAccountsForDisplay(rows, sortKey, sortDir) {
  const visibleRoots = []
  const hiddenRows = []
  const childrenByParent = new Map()

  for (const row of rows) {
    if (row.trashed_at) {
      hiddenRows.push(row)
      continue
    }
    if (row.parent_account_id) {
      const list = childrenByParent.get(row.parent_account_id) || []
      list.push(row)
      childrenByParent.set(row.parent_account_id, list)
      continue
    }
    visibleRoots.push(row)
  }

  const orderedVisibleRows = []
  const sortedRoots = [...visibleRoots].sort(buildAccountSortComparator(sortKey, sortDir))
  const placedChildIds = new Set()
  const visibleRootIds = new Set(sortedRoots.map(row => row.id))

  for (const root of sortedRoots) {
    orderedVisibleRows.push(root)
    const sortedChildren = [...(childrenByParent.get(root.id) || [])].sort(compareAccountNames)
    for (const child of sortedChildren) {
      placedChildIds.add(child.id)
      orderedVisibleRows.push(child)
    }
  }

  const orphanChildren = []
  for (const [parentId, children] of childrenByParent.entries()) {
    if (visibleRootIds.has(parentId)) continue
    orphanChildren.push(...children)
  }

  return [
    ...orderedVisibleRows,
    ...orphanChildren.filter(child => !placedChildIds.has(child.id)).sort(compareAccountNames),
    ...hiddenRows,
  ]
}

function reconcileAccountOrder(previousRows, nextRows) {
  const nextById = new Map(nextRows.map(row => [row.id, row]))
  const orderedRows = []
  const seenIds = new Set()

  for (const row of previousRows) {
    const next = nextById.get(row.id)
    if (!next) continue
    orderedRows.push(next)
    seenIds.add(row.id)
  }

  for (const row of nextRows) {
    if (seenIds.has(row.id)) continue
    orderedRows.push(row)
  }

  return orderedRows
}

function OwnerFilterPill({ label, count, active, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '6px 12px',
        borderRadius: 999,
        border: `1px solid ${active ? 'color-mix(in srgb, var(--accent) 60%, var(--border))' : 'var(--border)'}`,
        background: active
          ? 'color-mix(in srgb, var(--accent) 14%, var(--surface2))'
          : 'var(--surface2)',
        color: active ? 'var(--accent2)' : 'var(--muted)',
        fontSize: 12,
        fontWeight: 600,
        cursor: 'pointer',
        boxShadow: active ? '0 6px 14px rgba(15, 23, 42, 0.10)' : 'none',
      }}
    >
      <span>{count}</span>
      <span style={{ fontWeight: 500 }}>{label}</span>
    </button>
  )
}

// A section panel with an optional collapse toggle. On the tabbed Accounts page each section is the only
// thing on its tab, so it is rendered `collapsible={false}`: a static header (no toggle) with the content
// always shown. The collapsible form is retained for any other caller that still wants it.
// `headerActions` are controls that live in the header but must NOT toggle the card — a "Sync now" that
// stays reachable while collapsed. They cannot be part of `headerInner`: a collapsible header *is* a
// <button>, so nesting one inside it is invalid HTML and every click would also collapse the card. They
// are rendered as a sibling of the toggle, inside a flex row that the toggle grows to fill.
function SectionCard({ title, summary = '', headerCenter = null, headerActions = null, expanded, onExpandedChange, collapsible = true, disabled = false, width, children, style }) {
  const open = collapsible ? expanded : true
  const headerInner = (
    <>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        {collapsible ? <span style={{ fontSize: 12, color: 'var(--muted)' }}>{open ? '−' : '+'}</span> : null}
        <span style={{ fontSize: 14, fontWeight: 600 }}>{title}</span>
      </span>
      {headerCenter ? (
        <span style={{ display: 'inline-flex', alignItems: 'center', flexShrink: 1, minWidth: 0 }}>
          {headerCenter}
        </span>
      ) : null}
      {summary ? (
        <span style={{
          fontSize: 12,
          color: 'var(--muted)',
          whiteSpace: 'nowrap',
          marginLeft: 'auto',
        }}>
          {summary}
        </span>
      ) : null}
    </>
  )
  const headerStyle = {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '4px 12px',
    width: '100%',
    background: 'none',
    border: 'none',
    padding: '12px 16px',
    color: 'var(--text)',
    textAlign: 'left',
  }
  // A header with nothing in it would just be empty chrome — skip it.
  const hasHeader = collapsible || title || summary || headerCenter || headerActions
  return (
    <Card style={{
      width: typeof width === 'number' ? `${width}px` : (width || 'fit-content'),
      maxWidth: '100%',
      opacity: disabled ? 0.55 : 1,
      pointerEvents: disabled ? 'none' : 'auto',
      padding: 0,
      ...style,
    }}>
      {hasHeader ? (
        <div style={{ display: 'flex', alignItems: 'center', width: '100%' }}>
          {collapsible ? (
            <button type="button" onClick={() => onExpandedChange?.(!open)}
              style={{ ...headerStyle, cursor: 'pointer', flex: 1, minWidth: 0 }}>
              {headerInner}
            </button>
          ) : (
            <div style={{ ...headerStyle, flex: 1, minWidth: 0 }}>{headerInner}</div>
          )}
          {headerActions ? (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '0 16px 0 8px', flexShrink: 0 }}>
              {headerActions}
            </span>
          ) : null}
        </div>
      ) : null}
      {open ? (
        <div style={hasHeader ? { borderTop: '1px solid var(--border)' } : undefined}>
          {children}
        </div>
      ) : null}
    </Card>
  )
}

function controlStyle(extra = {}) {
  return {
    width: '100%',
    background: 'var(--surface2)',
    color: 'var(--text)',
    border: '1px solid var(--border)',
    borderRadius: 8,
    padding: '6px 10px',
    fontSize: 13,
    ...extra,
  }
}

// --- Data-source connections (security phase 6b) --------------------------------------------------
//
// The Connections tab: one card per supported aggregator, plus the vault affordance the cards depend on.
// Provider *configuration* (the app credential) lives here, not in Settings; the app secret is vaulted,
// so connecting/syncing needs the vault unlocked, and — on a networked bind — HTTPS. Only Plaid ships an
// adapter today; the layout is provider-generic for Teller/SimpleFIN later.

const PROVIDER_LABELS = { plaid: 'Plaid', teller: 'Teller', simplefin: 'SimpleFIN Bridge' }

function providerLabel(provider) {
  return PROVIDER_LABELS[provider] || (provider ? provider[0].toUpperCase() + provider.slice(1) : 'Provider')
}

// A small pill for the connection cards' at-a-glance state. `tone` picks the colour role rather than a
// literal colour, so the same component covers "needs attention" and "something is wrong".
function StatusPill({ tone = 'accent2', children, title, onClick }) {
  const color = tone === 'danger' ? 'var(--danger, #dc2626)'
    : tone === 'warning' ? 'var(--warning)'
      : 'var(--accent2)'
  const Tag = onClick ? 'button' : 'span'
  return (
    <Tag
      {...(onClick ? { type: 'button', onClick } : {})}
      title={title}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        padding: '1px 8px', borderRadius: 999, fontSize: 11, fontWeight: 600,
        background: `color-mix(in srgb, ${color} 12%, var(--surface2))`,
        color,
        border: `1px solid color-mix(in srgb, ${color} 50%, var(--border))`,
        cursor: onClick ? 'pointer' : 'default',
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </Tag>
  )
}

// Wording for the last sync's outcome. The outcome itself is decided in `services/providers/config.py`
// (`_sync_outcome`) and only rendered here, so the card and the sync log can never describe the same call
// differently. Each label names the effect on the user's data rather than the mechanism behind it: a walk
// that stopped on the provider's request budget is "more history to fetch", because "budget paused" means
// nothing to someone who does not know the provider meters requests.
const SYNC_OUTCOMES = {
  failed: {
    label: 'Sync failed', tone: 'danger',
    title: 'The last sync did not complete. Nothing new was imported.',
  },
  attention: {
    label: 'Synced · check the log', tone: 'warning',
    title: 'The sync succeeded, but some transactions did not make it into the ledger. Open the sync log for the detail.',
  },
  incomplete: {
    label: 'Synced · more history to fetch', tone: 'accent2',
    title: 'Everything the provider offered this time was imported, and older history is still outstanding — the next sync continues from where this one stopped.',
  },
  ok: { label: 'Synced', tone: null, title: 'The last sync completed and imported everything it was offered.' },
}

// The outcome of the last sync, laid out like the Import/Export history card's own outcome row and built
// from the same chips (`SourceAccountChip`) — a sync and a file import answer the same question, and a
// user reads the two surfaces minutes apart, so they should not look like different features.
function LastSyncSummary({ lastSync, syncing, providerAccounts = [], onOpenLog, onOpenReport }) {
  if (syncing) {
    return (
      <div style={{ fontSize: 12, color: 'var(--muted)' }}>
        <span style={{ color: 'var(--accent2)', fontWeight: 600 }}>Syncing…</span>{' '}
        importing transactions from this data source.
      </div>
    )
  }
  if (!lastSync) return null
  const outcome = SYNC_OUTCOMES[lastSync.outcome] || SYNC_OUTCOMES.ok
  const n = (v) => Number(v || 0).toLocaleString()
  const rowTotal = (lastSync.added || 0) + (lastSync.updated || 0) + (lastSync.removed || 0)
  // Every account the connection offers, not only those that received something. An account that imported
  // nothing is exactly what this exists to surface, and it cannot appear in a tally built from what landed
  // — which is why the chips are driven from the offered list and the counts merely joined onto it.
  //
  // The count is rows *seen* for the account, not rows landed, which is what an import card's chip has
  // always meant (`import_batch_account.row_count`, whether or not the account was skipped). Feeding this
  // one `added` alone made the shared chip mean two different things on the two surfaces: a skipped
  // account showed a bare `✕` here and `✕ … 35` there, so the connection card could not say how much data
  // a skipped account was turning away. Only the two no-destination buckets are added in — they arise
  // solely for accounts with no local account, so a mapped account's `−` (offered rows, imported none)
  // cannot be flipped to a `✓` by the routine already-held and zero-amount skips.
  const chips = providerAccounts.map(pa => {
    const c = lastSync.accounts?.[pa.external_account_id]
    return {
      ...pa,
      added: (c?.added || 0) + (c?.skipped_by_choice || 0) + (c?.skipped_unknown_account || 0),
    }
  })
  // Already-held rows this call cannot account for — decided server-side by `unexplained_already_held`
  // and stored on the summary, not re-derived here. Re-deriving it from `mode` is what made this chip
  // disagree with the outcome pill beside it and with the sync log behind it: `mode` stays `initial` for
  // every call of a backfill a metered provider spreads over days, and a walking adapter's overlapping
  // pages re-offer rows the same call just imported. Both are routine, and both used to light this up.
  // A summary written before the server sent the figure has no key, which reads as nothing to report —
  // the next sync fills it in, and staying quiet is the right way to be wrong about a warning.
  //
  // This is the only remaining outcome chip: rows with no destination are carried by the `✕` chips beside
  // it, per account and with their counts, which is both more informative and unambiguous — a separate
  // total sat next to a row of `✕` chips and read as a count of them whenever the two happened to agree.
  const heldUnexplained = Number(lastSync.already_held_unexplained || 0)
  // The import cards this pull wrote to, and whether its rows are still individually identified. Both come
  // from the stored summary rather than being inferred here: `scoped_rows` is 0 both when a pull added
  // nothing and when it added more than the server keeps a row list for, and the card has no way to tell
  // those apart — nor any need to, since the answer is the same either way.
  const reportCards  = lastSync.cards || []
  const reportRows   = Number(lastSync.scoped_rows || 0)
  const reportScoped = reportRows > 0

  return (
    <div style={{ display: 'grid', gap: 6, fontSize: 12, color: 'var(--muted)' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ color: 'var(--muted)' }}>Last sync</span>
        {outcome.tone
          ? <StatusPill tone={outcome.tone} title={outcome.title} onClick={onOpenLog}>{outcome.label}</StatusPill>
          : <span title={outcome.title} style={{ color: 'var(--text)' }}>{outcome.label}</span>}
        <span style={{ fontVariantNumeric: 'tabular-nums' }}>
          {rowTotal ? `${n(rowTotal)} row${rowTotal === 1 ? '' : 's'}` : 'no new transactions'}
        </span>
        {/* The same `↗` launcher used elsewhere on this card, and it opens the ledger over this page
            rather than navigating: finding the right card on the Import / Export history page was the
            entire friction this removes.
            The two modes are named rather than left to look identical, because they answer different
            questions — one shows what this pull delivered, the other the card it landed on, which by
            then usually holds earlier syncs' rows too. Both are useful; being told which one is open
            is what keeps the count in the drawer from reading as a contradiction of the count here. */}
        {onOpenReport && reportCards.length ? (
          <button
            type="button"
            onClick={onOpenReport}
            title={reportScoped
              ? `Review the ${n(reportRows)} transaction${reportRows === 1 ? '' : 's'} from this sync`
              : 'Open the import card this sync added to'}
            style={{
              background: 'none', border: 'none', padding: '0 2px', cursor: 'pointer',
              color: 'var(--accent2)', fontSize: 11, lineHeight: 1, opacity: 0.75,
            }}
          >↗</button>
        ) : null}
      </div>
      {chips.length ? (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          {chips.map(c => (
            <SourceAccountChip
              key={c.external_account_id}
              label={c.label}
              count={c.added}
              skipped={c.mapping_mode === 'skip'}
            />
          ))}
          {heldUnexplained ? (
            <OutcomeChip
              label="Already imported" count={heldUnexplained} tone="warning" onClick={onOpenLog}
              title="Reported as already imported on this connection’s first pull, before it had fetched anything — open the sync log."
            />
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function EnvBadge({ env }) {
  // Sandbox = muted; Production = a live-money warning tone; anything else = neutral.
  const tone = env === 'production'
    ? { bg: 'rgba(220, 38, 38, 0.14)', text: '#dc2626', border: 'rgba(220, 38, 38, 0.4)' }
    : env === 'sandbox'
      ? { bg: 'var(--surface2)', text: 'var(--muted)', border: 'var(--border)' }
      : { bg: 'rgba(37, 99, 235, 0.14)', text: '#2563eb', border: 'rgba(37, 99, 235, 0.4)' }
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center',
      background: tone.bg, color: tone.text, border: `1px solid ${tone.border}`,
      borderRadius: 99, padding: '2px 9px', fontSize: 11, fontWeight: 600, textTransform: 'capitalize',
      whiteSpace: 'nowrap',
    }}>
      {env || 'sandbox'}
    </span>
  )
}

function ProviderConfigDialog({ provider, initial, onSave, onClose, ensureVault }) {
  const [clientId, setClientId] = useState(initial?.client_id || '')
  const [secret, setSecret] = useState('')
  const [env, setEnv] = useState(initial?.env || 'sandbox')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  // What Show fetched, kept so an untouched reveal doesn't save the same secret back and re-encrypt it.
  const [revealedSecret, setRevealedSecret] = useState(null)
  const hasSecret = !!initial?.has_secret

  async function loadStoredSecret() {
    const res = await api.getProviderSecret(provider)
    setSecret(res.secret || '')
    setRevealedSecret(res.secret || '')
  }

  // The stored secret is write-only everywhere else, so revealing it means fetching it — a diagnostic for
  // checking the saved value against the provider's dashboard. Throwing keeps the field hidden rather than
  // showing an empty box that would read as "the secret is blank".
  //
  // The fetch needs the vault, so the gate is *awaited* here rather than reported as a failure:
  // PasswordInput holds the field hidden until this resolves, which is what lets an unlock reveal the
  // secret on the same press of Show. A declined prompt throws, leaving the field hidden and silent.
  async function revealStoredSecret() {
    if (secret) return               // already showing something typed (or previously revealed)
    if (!hasSecret) return
    setError('')
    if (!(await ensureVault())) throw new Error('The vault is still locked.')
    try {
      await loadStoredSecret()
    } catch (e) {
      let failure = e
      // The gate passes on cached flags, so a 423 here means the server dropped the key under us
      // (restart or idle timeout) — the same gate arriving late. Re-prompt and retry once, so this
      // still costs a single press of Show.
      if (failure.status === 423 && await ensureVault({ force: true })) {
        try {
          await loadStoredSecret()
          return
        } catch (retryFailure) { failure = retryFailure }
      }
      setError(failure.status === 423
        ? 'Unlock the vault to view the stored secret.'
        : (failure.message || 'Could not read the stored secret'))
      throw failure
    }
  }

  async function submit() {
    setSaving(true)
    setError('')
    // A blank secret field leaves the stored secret unchanged (write-only), so an edit that only
    // changes client_id/env never forces re-entering the secret. A revealed-but-unedited secret is
    // the same case: it is the stored value, so re-sending it would only churn the ciphertext.
    const payload = { client_id: clientId, env }
    if (secret && secret !== revealedSecret) payload.secret = secret
    // Only storing a secret encrypts anything, so the prompt is raised for that save alone; a declined
    // prompt leaves the form exactly as it was.
    if (payload.secret && !(await ensureVault())) { setSaving(false); return }
    try {
      await onSave(payload)
    } catch (e) {
      let failure = e
      if (failure.status === 423 && await ensureVault({ force: true })) {
        try {
          await onSave(payload)
          return
        } catch (retryFailure) { failure = retryFailure }
      }
      setError(failure.message || 'Could not save credentials')
      setSaving(false)
    }
  }

  return (
    <AppDialog
      title={`Configure ${providerLabel(provider)}`}
      description="These app credentials identify this app to the provider. The secret is stored in the encrypted vault; only the secret needs the vault unlocked to save."
      onClose={onClose}
      width="min(520px, 100%)"
      actions={
        <DialogActions>
          <Button variant="ghost" small onClick={onClose}>Cancel</Button>
          <Button small onClick={submit} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
        </DialogActions>
      }
    >
      <div style={{ display: 'grid', gap: 12 }}>
        <div style={{ display: 'grid', gap: 4, fontSize: 13 }}>
          <span style={{ color: 'var(--muted)' }}>Client ID</span>
          <Input value={clientId} onChange={setClientId} placeholder="Provider client ID" />
        </div>
        <div style={{ display: 'grid', gap: 4, fontSize: 13 }}>
          <span style={{ color: 'var(--muted)' }}>Secret</span>
          <PasswordInput value={secret} onChange={setSecret}
            placeholder={hasSecret ? '•••••••• (leave blank to keep)' : 'Provider secret'}
            onReveal={hasSecret ? revealStoredSecret : undefined}
            {...SENSITIVE_FIELD_PROPS} />
          {hasSecret ? (
            <span style={{ fontSize: 11, color: 'var(--muted)' }}>
              Show reveals the stored secret — for checking it against the provider’s dashboard. Leave the
              field untouched to keep it.
            </span>
          ) : null}
        </div>
        <div style={{ display: 'grid', gap: 4, fontSize: 13 }}>
          <span style={{ color: 'var(--muted)' }}>Environment</span>
          <Select value={env} onChange={setEnv} options={[
            { value: 'sandbox', label: 'Sandbox' },
            { value: 'development', label: 'Development' },
            { value: 'production', label: 'Production' },
          ]} />
        </div>
        {error ? <div style={{ fontSize: 13, color: '#dc2626' }}>{error}</div> : null}
      </div>
    </AppDialog>
  )
}

// How far back a newly connected data source pulls on its first sync. Shared by the connect dialog and the
// Plaid card so the two cannot drift apart. "All available history" is bounded by whatever the provider
// itself will return, which for a cursor provider is its published cap and for a walking provider is where
// its history actually runs out.
const HISTORY_DEPTH_OPTIONS = [
  { value: '0', label: 'All available history' },
  { value: '730', label: 'Last 2 years' },
  { value: '365', label: 'Last year' },
  { value: '90', label: 'Last 90 days' },
  { value: '30', label: 'Last 30 days' },
]

const HISTORY_DEPTH_TITLE = "How far back this data source pulls on its first sync. Saved as your default for future connections. To pull older history for a source that's already connected, use Fetch more history on its card."

// Connect a provider whose authorization is a value the user pastes rather than a widget that opens.
// Everything shown is driven by the provider's `connect_spec` — label, help link, placeholder — so adding
// another token-style provider needs no change here.
//
// The history depth is asked for HERE rather than on the provider's card, because for a provider with no
// app-level credential the card does not exist until a connection does — so a setting living there could
// not be reached at the one moment it applies, and every first connection silently took the default.
function TokenConnectDialog({ provider, spec, historyDays, onConnect, onClose }) {
  const [token, setToken] = useState('')
  // Held locally and handed to `onConnect`, rather than written straight to the shared preference: the
  // connect that follows must use exactly what is on screen, and reading it back from state the click
  // just scheduled is the kind of ordering question worth not having.
  const [days, setDays] = useState(historyDays)
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState('')

  async function submit() {
    setConnecting(true)
    setError('')
    try {
      await onConnect(token.trim(), days)
    } catch (e) {
      // Staying open with the message is deliberate: these tokens are single-use, and the most common
      // failure is a token already claimed — which the user resolves by pasting a fresh one right here.
      setError(e.message || 'Could not connect')
      setConnecting(false)
    }
  }

  return (
    <AppDialog
      title={`Connect ${providerLabel(provider)}`}
      description={`Paste the ${(spec?.label || 'token').toLowerCase()} to link accounts. It is exchanged for a credential that is stored in the encrypted vault.`}
      onClose={onClose}
      width="min(560px, 100%)"
      actions={
        <DialogActions>
          <Button variant="ghost" small onClick={onClose}>Cancel</Button>
          <Button small onClick={submit} disabled={connecting || !token.trim()}>
            {connecting ? 'Connecting…' : 'Connect'}
          </Button>
        </DialogActions>
      }
    >
      <div style={{ display: 'grid', gap: 12 }}>
        <div style={{ display: 'grid', gap: 4, fontSize: 13 }}>
          <span style={{ color: 'var(--muted)' }}>{spec?.label || 'Token'}</span>
          {/* A plain Input rather than a masked or multiline field: a setup token is one long opaque
              string, it is single-use and short-lived, and the user needs to see that the paste landed
              intact — the common failure here is a truncated copy. */}
          <Input
            value={token}
            onChange={setToken}
            placeholder={spec?.placeholder || ''}
            autoFocus
            {...SENSITIVE_FIELD_PROPS}
          />
          {spec?.hint ? (
            <span style={{ fontSize: 11, color: 'var(--muted)' }}>{spec.hint}</span>
          ) : null}
        </div>
        {spec?.help_url ? (
          <p style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5, margin: 0 }}>
            Get one at{' '}
            <a href={spec.help_url} target="_blank" rel="noreferrer noopener">{spec.help_url}</a>.
          </p>
        ) : null}
        <div style={{ display: 'grid', gap: 4, fontSize: 13 }}>
          <span style={{ color: 'var(--muted)' }}>Fetch history</span>
          <Select
            value={String(days)}
            onChange={v => setDays(Number(v))}
            options={HISTORY_DEPTH_OPTIONS}
            title={HISTORY_DEPTH_TITLE}
          />
        </div>
        {error ? <div style={{ fontSize: 13, color: '#dc2626' }}>{error}</div> : null}
      </div>
    </AppDialog>
  )
}


function VaultStrip({ vault, requestCount, onSet, onRequest, onUnlock, onUnlockPasskey,
  passkeyBusy = false, passkeyLabel = VAULT_PASSKEY_LABEL, onLock, onSettings }) {
  const box = (bg, border) => ({
    display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
    background: bg, border: `1px solid ${border}`, borderRadius: 8, padding: '10px 14px', marginBottom: 12,
    fontSize: 13,
  })
  if (!vault.configured) {
    return (
      <div style={box('var(--surface2)', 'var(--border)')}>
        <span style={{ color: 'var(--muted)' }}>Data-source credentials are kept in an encrypted vault. Set a passphrase to begin.</span>
        <Button small onClick={onSet} style={{ marginLeft: 'auto' }}>Set vault passphrase</Button>
      </div>
    )
  }
  // Waiting on someone else, and the only state on this strip with no action on it — which is why it
  // says who has to act rather than offering a button that would do nothing.
  if (vault.accessPending) {
    return (
      <div style={box('var(--surface2)', 'var(--border)')}>
        <span style={{ color: 'var(--muted)' }}>
          Vault access requested. Someone who can already open the vault needs to approve it before you
          can connect or sync data sources.
        </span>
      </div>
    )
  }
  if (!vault.hasPassphrase) {
    return (
      <div style={box('var(--surface2)', 'var(--border)')}>
        <span style={{ color: 'var(--muted)' }}>
          This workspace already has a credential vault. Set your own passphrase to ask for access to it.
        </span>
        <Button small onClick={onRequest} style={{ marginLeft: 'auto' }}>Request vault access</Button>
      </div>
    )
  }
  if (!vault.unlocked) {
    return (
      <div style={box('rgba(234, 179, 8, 0.12)', 'rgba(234, 179, 8, 0.4)')}>
        <span>The vault is locked. Unlock it to connect or sync.</span>
        {/* Offered first where it exists, because it is the day-to-day unlock the passkey slot was added
            for: a touch or a glance against retyping a 20-character passphrase. */}
        {/* Disabled for the duration of the ceremony, and saying so. A WebAuthn prompt is a separate
            window the browser owns, so the strip underneath still looks idle and pressable — which is
            how a second press happened, and the browser answers that with an error dialog stacked on
            top of the prompt. Busy state and wording both come from `useVaultPasskeyUnlock`, shared
            with the passphrase dialog's identical button rather than kept in step by hand. */}
        {vault.hasPasskey ? (
          <Button small onClick={onUnlockPasskey} disabled={passkeyBusy} style={{ marginLeft: 'auto' }}>
            {passkeyLabel}
          </Button>
        ) : null}
        {/* Also disabled: the passphrase dialog opens *over* the passkey prompt, and dismissing one of
            two stacked asks for the same thing is the confusion this whole change is about. */}
        <Button small variant={vault.hasPasskey ? 'ghost' : 'primary'} onClick={onUnlock}
          disabled={passkeyBusy}
          style={vault.hasPasskey ? undefined : { marginLeft: 'auto' }}>
          Unlock with a passphrase
        </Button>
      </div>
    )
  }
  return (
    <div style={box('var(--surface2)', 'var(--border)')}>
      <span style={{ color: 'var(--muted)' }}>Vault unlocked for this session.</span>
      {/* Reachable only while unlocked, and that is the gate rather than the styling: approving someone
          and replacing the key both need the key in hand. The waiting count rides the button because
          this strip is the only place on the page a pending request would otherwise be visible. */}
      <Button variant="ghost" small onClick={onSettings} style={{ marginLeft: 'auto' }}>
        {requestCount ? `Vault settings (${requestCount} waiting)` : 'Vault settings'}
      </Button>
      <Button variant="ghost" small onClick={onLock}>Lock</Button>
    </div>
  )
}

// Load Plaid Link on demand (so normal visits don't pull the third-party script) exactly once. A cached
// promise means repeated "Connect account" attempts reuse the same <script> and global instead of appending a
// fresh tag each time — which previously stacked multiple Link handlers, each firing its own onSuccess.
let plaidScriptPromise = null
function loadPlaidScript() {
  if (window.Plaid) return Promise.resolve()
  if (plaidScriptPromise) return plaidScriptPromise
  plaidScriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js'
    script.onload = () => resolve()
    script.onerror = () => { plaidScriptPromise = null; reject(new Error('Could not load Plaid Link.')) }
    document.head.appendChild(script)
  })
  return plaidScriptPromise
}

function DataSourceConnections({ accounts, onAccountsChanged, currentUser, setCurrentUser, authEnabled, width, disabled,
  onOpenAccountDetail, categories = [], onAddCategory }) {
  const [providers, setProviders] = useState(null)
  const [transport, setTransport] = useState(null)
  const [vault, setVault] = useState({ configured: false, hasPassphrase: false, unlocked: false })
  const [loading, setLoading] = useState(true)
  // Lifted to `SyncStatusContext`: a sync outlives this page. While the driver lived here, navigating
  // away mid-backfill left its poll loop running in a detached closure writing to an unmounted component —
  // the work carried on invisibly and its results landed nowhere. The cards below still read the same
  // shape, they just no longer own it.
  const { syncState, setSyncState, runSync: syncUntilComplete } = useSyncStatus()
  const [configTarget, setConfigTarget] = useState(null)
  const [connectTarget, setConnectTarget] = useState(null)  // provider whose token-connect dialog is open
  // Every action needing an open vault goes through this gate: it prompts and the action then continues
  // itself (see lib/useVaultGate.js). `vaultDialog` is only which passphrase dialog to render.
  const { mode: vaultDialog, ensureVault, openVault, closeVault } = useVaultGate(vault)
  // Held apart from the gate's own mode on purpose: the gate exists to make a blocked action resume once
  // the vault opens, and nothing is waiting on a passphrase change. Sharing its state would give the
  // change dialog a waiter to settle and let a change resolve some unrelated pending action as "unlocked".
  const [changingPassphrase, setChangingPassphrase] = useState(false)
  const [vaultSettingsOpen, setVaultSettingsOpen] = useState(false)
  // Only the count, and only to badge the settings button — the queue itself lives in that dialog. Held
  // here because the strip renders whether or not the dialog has ever been opened.
  const [accessRequestCount, setAccessRequestCount] = useState(0)
  const [notice, setNotice] = useState(null)
  const [disconnectTarget, setDisconnectTarget] = useState(null) // { provider, external_id, institution }
  const [disconnecting, setDisconnecting] = useState(false)
  // "Remove synced transactions": a preflight (how much would go, and which of it was hand-edited since
  // it synced) feeds the confirm dialog before anything is deleted.
  const [removeSyncTarget, setRemoveSyncTarget] = useState(null) // { connection, summary }
  const [removingSync, setRemovingSync] = useState(false)
  // The open connection card's "⋯" menu. One at a time, so it lives on the tab rather than per card.
  const [cardMenu, setCardMenu] = useState(null) // { connectionId, provider, connection, anchorRect }
  // Per-connection sync-record summary (connection_id -> { suspects, cards }), the Connections-tab home for
  // a sync's duplicate review: a synced row lands on a per-(connection, month) import card, and unresolved
  // cross-source duplicates surface here as a badge that jumps to the Import/Export report to resolve them.
  const [syncSummaryByConnection, setSyncSummaryByConnection] = useState({})
  // The same floating import-card ledger the Import / Export page opens, hosted here so a connection's
  // last sync can be reviewed without leaving the tab. Reused rather than rebuilt: that panel is already
  // read-write for categories and already knows how to page, sort, search and bulk-edit a card's rows.
  const { openBatchDetail, panelsNode } = useBatchDetailPanels({ categories, onAddCategory })

  // Open the ledger on whatever the connection's last sync wrote to.
  //
  // ONE panel per card, because one pull can write to two: rows are filed under their own transaction
  // month, so for a few days after a rollover the tail of the previous month arrives beside the current
  // one. Opening only the largest would silently drop rows the summary just counted, and a card cannot
  // show rows that are not on it.
  //
  // `scoped` decides which of the two reports this is. Under the cap the ledger is narrowed to exactly
  // the rows this sync delivered — the case worth having, since a routine sync is a handful of rows
  // someone may well want to categorize on the spot. Over it the ids were never stored and the card
  // opens whole, which is the better report at that size anyway: the only pull that exceeds the cap is
  // a first backfill, and a backfill has a dedicated "Initial import" card that already isolates it.
  const openLastSyncReport = useCallback((connection) => {
    const cards = connection?.last_sync?.cards || []
    if (!cards.length) return
    const scoped = Number(connection?.last_sync?.scoped_rows || 0) > 0
    cards.forEach(card => openBatchDetail({
      id: card.id,
      filename: card.label,
      imported_at: card.imported_at,
      ...(scoped ? { _syncScope: { connectionId: connection.id, label: 'the last sync' } } : {}),
    }))
  }, [openBatchDetail])
  // How far back a new connection's initial pull fetches (`days_requested`; 0 = all available ~24 months).
  // Persisted as the user's default for future connections. Routine syncs pull cursor deltas regardless.
  const [historyDays, setHistoryDays] = useUserPreference('connection.historyDays', 90)
  // Which provider cards are expanded, keyed by provider and remembered across visits — the tab is a
  // place people return to, and re-collapsing the same cards every visit is the kind of small tax that
  // makes a feature not worth using. Absent = the per-card default (see the render).
  const [expandedProviders, setExpandedProviders] = useUserPreference('connection.expandedProviders', {})
  const [refreshingConnId, setRefreshingConnId] = useState(null)  // connection currently being refreshed
  const [fetchingHistoryConnId, setFetchingHistoryConnId] = useState(null)  // connection currently deepening history
  // The account-mapping step. `pendingBackfill` marks the post-Link case, where mapping is required and
  // the historical pull runs only once it is resolved — an unmapped provider account has nowhere to sync
  // into, and the mapping is what gives dedupe its cross-account alias. Reopened from a connection card
  // (without `pendingBackfill`) it is a plain edit.
  const [mapTarget, setMapTarget] = useState(null)   // { connection, accounts, pendingBackfill, days }
  const [mapLoading, setMapLoading] = useState(false)
  const [mapSaving, setMapSaving] = useState(false)
  const [mapError, setMapError] = useState(null)
  const [unmappedByConnection, setUnmappedByConnection] = useState({})
  // {connectionId: [{external_account_id, label, mapped, mapping_mode}]} — names the last sync's
  // per-account counts, including accounts that received nothing.
  const [providerAccountsByConnection, setProviderAccountsByConnection] = useState({})
  // local account id -> the institution the provider says it is at, for a connection spanning several banks
  const [institutionByAccountId, setInstitutionByAccountId] = useState({})
  // While a Plaid Link (+ bank OAuth) session is open, the whole app is blocked behind a modal scrim: the
  // Link handler and its onSuccess closure live in THIS component, so navigating away mid-connect unmounts
  // it and silently loses the in-flight connection. linkInProgress drives the scrim; plaidHandlerRef lets
  // the scrim's Cancel exit Link cleanly. Cleared when Link resolves (onSuccess/onExit) or is canceled.
  const [linkInProgress, setLinkInProgress] = useState(false)
  const plaidHandlerRef = useRef(null)
  const exchangingRef = useRef(false)  // guards against a double Plaid onSuccess exchanging the same token twice
  const navigate = useNavigate()

  // Browser-level leave guard (refresh / close tab / external nav) while a Link session is open. In-app
  // (SPA) navigation is already blocked by the scrim capturing every click; this catches the leaves a
  // click-scrim can't. A true React Router `useBlocker` would additionally guard programmatic route
  // changes, but that hook only works under a data router — this app mounts `BrowserRouter` — so the scrim
  // (click capture) + this beforeunload are the equivalent without an app-wide router migration.
  useEffect(() => {
    if (!linkInProgress) return
    const warn = (e) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [linkInProgress])

  const isAdmin = !authEnabled || currentUser?.role === 'admin'
  // On a networked (non-loopback) bind, the app secret / bank tokens cross the wire, so connecting needs
  // real HTTPS — decoupled from the forward-looking "intend to connect" declaration (see transport docs).
  const httpsBlocked = !!(transport && !transport.is_loopback && !transport.is_https)

  const refresh = useCallback(async () => {
    const [status, provResp, batches] = await Promise.all([
      api.getAuthStatus().catch(() => ({})),
      api.getProviders().catch(() => ({ providers: [] })),
      api.listBatches().catch(() => []),
    ])
    setTransport(status.transport || null)
    const u = status.user || currentUser || {}
    setVault({
      configured: !!u.vault_configured,
      hasPassphrase: !!u.vault_has_passphrase,
      unlocked: !!u.vault_unlocked,
      accessPending: !!u.vault_access_pending,
      hasPasskey: (u.vault_passkeys || []).some(pk => !pk.pending),
    })
    // Only a member holding the key can approve, so only they are asked to look. Fetching it for anyone
    // else would put a count on screen that clicking through could not act on.
    if (u.vault_unlocked) {
      const pending = await api.vaultAccessRequests().catch(() => ({ requests: [] }))
      setAccessRequestCount((pending.requests || []).filter(r => r.user_id !== u.id).length)
    } else {
      setAccessRequestCount(0)
    }
    setProviders(provResp.providers || [])
    // Roll each connection's sync period cards up to a suspect/card count for the review badge below.
    const summary = {}
    for (const b of (batches || [])) {
      if (b.source_kind !== 'connection_sync' || !b.connection_id) continue
      const entry = summary[b.connection_id] || (summary[b.connection_id] = { suspects: 0, cards: 0 })
      entry.suspects += Math.max(0, Number(b.suspect_duplicate_count || 0))
      entry.cards += 1
    }
    setSyncSummaryByConnection(summary)
    // How many of each connection's provider accounts still have no destination. Drives the "N to map"
    // nudge on the card: an unmapped account is silently skipped by every sync until it is resolved, so
    // the state has to be visible rather than inferred from missing transactions.
    const unmapped = {}
    const providerAccounts = {}
    // The institution each mapped account actually sits at, which the connection heading cannot say when
    // one credential spans several banks (a SimpleFIN access URL does). It rides the same fetch as the
    // mapping counts because `connection_account` is where the provider's own naming is kept — a local
    // account carries the name the user gave it, not the bank's.
    const institutions = {}
    await Promise.all(
      (provResp.providers || []).flatMap(p => (p.connections || []).map(async c => {
        try {
          const res = await api.getConnectionAccounts(c.id)
          unmapped[c.id] = res.unmapped || 0
          // Kept for the last-sync breakdown: it is keyed by the *provider's* account id, and only this
          // list can name one that has no local account — which is exactly the row worth showing, since an
          // account receiving nothing cannot appear in any tally built from what landed.
          providerAccounts[c.id] = (res.accounts || []).map(pa => ({
            external_account_id: pa.external_account_id,
            label: pa.source_label || pa.provider_name || pa.external_account_id,
            mapped: !!pa.mapped,
            mapping_mode: pa.mapping_mode,
          }))
          for (const pa of res.accounts || []) {
            if (pa.account_id && pa.provider_official_name) {
              institutions[pa.account_id] = pa.provider_official_name
            }
          }
        } catch { /* a connection whose accounts can't be read just shows no badge */ }
      })),
    )
    setUnmappedByConnection(unmapped)
    setProviderAccountsByConnection(providerAccounts)
    setInstitutionByAccountId(institutions)
    setLoading(false)
  }, [currentUser])

  useEffect(() => { refresh() }, [refresh])

  // Accounts link a connection by account.connection_id == connection.id (6b-3). CSV/manual accounts and
  // disconnected ones have a NULL connection_id, so they naturally fall out of every connection group. The
  // authoritative connection list comes from the backend (p.connections).
  const accountsForConnectionId = useCallback((connectionId) => {
    return (accounts || []).filter(a => a.connection_id === connectionId)
  }, [accounts])

  // Resolves a merged child's group name for the card's account rows.
  const accountLabelById = useMemo(
    () => new Map((accounts || []).map(a => [a.id, a.display_name || a.name])),
    [accounts],
  )

  async function saveConfig(provider, payload) {
    const result = await api.saveProviderConfig(provider, payload)
    await refresh()
    if (result?.transport_warning) {
      setNotice({ title: 'Saved — check your connection security', description: result.transport_warning })
    }
    setConfigTarget(null)
  }

  // The dialog is dismissed only after the session's vault flags have been re-read, so whatever action
  // was waiting on the gate resumes against the state the unlock actually produced.
  async function submitVault(passphrase) {
    // 'set' and 'request' are the same call — which of the two it turns out to be is the server's to
    // decide, since only it knows whether this workspace already has a vault. The response says which
    // happened via `vault_access_pending`.
    const resp = vaultDialog === 'set' || vaultDialog === 'request'
      ? await api.setVaultPassphrase(passphrase)
      : await api.unlockVault(passphrase)
    if (resp?.user) setCurrentUser?.(resp.user)
    await refresh()
    // A request grants nothing yet, so settling the gate as "unlocked" would let whatever action was
    // waiting run straight into a locked vault. It closes as declined, and the strip explains the wait.
    closeVault(!resp?.user?.vault_access_pending)
    if (resp?.user?.vault_access_pending) {
      setNotice({
        title: 'Vault access requested',
        description: 'Your passphrase is saved. It starts opening the vault as soon as someone who can '
          + 'already open it approves the request — they do not need your passphrase to do that.',
      })
    }
  }

  // Deliberately not routed through `closeVault`: no action is waiting, and the vault was already open
  // before this ran — a change rewraps the DEK the session is holding rather than obtaining one.
  async function submitPassphraseChange({ current, next }) {
    const resp = await api.changeVaultPassphrase(current, next)
    if (resp?.user) setCurrentUser?.(resp.user)
    await refresh()
    setChangingPassphrase(false)
    setNotice({
      title: 'Vault passphrase changed',
      description: 'Your data sources are unaffected. Any credentials backup taken before now still '
        + 'needs the previous passphrase to restore.',
    })
  }

  async function lockVault() {
    await api.lockVault().catch(() => { })
    const status = await api.getAuthStatus().catch(() => ({}))
    if (status?.user) setCurrentUser?.(status.user)
    await refresh()
  }

  // What this page does once a passkey has opened the vault, whichever surface ran the ceremony — the
  // strip's own button, or the unlock dialog a gated action raised. Settles the gate exactly as the
  // passphrase path does, so an action waiting on `ensureVault` resumes either way.
  async function adoptPasskeyUnlock(user) {
    if (user) setCurrentUser?.(user)
    await refresh()
    closeVault(true)
  }

  // The strip's button, on the same hook the unlock dialog uses. A refused or dismissed ceremony leaves
  // the strip as it was rather than opening anything, because the passphrase is still one click away on
  // the button beside it — so a refusal here is a notice, where in the dialog it is an inline error.
  const { busy: passkeyBusy, unlock: unlockWithPasskey, label: passkeyLabel } = useVaultPasskeyUnlock({
    onUnlocked: adoptPasskeyUnlock,
    onRefused: message => setNotice({ title: 'Could not use a passkey', description: message }),
  })

  // A 423 is the gate arriving late: this page's "the vault is open" is a cached answer, and the server
  // drops the key on restart and on its idle timeout. So it is answered the same way a locked vault is —
  // prompt, then run the action again — rather than reported as a failure whose remedy the user has to
  // infer. Returns whether the error was this case and has been dealt with.
  async function retriedAfterUnlock(error, action) {
    if (error?.status !== 423) return false
    if (await ensureVault({ force: true })) await action()
    return true
  }

  // The connect affordance comes from the provider's own `connect_spec`, not from its name: a Link-style
  // provider opens its widget, a token-style one collects a pasted value. The vault and HTTPS gates are
  // shared, since they are about the credential this produces rather than how it was obtained. HTTPS is
  // the one gate that stays a refusal: no dialog can resolve it from here.
  async function connect(p) {
    if (!(await ensureVault())) return
    if (httpsBlocked) {
      setNotice({
        title: 'HTTPS required to connect',
        description: 'This server is reachable over the network without HTTPS. Configure HTTPS (a reverse proxy) before connecting a data source, so bank credentials never cross the network in cleartext.',
      })
      return
    }
    if (p.connect_spec?.style === 'token') { setConnectTarget(p); return }
    startPlaidLink()
  }

  // Finish a token-style connect: the same tail Link takes after its callback — refresh, then either the
  // mapping step (which owns the backfill from there) or a straight historical pull.
  async function connectWithToken(provider, token, days) {
    let result
    try {
      result = await api.connectProvider(provider, { setup_token: token })
    } catch (e) {
      // The vault can be dropped between opening this dialog and submitting it, so prompt and send the
      // same token again — a 423 never reached the provider, so a single-use setup token is still good.
      // Anything else (including a declined prompt) goes back to the dialog, which keeps the token on
      // screen and reports the reason.
      if (e.status !== 423 || !(await ensureVault({ force: true }))) throw e
      result = await api.connectProvider(provider, { setup_token: token })
    }
    // Remember the depth chosen in the dialog as the default for next time, but go on using the value that
    // was actually on screen — the persisted copy is a convenience, not the source of truth for this pull.
    if (days !== historyDays) setHistoryDays(days)
    setConnectTarget(null)
    await refresh()
    if (result?.connection_id) {
      if (result.unmapped) {
        await openAccountMap(
          { id: result.connection_id, provider, institution: result.institution },
          { pendingBackfill: true, days },
        )
        return
      }
      await pullConnectionHistory(provider, {
        connectionId: result.connection_id, days,
        failureTitle: 'Connected, but could not pull history',
      })
    }
    await onAccountsChanged?.()
    await refresh()
  }

  // The historical pull that follows a connect or a mapping decision — the same three moves each time:
  // mark the provider syncing, poll to completion, and report a failure without implying the step it
  // followed (the connect, the mapping save) failed with it. A locked vault is handled rather than
  // reported, since the credential is needed by this pull alone and the operation before it is done.
  async function pullConnectionHistory(provider, { connectionId, days, failureTitle }) {
    setSyncState(prev => ({ ...prev, [provider]: { syncing: true, result: null } }))
    try {
      await syncUntilComplete(provider, { days, connectionId, fullHistory: true })
    } catch (e) {
      setSyncState(prev => ({ ...prev, [provider]: { syncing: false, result: null } }))
      if (await retriedAfterUnlock(e, () => pullConnectionHistory(provider, { connectionId, days, failureTitle }))) return
      setNotice({ title: failureTitle, description: e.message })
    }
  }

  async function startPlaidLink() {
    try {
      const { link_token } = await api.getLinkToken()
      await loadPlaidScript()  // loaded once and reused — not re-appended per attempt (would stack handlers)
      const handler = window.Plaid.create({
        token: link_token,
        onSuccess: async (public_token, metadata) => {
          // Plaid's onSuccess can fire more than once; exchange is single-use per token, so guard against a
          // second concurrent call racing into /exchange (the backend is idempotent too, belt-and-braces).
          if (exchangingRef.current) return
          exchangingRef.current = true
          try {
            const result = await api.exchangeToken(public_token, metadata.institution?.name)
            // Link + OAuth are done and the token is now a durable connection — lift the modal block here,
            // BEFORE the (possibly minutes-long) historical backfill, so the app isn't frozen while history
            // streams in. The sync has its own progress UI and resumes from the cursor if interrupted.
            setLinkInProgress(false)
            plaidHandlerRef.current = null
            if (result?.connection_id) {
              await refresh()
              if (result.unmapped) {
                // Accounts still need a destination. The mapping step owns the backfill from here: it
                // runs once every account is resolved, so the first rows pulled are deduped against the
                // accounts they were mapped onto rather than landing unattached.
                await openAccountMap(
                  { id: result.connection_id, provider: result.provider || 'plaid', institution: metadata.institution?.name },
                  { pendingBackfill: true, days: historyDays },
                )
                return
              }
              // Everything was already mapped (a re-link of a bank Luma still knows), so pull straight
              // away — polling until the provider signals the historical backfill is complete.
              await pullConnectionHistory('plaid', {
                connectionId: result.connection_id, days: historyDays,
                failureTitle: 'Connected, but could not pull history',
              })
            }
            await onAccountsChanged?.()
            await refresh()
          } catch (e) {
            setNotice({ title: 'Could not finish connecting', description: e.message })
          } finally {
            exchangingRef.current = false
            setLinkInProgress(false)  // idempotent: also covers an exchange that threw before the release above
          }
        },
        onExit: (err) => {
          // The user closed Link, or it errored out — lift the block either way.
          setLinkInProgress(false)
          plaidHandlerRef.current = null
          if (err) console.error('Plaid Link error', err)
        },
      })
      // Arm the block right before opening Link, and keep the handle so the scrim's Cancel can exit cleanly.
      plaidHandlerRef.current = handler
      setLinkInProgress(true)
      handler.open()
    } catch (e) {
      setLinkInProgress(false)
      plaidHandlerRef.current = null
      if (await retriedAfterUnlock(e, startPlaidLink)) return
      setNotice({ title: 'Could not start the connection', description: e.message })
    }
  }

  // Escape hatch for the connect scrim: never let a stalled Link session trap the app. Exits/destroys Link
  // (which also fires onExit) and lifts the block directly, so the user is freed even if onExit never comes.
  function cancelPlaidLink() {
    try {
      plaidHandlerRef.current?.exit?.({ force: true })
      plaidHandlerRef.current?.destroy?.()
    } catch (e) {
      console.error('Plaid Link cancel failed', e)
    }
    plaidHandlerRef.current = null
    exchangingRef.current = false
    setLinkInProgress(false)
  }

  async function sync(provider) {
    if (syncState[provider]?.syncing) return
    if (!(await ensureVault())) return
    setSyncState(prev => ({ ...prev, [provider]: { syncing: true, result: null } }))
    try {
      // Routine top-up across this provider's connections. days=0 keeps a cursor provider's maintained
      // window at max, so a routine sync never narrows history the initial pull already fetched; a
      // provider with no cursor reads it as "top up", and its own look-back bounds the fetch.
      await syncUntilComplete(provider, { days: 0, connectionId: null })
      await onAccountsChanged?.()
      // A sync changes server-side state this card renders — each connection's last-synced time, its
      // failure count, the review counts — and `onAccountsChanged` only refreshes the *accounts* list.
      // Without this the card keeps showing pre-sync values until something else happens to refetch.
      await refresh()
    } catch (e) {
      setSyncState(prev => ({ ...prev, [provider]: { syncing: false, result: null } }))
      // Refresh on failure too: the failure was recorded server-side, and the badge reporting it is
      // least useful if it only appears after an unrelated reload.
      await refresh()
      if (await retriedAfterUnlock(e, () => sync(provider))) return
      setNotice({ title: 'Sync failed', description: e.message })
    }
  }

  // Open the account-mapping step for a connection. `pendingBackfill` (post-Link) makes every account
  // require a decision and defers the historical pull until they have one; without it this is a plain
  // edit of an existing mapping.
  async function openAccountMap(connection, { pendingBackfill = false, days = null } = {}) {
    setMapError(null)
    setMapLoading(true)
    setMapTarget({ connection, accounts: [], captureFields: [], pendingBackfill, days })
    try {
      const res = await api.getConnectionAccounts(connection.id)
      setMapTarget({
        connection: res.connection || connection,
        accounts: res.accounts || [],
        captureFields: res.capture_fields || [],
        pendingBackfill, days,
      })
      setUnmappedByConnection(prev => ({ ...prev, [connection.id]: res.unmapped || 0 }))
    } catch (e) {
      setMapError(e.message)
    } finally {
      setMapLoading(false)
    }
  }

  // Optional capture fields are saved as they are toggled rather than with the mapping: they are a
  // per-connection setting, not part of the mapping decision, and persisting immediately means a user
  // who closes the dialog without saving a mapping change still keeps the capture choice.
  async function toggleCaptureField(key, enabled) {
    const target = mapTarget
    if (!target) return
    const next = (target.captureFields || []).map(f => (f.key === key ? { ...f, enabled } : f))
    setMapTarget(prev => (prev ? { ...prev, captureFields: next } : prev))
    try {
      const res = await api.setConnectionCapturedFields(
        target.connection.id,
        next.filter(f => !f.locked && f.enabled).map(f => f.key),
      )
      setMapTarget(prev => (prev ? { ...prev, captureFields: res.capture_fields || next } : prev))
    } catch (e) {
      setMapError(e.message)
    }
  }

  async function saveAccountMap(mappings) {
    const target = mapTarget
    if (!target) return
    setMapSaving(true)
    setMapError(null)
    try {
      const res = await api.setConnectionAccountMap(target.connection.id, mappings)
      setUnmappedByConnection(prev => ({ ...prev, [target.connection.id]: res.unmapped || 0 }))
      setMapTarget(null)
      await onAccountsChanged?.()
      // Post-Link: the accounts now exist, so the deferred historical pull can run. It is deliberately
      // after the mapping rather than before, so the very first batch of rows is deduped against
      // whatever the mapped accounts already hold instead of arriving unattached.
      // Two occasions need a pull right after mapping, and they are the same pull: the post-connect
      // backfill, and an account that joined an existing connection later (discovered by sync) and so has
      // no history yet. Without running it here, a just-mapped account sits visibly empty until some later
      // sync happens to collect it.
      if (target.pendingBackfill || res.awaiting_history?.length) {
        await pullConnectionHistory(target.connection.provider || 'plaid', {
          connectionId: target.connection.id,
          days: target.days ?? historyDays,
          failureTitle: 'Mapped, but could not pull history',
        })
        await onAccountsChanged?.()
      }
      // A mapping change re-checks whatever this connection had already synced, since the decision
      // just made is what those rows were missing. Silent when it finds nothing; reported when it
      // acts, because it removed transactions the user could otherwise see vanish unexplained.
      const removed = (res.rescan?.hard_rejected || 0) + (res.rescan?.promoted || 0)
      const flagged = (res.rescan?.soft_flagged || 0) + (res.rescan?.swept || 0)
      if (removed || flagged) {
        const parts = []
        if (removed) parts.push(`${removed} removed as ${removed === 1 ? 'a duplicate' : 'duplicates'}`)
        if (flagged) parts.push(`${flagged} flagged for review`)
        setNotice({
          title: 'Mapping applied — already-synced transactions re-checked',
          description: `${parts.join(', ')}. Removed transactions keep their category and can be restored `
            + 'from this connection’s cards in Import / Export history.',
        })
      }
      await refresh()
    } catch (e) {
      setMapError(e.message)
    } finally {
      setMapSaving(false)
    }
  }

  // Rebuild a connection's account rows from its still-valid credential (no re-link), then poll-sync its
  // history. The one-click recovery after a restore rolled back the accounts but kept the connection.
  async function refreshConnectionAccounts(provider, connection) {
    if (refreshingConnId) return
    if (!(await ensureVault())) return
    setRefreshingConnId(connection.id)
    setSyncState(prev => ({ ...prev, [provider]: { syncing: true, result: null } }))
    try {
      const res = await api.refreshConnectionAccounts(provider, connection.external_id)
      // Recovery syncs at full depth (days=0), independent of the new-connection window: a restore-recovery
      // should pull back as much as the provider will give, not the shallower default a fresh connect might use.
      await syncUntilComplete(provider, { days: 0, connectionId: res.connection_id, fullHistory: true })
      await onAccountsChanged?.()
      await refresh()
    } catch (e) {
      setSyncState(prev => ({ ...prev, [provider]: { syncing: false, result: null } }))
      if (await retriedAfterUnlock(e, () => refreshConnectionAccounts(provider, connection))) return
      setNotice({ title: 'Could not refresh accounts', description: e.message })
    } finally {
      setRefreshingConnId(null)
    }
  }

  // Deepen one connection's history: request all available history and poll to completion. `fullHistory`
  // is what separates this from a routine top-up, which sends the same `days` — for Plaid it raises
  // days_requested and the provider backfills older transactions through the same cursor, while a provider
  // with no cursor reads it as "walk further back" rather than "fetch the recent window again". It is also
  // the only kind of pull permitted to widen the connection's coverage claim backward. A bank/plan may cap
  // how far back it goes.
  async function fetchMoreHistory(provider, connection) {
    if (fetchingHistoryConnId || refreshingConnId) return
    if (!(await ensureVault())) return
    setFetchingHistoryConnId(connection.id)
    try {
      await pullConnectionHistory(provider, {
        connectionId: connection.id, days: 0,
        failureTitle: 'Could not fetch more history',
      })
      await onAccountsChanged?.()
      await refresh()
    } finally {
      setFetchingHistoryConnId(null)
    }
  }

  // Remove everything a connection has synced. The cursor reset that comes with it is why this is a
  // connection-level action rather than a per-card Undo: a routine sync only pulls changes since the
  // cursor, so rows deleted without it would be beyond the reach of any later sync. The dialog opens on
  // the preflight rather than on cached card counts, since the numbers it states are what gets deleted.
  async function openRemoveSynced(connection) {
    setRemoveSyncTarget({ connection, summary: null })
    try {
      const summary = await api.getConnectionSyncedTransactions(connection.id)
      setRemoveSyncTarget({ connection, summary })
    } catch (e) {
      setRemoveSyncTarget(null)
      setNotice({ title: 'Could not read this connection’s synced transactions', description: e.message })
    }
  }

  async function confirmRemoveSynced(force) {
    const target = removeSyncTarget
    if (!target) return
    setRemovingSync(true)
    try {
      const res = await api.removeConnectionSyncedTransactions(target.connection.id, force)
      setRemoveSyncTarget(null)
      await onAccountsChanged?.()
      await refresh()
      // The restored count is reported because it is the one effect with no visible home: rows on other
      // imports that had been removed as duplicates of this connection's copies come back to the ledger.
      setNotice({
        title: 'Synced transactions removed',
        description: `${res.removed} transaction${res.removed === 1 ? '' : 's'} removed.`
          + (res.restored ? ` ${res.restored} transaction${res.restored === 1 ? '' : 's'} from other imports, previously removed as duplicates of them, ${res.restored === 1 ? 'is' : 'are'} back in the ledger.` : '')
          + ' The next sync re-imports this history from the provider.',
      })
    } catch (e) {
      setRemoveSyncTarget(null)
      setNotice({ title: 'Could not remove synced transactions', description: e.message })
    } finally {
      setRemovingSync(false)
    }
  }

  // Disconnecting revokes the credential where the provider allows it, so it needs the vault open. The
  // prompt deliberately comes *after* the confirmation rather than gating the menu item: a passphrase is
  // only worth asking for once the user has committed to disconnecting. The confirm dialog stays open
  // underneath, so backing out of the prompt returns to the decision instead of discarding it.
  async function confirmDisconnect() {
    if (!disconnectTarget) return
    if (!(await ensureVault())) return
    setDisconnecting(true)
    try {
      await api.disconnectProvider(disconnectTarget.provider, disconnectTarget.external_id)
      setDisconnectTarget(null)
      await onAccountsChanged?.()
      await refresh()
    } catch (e) {
      if (await retriedAfterUnlock(e, confirmDisconnect)) return
      setDisconnectTarget(null)
      setNotice({ title: 'Could not disconnect', description: e.message })
    } finally {
      setDisconnecting(false)
    }
  }

  if (loading) return <Card style={{ width: typeof width === 'number' ? `${width}px` : (width || 'fit-content'), maxWidth: '100%', padding: 0 }}><Spinner /></Card>

  const list = providers || []
  // The card menu and the disconnect dialog need a provider's declared capabilities, and both are rendered
  // outside the per-provider loop that has them in hand.
  const providerById = Object.fromEntries(list.map(p => [p.provider, p]))
  const configured = list.filter(p => p.configured)
  const unconfigured = list.filter(p => !p.configured)

  // Everything the collapsed header has to be able to say, so that collapsing a card never hides
  // something that is asking to be acted on. A card is only worth collapsing if what it conceals is
  // routine detail; a failing connection or an unmapped account is neither.
  function providerSummary(p) {
    const connections = p.connections || []
    const reauth = connections.filter(c => c.reauth_required)
    // A connection needing reconnection is also failing, but it is reported only as the former: the two
    // pills would say the same thing twice, and only one of them names something the user can do.
    const failing = connections.filter(c => (c.consecutive_sync_failures || 0) > 0 && !c.reauth_required)
    const warned = connections.filter(c => (c.last_sync_warnings || []).length > 0)
    const synced = connections.map(c => c.last_synced_at).filter(Boolean).sort()
    const unmapped = connections.reduce((n, c) => n + (unmappedByConnection[c.id] || 0), 0)
    const review = connections.reduce((n, c) => n + (syncSummaryByConnection[c.id]?.suspects || 0), 0)
    return {
      connections, reauth, failing, warned, unmapped, review,
      // The OLDEST of the successful pulls, not the newest: the card speaks for every connection under
      // it, so the honest headline is the one that is furthest behind. Taking the newest would let one
      // healthy connection make a card look current while another had not synced in a month.
      lastSynced: synced.length === connections.length && synced.length ? synced[0] : (synced[0] || null),
      allSynced: synced.length === connections.length && synced.length > 0,
    }
  }

  return (
    <>
    <div style={{ display: 'grid', gap: 12, width: typeof width === 'number' ? `${width}px` : (width || '100%'), maxWidth: '100%', opacity: disabled ? 0.55 : 1, pointerEvents: disabled ? 'none' : 'auto' }}>
      {/* Modal block while Plaid Link is open. Plaid's own iframe sits at ~max z-index, so Link stays fully
          interactive above this scrim; the scrim (z 2000, above app chrome) covers the app so a stray click
          can't reach nav and unmount this component mid-connect. Cancel is the never-trapped escape hatch. */}
      {linkInProgress ? (
        <OverlayBackdrop zIndex={2000}>
          <div style={{
            background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12,
            padding: '20px 22px', maxWidth: 380, textAlign: 'center', display: 'grid', gap: 10,
            pointerEvents: 'auto', boxShadow: '0 10px 40px rgba(0,0,0,0.28)',
          }}>
            <div style={{ fontSize: 15, fontWeight: 600 }}>Connecting your account…</div>
            <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.5 }}>
              Finish the steps in the connection window. The rest of the app is paused so a stray click can’t interrupt it.
            </div>
            <div style={{ display: 'flex', justifyContent: 'center', marginTop: 4 }}>
              <Button variant="ghost" small onClick={cancelPlaidLink}>Cancel</Button>
            </div>
          </div>
        </OverlayBackdrop>
      ) : null}
      <VaultStrip
        vault={vault}
        requestCount={accessRequestCount}
        onSet={() => openVault('set')}
        onRequest={() => openVault('request')}
        onUnlock={() => openVault('unlock')}
        onUnlockPasskey={unlockWithPasskey}
        passkeyBusy={passkeyBusy}
        passkeyLabel={passkeyLabel}
        onSettings={() => setVaultSettingsOpen(true)}
        onLock={lockVault}
      />

      {configured.length === 0 && unconfigured.length === 0 ? (
        <Card style={{ padding: 16 }}>
          <p style={{ fontSize: 13, color: 'var(--muted)', margin: 0 }}>No data-source providers are available.</p>
        </Card>
      ) : null}

      {configured.map(p => {
        const connections = p.connections || []
        const ss = syncState[p.provider] || {}
        // Any connection of this provider reporting a live sync — the server's own view, which outlives
        // the page that started it (see `sync_started_at`).
        const serverSyncing = connections.some(c => c.syncing)
        // A locked vault deliberately does NOT disable this: clicking asks for the passphrase and then
        // goes on to connect. What still disables is what no dialog here can resolve — missing HTTPS,
        // and a vault this user cannot open yet, whether because they have not asked for access or
        // because the request has not been approved. Both of those are answered on the strip above,
        // which is where the button's title points.
        const noVaultSlot = vault.configured && !vault.hasPassphrase
        const connectDisabled = disabled || noVaultSlot || httpsBlocked
        const connectTitle = vault.accessPending ? 'Waiting for your vault access to be approved'
          : noVaultSlot ? 'Request access to this workspace’s credential vault first'
            : httpsBlocked ? 'Configure HTTPS before connecting on a networked server'
              : ''
        const s = providerSummary(p)
        const lastSyncedLabel = formatTimestamp(s.lastSynced)
        const expanded = expandedProviders[p.provider] !== undefined
          ? expandedProviders[p.provider]
          // Default: open while there is nothing to sync yet (the card is a setup step, and collapsing
          // it would hide the only action available), collapsed once it is connected and doing its job.
          : connections.length === 0
        return (
          <SectionCard
            key={p.provider}
            title={providerLabel(p.provider)}
            // Same syncing expression the button below uses, deliberately: `ss.syncing` is this
            // component's memory of a pull it started and turns over immediately on click, while
            // `serverSyncing` is the connection's own marker and survives a navigation. Reading only
            // one of them would let the button and the line beside it disagree, which is the class of
            // bug this line already had once. The precedence itself lives in `providerSummaryLine`.
            summary={providerSummaryLine({
              connectionCount: connections.length,
              syncing: ss.syncing || serverSyncing,
              lastSyncedLabel,
            })}
            collapsible
            expanded={expanded}
            onExpandedChange={(next) => setExpandedProviders({ ...expandedProviders, [p.provider]: next })}
            width={width}
            headerCenter={
              // Everything here has to survive collapsing, because each item is asking for something and
              // a nudge only visible after expanding a card is a nudge that will not be seen. The env
              // badge is the exception and stays last: it is context, not a request.
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                {s.reauth.length ? (
                  // First, and its own pill rather than another failure count. Every other sync failure
                  // resolves itself or does not; this one waits on the user, and a count of attempts is
                  // exactly the wrong thing to show for a connection that will never succeed again.
                  <StatusPill tone="danger"
                    title={s.reauth.map(c => `${c.institution || 'Connection'}: ${c.last_sync_error || 'the provider no longer accepts this connection'}`).join('\n')}>
                    ⚠ {s.reauth.length === 1 ? 'reconnect needed' : `${s.reauth.length} need reconnecting`}
                  </StatusPill>
                ) : null}
                {s.failing.length ? (
                  <StatusPill tone="danger"
                    title={s.failing.map(c => `${c.institution || 'Connection'}: ${c.last_sync_error || 'sync failed'} (${c.consecutive_sync_failures} in a row)`).join('\n')}>
                    ⚠ {s.failing.length === connections.length && connections.length > 1
                      ? 'all connections failing'
                      : `${s.failing.length} failing`}
                  </StatusPill>
                ) : null}
                {s.warned.length ? (
                  // Labelled as a message from the provider rather than as "partly synced": the pill
                  // cannot tell a bank that failed to deliver from a server advisory about the request
                  // itself, and asserting missing data when none is missing would send the user looking
                  // for a problem that isn't there. The text they need is the provider's own, in the
                  // tooltip — which says "authentication required" when that is what happened.
                  <StatusPill tone="warning"
                    title={s.warned.map(c => `${c.institution || 'Connection'}: ${(c.last_sync_warnings || []).join('; ')}`).join('\n')}>
                    ⚠ provider notice
                  </StatusPill>
                ) : null}
                {s.unmapped ? (
                  <StatusPill tone="accent2"
                    title={`${s.unmapped} account${s.unmapped === 1 ? '' : 's'} from this data source ${s.unmapped === 1 ? 'has' : 'have'} no destination yet — transactions for ${s.unmapped === 1 ? 'it' : 'them'} are skipped until mapped`}>
                    {s.unmapped} to map
                  </StatusPill>
                ) : null}
                {s.review ? (
                  <StatusPill tone="warning" onClick={() => navigate('/import-export')}
                    title={`${s.review} synced transaction${s.review === 1 ? '' : 's'} may duplicate an existing row — open the Import / Export history to review`}>
                    ⚠ {s.review} to review
                  </StatusPill>
                ) : null}
                {/* No badge for a provider with no test mode: an empty or invented one would imply a
                    sandbox/production distinction it does not have. */}
                {p.env ? <EnvBadge env={p.env} /> : null}
              </span>
            }
            headerActions={
              // Kept out of the collapsed body on purpose: syncing is the one thing a user comes to this
              // card to do routinely, and needing to expand first would make collapsing cost something.
              // `ss.syncing` is this component's memory of a sync *it* started, and it dies with the
              // component — navigating away and back used to re-enable the button while the pull was still
              // running, inviting a second one. `serverSyncing` is the connection's own state, so the
              // button reflects what is actually happening regardless of which page or tab began it.
              <Button variant="ghost" small onClick={() => sync(p.provider)}
                disabled={ss.syncing || serverSyncing || !connections.length}
                title={!connections.length
                  ? `Connect ${providerLabel(p.provider)} before syncing`
                  : (ss.syncing || serverSyncing)
                    ? 'A sync is already running for this data source'
                    : 'Pull new and changed transactions for every connection'}>
                {(ss.syncing || serverSyncing) ? 'Syncing…' : '↻ Sync now'}
              </Button>
            }
          >
            <div style={{ padding: '12px 16px 14px', display: 'grid', gap: 12 }}>
              {/* One-time connection setup (left) is kept distinct from the ongoing "Sync now" op (right),
                  so the history-depth selector below reads as governing new connections, not every sync. */}
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                {/* Configure only where there is something to configure — a provider with no app-level
                    credential would open a dialog with no fields in it. */}
                {isAdmin && p.requires_app_config !== false
                  ? <Button variant="ghost" small onClick={() => setConfigTarget(p)}>Configure</Button> : null}
                {/* Named for the provider, not "account". What this adds is a *connection* to the data
                    source; the accounts belong to that source and arrive with it — and "account" already
                    means a ledger account everywhere else in the app, so using it here named the wrong
                    thing twice over. */}
                <Button small onClick={() => connect(p)} disabled={connectDisabled} title={connectTitle}>
                  + Connect {providerLabel(p.provider)}
                </Button>
                {/* "Sync now" lives in the card header, not here — it is the routine action, so it has to
                    stay reachable while the card is collapsed. */}
              </div>
              {/* Only for a provider whose connect step opens straight into the provider's own widget:
                  there is no dialog of ours to ask in, so the depth has to be chosen before the button is
                  pressed. A token-style provider asks inside its connect dialog instead, at the moment it
                  applies — a second copy here would be a control for a choice already made. */}
              {p.connect_spec?.style !== 'token' ? (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--muted)' }}>
                  <span>New connections fetch</span>
                  <Select
                    value={String(historyDays)}
                    onChange={v => setHistoryDays(Number(v))}
                    options={HISTORY_DEPTH_OPTIONS}
                    title={HISTORY_DEPTH_TITLE}
                    style={{ fontSize: 12, padding: '4px 8px', minWidth: 0, width: 'auto' }}
                  />
                </span>
              ) : null}

              {ss.syncing ? (
                <div style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 14px', fontSize: 13, color: 'var(--muted)' }}>
                  {ss.progress
                    ? `Importing history… ${ss.progress.added} added so far${ss.status === 'INITIAL_UPDATE_COMPLETE' ? ' (fetching older transactions…)' : ''}`
                    : 'Importing history…'}
                </div>
              ) : ss.result ? (
                <div style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 14px', fontSize: 13, color: 'var(--muted)' }}>
                  {ss.incomplete
                    ? `Synced ${ss.result.added} so far — the bank is still sending history. Click Sync now again in a minute to pull the rest.`
                    : ss.paused?.length
                      // Named for what the user sees and what to do about it. Retrying now would not help
                      // and would push the provider toward cutting the connection off entirely.
                      ? `Synced ${ss.result.added} transactions — exhausted ${providerLabel(p.provider)} limit on requests/day. History retrieval will restart on the next sync after the limit resets.`
                      : `Sync complete — ${ss.result.added} added, ${ss.result.updated} updated${ss.result.removed ? `, ${ss.result.removed} removed` : ''}, ${ss.result.skipped} skipped`}
                </div>
              ) : null}

              {connections.length ? (
                <div style={{ display: 'grid', gap: 10 }}>
                  {connections.map(c => {
                    const accts = accountsForConnectionId(c.id)
                    const syncSummary = syncSummaryByConnection[c.id]
                    return (
                      <div key={c.id} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px', display: 'grid', gap: 6 }}>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                          <span style={{ fontWeight: 600, fontSize: 13 }}>{c.institution || 'Linked bank'}</span>
                          {syncSummary?.suspects > 0 ? (
                            <button
                              type="button"
                              onClick={() => navigate('/import-export')}
                              title={`${syncSummary.suspects} synced transaction${syncSummary.suspects === 1 ? '' : 's'} may duplicate an existing row — open the Import / Export history to review this connection's sync cards`}
                              style={{
                                display: 'inline-flex', alignItems: 'center', gap: 4,
                                padding: '1px 8px', borderRadius: 999, fontSize: 11, fontWeight: 600, cursor: 'pointer',
                                background: 'color-mix(in srgb, var(--warning) 12%, var(--surface2))',
                                color: 'var(--warning)',
                                border: '1px solid color-mix(in srgb, var(--warning) 50%, var(--border))',
                              }}
                            >
                              ⚠ {syncSummary.suspects} to review
                            </button>
                          ) : null}
                          {unmappedByConnection[c.id] > 0 ? (
                            <button
                              type="button"
                              onClick={() => openAccountMap(c)}
                              title={`${unmappedByConnection[c.id]} account${unmappedByConnection[c.id] === 1 ? '' : 's'} from this data source ${unmappedByConnection[c.id] === 1 ? 'has' : 'have'} no destination yet — transactions for ${unmappedByConnection[c.id] === 1 ? 'it' : 'them'} are skipped until mapped`}
                              style={{
                                display: 'inline-flex', alignItems: 'center', gap: 4,
                                padding: '1px 8px', borderRadius: 999, fontSize: 11, fontWeight: 600, cursor: 'pointer',
                                background: 'color-mix(in srgb, var(--accent2) 12%, var(--surface2))',
                                color: 'var(--accent2)',
                                border: '1px solid color-mix(in srgb, var(--accent2) 50%, var(--border))',
                              }}
                            >
                              {unmappedByConnection[c.id]} to map
                            </button>
                          ) : null}
                          {/* Card maintenance lives behind one "⋯" rather than a row of buttons. These
                              actions are real but rare, and five permanent controls per card meant a
                              screenful of them at seven connections — louder than the badges above, which
                              are the part of the card that is actually asking for something. Busy state
                              still shows on the trigger's own label, since the menu it lives in is closed
                              while the work runs. */}
                          <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginLeft: 'auto' }}>
                            {fetchingHistoryConnId === c.id || refreshingConnId === c.id ? (
                              <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                                {fetchingHistoryConnId === c.id ? 'Fetching…' : 'Refreshing…'}
                              </span>
                            ) : null}
                            <ActionMenuButton
                              open={cardMenu?.connectionId === c.id}
                              title={`Actions for ${c.institution || 'this connection'}`}
                              disabled={!!refreshingConnId || !!fetchingHistoryConnId || ss.syncing || removingSync}
                              onOpen={rect => setCardMenu({ connectionId: c.id, provider: p.provider, connection: c, anchorRect: rect })}
                            />
                          </div>
                        </div>
                        {/* Stated on the card as well as in the header pill. The pill has to work while
                            collapsed, so it summarizes across connections; this is where the user is when
                            they act, and with several connections under one provider it is the only place
                            that says which one. */}
                        {c.reauth_required ? (
                          <div style={{
                            fontSize: 12, lineHeight: 1.5, borderRadius: 6, padding: '6px 9px',
                            background: 'color-mix(in srgb, var(--danger) 10%, var(--surface2))',
                            border: '1px solid color-mix(in srgb, var(--danger) 40%, var(--border))',
                            color: 'var(--danger)',
                          }}>
                            {c.last_sync_error || 'This data source no longer accepts this connection.'}
                            {' '}Syncing stays stopped until it is connected again.
                          </div>
                        ) : null}
                        <LastSyncSummary
                          lastSync={c.last_sync}
                          syncing={!!c.syncing}
                          providerAccounts={providerAccountsByConnection[c.id] || []}
                          onOpenReport={() => openLastSyncReport(c)}
                          onOpenLog={() => navigate(
                            `/settings?section=connectionSyncLog&connection=${encodeURIComponent(c.id)}`,
                          )}
                        />
                        {/* Titled because the block above it is now also a list of accounts — the sync's
                            per-account outcome — and without a heading the two read as one confusing run
                            of names. These are the local accounts the connection feeds; those were the
                            provider's own accounts and what each contributed. */}
                        {accts.length ? (
                          <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.04em', marginTop: 2 }}>
                            Connected accounts
                          </div>
                        ) : null}
                        {accts.length ? accts.map(a => (
                          <div key={a.id} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, color: 'var(--muted)' }}>
                            <span style={{ color: 'var(--text)' }}>{a.display_name || a.name}</span>
                            {a.mask ? <span>····{a.mask}</span> : null}
                            {/* The same launcher the Accounts tab uses, on the same handler — a connection's
                                account list is a place a user wants to go *look at* the account, and having
                                to find the row again on another tab is friction with no reason behind it. */}
                            <button
                              type="button"
                              onClick={() => onOpenAccountDetail?.({
                                id: a.id, name: a.display_name || a.name, mask: a.mask,
                              })}
                              title={`View ${a.display_name || a.name}`}
                              style={{
                                background: 'none', border: 'none', padding: '0 2px', cursor: 'pointer',
                                color: 'var(--accent2)', fontSize: 11, lineHeight: 1, opacity: 0.75,
                              }}
                            >↗</button>
                            {/* One credential can cover several banks (a SimpleFIN access URL does), so the
                                card's own institution name does not identify which bank an account is at.
                                Shown only when it adds something the card heading doesn't already say. */}
                            {institutionByAccountId[a.id] && institutionByAccountId[a.id] !== c.institution ? (
                              <span style={{ fontSize: 11 }}>{institutionByAccountId[a.id]}</span>
                            ) : null}
                            {/* Named because a merged account is otherwise indistinguishable here from a
                                standalone one, and the group is where its transactions are read. */}
                            {a.parent_account_id ? (
                              <span style={{ fontSize: 11 }}>
                                in {accountLabelById.get(a.parent_account_id) || 'a merged group'}
                              </span>
                            ) : null}
                          </div>
                        )) : (
                          // Two different empty states wearing one message before: a connection whose
                          // provider accounts were never pulled needs "Refresh accounts", while one
                          // whose accounts are pulled but undecided needs the mapping step. Sending the
                          // second case to Refresh is advice that cannot work — the accounts are already
                          // here, they just have nowhere to go. Both name the menu they now live in,
                          // since neither is a visible button any more.
                          <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                            {unmappedByConnection[c.id] > 0
                              ? `${unmappedByConnection[c.id]} account${unmappedByConnection[c.id] === 1 ? '' : 's'} from this data source ${unmappedByConnection[c.id] === 1 ? 'has' : 'have'} no destination yet — map ${unmappedByConnection[c.id] === 1 ? 'it' : 'them'} in ⋯ → “Connection settings…”.`
                              : 'No accounts imported yet — pull them in with ⋯ → “↻ Refresh accounts”.'}
                          </span>
                        )}
                      </div>
                    )
                  })}
                </div>
              ) : (
                <p style={{ fontSize: 13, color: 'var(--muted)', margin: 0, lineHeight: 1.6 }}>
                  {/* The sandbox note only makes sense for a provider that has one; for the rest it would
                      describe a mode they cannot be in. */}
                  {p.env === 'sandbox'
                    ? 'Running in Sandbox — use the provider’s test credentials when the connect dialog opens. Switch to Production on Configure once you’re ready for real accounts.'
                    : 'Connect an account to keep balances and transactions in sync.'}
                </p>
              )}
            </div>
          </SectionCard>
        )
      })}

      {/* Adding a data source means whatever its first step actually is: entering app credentials for a
          provider that has them, and connecting straight away for one that has none — for which a
          Configure dialog would open with nothing in it. Providers needing credentials stay admin-only;
          one that needs none is gated on the vault like any other connect. */}
      {unconfigured.length && unconfigured.some(p => isAdmin || p.requires_app_config === false) ? (
        <Card style={{ padding: '12px 16px', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13, color: 'var(--muted)' }}>Add a data source:</span>
          {unconfigured
            .filter(p => isAdmin || p.requires_app_config === false)
            .map(p => (
              <Button key={p.provider} variant="ghost" small
                onClick={() => (p.requires_app_config === false ? connect(p) : setConfigTarget(p))}>
                + {providerLabel(p.provider)}
              </Button>
            ))}
        </Card>
      ) : null}

      {connectTarget ? (
        <TokenConnectDialog
          provider={connectTarget.provider}
          spec={connectTarget.connect_spec}
          historyDays={historyDays}
          onConnect={(token, days) => connectWithToken(connectTarget.provider, token, days)}
          onClose={() => setConnectTarget(null)}
        />
      ) : null}

      {configTarget ? (
        <ProviderConfigDialog
          provider={configTarget.provider}
          initial={configTarget}
          onSave={(payload) => saveConfig(configTarget.provider, payload)}
          ensureVault={ensureVault}
          onClose={() => setConfigTarget(null)}
        />
      ) : null}

      {vaultDialog ? (
        <VaultPassphraseDialog mode={vaultDialog} onSubmit={submitVault}
          onUnlockedByPasskey={adoptPasskeyUnlock} onClose={() => closeVault(false)} />
      ) : null}
      {changingPassphrase ? (
        <VaultPassphraseDialog mode="change" onSubmit={submitPassphraseChange}
          onClose={() => setChangingPassphrase(false)} />
      ) : null}
      {vaultSettingsOpen ? (
        <VaultSettingsDialog
          currentUserId={currentUser?.id}
          isAdmin={isAdmin}
          onChangePassphrase={() => { setVaultSettingsOpen(false); setChangingPassphrase(true) }}
          onChanged={refresh}
          onClose={() => setVaultSettingsOpen(false)}
        />
      ) : null}

      {disconnectTarget ? (
        <AppConfirmDialog
          title={`Disconnect ${disconnectTarget.institution || 'this bank'}?`}
          // Two materially different outcomes, so they get two different sentences. Where the provider can
          // be told to revoke, disconnecting really does end the access. Where it cannot, only Luma's copy
          // of the credential goes and the credential itself stays live — saying otherwise would leave
          // someone believing they had cut off access they still have.
          description={disconnectTarget.revokes
            ? 'This revokes the connection at the provider, so it can no longer pull transactions (and any leaked copy of the token also stops working). Existing accounts and their transactions are kept. Reconnecting later means linking the bank again.'
            : `This removes the connection from Luma, so it stops pulling transactions here. Existing accounts and their transactions are kept. ${providerLabel(disconnectTarget.provider)} has no way to revoke a credential from another app, so the access itself stays valid until it is revoked at the provider.`}
          confirmLabel={disconnecting ? 'Disconnecting…' : 'Disconnect'}
          confirmDisabled={disconnecting}
          cancelDisabled={disconnecting}
          onConfirm={confirmDisconnect}
          onCancel={() => setDisconnectTarget(null)}
        />
      ) : null}

      {/* Grouped by what the action is for: the mapping decision, then the two provider re-pulls, then
          the two that take something away. Only Disconnect is styled danger — it revokes the token at
          the provider, so coming back means a fresh Link the bank (or the plan) may not grant. Removing
          synced transactions reads more destructive than it is: the cursor reset is what makes the next
          sync pull the same history back, so its red belongs on the confirm button, not here. */}
      {cardMenu ? (
        <ActionMenu
          anchorRect={cardMenu.anchorRect}
          onClose={() => setCardMenu(null)}
          minWidth={220}
          items={[
            {
              label: 'Connection settings…',
              title: 'Choose what each account from this data source maps to — an existing account, a new one, or skipped — and which details future syncs capture. The mapping is also how Luma recognizes transactions already imported from a file.',
              onClick: () => openAccountMap(cardMenu.connection),
            },
            {
              label: '↻ Fetch more history',
              separatorBefore: true,
              title: 'Pull older transactions for this connection — requests all available history from the provider and imports anything earlier than what’s already here. A bank or plan may cap how far back it will return.',
              onClick: () => fetchMoreHistory(cardMenu.provider, cardMenu.connection),
            },
            {
              label: '↻ Refresh accounts',
              title: 'Rebuild this connection’s accounts from its saved credential (no re-linking), then sync. Use this if the accounts are missing — e.g. after restoring a backup. To pull older transactions, use Fetch more history.',
              onClick: () => refreshConnectionAccounts(cardMenu.provider, cardMenu.connection),
            },
            {
              label: 'View sync log',
              separatorBefore: true,
              title: 'What every sync of this connection actually did — how much arrived, whether the full history was fetched, and anything the provider reported. The place to look when a connection brings in nothing, or less than expected.',
              onClick: () => navigate(
                `/settings?section=connectionSyncLog&connection=${encodeURIComponent(cardMenu.connection.id)}`,
              ),
            },
            {
              label: 'Remove synced transactions',
              separatorBefore: true,
              title: 'Delete every transaction this connection has synced and reset how far it has pulled, so the next sync re-imports that history from the provider. The connection, its accounts, and their mapping are kept.',
              onClick: () => openRemoveSynced(cardMenu.connection),
            },
            {
              label: 'Disconnect',
              danger: true,
              title: providerById[cardMenu.provider]?.revokes_on_disconnect === false
                ? 'Remove this connection from Luma. Existing accounts and transactions are kept. This provider has no way to revoke a credential from here, so revoking it means going to the provider.'
                : 'Revoke this connection at the provider. Existing accounts and transactions are kept, but reconnecting means linking the bank again.',
              onClick: () => setDisconnectTarget({
                provider: cardMenu.provider,
                external_id: cardMenu.connection.external_id,
                institution: cardMenu.connection.institution,
                revokes: providerById[cardMenu.provider]?.revokes_on_disconnect !== false,
              }),
            },
          ]}
        />
      ) : null}

      {removeSyncTarget ? (() => {
        const summary = removeSyncTarget.summary
        const edited = summary?.edited_transactions || []
        const count = summary?.transaction_count || 0
        return (
          <AppConfirmDialog
            title={`Remove synced transactions from ${removeSyncTarget.connection.institution || 'this bank'}?`}
            confirmLabel={removingSync ? 'Removing…'
              : edited.length ? 'Remove all anyway'
                : count ? `Remove ${count} transaction${count === 1 ? '' : 's'}`
                  : 'Reset sync history'}
            confirmVariant="danger"
            confirmDisabled={!summary || removingSync}
            cancelDisabled={removingSync}
            onConfirm={() => confirmRemoveSynced(edited.length > 0)}
            onCancel={() => setRemoveSyncTarget(null)}
          >
            {!summary ? <Spinner /> : (
              <>
                <EditedTransactionsWarning rows={edited} suffix="after syncing" />
                <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.6 }}>
                  {count
                    ? `${count} transaction${count === 1 ? '' : 's'} synced from this connection will be permanently deleted, along with ${summary.card_count === 1 ? 'its sync card' : `their ${summary.card_count} sync cards`} in the import history.`
                    : 'No synced transactions are recorded for this connection.'}
                  {' '}The connection stays linked and its accounts and mapping are kept. What resets is how
                  far this connection has pulled, so the next sync re-imports its history from the provider
                  rather than only changes since the last one.
                </div>
              </>
            )}
          </AppConfirmDialog>
        )
      })() : null}

      {mapTarget ? (
        <ConnectionAccountMapDialog
          connection={mapTarget.connection}
          providerAccounts={mapTarget.accounts}
          captureFields={mapTarget.captureFields}
          accounts={accounts}
          onToggleCaptureField={toggleCaptureField}
          loading={mapLoading}
          saving={mapSaving}
          error={mapError}
          requireAll={mapTarget.pendingBackfill}
          onSave={saveAccountMap}
          onClose={() => { setMapTarget(null); setMapError(null) }}
        />
      ) : null}

      {notice ? (
        <AppNoticeDialog title={notice.title} description={notice.description} onClose={() => setNotice(null)} />
      ) : null}
    </div>
    {/* Outside the wrapper above on purpose: it dims and disables itself while another workspace owns the
        page, and these panels float over the app rather than belonging to the tab that opened them. */}
    {panelsNode}
    </>
  )
}

function PillSelect({ value, options, onChange, placeholder = '—', minOpenWidth = 132, createLabel = null, onCreate = null, onContextMenu = null, disabled = false }) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef(null)
  const listRef = useRef(null)
  const [menuPos, setMenuPos] = useState(null)
  const selectedLabel = options.find(o => o.value === (value || ''))?.label || placeholder

  const { openUp } = useDismissiblePopup({
    open,
    setOpen,
    anchorRef: wrapRef,
    popupRef: listRef,
    placementDeps: [options.length],
    disabled,
  })

  useLayoutEffect(() => {
    if (!open) {
      setMenuPos(null)
      return
    }
    if (!listRef.current || !wrapRef.current) return
    const rect = wrapRef.current.getBoundingClientRect()
    setMenuPos({
      left: rect.left,
      top: rect.bottom + 4,
      width: Math.max(minOpenWidth, rect.width),
    })
  }, [minOpenWidth, open, options.length])

  return (
    <div ref={wrapRef} style={{ position: 'relative', display: 'inline-flex', width: 'fit-content', maxWidth: '100%', zIndex: open ? 250 : 1 }}>
      <button
        type="button"
        onClick={() => {
          if (disabled) return
          if (!open && wrapRef.current) {
            const rect = wrapRef.current.getBoundingClientRect()
            setMenuPos({
              left: rect.left,
              top: rect.bottom + 4,
              width: Math.max(minOpenWidth, rect.width),
            })
          }
          setOpen(prev => !prev)
        }}
        onContextMenu={disabled ? undefined : onContextMenu}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 'fit-content',
          maxWidth: '100%',
          height: ACCOUNT_CONTROL_HEIGHT,
          background: 'var(--surface2)',
          color: 'var(--text)',
          border: '1px solid var(--border)',
          borderRadius: 999,
          padding: '0 8px',
          fontSize: 11,
          lineHeight: 1.1,
          cursor: disabled ? 'default' : 'pointer',
          whiteSpace: 'nowrap',
          opacity: disabled ? 0.6 : 1,
        }}
        title={disabled ? undefined : 'Click to change'}
      >
        {selectedLabel}
      </button>
      {open ? (
        <div
          ref={listRef}
          style={{
            position: 'fixed',
            left: menuPos?.left ?? 0,
            minWidth: menuPos?.width ?? minOpenWidth,
            width: 'max-content',
            maxWidth: 240,
            background: 'var(--surface2)',
            border: '1.5px solid color-mix(in srgb, var(--text) 22%, var(--border))',
            borderRadius: 10,
            boxShadow: '0 2px 8px rgba(0,0,0,0.12), 0 12px 40px rgba(0,0,0,0.36)',
            padding: 4,
            zIndex: 200,
            visibility: menuPos ? 'visible' : 'hidden',
            ...(openUp ? { top: Math.max(8, (menuPos?.top ?? 0) - (listRef.current?.offsetHeight || 0) - 32) } : { top: menuPos?.top ?? 0 }),
          }}
        >
          {options.map(option => {
            const active = option.value === (value || '')
            return (
              <button
                key={option.value}
                type="button"
                onMouseDown={e => {
                  e.preventDefault()
                  onChange(option.value || '')
                  setOpen(false)
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  width: '100%',
                  textAlign: 'left',
                  background: active ? 'var(--surface2)' : 'none',
                  border: 'none',
                  color: 'var(--text)',
                  fontSize: 12,
                  padding: '7px 9px',
                  borderRadius: 7,
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                }}
              >
                <span style={{ flex: 1 }}>{option.label}</span>
                {active ? <span style={{ fontSize: 11, color: 'var(--accent2)' }}>✓</span> : null}
              </button>
            )
          })}
          {createLabel && onCreate ? (
            <>
              <div style={{ height: 1, background: 'var(--border)', margin: '4px 6px' }} />
              <button
                type="button"
                onClick={e => {
                  e.stopPropagation()
                  setOpen(false)
                  onCreate()
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  width: '100%',
                  textAlign: 'left',
                  background: 'none',
                  border: 'none',
                  color: 'var(--accent2)',
                  fontSize: 12,
                  padding: '7px 9px',
                  borderRadius: 7,
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                  fontWeight: 600,
                }}
              >
                {createLabel}
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function DraftAccountRow({ owners, onCreate, onCancel, creating, gridTemplateColumns }) {
  const formId = 'draft-account-form'
  const [name, setName] = useState('')
  const [type, setType] = useState('depository')
  const [ownerId, setOwnerId] = useState('')
  const [ownerError, setOwnerError] = useState('')
  const nameRef = useRef(null)
  const personalOwners = getPersonalOwners(owners)
  const assignableOwners = getAssignableOwners(owners)

  useEffect(() => {
    nameRef.current?.focus()
  }, [])

  useEffect(() => {
    if (personalOwners.length === 1) {
      setOwnerId(personalOwners[0].id)
      setOwnerError('')
    }
  }, [personalOwners])

  async function submit() {
    const trimmed = name.trim()
    if (!trimmed || creating) return
    if (personalOwners.length > 1 && !ownerId) {
      setOwnerError('Select an owner before creating this account.')
      return
    }
    setOwnerError('')
    await onCreate({ name: trimmed, type, owner_id: ownerId || null })
    setName('')
    setType('depository')
    setOwnerId(personalOwners.length === 1 ? personalOwners[0]?.id || '' : '')
  }

  return (
    <div style={{ position: 'relative', borderBottom: '1px solid var(--border)', background: 'color-mix(in srgb, var(--surface2) 65%, var(--surface))' }}>
      <form
        id={formId}
        onSubmit={e => {
          e.preventDefault()
          submit()
        }}
      >
        <div style={{
          display: 'grid',
          gridTemplateColumns,
          gap: ACCOUNT_ROW_GAP,
          alignItems: 'center',
          padding: ACCOUNT_ROW_PADDING,
        }}>
          <div />

          <div style={{ minWidth: 0 }}>
            <TransientTextInput
              ref={nameRef}
              value={name}
              onChange={setName}
              onCommit={submit}
              onCancel={onCancel}
              restoreOnEscape
              onBlurCommit={false}
              placeholder="Account name"
              style={controlStyle({
                minWidth: 0,
                padding: '0 9px',
                fontSize: 12,
                height: ACCOUNT_CONTROL_HEIGHT,
                boxSizing: 'border-box',
              })}
            />
          </div>

          <PillSelect
            value={type}
            options={ACCOUNT_TYPES}
            onChange={setType}
            minOpenWidth={160}
          />

          <div style={{ display: 'flex', justifyContent: 'center', minWidth: 0 }}>
            <PillSelect
              value={ownerId}
              placeholder={personalOwners.length > 1 ? 'Owner required' : 'Owner'}
              options={assignableOwners.map(o => ({ value: o.id, label: o.name }))}
              onChange={value => {
                setOwnerId(value)
                setOwnerError('')
              }}
              minOpenWidth={138}
            />
          </div>

          <div />

          <button
            type="button"
            onClick={onCancel}
            title="Cancel new account"
            style={{
              background: 'none',
              border: '1px solid var(--border)',
              color: 'var(--muted)',
              cursor: 'pointer',
              fontSize: 16,
              width: 28,
              height: ACCOUNT_CONTROL_HEIGHT,
              lineHeight: 1,
              padding: 0,
              borderRadius: 6,
              justifySelf: 'end',
            }}
          >
            ×
          </button>
        </div>
        {ownerError && (
          <div style={{ padding: '0 10px 2px 10px', fontSize: 11, color: 'var(--danger)' }}>
            {ownerError}
          </div>
        )}
      </form>
    </div>
  )
}

function OwnerPill({ owner, editing, draft, onDraftChange, onStartEdit, onCommitEdit, onCancelEdit, onContextMenu }) {
  const shared = isSharedOwner(owner)
  if (editing) {
    return (
      <TransientTextInput
        value={draft}
        onChange={onDraftChange}
        onCommit={onCommitEdit}
        onCancel={onCancelEdit}
        restoreOnEscape
        style={controlStyle({
          width: Math.max(78, draft.length * 8 + 28),
          minWidth: 78,
          maxWidth: 180,
          height: ACCOUNT_CONTROL_HEIGHT,
          padding: '0 10px',
          borderRadius: 999,
          fontSize: 12,
          boxSizing: 'border-box',
        })}
      />
    )
  }

  return (
    <button
      type="button"
      onClick={onStartEdit}
      onContextMenu={shared ? (e => e.preventDefault()) : onContextMenu}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: 28,
        padding: '0 10px',
        borderRadius: 999,
        border: '1px solid var(--border)',
        background: 'var(--surface2)',
        color: 'var(--text)',
        fontSize: 12,
        fontStyle: shared ? 'italic' : 'normal',
        cursor: shared ? 'default' : 'text',
        whiteSpace: 'nowrap',
        opacity: shared ? 0.86 : 1,
      }}
      title={shared ? 'Built-in shared owner' : 'Click to rename'}
      disabled={shared}
    >
      {owner.name}
    </button>
  )
}

function OwnersPanel({ owners, onCreateOwner, onSaveOwner, onDeleteOwner, onError = () => { }, disabled = false, width, expanded, onExpandedChange, collapsible = true }) {
  const visibleOwners = getPersonalOwners(owners)
  const ownersSummary = formatCountSummary(visibleOwners.length, 'owner')
  const [editingOwnerId, setEditingOwnerId] = useState(null)
  const [ownerDraft, setOwnerDraft] = useState('')
  const [creatingOwner, setCreatingOwner] = useState(false)
  const [newOwnerDraft, setNewOwnerDraft] = useState('')
  const [ownerMenu, setOwnerMenu] = useState(null)
  const newOwnerInputRef = useRef(null)
  const ownerMenuRef = useRef(null)

  useEffect(() => {
    if (disabled) {
      setEditingOwnerId(null)
      setOwnerDraft('')
      setCreatingOwner(false)
      setNewOwnerDraft('')
      setOwnerMenu(null)
    }
  }, [disabled])

  useDismissibleLayer({
    open: !!ownerMenu,
    onClose: () => setOwnerMenu(null),
    refs: [ownerMenuRef],
    closeOnBlur: true,
  })

  useLayoutEffect(() => {
    if (!creatingOwner) return
    const id = requestAnimationFrame(() => {
      newOwnerInputRef.current?.focus()
      newOwnerInputRef.current?.select?.()
    })
    return () => cancelAnimationFrame(id)
  }, [creatingOwner])

  async function commitEdit() {
    const trimmed = ownerDraft.trim()
    const current = owners.find(o => o.id === editingOwnerId)
    if (!current) {
      setEditingOwnerId(null)
      setOwnerDraft('')
      return
    }
    if (!trimmed || trimmed === current.name) {
      setEditingOwnerId(null)
      setOwnerDraft('')
      return
    }
    await onSaveOwner(current.id, { name: trimmed })
    setEditingOwnerId(null)
    setOwnerDraft('')
  }

  async function submitNewOwner() {
    const trimmed = newOwnerDraft.trim()
    if (!trimmed) return
    try {
      await onCreateOwner(trimmed)
      setCreatingOwner(false)
      setNewOwnerDraft('')
    } catch (error) {
      onError('Could not create owner', error)
    }
  }

  return (
    <SectionCard
      title="Account Owners"
      summary={ownersSummary}
      expanded={expanded}
      onExpandedChange={onExpandedChange}
      collapsible={collapsible}
      disabled={disabled}
      width={width}
      style={collapsible ? {
        marginTop: 12,
      } : undefined}
    >
      <div style={{ padding: '12px 16px 14px' }}>
        {visibleOwners.length > 0 ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
            {visibleOwners.map(owner => (
              <OwnerPill
                key={owner.id}
                owner={owner}
                editing={editingOwnerId === owner.id}
                draft={ownerDraft}
                onDraftChange={setOwnerDraft}
                onStartEdit={() => {
                  setEditingOwnerId(owner.id)
                  setOwnerDraft(owner.name)
                  setCreatingOwner(false)
                  setNewOwnerDraft('')
                }}
                onCommitEdit={commitEdit}
                onCancelEdit={() => {
                  setEditingOwnerId(null)
                  setOwnerDraft('')
                }}
                onContextMenu={e => {
                  e.preventDefault()
                  setOwnerMenu({ x: e.clientX, y: e.clientY, owner })
                }}
              />
            ))}
            {creatingOwner ? (
              <div style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '6px 8px',
                borderRadius: 999,
                border: '1px solid var(--border)',
                background: 'color-mix(in srgb, var(--surface2) 74%, var(--surface))',
              }}>
                <TransientTextInput
                  ref={newOwnerInputRef}
                  value={newOwnerDraft}
                  onChange={setNewOwnerDraft}
                  onCommit={submitNewOwner}
                  onCancel={() => {
                    setCreatingOwner(false)
                    setNewOwnerDraft('')
                  }}
                  restoreOnEscape
                  onBlurCommit={false}
                  placeholder="name"
                  style={controlStyle({
                    width: 104,
                    minWidth: 0,
                    background: 'var(--surface)',
                    border: '1px solid var(--accent)',
                    borderRadius: 999,
                    padding: '0 8px',
                    fontSize: 11,
                    height: 22,
                    boxSizing: 'border-box',
                  })}
                />
                <Button small onClick={submitNewOwner} disabled={!newOwnerDraft.trim()} style={{ height: 22, padding: '0 9px', borderRadius: 999, fontSize: 11 }}>
                  Add
                </Button>
                <Button
                  small
                  variant="ghost"
                  style={{ height: 22, padding: '0 8px', borderRadius: 999, fontSize: 11 }}
                  onClick={() => {
                    setCreatingOwner(false)
                    setNewOwnerDraft('')
                  }}
                >
                  Cancel
                </Button>
              </div>
            ) : (
              <Button
                small
                variant="ghost"
                onClick={() => {
                  setEditingOwnerId(null)
                  setOwnerDraft('')
                  setCreatingOwner(true)
                }}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  height: ACCOUNT_CONTROL_HEIGHT,
                  borderRadius: 999,
                  lineHeight: 1,
                }}
              >
                +New owner
              </Button>
            )}
          </div>
        ) : creatingOwner ? (
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <TransientTextInput
              ref={newOwnerInputRef}
              value={newOwnerDraft}
              onChange={setNewOwnerDraft}
              onCommit={submitNewOwner}
              onCancel={() => {
                setCreatingOwner(false)
                setNewOwnerDraft('')
              }}
              restoreOnEscape
              onBlurCommit={false}
              placeholder="name"
              style={controlStyle({
                width: 104,
                minWidth: 0,
                background: 'var(--surface)',
                border: '1px solid var(--accent)',
                borderRadius: 999,
                padding: '0 8px',
                fontSize: 11,
                height: 22,
                boxSizing: 'border-box',
              })}
            />
            <Button small onClick={submitNewOwner} disabled={!newOwnerDraft.trim()} style={{ height: 22, padding: '0 9px', borderRadius: 999, fontSize: 11 }}>
              Add
            </Button>
            <Button
              small
              variant="ghost"
              style={{ height: 22, padding: '0 8px', borderRadius: 999, fontSize: 11 }}
              onClick={() => {
                setCreatingOwner(false)
                setNewOwnerDraft('')
              }}
            >
              Cancel
            </Button>
          </div>
        ) : (
          <Button
            small
            variant="ghost"
            onClick={() => setCreatingOwner(true)}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: ACCOUNT_CONTROL_HEIGHT,
              borderRadius: 999,
              lineHeight: 1,
            }}
          >
            +New owner
          </Button>
        )}
        {ownerMenu ? (
          <div
            ref={ownerMenuRef}
            onMouseDown={e => e.stopPropagation()}
            style={{
              position: 'fixed',
              left: Math.min(ownerMenu.x, window.innerWidth - 160),
              top: Math.min(ownerMenu.y, window.innerHeight - 100),
              zIndex: 260,
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: 10,
              boxShadow: '0 14px 36px rgba(0,0,0,0.18)',
              padding: 4,
              minWidth: 150,
            }}
          >
            <button
              onClick={() => {
                if (isSharedOwner(ownerMenu.owner)) {
                  setOwnerMenu(null)
                  return
                }
                setOwnerMenu(null)
                setCreatingOwner(false)
                setEditingOwnerId(ownerMenu.owner.id)
                setOwnerDraft(ownerMenu.owner.name)
              }}
              style={{
                display: 'block', width: '100%', textAlign: 'left',
                background: 'none', border: 'none', color: 'var(--text)',
                fontSize: 13, padding: '8px 10px', borderRadius: 6, cursor: 'pointer',
              }}
            >
              Rename
            </button>
            <button
              onClick={async () => {
                const owner = ownerMenu.owner
                setOwnerMenu(null)
                if (isSharedOwner(owner)) return
                try {
                  await onDeleteOwner(owner)
                } catch (error) {
                  onError('Could not delete owner', error)
                }
              }}
              style={{
                display: 'block', width: '100%', textAlign: 'left',
                background: 'none', border: 'none', color: 'var(--danger)',
                fontSize: 13, padding: '8px 10px', borderRadius: 6, cursor: 'pointer',
              }}
            >
              Delete
            </button>
          </div>
        ) : null}
      </div>
    </SectionCard>
  )
}

// Tags cell for one account row. Top-level accounts show and edit their own tags; child accounts
// show the parent's tags as muted/inherited (read-only) — a child's own tags are dormant while
// merged (resolved through the effective account on the backend), so they aren't editable here.
function AccountTagsCell({
  account, isChild, parentAccount, allTags, editMode,
  pickerOpen, onOpenPicker, onClosePicker, onSetTags, onTagCreated,
}) {
  const tagsById = new Map((allTags || []).map(tag => [tag.id, tag]))
  const ownTagIds = Array.isArray(account.tag_ids) ? account.tag_ids : []
  const inheritedTagIds = isChild && Array.isArray(parentAccount?.tag_ids) ? parentAccount.tag_ids : []
  const displayTagIds = isChild ? inheritedTagIds : ownTagIds
  const pills = displayTagIds.map(id => tagsById.get(id)).filter(Boolean)
  const editable = !isChild
  // The "+" add-tag control shows in page-wide edit mode, and also for a single row whose picker was
  // opened on its own (via the row's right-click "Edit tags…") — the picker anchors its floating
  // position to this button, so the row needs it rendered even when edit mode is off.
  const showControls = editable && (editMode || pickerOpen)

  // The picker floats beside the "+" via fixed positioning rather than dropping down over the
  // column, so the tag column below stays uncovered and the user can open the next row's picker
  // without first closing this one. It opens to the right of the button (clamped to the viewport),
  // and clamps vertically so it never spills past the edge or gets clipped by the list's own scroll
  // container the way an absolutely-positioned panel would on the bottom rows.
  const addButtonRef = useRef(null)
  const pickerRef = useRef(null)
  const [pickerPos, setPickerPos] = useState(null)

  useLayoutEffect(() => {
    if (!(editable && pickerOpen)) {
      setPickerPos(null)
      return undefined
    }
    function place() {
      const anchor = addButtonRef.current
      if (!anchor) return
      const rect = anchor.getBoundingClientRect()
      const pad = 8
      const gap = 6
      const panelW = pickerRef.current?.offsetWidth || 252
      const panelH = pickerRef.current?.offsetHeight || 320
      let left = rect.right + gap
      if (left + panelW > window.innerWidth - pad) {
        left = Math.max(pad, window.innerWidth - panelW - pad)
      }
      let top = rect.top
      if (top + panelH > window.innerHeight - pad) {
        top = Math.max(pad, window.innerHeight - panelH - pad)
      }
      setPickerPos({ left, top })
    }
    place()
    // Reposition as the panel grows (e.g. entering "+ New tag" create mode) and on scroll/resize.
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(place) : null
    if (observer && pickerRef.current) observer.observe(pickerRef.current)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [editable, pickerOpen])

  function toggleTag(tag, nextChecked) {
    const next = new Set(ownTagIds)
    if (nextChecked) next.add(tag.id)
    else next.delete(tag.id)
    onSetTags(account.id, Array.from(next))
  }

  return (
    <div style={{ position: 'relative', minWidth: 0, display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
      {pills.map(tag => (
        <span
          key={tag.id}
          title={isChild ? `${tag.name} (inherited from ${parentAccount?.display_name || parentAccount?.name || 'parent account'})` : tag.name}
          style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 16, height: 16, borderRadius: '50%', flexShrink: 0,
            background: tag.color || 'var(--muted)', color: '#fff',
            fontSize: 9, fontWeight: 700, lineHeight: 1, cursor: 'default', userSelect: 'none',
            border: isChild ? '1.5px solid color-mix(in srgb, #0f172a 28%, transparent)' : 'none',
            opacity: isChild ? 0.75 : 1,
          }}
        >
          {((tag.name || '').trim().charAt(0) || '?').toUpperCase()}
        </span>
      ))}
      {showControls ? (
        <button
          ref={addButtonRef}
          type="button"
          onClick={() => onOpenPicker(account.id)}
          title="Add or remove tags"
          style={{
            width: 18, height: 18, borderRadius: '50%', border: '1px dashed var(--border)', background: 'var(--surface)',
            color: 'var(--muted)', cursor: 'pointer', fontSize: 12, lineHeight: 1, padding: 0, flexShrink: 0,
          }}
        >
          +
        </button>
      ) : null}
      {editable && pickerOpen ? (
        <div
          ref={pickerRef}
          style={{
            position: 'fixed',
            left: pickerPos?.left ?? 0,
            top: pickerPos?.top ?? 0,
            zIndex: 520,
            borderRadius: 10,
            boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
            visibility: pickerPos ? 'visible' : 'hidden',
          }}
        >
          <TagPickerWithCreate
            allTags={allTags}
            selectedTagIds={new Set(ownTagIds)}
            onToggleTag={toggleTag}
            onTagCreated={onTagCreated}
            onClose={onClosePicker}
            positioning="relative"
          />
        </div>
      ) : null}
    </div>
  )
}

function AccountRow({
  account,
  parentAccount = null,
  hasChildren = false,
  isLastChild = false,
  isCollapsed = false,
  onToggleCollapse,
  restrictedOwnerOptions = null,
  gridTemplateColumns,
  owners,
  onSave,
  onRequestDelete,
  confirmingDelete,
  onCancelDelete,
  onOpenDetail,
  onCreateOwnerForAccount,
  onRequestRenameOwner,
  onRequestDeleteOwner,
  onRequestTrash,
  onError = () => { },
  interactionDisabled = false,
  dragDisabled = false,
  dropActive = false,
  onDragStart,
  onDragEnd,
  allTags = [],
  tagsEditMode = false,
  tagPickerAccountId = null,
  onOpenTagPicker = () => { },
  onCloseTagPicker = () => { },
  onSetAccountTags = () => { },
  onAccountTagCreated = () => { },
  onAccountContextMenu = () => { },
}) {
  const [, setSavingName] = useState(false)
  const [creatingOwner, setCreatingOwner] = useState(false)
  const [ownerDraft, setOwnerDraft] = useState('')
  const [showOwnerCreate, setShowOwnerCreate] = useState(false)
  const [ownerCreatePos, setOwnerCreatePos] = useState(null)
  const [ownerMenu, setOwnerMenu] = useState(null)
  const rowRef = useRef(null)
  const ownerCreateRef = useRef(null)
  const ownerInputRef = useRef(null)
  const ownerAnchorRef = useRef(null)
  const ownerMenuRef = useRef(null)
  // The name button's tooltip shows the edit hint normally, but the full account name when the label is
  // ellipsized by a narrow column — measured on hover so it stays correct as the column/window resizes.
  const nameTextRef = useRef(null)
  const [nameHoverTitle, setNameHoverTitle] = useState('Click to edit name')
  const {
    editing: editingName,
    setEditing: setEditingName,
    draft: nameDraft,
    setDraft: setNameDraft,
    beginEdit: beginEditingName,
    cancelEdit: cancelEditingName,
    commitEdit: commitName,
  } = useTransientTextEdit(account.name || '', {
    onCommit: async nextName => {
      setSavingName(true)
      try {
        await savePatch({ name: nextName })
      } finally {
        setSavingName(false)
      }
    },
  })

  const isChild = !!parentAccount

  useEffect(() => {
    if (interactionDisabled) setEditingName(false)
  }, [interactionDisabled, setEditingName])

  useEffect(() => {
    if (!interactionDisabled) return
    setShowOwnerCreate(false)
    setOwnerDraft('')
    setOwnerCreatePos(null)
    setOwnerMenu(null)
  }, [interactionDisabled])

  useLayoutEffect(() => {
    if (!showOwnerCreate) return
    if (ownerAnchorRef.current) {
      const rect = ownerAnchorRef.current.getBoundingClientRect()
      setOwnerCreatePos({
        left: rect.left,
        top: rect.top + rect.height / 2,
      })
    }
    const focusId = requestAnimationFrame(() => {
      ownerInputRef.current?.focus()
      ownerInputRef.current?.select?.()
    })
    function updatePosition() {
      if (!ownerAnchorRef.current) return
      const rect = ownerAnchorRef.current.getBoundingClientRect()
      setOwnerCreatePos({
        left: rect.left,
        top: rect.top + rect.height / 2,
      })
    }
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    return () => {
      cancelAnimationFrame(focusId)
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [showOwnerCreate])

  useDismissibleLayer({
    open: showOwnerCreate,
    onClose: () => {
      setShowOwnerCreate(false)
      setOwnerDraft('')
      setOwnerCreatePos(null)
    },
    refs: [ownerCreateRef, ownerAnchorRef],
  })

  useDismissibleLayer({
    open: !!ownerMenu,
    onClose: () => setOwnerMenu(null),
    refs: [ownerMenuRef],
    closeOnBlur: true,
  })

  const typeValue = account.type || 'other'
  const displayOwnerId = account.owner_id || ''
  const transactionCount = Number(account.transaction_count || 0)
  const deletePrompt = transactionCount > 0
    ? <>Remove <strong>{account.name}</strong> and {transactionCount} transaction{transactionCount === 1 ? '' : 's'}?</>
    : <>Remove <strong>{account.name}</strong>?</>
  const assignableOwners = getAssignableOwners(owners)
  // Parents with children may toggle between their personal owner and shared — restricted options
  // are passed in from the parent to enforce this. Children and plain accounts use all assignable owners.
  const effectiveOwnerOptions = restrictedOwnerOptions ?? assignableOwners
  const detailAccount = parentAccount || account
  const canShowOwnerControls = !isChild
  // Allow owner change on parents-with-children but only between personal owner and shared.
  const ownerEditDisabled = interactionDisabled || isChild
  const typeEditDisabled = interactionDisabled || isChild || hasChildren
  const canDrag = !interactionDisabled && !dragDisabled
  const deleteDisabled = interactionDisabled || (!isChild && hasChildren)

  async function savePatch(patch) {
    await onSave(account.id, patch)
  }

  async function changeType(type) {
    if (type === typeValue) return
    await savePatch({ type })
  }

  async function changeOwner(owner_id) {
    const next = owner_id || ''
    if (next === (account.owner_id || '')) return
    await savePatch({ owner_id: next })
  }

  async function submitCreateOwner() {
    const trimmed = ownerDraft.trim()
    if (!trimmed || creatingOwner) return
    setShowOwnerCreate(false)
    setOwnerDraft('')
    setCreatingOwner(true)
    try {
      await onCreateOwnerForAccount(account.id, trimmed)
    } catch (error) {
      onError('Could not create owner', error)
    } finally {
      setCreatingOwner(false)
    }
  }

  async function handleRenameOwner() {
    if (!account.owner_id) return
    const current = owners.find(o => o.id === account.owner_id)
    if (isSharedOwner(current)) return
    setOwnerMenu(null)
    onRequestRenameOwner(current || { id: account.owner_id, name: account.owner_name || '' })
  }

  async function handleDeleteOwner() {
    if (!account.owner_id) return
    const current = owners.find(o => o.id === account.owner_id)
    if (isSharedOwner(current)) return
    setOwnerMenu(null)
    onRequestDeleteOwner(current || { id: account.owner_id, name: account.owner_name || 'owner' })
  }

  return (
    <div
      ref={rowRef}
      data-account-row
      data-account-row-id={account.id}
      style={{
        position: 'relative',
        borderBottom: '1px solid var(--border)',
        background: dropActive ? 'color-mix(in srgb, var(--accent) 10%, var(--surface))' : 'transparent',
      }}
    >
      {isChild && (
        <div style={{
          position: 'absolute',
          left: 10,
          top: 0,
          width: 2,
          height: isLastChild ? '50%' : '100%',
          background: 'var(--border)',
          borderRadius: 1,
          pointerEvents: 'none',
        }} />
      )}
      <div
        onContextMenu={isChild ? undefined : (event => onAccountContextMenu(account.id, event))}
        style={{
          display: 'grid',
          gridTemplateColumns,
          gap: ACCOUNT_ROW_GAP,
          alignItems: 'center',
          padding: ACCOUNT_ROW_PADDING,
          paddingLeft: isChild ? `${10 + ACCOUNT_ROW_CHILD_INDENT}px` : undefined,
        }}>
        <button
          type="button"
          draggable={canDrag}
          onDragStart={event => onDragStart?.(event, account)}
          onDragEnd={() => onDragEnd?.()}
          onClick={event => event.preventDefault()}
          title={canDrag ? (isChild ? 'Drag to reorder or pull out to top level' : 'Drag to merge or reorder') : undefined}
          style={{
            background: 'none',
            border: 'none',
            color: canDrag ? 'var(--muted)' : 'color-mix(in srgb, var(--muted) 55%, transparent)',
            cursor: canDrag ? 'grab' : 'default',
            fontSize: 14,
            padding: 0,
            width: 22,
            lineHeight: 1,
          }}
        >
          ⋮⋮
        </button>

        <div style={{ minWidth: 0 }}>
          {editingName ? (
            <TransientTextInput
              value={nameDraft}
              onChange={setNameDraft}
              onCommit={commitName}
              onCancel={cancelEditingName}
              restoreOnEscape
              style={controlStyle({
                minWidth: 0,
                padding: '0 9px',
                fontSize: 12,
                height: ACCOUNT_CONTROL_HEIGHT,
                boxSizing: 'border-box',
              })}
            />
          ) : (
            <button
              type="button"
              onClick={() => {
                if (interactionDisabled) return
                beginEditingName(account.name || '')
              }}
              onMouseEnter={() => {
                if (interactionDisabled) return
                const el = nameTextRef.current
                setNameHoverTitle(el && el.scrollWidth > el.clientWidth ? account.name : 'Click to edit name')
              }}
              title={interactionDisabled ? undefined : nameHoverTitle}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                background: 'none',
                border: 'none',
                padding: 0,
                color: 'var(--text)',
                cursor: interactionDisabled ? 'default' : 'text',
                minWidth: 0,
                width: '100%',
                textAlign: 'left',
                opacity: interactionDisabled ? 0.75 : 1,
              }}
            >
              <span ref={nameTextRef} style={{
                fontWeight: 500,
                fontSize: 12,
                lineHeight: `${ACCOUNT_CONTROL_HEIGHT}px`,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}>
                {account.name}
              </span>
              <span
                onClick={e => {
                  e.stopPropagation()
                  if (interactionDisabled) return
                  onOpenDetail?.({ id: detailAccount.id, name: detailAccount.display_name || detailAccount.name, mask: detailAccount.mask })
                }}
                title={interactionDisabled ? undefined : 'View account detail'}
                style={{
                  color: 'var(--accent2)',
                  cursor: interactionDisabled ? 'default' : 'pointer',
                  fontSize: 10,
                  padding: '3px 5px',
                  opacity: interactionDisabled ? 0.4 : 0.75,
                  lineHeight: 1,
                  flexShrink: 0,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderRadius: 6,
                }}
              >
                ↗
              </span>
            </button>
          )}
          {/* Lines under the account name. The connection detail line (institution · ···mask) comes first so
              it stays paired with the name on line 1; a merged *parent's* expand/collapse control sits below
              it (line 3). Shown for every account — parent, child, or standalone — so becoming part of a
              merged group no longer hides which real account a row maps to. (Costs a row of height on merged
              entries — acceptable given the table stays small.) CSV/manual accounts have no institution/mask,
              so no detail line renders. */}
          <div style={{ marginTop: 2, display: 'grid', gap: 1 }}>
            {(account.institution || account.mask) ? (
              <div style={{ fontSize: 10, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {account.institution && <span>{account.institution} · </span>}
                {account.mask && <span>···{account.mask}</span>}
              </div>
            ) : null}
            {hasChildren && !isChild ? (
              <button
                type="button"
                onClick={e => { e.stopPropagation(); onToggleCollapse?.() }}
                style={{
                  background: 'none',
                  border: 'none',
                  padding: 0,
                  cursor: 'pointer',
                  color: 'var(--muted)',
                  fontSize: 10,
                  lineHeight: 1,
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  justifySelf: 'start',
                }}
                title={isCollapsed ? 'Show merged accounts' : 'Hide merged accounts'}
              >
                <span style={{ fontSize: 9 }}>{isCollapsed ? '▶' : '▼'}</span>
                <span>{hasChildren === 1 ? '1 merged account' : `${hasChildren} merged accounts`}</span>
              </button>
            ) : null}
          </div>
        </div>

        {isChild ? (
          <div style={{ fontSize: 11, color: 'var(--muted)' }}> </div>
        ) : (
          <PillSelect
            value={typeValue}
            options={ACCOUNT_TYPES}
            onChange={changeType}
            minOpenWidth={160}
            disabled={typeEditDisabled}
          />
        )}

        <div ref={ownerAnchorRef} style={{ display: 'flex', justifyContent: 'center', minWidth: 0, position: 'relative' }}>
          {!canShowOwnerControls ? (
            <div style={{ fontSize: 11, color: 'var(--muted)' }} />
          ) : effectiveOwnerOptions.length > 0 ? (
            <PillSelect
              value={displayOwnerId}
              placeholder="Assign owner"
              options={effectiveOwnerOptions.map(o => ({ value: o.id, label: o.name }))}
              onChange={changeOwner}
              minOpenWidth={138}
              createLabel={restrictedOwnerOptions ? null : 'Create owner...'}
              onCreate={restrictedOwnerOptions ? null : () => {
                setOwnerDraft('')
                setShowOwnerCreate(true)
              }}
              onContextMenu={account.owner_id && !isSharedOwner(owners.find(o => o.id === account.owner_id)) ? (e => {
                e.preventDefault()
                e.stopPropagation()
                setOwnerMenu({ x: e.clientX, y: e.clientY })
              }) : null}
              disabled={ownerEditDisabled}
            />
          ) : (
            <button
              type="button"
              onClick={() => {
                if (ownerEditDisabled) return
                setOwnerDraft('')
                setShowOwnerCreate(true)
              }}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 'fit-content',
                maxWidth: '100%',
                height: ACCOUNT_CONTROL_HEIGHT,
                background: 'var(--surface2)',
                color: 'var(--text)',
                border: '1px solid var(--border)',
                borderRadius: 999,
                padding: '0 9px',
                fontSize: 11,
                lineHeight: 1.1,
                cursor: ownerEditDisabled ? 'default' : 'pointer',
                whiteSpace: 'nowrap',
                opacity: ownerEditDisabled ? 0.6 : 1,
              }}
              title={ownerEditDisabled ? undefined : 'Create and assign owner'}
            >
              Assign owner
            </button>
          )}
          {showOwnerCreate && canShowOwnerControls ? (
            <div
              ref={ownerCreateRef}
              onMouseDown={e => e.stopPropagation()}
              style={{
                position: 'fixed',
                left: ownerCreatePos?.left ?? 0,
                top: ownerCreatePos?.top ?? 0,
                transform: 'translateY(-50%)',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                minWidth: 220,
                padding: '6px 8px',
                background: 'color-mix(in srgb, var(--surface2) 74%, var(--surface))',
                border: '1px solid var(--border)',
                borderRadius: 999,
                boxShadow: '0 12px 26px rgba(0, 0, 0, 0.16)',
                zIndex: 260,
                visibility: ownerCreatePos ? 'visible' : 'hidden',
              }}
            >
              <TransientTextInput
                ref={ownerInputRef}
                value={ownerDraft}
                onChange={setOwnerDraft}
                onCommit={submitCreateOwner}
                onCancel={() => {
                  setShowOwnerCreate(false)
                  setOwnerDraft('')
                }}
                restoreOnEscape
                onBlurCommit={false}
                placeholder="name"
                style={controlStyle({
                  width: 104,
                  minWidth: 0,
                  background: 'var(--surface)',
                  border: '1px solid var(--accent)',
                  borderRadius: 999,
                  padding: '0 8px',
                  fontSize: 11,
                  height: 22,
                  boxSizing: 'border-box',
                })}
              />
              <Button
                small
                onClick={submitCreateOwner}
                disabled={!ownerDraft.trim() || creatingOwner}
                style={{ height: 22, padding: '0 9px', borderRadius: 999, fontSize: 11 }}
              >
                {creatingOwner ? 'Adding...' : 'Add'}
              </Button>
              <Button
                small
                variant="ghost"
                style={{ height: 22, padding: '0 8px', borderRadius: 999, fontSize: 11 }}
                onClick={() => {
                  setShowOwnerCreate(false)
                  setOwnerDraft('')
                }}
              >
                Cancel
              </Button>
            </div>
          ) : null}
          {ownerMenu && canShowOwnerControls ? (
            <div
              ref={ownerMenuRef}
              onMouseDown={e => e.stopPropagation()}
              style={{
                position: 'fixed',
                left: Math.min(ownerMenu.x, window.innerWidth - 160),
                top: Math.min(ownerMenu.y, window.innerHeight - 100),
                zIndex: 260,
                background: 'var(--surface)',
                border: '1px solid var(--border)',
                borderRadius: 10,
                boxShadow: '0 14px 36px rgba(0,0,0,0.18)',
                padding: 4,
                minWidth: 150,
              }}
            >
              <button
                onClick={handleRenameOwner}
                style={{
                  display: 'block', width: '100%', textAlign: 'left',
                  background: 'none', border: 'none', color: 'var(--text)',
                  fontSize: 13, padding: '8px 10px', borderRadius: 6, cursor: 'pointer',
                }}
              >
                Rename
              </button>
              <button
                onClick={handleDeleteOwner}
                style={{
                  display: 'block', width: '100%', textAlign: 'left',
                  background: 'none', border: 'none', color: 'var(--danger)',
                  fontSize: 13, padding: '8px 10px', borderRadius: 6, cursor: 'pointer',
                }}
              >
                Delete
              </button>
              <div style={{ height: 1, background: 'var(--border)', margin: '4px 6px' }} />
              <button
                onClick={() => {
                  setOwnerMenu(null)
                  setOwnerDraft('')
                  setShowOwnerCreate(true)
                }}
                style={{
                  display: 'block', width: '100%', textAlign: 'left',
                  background: 'none', border: 'none', color: 'var(--accent2)',
                  fontSize: 13, padding: '8px 10px', borderRadius: 6, cursor: 'pointer',
                  fontWeight: 600,
                }}
              >
                +New owner
              </button>
            </div>
          ) : null}
        </div>

        <AccountTagsCell
          account={account}
          isChild={isChild}
          parentAccount={parentAccount}
          allTags={allTags}
          editMode={tagsEditMode}
          pickerOpen={tagPickerAccountId === account.id}
          onOpenPicker={onOpenTagPicker}
          onClosePicker={onCloseTagPicker}
          onSetTags={onSetAccountTags}
          onTagCreated={onAccountTagCreated}
        />

        <button
          type="button"
          onClick={() => {
            if (deleteDisabled) return
            if (isChild) {
              onRequestTrash?.(account)
              return
            }
            onRequestDelete(account.id)
          }}
          title={deleteDisabled ? (!isChild && hasChildren ? 'Trash or ungroup the merged child accounts first' : undefined) : (isChild ? 'Send child account to trash' : 'Delete account')}
          style={{
            background: 'none',
            border: '1px solid var(--border)',
            color: isChild ? 'var(--danger)' : 'var(--muted)',
            cursor: deleteDisabled ? 'default' : 'pointer',
            fontSize: 16,
            width: 28,
            height: ACCOUNT_CONTROL_HEIGHT,
            lineHeight: 1,
            padding: 0,
            borderRadius: 6,
            justifySelf: 'end',
            opacity: deleteDisabled ? 0.45 : 1,
          }}
        >
          ×
        </button>
      </div>

      {confirmingDelete && (
        <div style={{
          margin: '0 12px 8px 62px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: 12,
          padding: '8px 12px',
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 10,
          boxShadow: '0 12px 30px rgba(0, 0, 0, 0.14)',
          fontSize: 12,
        }}>
          <div style={{ color: 'var(--muted)' }}>
            {deletePrompt}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button small variant="danger" onClick={() => onCancelDelete(account.id, true)}>Remove</Button>
            <Button small variant="ghost" onClick={() => onCancelDelete(account.id, false)}>Cancel</Button>
          </div>
        </div>
      )}
    </div>
  )
}

export default function Accounts() {
  /*
   * This page keeps three account states in one workspace:
   * - top-level rows are the selectable physical accounts used everywhere else in the app
   * - child rows preserve historical account numbers while sharing the parent's display identity
   * - trash is only the reversible holding state before permanent cleanup happens from Settings
   */
  const [accounts, setAccounts] = useState([])
  const [owners, setOwners] = useState([])
  const [availableTags, setAvailableTags] = useState([])
  const [tagsEditMode, setTagsEditMode] = useState(false)
  const [tagPickerAccountId, setTagPickerAccountId] = useState(null)
  const [categories, setCategories] = useState([])
  const [loading, setLoading] = useState(true)
  const [confirmDeleteId, setConfirmDeleteId] = useState(null)
  const [pendingTrashAccount, setPendingTrashAccount] = useState(null)
  const [noticeDialog, setNoticeDialog] = useState(null)
  const [promoteTagsDialog, setPromoteTagsDialog] = useState(null)
  const [pendingOwnerDelete, setPendingOwnerDelete] = useState(null)
  const [ownerRenameDialog, setOwnerRenameDialog] = useState(null)
  const [showCreateAccount, setShowCreateAccount] = useState(false)
  const [creatingAccount, setCreatingAccount] = useState(false)
  const [contextOpen, setContextOpen] = useState(false)
  const [listContextMenu, setListContextMenu] = useState(null) // { x, y }
  const [detailAccounts, setDetailAccounts] = useState([])
  const { dbInstanceId, preferenceSubjectId: userId, currentUser, setCurrentUser, authEnabled } = useAppSession()
  const { preferences, setPreference } = useUserPreferences()
  const [sectionExpandedState, setSectionExpandedState] = useState({})
  const [sectionStateLoaded, setSectionStateLoaded] = useState(false)
  const [draggingAccountId, setDraggingAccountId] = useState(null)
  const [sortKey, setSortKey] = useState('type') // 'name' | 'type' | 'owner'
  const [sortDir, setSortDir] = useState('asc')
  const [sortDirections, setSortDirections] = useState(DEFAULT_ACCOUNT_SORT_DIRECTIONS)
  const [sortLoaded, setSortLoaded] = useState(false)
  const [sortIndicatorActive, setSortIndicatorActive] = useState(true)
  // dropIntent: null | { kind: 'merge', targetId: string } | { kind: 'detach', accountId: string }
  const [dropIntent, setDropIntent] = useState(null)
  const [dragTooltip, setDragTooltip] = useState(null) // { x, y, message }
  const [movingAccountId, setMovingAccountId] = useState(null)
  const [collapsedGroups, setCollapsedGroups] = useState(new Set()) // Set of parent account IDs
  const [collapsedGroupsLoaded, setCollapsedGroupsLoaded] = useState(false)
  // null = no owner filter (show all); empty string = unassigned-only; otherwise the selected owner_id.
  const [ownerFilter, setOwnerFilter] = useState(null)
  const dragTooltipTimerRef = useRef(null)
  const listRef = useRef(null)
  const accountsPanelRef = useRef(null)
  const initialSortSeedRef = useRef('')
  const [accountsPanelWidth, setAccountsPanelWidth] = useState(ACCOUNTS_SECTION_BASE_WIDTH)
  const sectionPanelWidth = accountsPanelWidth

  // Active in-page tab, session-scoped (sticks while the app is open, resets to Accounts next launch). A
  // `?tab=` query param (e.g. from a Tasks deep-link that targets a specific tab) takes precedence on arrival.
  const [searchParams, setSearchParams] = useSearchParams()
  const [tab, setTabState] = useState(() => {
    const fromUrl = searchParams.get('tab')
    if (ACCOUNT_TABS.some(([id]) => id === fromUrl)) return fromUrl
    const stored = typeof sessionStorage !== 'undefined' ? sessionStorage.getItem(ACCOUNTS_TAB_STORAGE_KEY) : null
    return ACCOUNT_TABS.some(([id]) => id === stored) ? stored : 'accounts'
  })
  function setTab(next) {
    setTabState(next)
    try { sessionStorage.setItem(ACCOUNTS_TAB_STORAGE_KEY, next) } catch { /* sessionStorage unavailable — non-fatal */ }
  }
  // Honor a `?tab=` deep-link, then strip it so it doesn't linger in the URL or override later manual tab
  // switches. Runs on arrival and also if a new `?tab=` link is followed while the page is already mounted.
  useEffect(() => {
    const fromUrl = searchParams.get('tab')
    if (!fromUrl) return
    if (ACCOUNT_TABS.some(([id]) => id === fromUrl)) {
      setTabState(fromUrl)
      try { sessionStorage.setItem(ACCOUNTS_TAB_STORAGE_KEY, fromUrl) } catch { /* sessionStorage unavailable — non-fatal */ }
    }
    const next = new URLSearchParams(searchParams)
    next.delete('tab')
    setSearchParams(next, { replace: true })
  }, [searchParams, setSearchParams])

  // Resizable account-list columns. Geometry/order persist through the shared preference model; the
  // header (PillTableHeader), each AccountRow, and the draft-create row all render against the one
  // template string so they stay aligned. During a drag we hold the live widths in component state for
  // an immediate preview (the list is short, so per-frame re-render is fine) and commit once on mouse-up.
  const [accountColumns, onAccountColumnsChange] = useColumnPreference(ACCOUNTS_COLUMNS_PREF_KEY, ACCOUNT_COLUMN_DEFAULTS)
  const [liveAccountColumns, setLiveAccountColumns] = useState(null)
  const columnResizeRef = useRef(null)
  const liveAccountColumnsRef = useRef(null)
  const effectiveAccountColumns = liveAccountColumns || accountColumns
  const accountGridTemplate = useMemo(
    () => buildAccountGridTemplate(effectiveAccountColumns),
    [effectiveAccountColumns],
  )

  function startAccountColumnResize(event, key) {
    if (!ACCOUNT_RESIZABLE_COLUMN_KEYS.has(key)) return
    event.preventDefault()
    event.stopPropagation()
    columnResizeRef.current = { key, startX: event.clientX, startColumns: accountColumns.map(c => ({ ...c })) }
  }

  useEffect(() => {
    function onMove(event) {
      const state = columnResizeRef.current
      if (!state) return
      const next = state.startColumns.map(c => ({ ...c }))
      const index = next.findIndex(c => c.key === state.key)
      if (index === -1) return
      const column = next[index]
      const minWidth = Number(column.minWidth || 44)
      const startWidth = Number(column.width || 0)
      column.width = Math.max(minWidth, Math.min(640, startWidth + (event.clientX - state.startX)))
      liveAccountColumnsRef.current = next
      setLiveAccountColumns(next)
    }
    function onUp() {
      if (!columnResizeRef.current) return
      columnResizeRef.current = null
      const committed = liveAccountColumnsRef.current
      liveAccountColumnsRef.current = null
      setLiveAccountColumns(null)
      if (committed) onAccountColumnsChange(committed)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [onAccountColumnsChange])

  function showAsyncNotice(title, error) {
    setNoticeDialog({
      title,
      description: error?.message || 'Something went wrong.',
    })
  }

  function openAccountDetail(account) {
    if (!account?.id) return
    setDetailAccounts(prev => [
      ...prev.filter(item => item.id !== account.id),
      account,
    ])
  }

  function closeAccountDetail(accountId) {
    setDetailAccounts(prev => prev.filter(item => item.id !== accountId))
  }

  function getAccountDetailInitialPosition() {
    if (!accountsPanelRef.current || typeof window === 'undefined') return null
    const rect = accountsPanelRef.current.getBoundingClientRect()
    const panelWidth = Math.min(820, window.innerWidth - 32)
    const gutter = 20
    const fitsToRight = rect.right + gutter + panelWidth <= window.innerWidth - 16
    const fallbackOffset = Math.min(Math.max(rect.width * 0.42, 260), 420)
    const maxVisibleX = Math.max(16, window.innerWidth - panelWidth - 16)
    return {
      x: fitsToRight ? rect.right + gutter : Math.min(rect.left + fallbackOffset, maxVisibleX),
      y: Math.max(96, Math.round(rect.top)),
    }
  }

  const loadData = () => {
    setLoading(true)
    Promise.all([api.getAccounts({ include_children: true }), api.getOwners(), api.getCategories(), api.getTags()])
      .then(([a, o, c, t]) => {
        setAccounts(prev => reconcileAccountOrder(prev, a))
        setOwners(o)
        setCategories(c)
        setAvailableTags(Array.isArray(t) ? t : [])
      })
      .finally(() => setLoading(false))
  }

  async function reloadAccounts() {
    const rows = await api.getAccounts({ include_children: true })
    setAccounts(prev => reconcileAccountOrder(prev, rows))
    return rows
  }

  async function handleSetAccountTags(accountId, nextTagIds) {
    setAccounts(prev => prev.map(account => (
      account.id === accountId ? { ...account, tag_ids: nextTagIds } : account
    )))
    try {
      await api.setAccountTags(accountId, nextTagIds)
    } catch (error) {
      setNoticeDialog({ title: 'Could not update account tags', description: error?.message || 'Please try again.' })
      reloadAccounts().catch(() => { })
    }
  }

  async function confirmPromoteTags() {
    const dialog = promoteTagsDialog
    setPromoteTagsDialog(null)
    if (!dialog) return
    await handleSetAccountTags(dialog.targetId, dialog.nextTagIds)
    notifyAccountsChanged()
  }

  function handleAccountTagCreated(created) {
    if (!created?.id) return
    setAvailableTags(prev => (prev.some(tag => tag.id === created.id) ? prev : [...prev, created]))
  }

  const accountTagProps = {
    allTags: availableTags,
    tagsEditMode,
    tagPickerAccountId,
    onOpenTagPicker: setTagPickerAccountId,
    onCloseTagPicker: () => setTagPickerAccountId(null),
    onSetAccountTags: handleSetAccountTags,
    onAccountTagCreated: handleAccountTagCreated,
    // Right-click a top-level row opens the shared list context menu carrying this account id, so
    // "Edit tags…" sits alongside Collapse/Expand all instead of fighting the existing menu.
    onAccountContextMenu: (accountId, event) => {
      event.preventDefault()
      event.stopPropagation()
      setListContextMenu({ x: event.clientX, y: event.clientY, accountId })
    },
  }

  useEffect(() => { loadData() }, [])

  useEffect(() => {
    setDetailAccounts(current => current.map(detail => {
      const nextAccount = accounts.find(account => account.id === detail.id)
      return nextAccount
        ? { ...detail, name: nextAccount.display_name || nextAccount.name, mask: nextAccount.mask }
        : detail
    }))
  }, [accounts])

  useEffect(() => {
    const storageKey = getAccountsSectionsStorageKey(dbInstanceId, userId)
    const prefValue = preferences?.[ACCOUNTS_SECTIONS_PREF_KEY]
    const nextSectionState = isObjectLike(prefValue) ? prefValue : {}

    if (!isObjectLike(prefValue) && storageKey) {
      try {
        const raw = window.localStorage.getItem(storageKey)
        const parsed = raw ? JSON.parse(raw) : null
        if (isObjectLike(parsed)) {
          Object.assign(nextSectionState, parsed)
        }
      } catch {
        // Ignore storage failures in restricted environments.
      }
    }

    if (nextSectionState.accountOwners === undefined) {
      const legacyPrefValue = preferences?.[LEGACY_ACCOUNT_OWNERS_PREF_KEY]
      if (typeof legacyPrefValue === 'boolean') {
        nextSectionState.accountOwners = legacyPrefValue
      } else {
        const legacyStorageKey = getLegacyAccountOwnersStorageKey(dbInstanceId, userId)
        if (legacyStorageKey) {
          try {
            const raw = window.localStorage.getItem(legacyStorageKey)
            if (raw !== null) nextSectionState.accountOwners = raw === 'true'
          } catch {
            // Ignore storage failures in restricted environments.
          }
        }
      }
    }

    setSectionExpandedState(nextSectionState)
    setSectionStateLoaded(true)

    // Load collapsed group state (which parent accounts have their children hidden).
    const collapsedPrefValue = preferences?.[ACCOUNTS_COLLAPSED_PREF_KEY]
    const collapsedStorageKey = getAccountsCollapsedStorageKey(dbInstanceId, userId)
    let savedCollapsed = Array.isArray(collapsedPrefValue) ? collapsedPrefValue : null
    if (!savedCollapsed && collapsedStorageKey) {
      try {
        const raw = window.localStorage.getItem(collapsedStorageKey)
        const parsed = raw ? JSON.parse(raw) : null
        if (Array.isArray(parsed)) savedCollapsed = parsed
      } catch {
        // Ignore storage failures in restricted environments.
      }
    }
    setCollapsedGroups(new Set(savedCollapsed || []))
    setCollapsedGroupsLoaded(true)

    // Load sort preference — active key plus each column's last-used direction.
    const sortPrefValue = preferences?.[ACCOUNTS_SORT_PREF_KEY]
    const sortStorageKey = getAccountsSortStorageKey(dbInstanceId, userId)
    let savedSort = isObjectLike(sortPrefValue) ? sortPrefValue : null
    if (!savedSort && sortStorageKey) {
      try {
        const raw = window.localStorage.getItem(sortStorageKey)
        const parsed = raw ? JSON.parse(raw) : null
        if (isObjectLike(parsed)) savedSort = parsed
      } catch {
        // Ignore storage failures in restricted environments.
      }
    }
    if (savedSort?.key) {
      const nextSortKey = ACCOUNT_SORT_KEYS.includes(savedSort.key) ? savedSort.key : 'type'
      const nextSortDirections = normalizeAccountSortDirections(savedSort.directions, savedSort.dir || 'asc')
      setSortKey(nextSortKey)
      setSortDir(nextSortDirections[nextSortKey] || 'asc')
      setSortDirections(nextSortDirections)
    } else {
      setSortDirections(DEFAULT_ACCOUNT_SORT_DIRECTIONS)
    }
    setSortIndicatorActive(true)
    setSortLoaded(true)
    // Seed working state from saved preferences ONCE per identity — not on every `preferences`
    // change. The save effects below persist via setPreference, which updates the in-memory
    // preferences; re-running this loader on that echo rebuilt the collapsed-groups Set and the
    // sort object with fresh identities, which re-fired the saves — an infinite update loop. A
    // [dbInstanceId, userId] dependency still re-seeds on identity switches (the preferences
    // provider is keyed by identity, so this page remounts then).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dbInstanceId, userId])

  // Accounts-page section collapse state is profile-scoped UI state, so one person's workspace shape restores cleanly without affecting others.
  useEffect(() => {
    if (!sectionStateLoaded) return
    const storageKey = getAccountsSectionsStorageKey(dbInstanceId, userId)
    if (storageKey) {
      try {
        window.localStorage.setItem(storageKey, JSON.stringify(sectionExpandedState))
      } catch {
        // Ignore storage failures in restricted environments.
      }
    }
    setPreference(ACCOUNTS_SECTIONS_PREF_KEY, sectionExpandedState)
  }, [dbInstanceId, userId, sectionExpandedState, sectionStateLoaded, setPreference])

  // Collapsed group state is profile-scoped UI state, persisted as an array of collapsed parent IDs.
  useEffect(() => {
    if (!collapsedGroupsLoaded) return
    const collapsed = [...collapsedGroups]
    const storageKey = getAccountsCollapsedStorageKey(dbInstanceId, userId)
    if (storageKey) {
      try {
        window.localStorage.setItem(storageKey, JSON.stringify(collapsed))
      } catch {
        // Ignore storage failures in restricted environments.
      }
    }
    setPreference(ACCOUNTS_COLLAPSED_PREF_KEY, collapsed)
  }, [dbInstanceId, userId, collapsedGroups, collapsedGroupsLoaded, setPreference])

  // Sort preference is profile-scoped UI state, persisted as the active column plus
  // each header's remembered direction so switching columns reuses the last direction
  // that header sorted with.
  useEffect(() => {
    if (!sortLoaded) return
    const value = { key: sortKey, dir: sortDir, directions: sortDirections }
    const storageKey = getAccountsSortStorageKey(dbInstanceId, userId)
    if (storageKey) {
      try {
        window.localStorage.setItem(storageKey, JSON.stringify(value))
      } catch {
        // Ignore storage failures in restricted environments.
      }
    }
    setPreference(ACCOUNTS_SORT_PREF_KEY, value)
  }, [dbInstanceId, userId, sortDirections, sortKey, sortDir, sortLoaded, setPreference])

  const applyAccountSort = useCallback((nextSortKey = sortKey, nextSortDir = sortDir) => {
    setAccounts(prev => orderAccountsForDisplay(prev, nextSortKey, nextSortDir))
    setSortIndicatorActive(true)
  }, [sortKey, sortDir])

  function toggleAccountSort(nextSortKey) {
    const rememberedDir = sortDirections[nextSortKey] || 'asc'
    const nextSortDir = sortIndicatorActive && sortKey === nextSortKey
      ? (sortDir === 'asc' ? 'desc' : 'asc')
      : rememberedDir
    const nextSortDirections = { ...sortDirections, [nextSortKey]: nextSortDir }
    setSortKey(nextSortKey)
    setSortDir(nextSortDir)
    setSortDirections(nextSortDirections)
    applyAccountSort(nextSortKey, nextSortDir)
  }

  useEffect(() => {
    if (loading || !sortLoaded) return
    const seed = `${dbInstanceId || 'local'}:${userId || 'default'}`
    if (initialSortSeedRef.current === seed) return
    applyAccountSort(sortKey, sortDir)
    initialSortSeedRef.current = seed
  }, [applyAccountSort, dbInstanceId, loading, sortDir, sortKey, sortLoaded, userId])

  useEffect(() => {
    if (!accountsPanelRef.current || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(entries => {
      const entry = entries[0]
      if (!entry) return
      const nextWidth = Math.round(entry.contentRect.width)
      if (!getSectionExpanded(sectionExpandedState, 'accountList') && accountsPanelWidth && nextWidth < accountsPanelWidth) return
      // Mirror the table width into the lower cards so the page still reads as one
      // anchored column even when account rows reflow or the create row appears.
      setAccountsPanelWidth(nextWidth)
    })
    observer.observe(accountsPanelRef.current)
    return () => observer.disconnect()
  }, [accounts.length, accountsPanelWidth, loading, sectionExpandedState, showCreateAccount])

  function openCreateAccount() {
    setContextOpen(false)
    setShowCreateAccount(true)
  }

  const createAccount = async (data) => {
    setCreatingAccount(true)
    try {
      await api.createAccount(data)
      setShowCreateAccount(false)
      await reloadAccounts()
    } finally {
      setCreatingAccount(false)
    }
  }

  async function saveAccount(accountId, patch) {
    await api.updateAccount(accountId, patch)
    setAccounts(prev => prev.map(account => {
      if (account.id !== accountId) return account
      const nextOwnerId = patch.owner_id !== undefined ? (patch.owner_id || null) : account.owner_id
      const nextOwnerName = patch.owner_id !== undefined
        ? (owners.find(owner => owner.id === nextOwnerId)?.name || '')
        : account.owner_name
      return {
        ...account,
        ...patch,
        owner_id: nextOwnerId,
        owner_name: nextOwnerName,
      }
    }))
    if (patch.name !== undefined || patch.type !== undefined || patch.owner_id !== undefined) {
      setSortIndicatorActive(false)
    }
    notifyAccountsChanged()
  }

  function requestDelete(accountId) {
    setConfirmDeleteId(accountId)
  }

  async function cancelOrConfirmDelete(accountId, confirm) {
    if (!confirm) {
      setConfirmDeleteId(null)
      return
    }
    setConfirmDeleteId(null)
    setAccounts(prev => prev.filter(a => a.id !== accountId))
    await api.deleteAccount(accountId)
    reloadAccounts().catch(() => { })
    notifyAccountsChanged()
  }

  async function saveOwner(ownerId, data) {
    await api.updateOwner(ownerId, data)
    setOwners(prev => prev.map(o => o.id === ownerId ? { ...o, ...data } : o))
    if (data.name !== undefined) {
      setAccounts(prev => prev.map(account => (
        account.owner_id === ownerId
          ? { ...account, owner_name: data.name }
          : account
      )))
      setSortIndicatorActive(false)
    }
  }

  async function deleteOwner(owner) {
    if (!owner?.id) return
    await api.deleteOwner(owner.id)
    loadData()
  }

  async function createOwner(name) {
    const owner = await api.createOwner({ name })
    if (!owner?.id) throw new Error('Owner response did not include an id.')
    setOwners(prev => [...prev, owner])
    return owner
  }

  async function createOwnerForAccount(accountId, name) {
    const owner = await createOwner(name)
    if (!owner?.id) throw new Error('Owner response did not include an id.')
    await api.updateAccount(accountId, { owner_id: owner.id })
    setAccounts(prev => prev.map(account => (
      account.id === accountId
        ? { ...account, owner_id: owner.id, owner_name: owner.name }
        : account
    )))
    setSortIndicatorActive(false)
    notifyAccountsChanged()
  }

  function clearDragState() {
    setDraggingAccountId(null)
    setDropIntent(null)
    clearTimeout(dragTooltipTimerRef.current)
    setDragTooltip(null)
  }

  // If target is a child account, return its parent instead — dropping anywhere on a
  // parent-child group should be treated as targeting the parent for merge purposes.
  function resolveDropTarget(target) {
    if (!target?.parent_account_id) return target
    return activeAccounts.find(a => a.id === target.parent_account_id) || target
  }

  function canAttachAccount(source, target) {
    if (!source || !target) return false
    if (source.id === target.id) return false
    if (source.trashed_at || target.trashed_at) return false
    if (target.parent_account_id) return false
    // Regrouping always flattens the dragged account's visible group under the new
    // parent, so compatibility is checked against the dragged root account itself.
    if (!source.type || !source.owner_id) return false
    if (!target.type || !target.owner_id) return false
    return hasSameMergeFields(source, target, owners)
  }

  async function attachAccount(source, target) {
    if (!canAttachAccount(source, target)) return
    setMovingAccountId(source.id)
    try {
      await api.attachAccount(source.id, target.id)
      await reloadAccounts()
      notifyAccountsChanged()
      // Merging sets the child's own account tags aside — the parent's tags govern its transactions now
      // (see data-model.md). Offer to *promote* only the child's tags the parent lacks, so they keep
      // applying; overlapping tags are already governed by the parent, and identical/no extra tags merge
      // silently. Promotion is one-way (a later detach won't strip the promoted tags).
      const childTagIds = Array.isArray(source.tag_ids) ? source.tag_ids : []
      const parentTagIds = Array.isArray(target.tag_ids) ? target.tag_ids : []
      const missingTagIds = childTagIds.filter(id => !parentTagIds.includes(id))
      if (missingTagIds.length > 0) {
        setPromoteTagsDialog({
          sourceName: source.display_name || source.name,
          targetName: target.display_name || target.name,
          targetId: target.id,
          nextTagIds: [...parentTagIds, ...missingTagIds],
          tagNames: missingTagIds
            .map(id => availableTags.find(t => t.id === id)?.name)
            .filter(Boolean),
        })
      }
    } catch (error) {
      setNoticeDialog({
        title: 'Could not regroup accounts',
        description: error.message,
      })
    } finally {
      setMovingAccountId(null)
      clearDragState()
    }
  }

  async function detachAccount(account) {
    if (!account?.parent_account_id) return
    setMovingAccountId(account.id)
    try {
      await api.detachAccount(account.id)
      await reloadAccounts()
      notifyAccountsChanged()
    } catch (error) {
      setNoticeDialog({
        title: 'Could not ungroup account',
        description: error.message,
      })
    } finally {
      setMovingAccountId(null)
      clearDragState()
    }
  }

  async function confirmTrashChildAccount() {
    if (!pendingTrashAccount?.id) return
    const account = pendingTrashAccount
    setPendingTrashAccount(null)
    setMovingAccountId(account.id)
    try {
      await api.trashAccount(account.id)
      await reloadAccounts()
      notifyAccountsChanged()
    } catch (error) {
      setNoticeDialog({
        title: 'Could not send account to trash',
        description: error.message,
      })
    } finally {
      setMovingAccountId(null)
    }
  }

  function handleAccountDragStart(event, account) {
    if (movingAccountId || showCreateAccount) {
      event.preventDefault()
      return
    }
    setDraggingAccountId(account.id)
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', account.id)

    // Clone the row element as the drag ghost so it looks like the account record.
    const rowEl = event.currentTarget.closest('[data-account-row]')
    if (rowEl) {
      const clone = rowEl.cloneNode(true)
      clone.style.position = 'fixed'
      clone.style.top = '-9999px'
      clone.style.left = '-9999px'
      clone.style.width = `${rowEl.offsetWidth}px`
      clone.style.opacity = '0.92'
      clone.style.pointerEvents = 'none'
      clone.style.borderRadius = '8px'
      clone.style.boxShadow = '0 8px 24px rgba(0,0,0,0.22)'
      clone.style.background = 'var(--surface)'
      clone.style.border = '1px solid var(--border)'
      document.body.appendChild(clone)
      event.dataTransfer.setDragImage(clone, rowEl.offsetWidth / 2, rowEl.offsetHeight / 2)
      requestAnimationFrame(() => document.body.removeChild(clone))
    }
  }

  function handleAccountDragEnd() {
    clearDragState()
  }

  const dragInvalidSinceRef = useRef(null)

  // Drag-over handler — child accounts can return to top level by being pulled
  // into the left gutter; otherwise drag intent falls back to regroup detection.
  function handleListDragOver(event) {
    if (!listRef.current || !draggingAccount || showCreateAccount || movingAccountId) return
    event.preventDefault()

    const listRect = listRef.current.getBoundingClientRect()
    const detachZoneRight = listRect.left + ACCOUNT_DETACH_DROP_ZONE_WIDTH
    if (draggingAccount.parent_account_id && event.clientX <= detachZoneRight) {
      event.dataTransfer.dropEffect = 'move'
      setDropIntent({ kind: 'detach', accountId: draggingAccount.id })
      dragInvalidSinceRef.current = null
      clearTimeout(dragTooltipTimerRef.current)
      setDragTooltip(null)
      return
    }
    const el = document.elementFromPoint(
      Math.max(listRect.left + 1, Math.min(event.clientX, listRect.right - 1)),
      event.clientY,
    )
    const rowEl = el?.closest('[data-account-row-id]')
    const targetId = rowEl?.dataset?.accountRowId
    const target = targetId ? activeAccounts.find(a => a.id === targetId) : null

    if (!target) {
      setDropIntent(null)
      dragInvalidSinceRef.current = null
      clearTimeout(dragTooltipTimerRef.current)
      setDragTooltip(null)
      return
    }

    // Within own group — highlight parent but no action.
    const draggingGroupRootId = draggingAccount.parent_account_id || null
    const targetGroupRootId = target.parent_account_id || (childAccountsByParent.get(target.id)?.length > 0 && !collapsedGroups.has(target.id) ? target.id : null)
    if (draggingGroupRootId && draggingGroupRootId === targetGroupRootId) {
      event.dataTransfer.dropEffect = 'move'
      setDropIntent({ kind: 'merge', targetId: draggingGroupRootId })
      dragInvalidSinceRef.current = null
      clearTimeout(dragTooltipTimerRef.current)
      setDragTooltip(null)
      return
    }

    const mergeTarget = resolveDropTarget(target)
    if (canAttachAccount(draggingAccount, mergeTarget)) {
      event.dataTransfer.dropEffect = 'move'
      setDropIntent({ kind: 'merge', targetId: mergeTarget.id })
      dragInvalidSinceRef.current = null
      clearTimeout(dragTooltipTimerRef.current)
      setDragTooltip(null)
      return
    }

    // Cannot merge accounts — show tooltip after delay.
    event.dataTransfer.dropEffect = 'none'
    setDropIntent(null)
    const sourceMissingType = !draggingAccount.type
    const sourceMissingOwner = !draggingAccount.owner_id
    const targetMissingType = !mergeTarget.type
    const targetMissingOwner = !mergeTarget.owner_id
    const sourceMissingFields = sourceMissingType || sourceMissingOwner
    const sourceNeeds = [sourceMissingType ? 'a type' : null, sourceMissingOwner ? 'an owner' : null].filter(Boolean)
    const targetNeeds = [targetMissingType ? 'a type' : null, targetMissingOwner ? 'an owner' : null].filter(Boolean)
    const ownerMismatch = !sourceMissingFields && !(targetMissingType || targetMissingOwner) &&
      !ownersAreCompatible(draggingAccount, mergeTarget, owners)
    const typeMismatch = !sourceMissingFields && !(targetMissingType || targetMissingOwner) &&
      (draggingAccount.type || '') !== (mergeTarget.type || '')
    const reasons = [
      sourceNeeds.length ? `this account needs ${sourceNeeds.join(' and ')}` : null,
      targetNeeds.length && !sourceMissingFields ? `that account needs ${targetNeeds.join(' and ')}` : null,
      ownerMismatch ? 'different owners' : null,
      typeMismatch ? 'different account types' : null,
    ].filter(Boolean).join(', ')
    if (reasons && dragInvalidSinceRef.current === null) {
      dragInvalidSinceRef.current = Date.now()
      clearTimeout(dragTooltipTimerRef.current)
      dragTooltipTimerRef.current = setTimeout(() => {
        setDragTooltip({ x: event.clientX, y: event.clientY, message: `Can't merge with this account: ${reasons}` })
      }, 600)
    } else if (!reasons) {
      dragInvalidSinceRef.current = null
      clearTimeout(dragTooltipTimerRef.current)
      setDragTooltip(null)
    }
  }

  // Drop handler — child accounts may detach in the left gutter, otherwise drops
  // either merge into another top-level account or no-op within the same group.
  function handleListDrop(event) {
    if (!draggingAccount) return
    const listRect = listRef.current?.getBoundingClientRect()
    if (!listRect) return
    const detachZoneRight = listRect.left + ACCOUNT_DETACH_DROP_ZONE_WIDTH
    if (draggingAccount.parent_account_id && event.clientX <= detachZoneRight) {
      event.preventDefault()
      detachAccount(draggingAccount)
      return
    }
    const el = document.elementFromPoint(
      Math.max(listRect.left + 1, Math.min(event.clientX, listRect.right - 1)),
      event.clientY,
    )
    const rowEl = el?.closest('[data-account-row-id]')
    const targetId = rowEl?.dataset?.accountRowId
    const target = targetId ? activeAccounts.find(a => a.id === targetId) : null
    if (!target) { clearDragState(); return }

    // Drop within own group — no-op.
    const draggingGroupRootId = draggingAccount.parent_account_id || null
    const targetGroupRootId = target.parent_account_id || (childAccountsByParent.get(target.id)?.length > 0 && !collapsedGroups.has(target.id) ? target.id : null)
    if (draggingGroupRootId && draggingGroupRootId === targetGroupRootId) {
      clearDragState()
      return
    }

    const mergeTarget = resolveDropTarget(target)
    if (!canAttachAccount(draggingAccount, mergeTarget)) return
    event.preventDefault()
    attachAccount(draggingAccount, mergeTarget)
  }

  const activeAccounts = accounts.filter(account => !account.trashed_at)
  const rootAccounts = activeAccounts.filter(account => !account.parent_account_id)
  const orderedRootAccounts = rootAccounts
  const childAccountsByParent = activeAccounts.reduce((map, account) => {
    if (!account.parent_account_id) return map
    const list = map.get(account.parent_account_id) || []
    list.push(account)
    map.set(account.parent_account_id, list)
    return map
  }, new Map())

  const accountCountsByOwnerId = rootAccounts.reduce((counts, account) => {
    const id = account.owner_id || ''
    counts.set(id, (counts.get(id) || 0) + 1)
    return counts
  }, new Map())
  const ownerFilterPills = [
    ...owners
      .filter(owner => accountCountsByOwnerId.has(owner.id))
      .map(owner => ({
        id: owner.id,
        name: owner.name || (isSharedOwner(owner) ? 'Shared' : 'Owner'),
        count: accountCountsByOwnerId.get(owner.id),
      })),
    ...(accountCountsByOwnerId.has('')
      ? [{ id: '', name: 'Unassigned', count: accountCountsByOwnerId.get('') }]
      : []),
  ]
  // Only worth offering pills once there's more than one bucket to choose between.
  const showOwnerFilterRow = ownerFilterPills.length > 1
  const displayRootAccounts = ownerFilter !== null
    ? orderedRootAccounts.filter(account => (account.owner_id || '') === ownerFilter)
    : orderedRootAccounts
  const draggingAccount = draggingAccountId ? activeAccounts.find(account => account.id === draggingAccountId) : null
  const detachDropActive = dropIntent?.kind === 'detach' && !!draggingAccount?.parent_account_id

  const ownerCount = owners.length
  const unownedCount = rootAccounts.filter(a => !a.owner_id).length
  const mergedChildCount = activeAccounts.length - rootAccounts.length
  const accountListSummary = rootAccounts.length
    ? `${formatCountSummary(rootAccounts.length, 'account')}${mergedChildCount ? `, ${formatCountSummary(mergedChildCount, 'merged account')}` : ''}`
    : 'No accounts'
  const ownerWarning = ownerCount > 0 && unownedCount > 0 ? `${unownedCount} account${unownedCount > 1 ? 's' : ''} need${unownedCount === 1 ? 's' : ''} an owner assigned` : ''
  const renameOwnerName = ownerRenameDialog?.name || ''

  async function confirmOwnerRename() {
    if (!ownerRenameDialog?.id || !renameOwnerName.trim()) return
    const ownerId = ownerRenameDialog.id
    const nextName = renameOwnerName.trim()
    setOwnerRenameDialog(null)
    try {
      await saveOwner(ownerId, { name: nextName })
    } catch (error) {
      showAsyncNotice('Could not rename owner', error)
    }
  }

  async function confirmOwnerDelete() {
    if (!pendingOwnerDelete) return
    const owner = pendingOwnerDelete
    setPendingOwnerDelete(null)
    try {
      await deleteOwner(owner)
    } catch (error) {
      showAsyncNotice('Could not delete owner', error)
    }
  }

  return (
    <div data-browser-context-passthrough="true" style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {dragTooltip ? (
        <div style={{
          position: 'fixed',
          left: dragTooltip.x + 14,
          top: dragTooltip.y + 14,
          zIndex: 400,
          background: 'var(--surface)',
          border: '1.5px solid color-mix(in srgb, var(--text) 24%, var(--border))',
          borderRadius: 6,
          padding: '5px 10px',
          fontSize: 12,
          color: 'var(--text)',
          boxShadow: '0 4px 12px rgba(15, 23, 42, 0.35)',
          pointerEvents: 'none',
          maxWidth: 260,
          lineHeight: 1.4,
        }}>
          {dragTooltip.message}
        </div>
      ) : null}
      {noticeDialog ? (
        <AppNoticeDialog
          title={noticeDialog.title}
          description={noticeDialog.description}
          onClose={() => setNoticeDialog(null)}
        />
      ) : null}

      {promoteTagsDialog ? (
        <AppConfirmDialog
          title="Bring tags along?"
          description={`Merging "${promoteTagsDialog.sourceName}" under "${promoteTagsDialog.targetName}" sets its own tags aside — while merged, the tags on "${promoteTagsDialog.targetName}" govern these transactions. "${promoteTagsDialog.sourceName}" has tags that "${promoteTagsDialog.targetName}" doesn't: ${promoteTagsDialog.tagNames.join(', ')}. Promote them so they keep applying? Promotion stays even if you ungroup later.`}
          confirmLabel="Promote tags"
          cancelLabel="Keep separate"
          onConfirm={confirmPromoteTags}
          onCancel={() => setPromoteTagsDialog(null)}
          width="min(480px, 100%)"
        />
      ) : null}

      {ownerRenameDialog ? (
        <AppTextEntryDialog
          title="Rename owner"
          description="Choose the name this owner should use across accounts and categories."
          label="Owner name"
          value={renameOwnerName}
          onChange={value => setOwnerRenameDialog(prev => prev ? { ...prev, name: value } : prev)}
          placeholder="Owner name"
          confirmLabel="Save"
          confirmDisabled={!renameOwnerName.trim()}
          onConfirm={confirmOwnerRename}
          onCancel={() => setOwnerRenameDialog(null)}
          width="min(460px, 100%)"
        />
      ) : null}

      {pendingOwnerDelete ? (
        <AppConfirmDialog
          title="Delete owner?"
          description={`Delete "${pendingOwnerDelete.name || 'owner'}"? Their accounts and categories will become unassigned.`}
          confirmLabel="Delete"
          confirmVariant="danger"
          borderColor="color-mix(in srgb, var(--danger) 35%, var(--border))"
          onConfirm={confirmOwnerDelete}
          onCancel={() => setPendingOwnerDelete(null)}
          width="min(500px, 100%)"
        />
      ) : null}

      {pendingTrashAccount ? (
        <AppConfirmDialog
          title="Send merged account to trash?"
          description={`Hide "${pendingTrashAccount.name}" for now? It will stay recoverable in Settings until the trash is emptied.`}
          confirmLabel="Send to trash"
          confirmVariant="danger"
          borderColor="color-mix(in srgb, var(--danger) 35%, var(--border))"
          onConfirm={confirmTrashChildAccount}
          onCancel={() => setPendingTrashAccount(null)}
          width="min(560px, 100%)"
        />
      ) : null}

      <div style={{ display: 'contents', visibility: (loading || !sectionStateLoaded || !sortLoaded) ? 'hidden' : 'visible' }}>
        <div style={{ padding: '24px 32px 0', flexShrink: 0 }}>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 12,
            width: 'fit-content',
            maxWidth: '100%',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <FeatureExplainer topic="merging-accounts" placement="bottom-left" />
              <h1 style={{ fontSize: 22, fontWeight: 600 }}>Accounts</h1>
            </div>
          </div>
          <div style={{ display: 'flex', borderBottom: '1px solid var(--border)', marginBottom: (tab === 'accounts' && showOwnerFilterRow) ? 16 : 0 }}>
            {ACCOUNT_TABS.map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setTab(id)}
                style={{
                  padding: '8px 24px', border: 'none', background: 'none', cursor: 'pointer', fontSize: 14,
                  color: tab === id ? 'var(--text)' : 'var(--muted)',
                  borderBottom: tab === id ? '2px solid var(--accent)' : '2px solid transparent',
                  fontWeight: tab === id ? 500 : 400,
                }}
              >
                {label}
              </button>
            ))}
          </div>
          {tab === 'accounts' && showOwnerFilterRow ? (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
              marginBottom: 18,
            }}>
              <OwnerFilterPill
                label="All"
                count={rootAccounts.length}
                active={ownerFilter === null}
                onClick={() => setOwnerFilter(null)}
              />
              {ownerFilterPills.map(pill => (
                <OwnerFilterPill
                  key={pill.id || '__unassigned__'}
                  label={pill.name}
                  count={pill.count}
                  active={ownerFilter === pill.id}
                  onClick={() => setOwnerFilter(prev => prev === pill.id ? null : pill.id)}
                />
              ))}
            </div>
          ) : null}
        </div>

        <div data-browser-context-passthrough="true" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 32px 32px' }}>
          {tab === 'accounts' && (
            <>
              <div
                onContextMenu={e => {
                  if (showCreateAccount) return
                  e.preventDefault()
                  setContextOpen(prev => !prev)
                }}
                style={{ position: 'relative' }}
              >
                {contextOpen && (
                  <div style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    zIndex: 40,
                    background: 'var(--surface)',
                    border: '1px solid var(--border)',
                    borderRadius: 10,
                    boxShadow: '0 14px 36px rgba(0, 0, 0, 0.18)',
                    padding: 6,
                  }}>
                    <Button small onClick={openCreateAccount}>Add account</Button>
                    {orderedRootAccounts.some(r => (childAccountsByParent.get(r.id) || []).length > 0) && (
                      <>
                        <Button small variant="ghost" style={{ display: 'block', width: '100%', marginTop: 4 }} onClick={() => {
                          setCollapsedGroups(new Set(orderedRootAccounts.filter(r => (childAccountsByParent.get(r.id) || []).length > 0).map(r => r.id)))
                          setContextOpen(false)
                        }}>Collapse all groups</Button>
                        <Button small variant="ghost" style={{ display: 'block', width: '100%', marginTop: 4 }} onClick={() => {
                          setCollapsedGroups(new Set())
                          setContextOpen(false)
                        }}>Expand all groups</Button>
                      </>
                    )}
                  </div>
                )}
              </div>

              {/* Spinner only when there is nothing to keep on screen: `loadData` re-runs after every
                  account mutation, and swapping the whole list for a spinner each time moved everything
                  below it twice per edit. A reload holds the current list until the new one arrives. */}
              {loading && accounts.length === 0 ? <Spinner /> : (
                <div style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-start' }}>
                  <div ref={accountsPanelRef} style={{ position: 'relative', width: 'fit-content', maxWidth: '100%' }}>
                    <SectionCard
                      summary={accountListSummary}
                      collapsible={false}
                      headerCenter={ownerWarning ? (
                        <span style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 6,
                          padding: '4px 10px',
                          borderRadius: 999,
                          background: 'color-mix(in srgb, var(--warning) 10%, var(--surface2))',
                          border: '1px solid var(--border)',
                          fontSize: 12,
                          color: 'var(--text)',
                          opacity: showCreateAccount ? 0.55 : 1,
                        }}>
                          <span>⚠️</span>
                          <span style={{ whiteSpace: 'nowrap' }}>{ownerWarning}</span>
                        </span>
                      ) : null}
                      width={sectionPanelWidth}
                      style={{ overflow: 'hidden', alignSelf: 'flex-start' }}
                    >
                      {rootAccounts.length === 0 && !showCreateAccount ? (
                        <div style={{ padding: '12px 16px 14px', fontSize: 14, color: 'var(--muted)', lineHeight: 1.4 }}>
                          No accounts yet.
                        </div>
                      ) : displayRootAccounts.length === 0 && !showCreateAccount ? (
                        <div style={{ padding: '12px 16px 14px', fontSize: 14, color: 'var(--muted)', lineHeight: 1.4 }}>
                          No accounts match this owner filter.
                        </div>
                      ) : (
                        <>
                          <div
                            onContextMenu={e => {
                              if (!orderedRootAccounts.some(r => (childAccountsByParent.get(r.id) || []).length > 0)) return
                              e.preventDefault()
                              setListContextMenu({ x: e.clientX, y: e.clientY })
                            }}
                            style={{ background: 'var(--surface2)' }}>
                            <PillTableHeader
                              columns={[
                                { key: 'drag', kind: 'spacer', cellPadding: 0 },
                                {
                                  key: 'name',
                                  label: 'Account',
                                  cellPadding: 0,
                                  contentPadding: '0 9px',
                                  leadingInset: 0,
                                  trailingInset: 0,
                                  resizable: false,
                                  draggable: false,
                                  title: 'Click to sort accounts by name',
                                },
                                {
                                  key: 'type',
                                  label: 'Type',
                                  cellPadding: 0,
                                  contentPadding: '0 9px',
                                  leadingInset: 0,
                                  trailingInset: 0,
                                  resizable: true,
                                  draggable: false,
                                  title: 'Click to sort accounts by type',
                                },
                                {
                                  key: 'owner',
                                  label: 'Owner',
                                  align: 'center',
                                  cellPadding: 0,
                                  contentPadding: '0 9px',
                                  leadingInset: 0,
                                  trailingInset: 0,
                                  resizable: true,
                                  draggable: false,
                                  title: 'Click to sort accounts by owner',
                                },
                                {
                                  key: 'tags',
                                  sortable: false,
                                  resizable: true,
                                  draggable: false,
                                  cellPadding: 0,
                                  contentPadding: '0 9px',
                                  render: () => (
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%' }}>
                                      <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', letterSpacing: 0.3, textTransform: 'uppercase' }}>Tags</span>
                                      <button
                                        type="button"
                                        onClick={() => { setTagsEditMode(v => !v); setTagPickerAccountId(null) }}
                                        title={tagsEditMode ? 'Finish editing account tags' : 'Edit account tags (or right-click a row)'}
                                        style={{
                                          background: tagsEditMode ? 'color-mix(in srgb, var(--accent) 16%, var(--surface))' : 'none',
                                          border: '1px solid var(--border)', borderRadius: 999, padding: '1px 8px',
                                          fontSize: 11, color: tagsEditMode ? 'var(--accent2)' : 'var(--muted)', cursor: 'pointer',
                                        }}
                                      >
                                        {tagsEditMode ? 'Done' : 'Edit tags'}
                                      </button>
                                    </div>
                                  ),
                                },
                                { key: 'actions', kind: 'spacer', cellPadding: 0 },
                              ]}
                              gridTemplateColumns={accountGridTemplate}
                              sortState={sortIndicatorActive ? { key: sortKey, dir: sortDir } : null}
                              onSort={toggleAccountSort}
                              onStartResize={startAccountColumnResize}
                              style={{
                                gap: ACCOUNT_ROW_GAP,
                                padding: '6px 10px',
                                alignItems: 'center',
                              }}
                            />
                          </div>
                          <div
                            ref={listRef}
                            onDragOver={handleListDragOver}
                            onDrop={handleListDrop}
                            onContextMenu={e => {
                              if (!orderedRootAccounts.some(r => (childAccountsByParent.get(r.id) || []).length > 0)) return
                              e.preventDefault()
                              setListContextMenu({ x: e.clientX, y: e.clientY })
                            }}
                            style={{ maxHeight: 640, overflowY: 'auto', position: 'relative' }}
                          >
                            {draggingAccount?.parent_account_id ? (
                              <div
                                aria-hidden="true"
                                style={{
                                  position: 'absolute',
                                  top: 8,
                                  bottom: 8,
                                  left: 8,
                                  width: ACCOUNT_DETACH_DROP_ZONE_WIDTH - 16,
                                  borderRadius: 12,
                                  border: `1px dashed ${detachDropActive ? 'color-mix(in srgb, var(--accent) 58%, var(--border))' : 'color-mix(in srgb, var(--border) 88%, transparent)'}`,
                                  background: detachDropActive
                                    ? 'linear-gradient(180deg, color-mix(in srgb, var(--accent) 14%, var(--surface2)), color-mix(in srgb, var(--accent) 8%, var(--surface)))'
                                    : 'color-mix(in srgb, var(--surface2) 42%, transparent)',
                                  boxShadow: detachDropActive ? 'inset 0 0 0 1px color-mix(in srgb, var(--accent) 10%, transparent)' : 'none',
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  textAlign: 'center',
                                  padding: '10px 8px',
                                  color: detachDropActive ? 'var(--accent2)' : 'var(--muted)',
                                  fontSize: 11,
                                  fontWeight: detachDropActive ? 700 : 600,
                                  lineHeight: 1.35,
                                  pointerEvents: 'none',
                                  zIndex: 1,
                                }}
                              >
                                {detachDropActive ? 'Release to ungroup' : 'Pull here to top level'}
                              </div>
                            ) : null}
                            {listContextMenu && (
                              <div
                                style={{
                                  position: 'fixed',
                                  left: Math.min(listContextMenu.x, window.innerWidth - 200),
                                  top: Math.min(listContextMenu.y, window.innerHeight - 100),
                                  zIndex: 300,
                                  background: 'var(--surface)',
                                  border: '1px solid var(--border)',
                                  borderRadius: 10,
                                  boxShadow: '0 8px 32px rgba(0,0,0,0.22)',
                                  padding: 4,
                                  minWidth: 180,
                                }}
                                onMouseLeave={() => setListContextMenu(null)}
                              >
                                {listContextMenu.accountId ? (
                                  <button type="button" onClick={() => {
                                    // Open just this row's picker without toggling the page-wide edit
                                    // mode: the row renders its own "+" anchor while its picker is open
                                    // (see showControls), so dismissing the picker leaves no lingering
                                    // "Done" state to clear.
                                    setTagPickerAccountId(listContextMenu.accountId)
                                    setListContextMenu(null)
                                  }} style={{ display: 'block', width: '100%', textAlign: 'left', background: 'none', border: 'none', color: 'var(--text)', fontSize: 13, padding: '8px 10px', borderRadius: 6, cursor: 'pointer' }}>
                                    Edit tags…
                                  </button>
                                ) : null}
                                {orderedRootAccounts.some(r => (childAccountsByParent.get(r.id) || []).length > 0) ? (
                                  <>
                                    {listContextMenu.accountId ? <div style={{ height: 1, background: 'var(--border)', margin: '4px 6px' }} /> : null}
                                    <button type="button" onClick={() => {
                                      setCollapsedGroups(new Set(orderedRootAccounts.filter(r => (childAccountsByParent.get(r.id) || []).length > 0).map(r => r.id)))
                                      setListContextMenu(null)
                                    }} style={{ display: 'block', width: '100%', textAlign: 'left', background: 'none', border: 'none', color: 'var(--text)', fontSize: 13, padding: '8px 10px', borderRadius: 6, cursor: 'pointer' }}>
                                      Collapse all
                                    </button>
                                    <button type="button" onClick={() => {
                                      setCollapsedGroups(new Set())
                                      setListContextMenu(null)
                                    }} style={{ display: 'block', width: '100%', textAlign: 'left', background: 'none', border: 'none', color: 'var(--text)', fontSize: 13, padding: '8px 10px', borderRadius: 6, cursor: 'pointer' }}>
                                      Expand all
                                    </button>
                                  </>
                                ) : null}
                              </div>
                            )}
                            {displayRootAccounts.map(root => {
                              const children = childAccountsByParent.get(root.id) || []
                              const isCollapsed = collapsedGroups.has(root.id)
                              const rootDragDisabled = !!movingAccountId
                              const groupMergeActive = dropIntent?.kind === 'merge' && dropIntent.targetId === root.id
                              return (
                                <div key={root.id}>
                                  <AccountRow
                                    account={root}
                                    gridTemplateColumns={accountGridTemplate}
                                    hasChildren={children.length}
                                    isCollapsed={isCollapsed}
                                    onToggleCollapse={() => setCollapsedGroups(prev => {
                                      const next = new Set(prev)
                                      if (next.has(root.id)) next.delete(root.id)
                                      else next.add(root.id)
                                      return next
                                    })}
                                    owners={owners}
                                    onSave={saveAccount}
                                    onRequestDelete={requestDelete}
                                    confirmingDelete={confirmDeleteId === root.id}
                                    onCancelDelete={cancelOrConfirmDelete}
                                    onOpenDetail={openAccountDetail}
                                    onCreateOwnerForAccount={createOwnerForAccount}
                                    onRequestRenameOwner={owner => {
                                      if (!owner?.id) return
                                      setOwnerRenameDialog({
                                        id: owner.id,
                                        name: owner.name || '',
                                      })
                                    }}
                                    onRequestDeleteOwner={owner => setPendingOwnerDelete(owner)}
                                    onRequestTrash={setPendingTrashAccount}
                                    onError={showAsyncNotice}
                                    interactionDisabled={showCreateAccount || !!movingAccountId}
                                    dragDisabled={rootDragDisabled}
                                    dropActive={groupMergeActive}
                                    onDragStart={handleAccountDragStart}
                                    onDragEnd={handleAccountDragEnd}
                                    {...accountTagProps}
                                  />
                                  {!isCollapsed && children.map((child, childIdx) => (
                                    <AccountRow
                                      key={child.id}
                                      account={child}
                                      gridTemplateColumns={accountGridTemplate}
                                      parentAccount={root}
                                      isLastChild={childIdx === children.length - 1}
                                      owners={owners}
                                      onSave={saveAccount}
                                      onRequestDelete={requestDelete}
                                      confirmingDelete={false}
                                      onCancelDelete={cancelOrConfirmDelete}
                                      onOpenDetail={openAccountDetail}
                                      onCreateOwnerForAccount={createOwnerForAccount}
                                      onRequestRenameOwner={owner => {
                                        if (!owner?.id) return
                                        setOwnerRenameDialog({
                                          id: owner.id,
                                          name: owner.name || '',
                                        })
                                      }}
                                      onRequestDeleteOwner={owner => setPendingOwnerDelete(owner)}
                                      onRequestTrash={setPendingTrashAccount}
                                      onError={showAsyncNotice}
                                      interactionDisabled={showCreateAccount || !!movingAccountId}
                                      dragDisabled={!!movingAccountId}
                                      dropActive={groupMergeActive}
                                      onDragStart={handleAccountDragStart}
                                      onDragEnd={handleAccountDragEnd}
                                      {...accountTagProps}
                                    />
                                  ))}
                                </div>
                              )
                            })}
                            {showCreateAccount && (
                              <DraftAccountRow
                                owners={owners}
                                gridTemplateColumns={accountGridTemplate}
                                creating={creatingAccount}
                                onCreate={createAccount}
                                onCancel={() => setShowCreateAccount(false)}
                              />
                            )}
                          </div>
                        </>
                      )}
                    </SectionCard>
                    {showCreateAccount && (
                      <div
                        style={{
                          position: 'absolute',
                          left: 'calc(100% + 8px)',
                          top: 'calc(100% - 48px)',
                          display: 'flex',
                          alignItems: 'center',
                          padding: '7px 8px',
                          background: 'color-mix(in srgb, var(--surface2) 65%, var(--surface))',
                          border: '1px solid var(--border)',
                          borderRadius: 14,
                          boxShadow: '0 10px 24px rgba(0, 0, 0, 0.10)',
                        }}
                      >
                        <button
                          type="submit"
                          form="draft-account-form"
                          style={{
                            padding: '6px 14px',
                            borderRadius: 10,
                            border: 'none',
                            cursor: creatingAccount ? 'not-allowed' : 'pointer',
                            fontSize: 13,
                            fontWeight: 500,
                            transition: 'opacity 0.15s',
                            opacity: creatingAccount ? 0.5 : 1,
                            background: 'var(--accent)',
                            color: '#fff',
                          }}
                          disabled={creatingAccount}
                        >
                          {creatingAccount ? 'Adding...' : 'Add'}
                        </button>
                      </div>
                    )}
                  </div>
                  <div style={{ width: '100%', display: 'flex', justifyContent: 'flex-end', marginTop: 6 }}>
                    <Button small onClick={() => setShowCreateAccount(true)} disabled={showCreateAccount}>
                      +New account
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}

          {tab === 'owners' && (
            <OwnersPanel
              owners={owners}
              onCreateOwner={createOwner}
              onSaveOwner={saveOwner}
              onDeleteOwner={owner => setPendingOwnerDelete(owner)}
              onError={showAsyncNotice}
              disabled={showCreateAccount}
              width={sectionPanelWidth}
              collapsible={false}
            />
          )}

          {tab === 'connections' && (
            <DataSourceConnections
              // Merged children included, deliberately. A connection maps onto whatever account the
              // user pointed it at, and merging that account into a group does not move the mapping —
              // so a root-only list drops exactly the accounts whose mappings are still in force,
              // leaving the card claiming nothing was imported and the mapping dialog rendering a
              // live decision as an empty select. Same reasoning as the CSV mapping grid's own
              // include_children fetch.
              accounts={activeAccounts}
              onAccountsChanged={loadData}
              // For the import-card ledger a connection card can now open in place: its rows are
              // categorizable, which is the whole reason to open it here rather than send the user
              // to the Import / Export page to find the card.
              categories={categories}
              onAddCategory={category => setCategories(prev => (
                prev.some(existing => existing.id === category.id) ? prev : [...prev, category]
              ))}
              // The same panel the Accounts tab opens, from the same handler — a connection's account list
              // is a place a user wants to look at the account, not a dead end that sends them elsewhere.
              onOpenAccountDetail={openAccountDetail}
              currentUser={currentUser}
              setCurrentUser={setCurrentUser}
              authEnabled={authEnabled}
              width={sectionPanelWidth}
              disabled={showCreateAccount}
            />
          )}

          {detailAccounts.map((account, index) => (
            <AccountDetail
              key={account.id}
              account={account}
              categories={categories}
              forceFloating
              stackIndex={index}
              initialPosition={getAccountDetailInitialPosition()}
              isTopmost={index === detailAccounts.length - 1}
              onClose={() => closeAccountDetail(account.id)}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
