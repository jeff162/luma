// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * Where a repayment goes: the open reimbursements it could be repaying.
 *
 * This exists because the sign of a row decides what there is to *do* with it. Money out is an expense
 * — the useful act is saying it is coming back, which needs no counterpart yet. Money in repays
 * something, so the useful act is naming what. Offering "track this" on both put a repayment into a
 * record of its own, and since a claim belongs to exactly one record, the expense could then never be
 * joined to it: both sides had spent their money on separate records. Every one of the user's expenses
 * ended up stranded that way.
 *
 * **Tracking alone stays available** rather than being removed as the wrong answer. A repayment can
 * genuinely arrive before its expense is recorded — the credit clears before the receipt is entered —
 * and refusing it would leave that money with nowhere to go at all. It is the quiet option because it
 * is the rarer one, not because it is invalid.
 */

import { Button } from './ui.jsx'
import { formatMoneyMagnitude } from '../lib/moneyDisplay.js'
import { reimbursementListLabel, residualSummary } from '../lib/reimbursements.js'

const rowStyle = {
  display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline',
  width: '100%', textAlign: 'left', font: 'inherit', fontSize: 12.5, cursor: 'pointer',
  padding: '5px 10px', borderRadius: 6,
  background: 'var(--surface2)', border: '1px solid var(--border)', color: 'var(--text)',
}

export default function ReimbursementMatchPicker({
  reimbursements = [],
  rows = [],
  amountLabel = '',
  busy = false,
  onMatch,
  onMatchRow,
  onTrackAlone,
  onCancel,
}) {
  const empty = !reimbursements.length && !rows.length
  return (
    <div style={{ display: 'grid', gap: 4 }}>
      <div style={{ fontSize: 12, color: 'var(--muted)' }}>
        {amountLabel ? `What does ${amountLabel} repay?` : 'What does this repay?'}
      </div>

      {reimbursements.map(reimbursement => (
        <button
          key={reimbursement.id}
          type="button"
          onClick={() => onMatch?.(reimbursement)}
          disabled={busy}
          style={{ ...rowStyle, cursor: busy ? 'default' : 'pointer' }}
        >
          <span style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {reimbursementListLabel(reimbursement)}
          </span>
          <span style={{ color: 'var(--muted)', whiteSpace: 'nowrap' }}>{residualSummary(reimbursement)}</span>
        </button>
      ))}

      {/* Expenses nobody has tracked yet. Listed beside the records because both are just receivable
          money: which of them happens to carry a record is not something the person matching them
          should have to think about, and requiring one first is what made this unreachable. Picking one
          creates the reimbursement with both sides on it. */}
      {rows.map(row => (
        <button
          key={row.txn_id}
          type="button"
          onClick={() => onMatchRow?.(row)}
          disabled={busy}
          style={{ ...rowStyle, cursor: busy ? 'default' : 'pointer' }}
        >
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {row.payee}
          </span>
          <span style={{ color: 'var(--muted)', whiteSpace: 'nowrap' }}>
            {formatMoneyMagnitude(Math.abs(row.unclaimed))} · not tracked yet
          </span>
        </button>
      ))}

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 2 }}>
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>
          {empty
            ? 'Nothing is waiting to be repaid yet.'
            : 'Or record it on its own until the expense is entered.'}
        </span>
        <span style={{ display: 'flex', gap: 6 }}>
          {onCancel ? <Button variant="ghost" small onClick={onCancel} disabled={busy}>Cancel</Button> : null}
          <Button
            variant={empty ? 'primary' : 'ghost'}
            small
            onClick={() => onTrackAlone?.()}
            disabled={busy}
          >
            {busy ? 'Working…' : 'Record on its own'}
          </Button>
        </span>
      </div>
    </div>
  )
}
