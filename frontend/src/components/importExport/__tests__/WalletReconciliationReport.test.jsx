// @vitest-environment jsdom

// The wallet reconciliation, the reconciliation shell's second vendor: its buckets and order, which call
// each action makes (a bank row with no wallet record is acknowledged by its own id, a wallet row by the
// wallet row's), and the two ways into the manual linking window — a row's own candidates, or the
// server's nearby rows when it has none.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const api = vi.hoisted(() => ({
  unpairWalletRows: vi.fn(),
  declineWalletPair: vi.fn(),
  markWalletPairReviewed: vi.fn(),
  pairWalletRows: vi.fn(),
  getWalletPairCandidates: vi.fn(),
}))
vi.mock('../../../lib/api.js', () => ({ api }))
vi.mock('../../detailShared.jsx', () => ({
  DetailPanelShell: ({ header, children, footer }) => <div>{header}{children}{footer}</div>,
  useDetailPanelChrome: () => ({ pos: {}, size: {}, panelRef: { current: null }, onDragStart: () => {}, onResizeStart: () => {} }),
  useRestorablePanelGeometry: () => ({}),
}))
// The header sort is a saved preference; local state stands in for the app's provider.
vi.mock('../../../lib/UserPreferencesContext.jsx', async (importOriginal) => {
  const { useState } = await import('react')
  return { ...(await importOriginal()), useUserPreference: (_key, initial) => useState(initial) }
})
vi.mock('../../../help/FeatureExplainer.jsx', () => ({ default: () => null }))
vi.mock('../../OriginFields.jsx', () => ({ MerchantOriginHoverCard: () => null }))
// Rows sized from layout jsdom lacks; one stand-in row per entry, every column rendered.
vi.mock('../MatchReport.jsx', () => ({
  MatchReport: ({ entries, columns, getRowId, selectable, selectedIds, onToggleRow }) => (
    <div>
      {entries.map(entry => (
        <div key={getRowId(entry)} data-testid="row" data-kind={entry.kind}>
          {selectable ? <input type="checkbox" aria-label={`select ${getRowId(entry)}`} checked={!!selectedIds?.has(getRowId(entry))} onChange={() => onToggleRow(entry)} /> : null}
          {columns.map(col => <div key={col.key}>{col.render(entry)}</div>)}
        </div>
      ))}
    </div>
  ),
}))

const { ReconciliationReportDialog } = await import('../reconciliation/ReconciliationReportDialog.jsx')

const txn = (id, date, amount, name, account) => ({ id, date, amount, name, account })

const PAYLOAD = {
  matched: [{ link_id: 'L1', wallet: txn('p1', '2026-08-25', 50, 'Harbor Relief Fund', 'PayPal'),
    counterpart: txn('c1', '2026-08-23', 50, 'PAYPAL *HARBOR', 'Harborline Card'), matched_by: 'auto' }],
  choice: [{ wallet: txn('p2', '2026-03-05', 75, 'Trail Club', 'PayPal'),
    candidates: [txn('c2', '2026-03-04', 75, 'PAYPAL *TRAIL', 'Harborline Card'), txn('c3', '2026-03-06', 75, 'PAYPAL TRAIL', 'Riverstone Checking')] }],
  unmatched: [{ wallet: txn('p3', '2026-03-27', 2100, 'Withdrawal', 'PayPal'), reviewed: false }],
  unaccounted: [{ ...txn('c4', '2026-02-01', 44, 'PAYPAL *UNKNOWN', 'Harborline Card'), reviewed: false }],
  wallet_names: ['PayPal'],
}

function renderReport() {
  const onReload = vi.fn()
  render(<ReconciliationReportDialog vendor="wallet" data={PAYLOAD} onClose={() => {}} onReload={onReload} />)
  return { onReload }
}

const rowFor = (text) => screen.getAllByTestId('row').find(r => within(r).queryByText(text))

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset().mockResolvedValue({})
})
afterEach(() => cleanup())

describe('wallet reconciliation', () => {
  it('lists what needs a choice first and the matches last', () => {
    renderReport()
    expect(screen.getAllByTestId('row').map(r => r.dataset.kind)).toEqual(['choice', 'unmatched', 'unaccounted', 'matched'])
    expect(screen.getByText('PayPal reconciliation')).toBeTruthy()
  })

  it('unlinks a match and declines every candidate of a choice', async () => {
    const { onReload } = renderReport()
    await userEvent.click(within(rowFor('Harbor Relief Fund')).getByRole('button', { name: 'Unlink' }))
    expect(api.unpairWalletRows).toHaveBeenCalledWith({ link_ids: ['L1'] })
    await userEvent.click(within(rowFor('Trail Club')).getByRole('button', { name: 'None of these' }))
    expect(api.declineWalletPair).toHaveBeenCalledWith({ wallet_txn_id: 'p2', counterpart_txn_ids: ['c2', 'c3'] })
    expect(onReload).toHaveBeenCalled()
  })

  it('acknowledges a wallet row by its own id and a bank row with no wallet record by the bank row', async () => {
    renderReport()
    await userEvent.click(within(rowFor('Withdrawal')).getByRole('button', { name: 'Mark reviewed' }))
    expect(api.markWalletPairReviewed).toHaveBeenCalledWith({ txn_ids: ['p3'], reviewed: true })
    await userEvent.click(within(rowFor('PAYPAL *UNKNOWN')).getByRole('button', { name: 'Mark reviewed' }))
    expect(api.markWalletPairReviewed).toHaveBeenCalledWith({ txn_ids: ['c4'], reviewed: true })
  })

  it('picks from a choice row’s own candidates', async () => {
    renderReport()
    await userEvent.click(within(rowFor('Trail Club')).getByRole('button', { name: 'Pick…' }))
    expect(api.getWalletPairCandidates).not.toHaveBeenCalled()
    const options = screen.getAllByRole('radio')
    expect(options).toHaveLength(2)
    await userEvent.click(options[1])
    await userEvent.click(screen.getByRole('button', { name: 'Link' }))
    expect(api.pairWalletRows).toHaveBeenCalledWith({ wallet_txn_id: 'p2', counterpart_txn_id: expect.any(String) })
  })

  it('offers an unmatched row the nearby rows the server finds, and compares magnitudes', async () => {
    api.getWalletPairCandidates.mockResolvedValue([txn('d1', '2026-03-30', -2100, 'ACH PAYPAL TRANSFER', 'Riverstone Checking')])
    renderReport()
    await userEvent.click(within(rowFor('Withdrawal')).getByRole('button', { name: 'Link…' }))
    expect(api.getWalletPairCandidates).toHaveBeenCalledWith('p3')
    await userEvent.click(await screen.findByRole('radio'))
    // A deposit of 2,100 is the other half of a 2,100 withdrawal: no mismatch warning.
    expect(screen.queryByText(/amounts differ/)).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Link' }))
    expect(api.pairWalletRows).toHaveBeenCalledWith({ wallet_txn_id: 'p3', counterpart_txn_id: 'd1' })
  })

  it('declines in bulk only for the selected choice rows', async () => {
    renderReport()
    await userEvent.click(screen.getByRole('checkbox', { name: 'select c:p2' }))
    await userEvent.click(screen.getByRole('checkbox', { name: 'select m:L1' }))
    await userEvent.click(screen.getByRole('button', { name: 'None of these (1)' }))
    expect(api.declineWalletPair).toHaveBeenCalledTimes(1)
    expect(api.unpairWalletRows).not.toHaveBeenCalled()
  })
})
