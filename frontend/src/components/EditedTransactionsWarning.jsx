// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import React from 'react'
import { formatTransactionAmount, getTransactionAmountColor } from '../lib/moneyDisplay.js'
import { formatDate } from '../lib/utils.js'

// The "you edited these after they came in" block shown before a removal that would delete them —
// a file's Undo and a connection's Remove synced transactions. Both back the same backend guard
// (409 with the edited rows unless force), so the warning they show is one component: the rows are
// what makes the removal destructive rather than a plain reversal, and the list is what lets the
// user recognize work they'd lose. The host owns the dialog shell and the confirm action.
export function EditedTransactionsWarning({ rows, noun = 'transactions', suffix = 'after import' }) {
  if (!rows?.length) return null
  return (
    <div style={{
      background: 'color-mix(in srgb, var(--danger) 10%, var(--surface2))',
      border: '1px solid var(--danger)',
      borderRadius: 8,
      padding: '10px 14px',
      marginBottom: 16,
    }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6, color: 'var(--danger)' }}>
        ⚠ {rows.length} {rows.length === 1 ? noun.replace(/s$/, '') : noun} {rows.length === 1 ? 'was' : 'were'} manually edited {suffix}
      </div>
      <div style={{ maxHeight: 180, overflowY: 'auto' }}>
        {rows.map(t => (
          <div key={t.id} style={{ display: 'grid', gridTemplateColumns: '90px 1fr 80px', fontSize: 12, padding: '4px 0', borderBottom: '1px solid var(--border)' }}>
            <span style={{ color: 'var(--muted)' }}>{formatDate(t.date)}</span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.display_name || t.merchant_name || t.raw_name}</span>
            <span style={{ textAlign: 'right', color: getTransactionAmountColor(t.amount) }}>{formatTransactionAmount(t.amount)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
