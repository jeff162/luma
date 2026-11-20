// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * Shared transaction-list renderer built on PillGridTable. The outer wrapper is the
 * scroll viewport (where `scrollRef` lands), and the PillTableHeader pins via
 * `position: sticky; top: 0` so column labels stay put as rows scroll past. `fillHeight`
 * switches the wrapper between a max-height bounded scroller and a flex-fill chain that
 * stretches to its parent.
 *
 * Scroll-container contract (`fillHeight=true`): every ancestor between this component
 * and its rendered root must be a flex-column with `flex: 1, minHeight: 0`. A plain
 * block anywhere in the chain breaks percentage-height resolution, the wrapper sizes
 * to content (no overflow, no scrollbar), and wheel events bubble out through any
 * floating-panel backdrop to whatever's behind.
 */

import { useCallback, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { formatDate } from '../lib/utils.js'
import { unusualBalanceColor } from '../lib/accountTypes.js'
import { BALANCE_WARNING_COLOR, formatSignedMoneyAmount } from '../lib/moneyDisplay.js'
import { CategoryCell, MerchantCell, TransactionMarkersCell, TransactionAmountCell, getTxnMerchantLabel } from './TransactionRow.jsx'
import { transactionRowKey } from '../lib/splitRows.js'
import PillGridTable from './PillGridTable.jsx'
import WindowedRows from './WindowedRows.jsx'
import { SelectAllCheckbox, Tooltip, ROW_HOVER_OPEN_DELAY_MS } from './ui.jsx'
import { BULK_SELECT_COLUMN_KEY } from '../lib/useTransactionSelection.js'
import { useTransactionRowActions, TransactionRowActionsChrome } from '../lib/useTransactionRowActions.jsx'
import RuleSuggestionToast from './RuleSuggestionToast.jsx'
import { reconcileRowsAfterRuleApply } from '../lib/txnMutations.js'

const COLUMN_DEFS = {
  date: { key: 'date', label: 'Date', defaultWidth: 96, minWidth: 82 },
  merchant: { key: 'merchant', label: 'Merchant', defaultWidth: 260, minWidth: 150 },
  category: { key: 'category', label: 'Category', defaultWidth: 150, minWidth: 110 },
  account: { key: 'account', label: 'Account', defaultWidth: 140, minWidth: 110 },
  // The original (source) account a row came from. Distinct from `account`, which shows the
  // effective/top-level account — identical for every row inside a merged-account report and so
  // surfaced only there (see AccountDetail), where it tells the merged children apart.
  sourceAccount: { key: 'sourceAccount', label: 'Account', defaultWidth: 150, minWidth: 110 },
  // The note/tag/status markers (see TransactionMarkersCell). Not sortable — there is no single
  // meaningful order across a mix of tags, notes, and status flags. Left-aligned like the other
  // text columns; overflow past its width is clipped by the cell wrapper.
  tags: { key: 'tags', label: 'Tags', defaultWidth: 96, minWidth: 44, sortable: false },
  amount: { key: 'amount', label: 'Amount', defaultWidth: 96, minWidth: 72, align: 'end' },
  // The account's balance just after the row (`running_balance`, from the server). Not sortable: it
  // follows the date order, so sorting by date is sorting by it.
  runningBalance: { key: 'runningBalance', label: 'Balance', defaultWidth: 112, minWidth: 84, align: 'end', sortable: false },
}

function getAvailableColumns({ showCategory, showAccount, showSourceAccount, showRunningBalance }) {
  return [
    COLUMN_DEFS.date,
    COLUMN_DEFS.merchant,
    ...(showCategory ? [COLUMN_DEFS.category] : []),
    ...(showAccount ? [COLUMN_DEFS.account] : []),
    ...(showSourceAccount ? [COLUMN_DEFS.sourceAccount] : []),
    COLUMN_DEFS.tags,
    COLUMN_DEFS.amount,
    ...(showRunningBalance ? [COLUMN_DEFS.runningBalance] : []),
  ]
}

// Column-header click sorting is handled entirely by the table when no external sort props
// are supplied — the surfaces that just render this table (PeriodDetail, the dashboard
// drill-down tables, AccountDetail, TagDetail) all get sort for free without each having to
// reimplement the comparator. Numeric/date columns default to "biggest first"; text columns
// to ascending, matching the pattern the Transactions page already uses.
function comparePrimary(a, b, key, sign) {
  if (key === 'date') return sign * String(a.date || '').localeCompare(String(b.date || ''))
  if (key === 'merchant') return sign * String(getTxnMerchantLabel(a) || '').localeCompare(String(getTxnMerchantLabel(b) || ''))
  if (key === 'category') return sign * String(a.category_name || '').localeCompare(String(b.category_name || ''))
  if (key === 'account') return sign * String(a.account_name || '').localeCompare(String(b.account_name || ''))
  if (key === 'sourceAccount') return sign * String(a.source_account_raw_name || '').localeCompare(String(b.source_account_raw_name || ''))
  if (key === 'amount') return sign * ((Number(a.amount) || 0) - (Number(b.amount) || 0))
  return 0
}

// When the primary key ties, fall back to date DESC then id DESC, so rows within a group read
// newest-first and the order is fully deterministic — mirroring the server-side ledger's explicit
// `ORDER BY <key>, t.date DESC, t.id DESC`. The tiebreaker direction is fixed to desc regardless of the
// primary column's direction (the ledger does the same). Sorting by `date` already resolves its own
// ties via the id fallback below.
function compareRows(a, b, key, sign) {
  const primary = comparePrimary(a, b, key, sign)
  if (primary !== 0) return primary
  if (key !== 'date') {
    const byDate = String(b.date || '').localeCompare(String(a.date || ''))
    if (byDate !== 0) return byDate
  }
  return String(b.id || '').localeCompare(String(a.id || ''))
}

function getInitialSortDirection(key) {
  return key === 'date' || key === 'amount' ? 'desc' : 'asc'
}

function normalizeInteractiveColumns(columnConfig, availableColumns) {
  const defsByKey = new Map(availableColumns.map(column => [column.key, column]))
  const normalized = []
  const usedKeys = new Set()

  if (Array.isArray(columnConfig)) {
    for (const column of columnConfig) {
      const def = defsByKey.get(column?.key)
      if (!def || usedKeys.has(def.key)) continue
      normalized.push({
        key: def.key,
        width: Number(column?.width) || def.defaultWidth,
      })
      usedKeys.add(def.key)
    }
  }

  // Splice any available column the saved config didn't have (e.g. `tags`, added after a config was
  // stored) in at its canonical position rather than tacking it onto the end, so a newly introduced
  // column lands next to its natural neighbours instead of stranded to the right of Amount.
  availableColumns.forEach((def, canonicalIndex) => {
    if (usedKeys.has(def.key)) return
    normalized.splice(Math.min(canonicalIndex, normalized.length), 0, {
      key: def.key,
      width: def.defaultWidth,
    })
    usedKeys.add(def.key)
  })

  return normalized
}

export default function TransactionListTable({
  rows,
  categories = [],
  onCategorySave,
  onCategoryOpenDetail,
  onTransactionOpenDetail,
  onAddCategory,
  onRowsChange,
  // Reconcile callbacks for the shared right-click row menu (owned by this table). The menu's
  // "Edit transaction" routes through onTransactionOpenDetail; it appears only when that callback
  // is supplied (and the table isn't in bulk-select mode). onTrashed lets a host adjust anything it
  // tracks outside `rows` after a soft-delete (a total count, an open child panel); onRuleSaved
  // fires after a rule is created/applied from the menu.
  onTrashed = null,
  onRuleSaved = null,
  // A split was rewritten. Only matters to a host whose rows are *expanded allocations* (a
  // category-scoped list), where the parts' categories and amounts came from the server and a row patch
  // cannot restate them — such a host passes its refetch. Where none is given the table falls back to
  // dropping the stale allocation rows rather than leaving them showing figures that are no longer true.
  onSplitSaved = null,
  // A row left or rejoined a recurring series from the row menu (see useTransactionRowActions). The row
  // itself is patched in place and lingers; a host that shows series counts beside it adjusts them here.
  onMembershipChange = null,
  getRowStyle,
  maxHeight = 420,
  showAccount = true,
  showSourceAccount = false,
  showCategory = true,
  // A Balance column after Amount, from each row's `running_balance`. `balanceFlags` maps a row id to the
  // note its balance carries, a span where the stated balances and the transactions disagree.
  showRunningBalance = false,
  balanceFlags = null,
  // The account's type, which colors a balance on the unusual side of zero (`unusualBalanceColor`).
  balanceAccountType = null,
  // The merchant ↗ (opens the merchant activity report) is self-referential on a list already scoped
  // to one merchant — e.g. TransactionDetail's own payee activity — so that surface turns it off while
  // keeping inline rename, the pencil, and the row menu.
  showMerchantReport = true,
  // When set, rows whose category (or its parent group) is excluded from totals get a quiet marker
  // by the amount + a dimmed amount, so a list that sits next to a total which omits those rows
  // explains the gap. Off by default: the plain Transactions/Categories ledgers show no totals, so
  // there is nothing for the marker to reconcile against there.
  markExcludedFromTotals = false,
  emptyMessage = 'No transactions found.',
  // Off where a rule is already being written: the rule editor's own preview of what it would change,
  // where a second "create a rule?" would compete with the one on screen.
  offerRuleSuggestions = true,
  scrollRef = null,
  // A host paging its rows by position (usePagedTransactions) passes its `paging`: the table then draws
  // `paging.slots`, the whole result with placeholders where pages have not arrived, and reports the rows
  // in view so the host fetches them. `rows` stays the loaded rows, for everything but drawing.
  paging = null,
  fillHeight = false,
  columnConfig = null,
  onColumnConfigChange = null,
  // Callers that own row fetching (and thus do sort server-side) can pass a controlled pair;
  // when omitted the table manages its own client-side sort.
  sortState: externalSortState = null,
  onSort: externalOnSort = null,
  // Opt-in bulk selection: when `bulkActive`, a leading checkbox column appears whose header is the
  // select-all checkbox. `bulkSelection` is a useTransactionSelection() instance; `bulkTotal` is the
  // filtered result count used for the select-all/indeterminate state.
  bulkActive = false,
  bulkSelection = null,
  bulkTotal = 0,
}) {
  // The wrapper below is the scroll viewport the rows window against, and a caller may want it too, so it
  // needs a ref whether or not the caller passed one.
  const internalScrollRef = useRef(null)
  const attachScrollRef = useCallback(node => {
    internalScrollRef.current = node
    if (typeof scrollRef === 'function') scrollRef(node)
    else if (scrollRef) scrollRef.current = node
  }, [scrollRef])

  const externallyControlled = typeof externalOnSort === 'function'
  const [internalSortState, setInternalSortState] = useState(null)
  const sortState = externallyControlled ? externalSortState : internalSortState
  function handleInternalSort(key) {
    setInternalSortState(prev => {
      if (prev && prev.key === key) {
        return { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
      }
      return { key, dir: getInitialSortDirection(key) }
    })
  }
  const onSort = externallyControlled ? externalOnSort : handleInternalSort

  // Shared right-click row menu + its note / tag / trash / rule editors, so every list built on this
  // table gets the same row actions as the Transactions ledger from one implementation. The host
  // owns its rows, so reconcile flows back through onRowsChange / onTrashed.
  const rowActions = useTransactionRowActions({
    onOpenDetail: onTransactionOpenDetail,
    reconcileRow: (txnId, patch) => patchRows(txnId, patch),
    removeRow: txnId => { onRowsChange?.(prev => prev.filter(row => row.id !== txnId)); onTrashed?.(txnId) },
    onRuleSaved,
    onSplitSaved: (txnId, result) => {
      if (onSplitSaved) { onSplitSaved(txnId, result); return }
      const expanded = (rows || []).some(row => row.id === txnId && row.split_part_id)
      if (expanded) onRowsChange?.(prev => prev.filter(row => !(row.id === txnId && row.split_part_id)))
    },
    onMembershipChange,
    categories,
    onAddCategory,
  })

  // The "create a rule?" offer after a category is picked, owned here rather than by each host. It used to
  // be wired per surface, and most lists outside the Transactions page never were — categorizing from a
  // sync report or a detail panel saved the category and offered nothing. Owning it here gives every list
  // built on this table the same offer, on any manual category change.
  const [rulePrompt, setRulePrompt] = useState(null)

  // The menu's "Edit transaction" item needs somewhere to open the editor; without that callback
  // there is no row menu. Bulk-select mode owns its own interaction, so suppress the menu there.
  const rowMenuEnabled = !bulkActive && typeof onTransactionOpenDetail === 'function'

  // External sort means the parent has already ordered `rows`; only sort here when we own state.
  const visibleRows = useMemo(() => {
    if (externallyControlled || !sortState) return rows
    const sign = sortState.dir === 'asc' ? 1 : -1
    return [...rows].sort((a, b) => compareRows(a, b, sortState.key, sign))
  }, [rows, externallyControlled, sortState])

  const availableColumns = getAvailableColumns({ showCategory, showAccount, showSourceAccount, showRunningBalance })
  const interactiveColumns = normalizeInteractiveColumns(columnConfig, availableColumns)

  function patchRows(txnId, patch) {
    onRowsChange?.(prev =>
      prev.map(row => row.id === txnId ? { ...row, ...patch } : row)
    )
  }

  function renderCell(columnKey, txn) {
    switch (columnKey) {
      case BULK_SELECT_COLUMN_KEY:
        return (
          <input
            type="checkbox"
            checked={!!bulkSelection?.isSelected(txn.id)}
            onChange={() => bulkSelection?.toggle(txn.id)}
            onClick={e => e.stopPropagation()}
            title="Select transaction"
            style={{ cursor: 'pointer', margin: 0 }}
          />
        )
      case 'date':
        return <span style={{ color: 'var(--muted)', fontSize: 12 }}>{formatDate(txn.date)}</span>
      case 'merchant':
        return (
          <MerchantCell
            txn={txn}
            onOpenDetail={onTransactionOpenDetail}
            onRename={(id, name) => patchRows(id, { display_name: name })}
            showReport={showMerchantReport}
          />
        )
      case 'category':
        return (
          <CategoryCell
            txn={txn}
            categories={categories}
            onSave={onCategorySave}
            onOpenDetail={txn.category_id && onCategoryOpenDetail
              ? () => onCategoryOpenDetail({
                id: txn.category_id,
                name: txn.category_name,
              })
              : undefined}
            onAddCategory={onAddCategory}
            onOpenSplit={rowActions.openSplitFromMenu}
            onRulePrompt={offerRuleSuggestions ? setRulePrompt : undefined}
          />
        )
      case 'account': {
        const accountLabel = `${txn.account_name}${txn.account_mask ? ` ···${txn.account_mask}` : ''}`
        return (
          <Tooltip
            content={accountLabel}
            openDelay={ROW_HOVER_OPEN_DELAY_MS}
            triggerStyle={{ display: 'flex', maxWidth: '100%' }}
          >
            <span
              style={{
                color: 'var(--muted)',
                fontSize: 12,
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {accountLabel}
            </span>
          </Tooltip>
        )
      }
      case 'sourceAccount':
        return (
          <span
            title={txn.source_account_raw_name || ''}
            style={{
              color: 'var(--muted)',
              fontSize: 12,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {txn.source_account_raw_name || ''}
          </span>
        )
      case 'tags':
        return (
          <TransactionMarkersCell
            txn={txn}
            showExcludedFromTotals={markExcludedFromTotals}
            onUpdateNote={(id, notes) => patchRows(id, { notes })}
            onUpdateTags={(id, tags, blockedTags) => patchRows(id, { tags, blocked_tags: blockedTags })}
            onUpdatePurchase={(id, purchase) => patchRows(id, { purchase })}
            onUpdateDocuments={(id, documents) => patchRows(id, { documents })}
            onMarkReviewed={rowMenuEnabled ? rowActions.markReviewed : undefined}
            onOpenDetail={onTransactionOpenDetail}
          />
        )
      case 'amount':
        return (
          <TransactionAmountCell
            txn={txn}
            showExcludedFromTotals={markExcludedFromTotals}
            onOpenDetail={onTransactionOpenDetail}
          />
        )
      case 'runningBalance': {
        if (txn.running_balance == null) return null
        const flag = balanceFlags?.get(txn.id)
        const figure = (
          <span style={{
            fontSize: 12, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
            color: unusualBalanceColor(balanceAccountType, txn.running_balance) || 'var(--muted)',
          }}>
            {flag ? <span style={{ color: BALANCE_WARNING_COLOR, marginRight: 4 }}>⚠</span> : null}
            {formatSignedMoneyAmount(txn.running_balance)}
          </span>
        )
        return (
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            {flag ? <Tooltip content={flag} align="right">{figure}</Tooltip> : figure}
          </div>
        )
      }
      default:
        return null
    }
  }

  // One row. Rendered through WindowedRows, so only the rows near the viewport exist in the DOM —
  // note there is deliberately no `content-visibility` here: windowing already keeps unmounted rows out
  // of layout, and the intrinsic-size placeholder would feed the virtualizer a wrong measurement.
  function renderRow(columns, gridTemplateColumns, txn) {
    return (
      <div
        onContextMenu={rowMenuEnabled ? e => rowActions.onContextMenu(e, txn) : undefined}
        style={{
          display: 'grid',
          gridTemplateColumns,
          padding: '10px 14px',
          alignItems: 'center',
          fontSize: 13,
          borderBottom: '1px solid var(--border)',
          ...getRowStyle?.(txn),
        }}
      >
        {columns.map(col => (
          <div
            key={col.key}
            style={{
              minWidth: 0,
              ...(col.key === BULK_SELECT_COLUMN_KEY
                ? { display: 'flex', justifyContent: 'center' }
                : col.key === 'amount' ? {} : { overflow: 'hidden' }),
            }}
          >
            {renderCell(col.key, txn)}
          </div>
        ))}
      </div>
    )
  }

  if (!rows.length) {
    return (
      <div style={{ fontSize: 13, color: 'var(--muted)' }}>
        {emptyMessage}
      </div>
    )
  }

  const pillColumns = interactiveColumns.map(column => {
    const def = COLUMN_DEFS[column.key]
    return {
      key: def.key,
      label: def.label,
      width: column.width,
      minWidth: def.minWidth,
      align: def.align,
      sortable: def.sortable !== false,
      draggable: true,
      resizable: true,
      title: `Drag middle to move ${def.label}`,
    }
  })

  if (bulkActive && bulkSelection) {
    const allSelected = bulkSelection.allMatching && bulkSelection.excludedCount === 0
    const count = bulkSelection.selectedCount(bulkTotal)
    pillColumns.unshift({
      key: BULK_SELECT_COLUMN_KEY,
      label: '',
      width: 40,
      minWidth: 40,
      align: 'center',
      cellPadding: 0,
      sortable: false,
      draggable: false,
      resizable: false,
      render: () => (
        <SelectAllCheckbox
          checked={allSelected}
          indeterminate={!allSelected && count > 0}
          onChange={() => { if (count > 0) bulkSelection.clear(); else bulkSelection.selectAllMatching() }}
          title="Select all matching transactions"
        />
      ),
    })
  }

  return (
    <>
      {/* This wrapper is the scroll viewport: vertical scroll feeds the sticky header below,
        horizontal scroll feeds the wide grid. scrollRef lands here so a caller can reach the same
        element the rows scroll inside. It is intentionally
        NOT a flex container — combining `display:flex,flex-direction:column` with `overflow:auto`
        and a height cap causes the block child to be flex-shrunk rather than allowed to overflow,
        which subtly changes the wrapper's measured size and throws off the floating detail
        panel's initial centered position. */}
      <div
        ref={attachScrollRef}
        style={{
          border: '1px solid var(--border)',
          borderRadius: 10,
          overflow: 'auto',
          ...(fillHeight ? { flex: 1, minHeight: 0, height: '100%' } : { maxHeight }),
        }}>
        <PillGridTable
          columns={pillColumns}
          onColumnsChange={onColumnConfigChange
            ? cols => onColumnConfigChange(cols.filter(col => col.key !== BULK_SELECT_COLUMN_KEY))
            : undefined}
          sortState={sortState}
          onSort={onSort}
          headerStyle={{
            position: 'sticky',
            top: 0,
            background: 'var(--surface)',
            zIndex: 2,
          }}
          renderBody={({ columns: activeColumns, gridTemplateColumns }) => (
            <WindowedRows
              scrollRef={internalScrollRef}
              items={paging ? paging.slots : visibleRows}
              getItemKey={transactionRowKey}
              estimateSize={41}
              measureKey={activeColumns.map(col => col.width).join(',')}
              onRangeChange={paging?.onRangeChange}
              apiRef={paging?.apiRef}
              renderRow={txn => renderRow(activeColumns, gridTemplateColumns, txn)}
            />
          )}
        />
      </div>
      <TransactionRowActionsChrome controller={rowActions} />
      {/* Portaled because this table often sits inside a floating panel or a draggable dialog, and a
          `position: fixed` toast inside a transformed ancestor is placed relative to that ancestor. */}
      {rulePrompt ? createPortal(
        <RuleSuggestionToast
          prompt={rulePrompt}
          onSaved={({ applyToExisting, transactionIds }) => {
            // The rows the rule recategorized stay on the list with their new category, re-fetched by id,
            // rather than dropping out of a scoped list on a reload. A host with no row setter is showing
            // a list it cannot patch, and keeps what it has.
            if (applyToExisting && onRowsChange) reconcileRowsAfterRuleApply(rows, transactionIds, onRowsChange)
          }}
          onDismiss={() => setRulePrompt(null)}
        />,
        document.body,
      ) : null}
    </>
  )
}
