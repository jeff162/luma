// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: GPL-3.0-or-later

import { formatDate } from '../lib/utils.js'
import { CategoryCell, MerchantCell } from './TransactionRow.jsx'
import AmountDisplay from './AmountDisplay.jsx'

export default function TransactionListTable({
  rows,
  categories = [],
  onCategorySave,
  onAddCategory,
  onRulePrompt,
  onRowsChange,
  maxHeight = 420,
  showAccount = true,
  showCategory = true,
  emptyMessage = 'No transactions found.',
  scrollRef = null,
  fillHeight = false,
}) {
  const columns = [
    { key: 'date', label: 'Date', width: '96px' },
    { key: 'merchant', label: 'Merchant', width: '1fr' },
    ...(showCategory ? [{ key: 'category', label: 'Category', width: '150px' }] : []),
    ...(showAccount ? [{ key: 'account', label: 'Account', width: '130px' }] : []),
    { key: 'amount', label: 'Amount', width: '100px' },
  ]
  const gridTemplateColumns = columns.map(col => col.width).join(' ')

  if (!rows.length) {
    return (
      <div style={{ fontSize: 13, color: 'var(--muted)' }}>
        {emptyMessage}
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
        gridTemplateColumns,
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
        {columns.map(col => (
          <span key={col.key} style={col.key === 'amount' ? { textAlign: 'right' } : undefined}>
            {col.label}
          </span>
        ))}
      </div>
      <div
        ref={scrollRef}
        style={fillHeight ? { flex: 1, minHeight: 0, overflowY: 'auto' } : { maxHeight, overflowY: 'auto' }}
      >
        {rows.map(txn => (
          <div
            key={txn.id}
            style={{
              display: 'grid',
              gridTemplateColumns,
              gap: 12,
              padding: '10px 14px',
              alignItems: 'center',
              fontSize: 13,
              borderBottom: '1px solid var(--border)',
            }}
          >
            <span style={{ color: 'var(--muted)', fontSize: 12 }}>{formatDate(txn.date)}</span>
            <MerchantCell
              txn={txn}
              onRename={(id, name) => onRowsChange?.(prev =>
                prev.map(row => row.id === id ? { ...row, display_name: name } : row)
              )}
            />
            {showCategory && (
              <CategoryCell
                txn={txn}
                categories={categories}
                onSave={onCategorySave}
                onAddCategory={onAddCategory}
                onRulePrompt={onRulePrompt}
              />
            )}
            {showAccount && (
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
            )}
            <AmountDisplay amount={txn.amount} isPending={!!txn.is_pending} />
          </div>
        ))}
      </div>
    </div>
  )
}
