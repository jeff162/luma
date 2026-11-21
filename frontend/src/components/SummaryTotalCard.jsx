// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Card } from './ui.jsx'
import { formatSignedMoneyAmount } from '../lib/moneyDisplay.js'

// One headline figure above a Dashboard report: a label naming what and when, and the amount. `format`
// replaces the signed amount where the label already names the direction (Liabilities), which then reads
// as a magnitude.
export default function SummaryTotalCard({ label, value, color, format = formatSignedMoneyAmount }) {
  return (
    <Card style={{ padding: '14px 24px' }}>
      <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 2 }}>{label}</div>
      <div data-testid="dashboard-total" style={{ fontSize: 28, fontWeight: 700, color }}>{format(value)}</div>
    </Card>
  )
}
