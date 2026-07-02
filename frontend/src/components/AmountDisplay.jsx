// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import React from 'react'
import { formatTransactionAmount, getTransactionAmountColor } from '../lib/moneyDisplay.js'

export default function AmountDisplay({ amount, isPending = false, align = 'right', style = {} }) {
  return (
    <span
      style={{
        textAlign: align,
        fontWeight: 600,
        color: getTransactionAmountColor(amount),
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: align === 'right' ? 'flex-end' : 'flex-start',
        gap: 6,
        ...style,
      }}
    >
      {isPending && (
        <span
          title="Pending transaction"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 16,
            height: 16,
            borderRadius: 999,
            fontSize: 10,
            fontWeight: 700,
            color: 'var(--accent2)',
            background: 'color-mix(in srgb, var(--accent) 12%, var(--surface2))',
            border: '1px solid color-mix(in srgb, var(--accent) 30%, var(--border))',
            flexShrink: 0,
          }}
        >
          P
        </span>
      )}
      <span>{formatTransactionAmount(amount)}</span>
    </span>
  )
}
