// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: GPL-3.0-or-later

import { useMemo, useState } from 'react'
import { formatDate } from '../lib/utils.js'
import { CategoryCell, MerchantCell, TransactionAmountCell, getTxnMerchantLabel } from './TransactionRow.jsx'
import PillGridTable from './PillGridTable.jsx'

const COLUMN_DEFS = {
  date: { key: 'date', label: 'Date', defaultWidth: 96, minWidth: 82 },
  merchant: { key: 'merchant', label: 'Merchant', defaultWidth: 260, minWidth: 150 },
  category: { key: 'category', label: 'Category', defaultWidth: 150, minWidth: 110 },
  account: { key: 'account', label: 'Account', defaultWidth: 140, minWidth: 110 },
  amount: { key: 'amount', label: 'Amount', defaultWidth: 108, minWidth: 88, align: 'end' },
}

function getAvailableColumns({ showCategory, showAccount }) {
  return [
    COLUMN_DEFS.date,
    COLUMN_DEFS.merchant,
    ...(showCategory ? [COLUMN_DEFS.category] : []),
    ...(showAccount ? [COLUMN_DEFS.account] : []),
    COLUMN_DEFS.amount,
  ]
}

// Column-header click sorting is handled entirely by the table when no external sort props
// are supplied — the surfaces that just render this table (MonthDetail, the dashboard
// drill-down tables, AccountDetail, TagDetail) all get sort for free without each having to
// reimplement the comparator. Numeric/date columns default to "biggest first"; text columns
// to ascending, matching the pattern the Transactions page already uses.
function compareRows(a, b, key, sign) {
  if (key === 'date') return sign * String(a.date || '').localeCompare(String(b.date || ''))
  if (key === 'merchant') return sign * String(getTxnMerchantLabel(a) || '').localeCompare(String(getTxnMerchantLabel(b) || ''))
  if (key === 'category') return sign * String(a.category_name || '').localeCompare(String(b.category_name || ''))
  if (key === 'account') return sign * String(a.account_name || '').localeCompare(String(b.account_name || ''))
  if (key === 'amount') return sign * ((Number(a.amount) || 0) - (Number(b.amount) || 0))
  return 0
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

  for (const def of availableColumns) {
    if (usedKeys.has(def.key)) continue
    normalized.push({
      key: def.key,
      width: def.defaultWidth,
    })
  }

  return normalized
}

/*
 * This shared transaction table keeps row rendering consistent while letting each surface
 * choose how heavy the table chrome should be. Detail drawers can stay lightweight, while
 * pages that need layout control can opt into the shared pill-header shell for resize/reorder.
 */
export default function TransactionListTable({
  rows,
  categories = [],
  onCategorySave,
  onCategoryOpenDetail,
  onTransactionOpenDetail,
  onAddCategory,
  onRulePrompt,
  onRowsChange,
  getRowStyle,
  maxHeight = 420,
  showAccount = true,
  showCategory = true,
  emptyMessage = 'No transactions found.',
  scrollRef = null,
  fillHeight = false,
  usePillTable = false,
  columnConfig = null,
  onColumnConfigChange = null,
  // Callers that own row fetching (and thus do sort server-side) can pass a controlled pair;
  // when omitted the table manages its own client-side sort.
  sortState: externalSortState = null,
  onSort: externalOnSort = null,
}) {
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

  // External sort means the parent has already ordered `rows`; only sort here when we own state.
  const visibleRows = useMemo(() => {
    if (externallyControlled || !sortState) return rows
    const sign = sortState.dir === 'asc' ? 1 : -1
    return [...rows].sort((a, b) => compareRows(a, b, sortState.key, sign))
  }, [rows, externallyControlled, sortState])

  const availableColumns = getAvailableColumns({ showCategory, showAccount })
  const simpleColumns = [
    { key: 'date', label: 'Date', width: '96px' },
    { key: 'merchant', label: 'Merchant', width: '1fr' },
    ...(showCategory ? [{ key: 'category', label: 'Category', width: '150px' }] : []),
    ...(showAccount ? [{ key: 'account', label: 'Account', width: '130px' }] : []),
    { key: 'amount', label: 'Amount', width: '100px' },
  ]
  const simpleGridTemplateColumns = simpleColumns.map(col => col.width).join(' ')
  const interactiveColumns = normalizeInteractiveColumns(columnConfig, availableColumns)

  function patchRows(txnId, patch) {
    onRowsChange?.(prev =>
      prev.map(row => row.id === txnId ? { ...row, ...patch } : row)
    )
  }

  function renderCell(columnKey, txn) {
    switch (columnKey) {
      case 'date':
        return <span style={{ color: 'var(--muted)', fontSize: 12 }}>{formatDate(txn.date)}</span>
      case 'merchant':
        return (
          <MerchantCell
            txn={txn}
            onOpenDetail={onTransactionOpenDetail}
            onRename={(id, name) => patchRows(id, { display_name: name })}
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
            onRulePrompt={onRulePrompt}
          />
        )
      case 'account':
        return (
          <span
            title={`${txn.account_name}${txn.account_mask ? ` ···${txn.account_mask}` : ''}`}
            style={{
              color: 'var(--muted)',
              fontSize: 12,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {txn.account_name}{txn.account_mask ? ` ···${txn.account_mask}` : ''}
          </span>
        )
      case 'amount':
        return (
          <TransactionAmountCell
            txn={txn}
            onUpdateNote={(id, notes) => patchRows(id, { notes })}
            onUpdateTags={(id, tags) => patchRows(id, { tags })}
            onOpenDetail={onTransactionOpenDetail}
          />
        )
      default:
        return null
    }
  }

  function renderRows(columns, gridTemplateColumns) {
    return visibleRows.map(txn => (
      <div
        key={txn.id}
        style={{
          display: 'grid',
          gridTemplateColumns,
          padding: '10px 14px',
          alignItems: 'center',
          fontSize: 13,
          borderBottom: '1px solid var(--border)',
          gap: usePillTable ? 0 : 12,
          ...getRowStyle?.(txn),
        }}
      >
        {columns.map(col => (
          <div
            key={col.key}
            style={{
              minWidth: 0,
              ...(col.key === 'amount' ? {} : { overflow: 'hidden' }),
            }}
          >
            {renderCell(col.key, txn)}
          </div>
        ))}
      </div>
    ))
  }

  if (!rows.length) {
    return (
      <div style={{ fontSize: 13, color: 'var(--muted)' }}>
        {emptyMessage}
      </div>
    )
  }

  if (usePillTable) {
    const pillColumns = interactiveColumns.map(column => {
      const def = COLUMN_DEFS[column.key]
      return {
        key: def.key,
        label: def.label,
        width: column.width,
        minWidth: def.minWidth,
        align: def.align,
        draggable: true,
        resizable: true,
        title: `Drag middle to move ${def.label}`,
      }
    })

    return (
      <div style={{
        border: '1px solid var(--border)',
        borderRadius: 10,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        ...(fillHeight ? { flex: 1, minHeight: 0, height: '100%' } : null),
      }}>
        <div style={{ flex: 1, minHeight: 0, overflowX: 'auto', overflowY: 'hidden' }}>
          <PillGridTable
            columns={pillColumns}
            onColumnsChange={onColumnConfigChange}
            sortState={sortState}
            onSort={onSort}
            fillHeight={fillHeight}
            renderBody={({ columns: activeColumns, gridTemplateColumns }) => (
              <div
                ref={scrollRef}
                style={fillHeight ? { flex: 1, minHeight: 0, overflowY: 'auto' } : { maxHeight, overflowY: 'auto' }}
              >
                {renderRows(activeColumns, gridTemplateColumns)}
              </div>
            )}
          />
        </div>
      </div>
    )
  }

  return (
    <div style={{
      border: '1px solid var(--border)',
      borderRadius: 10,
      overflow: 'hidden',
      display: 'flex',
      flexDirection: 'column',
      ...(fillHeight ? { flex: 1, minHeight: 0, height: '100%' } : null),
    }}>
      <div style={{
        display: 'grid',
        gridTemplateColumns: simpleGridTemplateColumns,
        gap: 12,
        padding: '8px 14px',
        fontSize: 11,
        fontWeight: 600,
        color: 'var(--muted)',
        textTransform: 'uppercase',
        letterSpacing: '0.05em',
        background: 'var(--surface2)',
        borderBottom: '1px solid var(--border)',
      }}>
        {simpleColumns.map(col => (
          <span
            key={col.key}
            style={col.key === 'amount'
              ? { display: 'block', width: '100%', textAlign: 'right' }
              : undefined}
          >
            {col.label}
          </span>
        ))}
      </div>
      <div
        ref={scrollRef}
        style={fillHeight ? { flex: 1, minHeight: 0, overflowY: 'auto' } : { maxHeight, overflowY: 'auto' }}
      >
        {renderRows(simpleColumns, simpleGridTemplateColumns)}
      </div>
    </div>
  )
}
