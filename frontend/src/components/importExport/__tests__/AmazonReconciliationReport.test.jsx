// @vitest-environment jsdom

// The Amazon reconciliation report's behavior, pinned from the outside: which rows it builds from the
// payload and in what order, what each kind offers and which call each action makes, the intersection bulk
// bar, and the charge picker. The report renders through the shared reconciliation shell, so these are also
// what a second client of that shell must not be able to disturb.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const api = vi.hoisted(() => ({
  unlinkAmazonOrderCharges: vi.fn(),
  linkAmazonCharges: vi.fn(),
  dismissAmazonSplitSuggestion: vi.fn(),
  markAmazonOrdersReviewed: vi.fn(),
  markAmazonUnaccountedReviewed: vi.fn(),
  trashAmazonDuplicateCharge: vi.fn(),
  mergeAmazonDuplicateCharges: vi.fn(),
  mergeUnaccountedAmazonCharges: vi.fn(),
  markAmazonChargesNotDuplicates: vi.fn(),
  getCategories: vi.fn(),
}))
vi.mock('../../../lib/api.js', () => ({ api }))
vi.mock('../../detailShared.jsx', () => ({
  DetailPanelShell: ({ header, children }) => <div>{header}{children}</div>,
  useDetailPanelChrome: () => ({ pos: {}, size: {}, panelRef: { current: null }, onDragStart: () => {}, onResizeStart: () => {} }),
  useRestorablePanelGeometry: () => ({}),
}))
vi.mock('../../../help/FeatureExplainer.jsx', () => ({ default: () => null }))
vi.mock('../../OriginFields.jsx', () => ({ MerchantOriginHoverCard: () => null }))
vi.mock('../../SplitEditorDialog.jsx', () => ({ default: ({ txn }) => <div>Split editor for {txn.name}</div> }))
// The shared table sizes its rows from layout jsdom does not have. It stands in as one row per entry, in the
// order given, rendering every column and the row's checkbox — which is all the report decides.
vi.mock('../MatchReport.jsx', () => ({
  MatchReport: ({ entries, columns, getRowId, selectable, selectedIds, onToggleRow, onToggleAll, error, emptyMessage }) => (
    <div>
      {error ? <div>{error}</div> : null}
      {selectable ? <button type="button" onClick={onToggleAll}>select all visible</button> : null}
      {entries.length === 0 ? <div>{emptyMessage}</div> : entries.map(entry => (
        <div key={getRowId(entry)} data-testid="row" data-kind={entry.kind}>
          {selectable ? <input type="checkbox" aria-label={`select ${getRowId(entry)}`} checked={!!selectedIds?.has(getRowId(entry))} onChange={() => onToggleRow(entry)} /> : null}
          {columns.map(col => <div key={col.key}>{col.render(entry)}</div>)}
        </div>
      ))}
    </div>
  ),
}))

const { ReconciliationReportDialog } = await import('../reconciliation/ReconciliationReportDialog.jsx')

const txn = (id, date, amount, name, account = 'Harborline Card') => ({ id, date, amount, name, account })

const PAYLOAD = {
  matched: [{ link_id: 'L-m', order: txn('o-m', '2026-03-10', 42, 'Order Matched', 'Amazon'), charges: [txn('c-m', '2026-03-11', 42, 'AMZN MKTP')] }],
  matched_review: [{
    link_id: 'L-r', order: txn('o-r', '2026-03-05', 30, 'Order Split', 'Amazon'),
    charges: [txn('c-r1', '2026-03-06', 10, 'AMZN MKTP'), txn('c-r2', '2026-03-09', 20, 'AMZN MKTP')],
    total: 30, spans_days: 3, reason: null,
  }],
  duplicate: [
    { link_id: 'L-d', order: txn('o-d', '2026-03-02', 15, 'Order Dup', 'Amazon'), mergeable: true,
      charges: [{ ...txn('c-d1', '2026-03-02', 15, 'AMZN A'), matched: true }, { ...txn('c-d2', '2026-03-02', 15, 'AMZN B') }] },
    { link_id: 'L-d2', order: txn('o-d2', '2026-03-03', 16, 'Order Dup Two', 'Amazon'), mergeable: false,
      charges: [txn('c-e1', '2026-03-03', 16, 'AMZN C'), txn('c-e2', '2026-03-03', 16, 'AMZN D')] },
  ],
  duplicate_review: [{ link_id: 'L-dr', order: txn('o-dr', '2026-03-04', 17, 'Order Dup Review', 'Amazon'), mergeable: true,
    charges: [txn('c-f1', '2026-03-01', 17, 'AMZN E'), txn('c-f2', '2026-03-12', 17, 'AMZN F')] }],
  amazon_unmatched: [
    { link_id: 'L-u', order: { ...txn('o-u', '2026-03-20', 25, 'Order Unmatched', 'Amazon'), item_count: 1 }, reviewed: false },
    { link_id: 'L-u2', order: { ...txn('o-u2', '2026-03-01', 26, 'Order Acknowledged', 'Amazon'), item_count: 1, is_split: true }, reviewed: true },
  ],
  payment_unmatched: [
    { ...txn('p-far', '2026-02-01', 11, 'AMZN far'), reviewed: false },
    { ...txn('p-near', '2026-03-19', 14, 'AMZN near'), reviewed: false },
  ],
  unaccounted_duplicate: [{ charges: [txn('c-u1', '2026-03-07', 9, 'AMZN G'), txn('c-u2', '2026-03-09', 9, 'AMZN H')] }],
}

function renderReport(props = {}) {
  const onReload = vi.fn()
  render(<ReconciliationReportDialog vendor="amazon" data={PAYLOAD} onClose={() => {}} onReload={onReload} {...props} />)
  return { onReload }
}

const rowFor = (text) => screen.getAllByTestId('row').find(r => within(r).queryByText(text))

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset().mockResolvedValue({})
  api.getCategories.mockResolvedValue([])
})
afterEach(() => cleanup())

describe('Amazon reconciliation report — rows', () => {
  it('lists problems first, then by date within a kind', () => {
    renderReport()
    expect(screen.getAllByTestId('row').map(r => r.dataset.kind)).toEqual([
      'duplicate', 'duplicate',
      'duplicate_review',
      'unmatched', 'unmatched',
      'matched_review',
      'unaccounted_duplicate',
      'reverse', 'reverse',
      'matched',
    ])
    // Within a kind, earliest first.
    const unmatched = screen.getAllByTestId('row').filter(r => r.dataset.kind === 'unmatched')
    expect(within(unmatched[0]).queryByText('Order Acknowledged')).toBeTruthy()
  })

  it('offers a pill per non-empty kind that filters the list, and All brings it back', async () => {
    renderReport({ data: { ...PAYLOAD, matched_review: [] } })
    expect(screen.getByRole('button', { name: 'All (9)' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Matched · review/ })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'No charge found (2)' }))
    expect(screen.getAllByTestId('row').map(r => r.dataset.kind)).toEqual(['unmatched', 'unmatched'])
    await userEvent.click(screen.getByRole('button', { name: 'All (9)' }))
    expect(screen.getAllByTestId('row')).toHaveLength(9)
  })

  it('shows each order\'s category and narrows to uncategorized orders alongside the kind', async () => {
    api.getCategories.mockResolvedValue([{ id: 'cat-gadgets', name: 'Gadgets', parent_id: 'grp' }])
    const matched = [{ ...PAYLOAD.matched[0], order: { ...PAYLOAD.matched[0].order, category_id: 'cat-gadgets' } }]
    renderReport({ data: { ...PAYLOAD, matched } })
    expect(await within(rowFor('Order Matched')).findByText('Gadgets')).toBeTruthy()
    expect(within(rowFor('Order Unmatched')).getByText('Uncategorized')).toBeTruthy()
    // Every order but the categorized one and the split one; a charge-only row has no order to categorize.
    await userEvent.click(screen.getByRole('button', { name: 'Uncategorized orders (5)' }))
    expect(screen.getAllByTestId('row')).toHaveLength(5)
    await userEvent.click(screen.getByRole('button', { name: 'No charge found (2)' }))
    expect(screen.getAllByTestId('row').map(r => within(r).queryByText('Order Unmatched') != null)).toEqual([true])
  })

  it('offers a Charge line of payee families only when there are two to choose between', async () => {
    const withFamily = (row, family) => ({ ...row, charges: row.charges.map(c => ({ ...c, payee_family: family })) })
    const oneFamily = { ...PAYLOAD, matched: [withFamily(PAYLOAD.matched[0], 'Amazon')] }
    const { unmount } = render(<ReconciliationReportDialog vendor="amazon" data={oneFamily} onClose={() => {}} onReload={() => {}} />)
    expect(screen.queryByText('Charge:')).toBeNull()
    unmount()

    const twoFamilies = {
      ...PAYLOAD,
      matched: [withFamily(PAYLOAD.matched[0], 'Prime Video')],
      duplicate: PAYLOAD.duplicate.map(row => withFamily(row, 'Amazon')),
    }
    renderReport({ data: twoFamilies })
    expect(screen.getByText('Charge:')).toBeTruthy()
    // Most common first; a row counts once however many of its charges share the family.
    expect(screen.getByRole('button', { name: 'Amazon (2)' }).compareDocumentPosition(screen.getByRole('button', { name: 'Prime Video (1)' })))
      .toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    await userEvent.click(screen.getByRole('button', { name: 'Prime Video (1)' }))
    expect(screen.getAllByTestId('row').map(r => within(r).queryByText('Order Matched') != null)).toEqual([true])
    await userEvent.click(screen.getByRole('button', { name: 'Prime Video (1)' }))
    expect(screen.getAllByTestId('row').length).toBeGreaterThan(1)
  })

  it('marks an acknowledged row reviewed and offers to undo it', () => {
    renderReport()
    const row = rowFor('Order Acknowledged')
    expect(within(row).getByText('✓ Reviewed')).toBeTruthy()
    expect(within(row).getByRole('button', { name: 'Undo review' })).toBeTruthy()
    expect(within(rowFor('Order Unmatched')).queryByText('✓ Reviewed')).toBeNull()
  })

  it('says so when there is nothing to reconcile', () => {
    renderReport({ data: {} })
    expect(screen.getByText('Nothing to reconcile for this import.')).toBeTruthy()
  })
})

describe('Amazon reconciliation report — row actions', () => {
  it('unlinks a matched order', async () => {
    const { onReload } = renderReport()
    await userEvent.click(within(rowFor('Order Matched')).getByRole('button', { name: 'Unlink' }))
    expect(api.unlinkAmazonOrderCharges).toHaveBeenCalledWith({ order_link_id: 'L-m' })
    expect(onReload).toHaveBeenCalled()
  })

  it('accepts or dismisses a split suggestion', async () => {
    renderReport()
    await userEvent.click(within(rowFor('Order Split')).getByRole('button', { name: 'Accept' }))
    expect(api.linkAmazonCharges).toHaveBeenCalledWith({ link_id: 'L-r', charge_txn_ids: ['c-r1', 'c-r2'] })
    await userEvent.click(within(rowFor('Order Split')).getByRole('button', { name: 'Dismiss' }))
    expect(api.dismissAmazonSplitSuggestion).toHaveBeenCalledWith({ link_id: 'L-r' })
  })

  it('acknowledges an order by its link and an unaccounted charge by its id', async () => {
    renderReport()
    await userEvent.click(within(rowFor('Order Unmatched')).getByRole('button', { name: 'Mark reviewed' }))
    expect(api.markAmazonOrdersReviewed).toHaveBeenCalledWith({ link_ids: ['L-u'], reviewed: true })
    await userEvent.click(within(rowFor('Order Acknowledged')).getByRole('button', { name: 'Undo review' }))
    expect(api.markAmazonOrdersReviewed).toHaveBeenCalledWith({ link_ids: ['L-u2'], reviewed: false })
    await userEvent.click(within(rowFor('AMZN near')).getByRole('button', { name: 'Mark reviewed' }))
    expect(api.markAmazonUnaccountedReviewed).toHaveBeenCalledWith({ txn_ids: ['p-near'], reviewed: true })
  })

  it('trashes an unaccounted charge as an ordinary delete, and a duplicate copy as a dedupe resolution', async () => {
    renderReport()
    await userEvent.click(within(rowFor('AMZN far')).getByRole('button', { name: 'Trash' }))
    expect(api.trashAmazonDuplicateCharge).toHaveBeenCalledWith({ charge_txn_id: 'p-far', order_link_id: null, as_duplicate: false })
    const dupRow = rowFor('Order Dup')
    await userEvent.click(within(dupRow).getAllByRole('button', { name: 'Discard' })[1])
    expect(api.trashAmazonDuplicateCharge).toHaveBeenCalledWith({ charge_txn_id: 'c-d2', order_link_id: 'L-d', as_duplicate: true })
  })

  it('merges only where a merge can succeed, choosing the call by kind', async () => {
    renderReport()
    expect(within(rowFor('Order Dup Two')).queryByRole('button', { name: 'Merge → keep one' })).toBeNull()
    await userEvent.click(within(rowFor('Order Dup')).getByRole('button', { name: 'Merge → keep one' }))
    expect(api.mergeAmazonDuplicateCharges).toHaveBeenCalledWith({ order_link_id: 'L-d', review_window: false })
    await userEvent.click(within(rowFor('Order Dup Review')).getByRole('button', { name: 'Merge → keep one' }))
    expect(api.mergeAmazonDuplicateCharges).toHaveBeenCalledWith({ order_link_id: 'L-dr', review_window: true })
    await userEvent.click(within(rowFor('AMZN G')).getByRole('button', { name: 'Merge → keep one' }))
    expect(api.mergeUnaccountedAmazonCharges).toHaveBeenCalledWith({ charge_txn_ids: ['c-u1', 'c-u2'] })
  })

  it('records distinct purchases for a duplicate group', async () => {
    renderReport()
    await userEvent.click(within(rowFor('Order Dup Two')).getByRole('button', { name: 'Not duplicates' }))
    expect(api.markAmazonChargesNotDuplicates).toHaveBeenCalledWith({ charge_txn_ids: ['c-e1', 'c-e2'] })
  })

  it('shows a failed action and does not reload', async () => {
    api.unlinkAmazonOrderCharges.mockRejectedValue(new Error('Link is gone'))
    const { onReload } = renderReport()
    await userEvent.click(within(rowFor('Order Matched')).getByRole('button', { name: 'Unlink' }))
    expect(await screen.findByText('Link is gone')).toBeTruthy()
    expect(onReload).not.toHaveBeenCalled()
  })

  it('opens the split editor on a settled order', async () => {
    api.getCategories.mockResolvedValue([])
    renderReport()
    await userEvent.click(within(rowFor('Order Matched')).getByRole('button', { name: 'Split…' }))
    expect(await screen.findByText('Split editor for Order Matched')).toBeTruthy()
  })

  it('offers no split on a one-item order unless it is already split', () => {
    renderReport()
    expect(within(rowFor('Order Unmatched')).queryByRole('button', { name: 'Split…' })).toBeNull()
    expect(within(rowFor('Order Acknowledged')).getByRole('button', { name: 'Edit split…' })).toBeTruthy()
  })
})

describe('Amazon reconciliation report — bulk actions', () => {
  it('counts only the selected rows that offer each action, and applies to exactly those', async () => {
    const { onReload } = renderReport()
    await userEvent.click(screen.getByRole('checkbox', { name: 'select u:L-u' }))
    await userEvent.click(screen.getByRole('checkbox', { name: 'select p:p-near' }))
    await userEvent.click(screen.getByRole('checkbox', { name: 'select m:L-m' }))
    expect(screen.getByText('3 selected:')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Mark reviewed (2)' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Unlink (1)' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Merge → keep one (0)' }).disabled).toBe(true)

    await userEvent.click(screen.getByRole('button', { name: 'Mark reviewed (2)' }))
    expect(api.markAmazonOrdersReviewed).toHaveBeenCalledWith({ link_ids: ['L-u'], reviewed: true })
    expect(api.markAmazonUnaccountedReviewed).toHaveBeenCalledWith({ txn_ids: ['p-near'], reviewed: true })
    expect(api.unlinkAmazonOrderCharges).not.toHaveBeenCalled()
    expect(onReload).toHaveBeenCalled()
    expect(screen.queryByText(/selected:/)).toBeNull()
  })

  it('selects every visible row of the filtered kind', async () => {
    renderReport()
    await userEvent.click(screen.getByRole('button', { name: 'Unaccounted charge (2)' }))
    await userEvent.click(screen.getByRole('button', { name: 'select all visible' }))
    expect(screen.getByText('2 selected:')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Move to trash (2)' })).toBeTruthy()
  })
})

describe('Amazon reconciliation report — linking charges by hand', () => {
  it('offers the unaccounted charges nearest the order first and warns on a total that does not match', async () => {
    renderReport()
    await userEvent.click(within(rowFor('Order Unmatched')).getByRole('button', { name: 'Link charges…' }))
    expect(screen.getByText('Link charges to this order')).toBeTruthy()
    // The picker's options are the labelled checkboxes; the row-selection boxes carry no label element.
    const options = screen.getAllByRole('checkbox').filter(box => box.closest('label'))
    expect(options.map(o => o.closest('label').textContent)).toEqual([
      expect.stringContaining('AMZN near'),
      expect.stringContaining('AMZN far'),
    ])
    await userEvent.click(options[0])
    expect(screen.getByText(/doesn.t match the order total/)).toBeTruthy()
    await userEvent.click(options[1])
    expect(screen.queryByText(/doesn.t match the order total/)).toBeNull()

    await userEvent.click(screen.getByRole('button', { name: 'Link 2 charges' }))
    expect(api.linkAmazonCharges).toHaveBeenCalledWith({ link_id: 'L-u', charge_txn_ids: ['p-near', 'p-far'] })
    expect(screen.queryByText('Link charges to this order')).toBeNull()
  })

  it('cannot open with nothing to link', () => {
    renderReport({ data: { ...PAYLOAD, payment_unmatched: [] } })
    expect(within(rowFor('Order Unmatched')).getByRole('button', { name: 'Link charges…' }).disabled).toBe(true)
  })
})
