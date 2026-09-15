// @vitest-environment jsdom

// Rows removed after an import (a Replace, a Reject, a merge) share the settled kind with the rows the file
// rejected at import, which can outnumber them by thousands. A file ledger's "Removed as duplicates (18)"
// line sent the user into a report reading "6373 rejected at import" with nothing pointing at the 18. These
// pin the three things that make them findable: the header counts them apart, a pill filters to them, and
// the ledger's link opens the report already on them.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('../../lib/api.js', () => ({ api: {} }))
vi.mock('../detailShared.jsx', () => ({
  DetailPanelShell: ({ header, children }) => <div>{header}{children}</div>,
  useDetailPanelChrome: () => ({ pos: {}, size: {}, panelRef: { current: null }, onDragStart: () => {}, onResizeStart: () => {} }),
  useRestorablePanelGeometry: () => ({}),
}))
// Stable per key, as the real hook is: it anchors each value's identity, and handing back a fresh default on
// every render makes a consumer that reacts to its preference re-render forever — the test hangs, it does
// not fail.
const preferences = new Map()
vi.mock('../../lib/UserPreferencesContext.jsx', () => ({
  useUserPreference: (key, fallback) => {
    if (!preferences.has(key)) preferences.set(key, fallback)
    return [preferences.get(key), value => preferences.set(key, value)]
  },
}))
vi.mock('../../App.jsx', () => ({ notifyAccountsChanged: () => {} }))
// The shared table sizes its rows from layout jsdom does not have. What is under test is which entries the
// dialog hands it, so it stands in as a plain list of each entry's merchant.
vi.mock('../importExport/MatchReport.jsx', () => ({
  MatchReport: ({ entries }) => <ul>{entries.map(e => <li key={e.incoming.txn_id || e.incoming.row_number}>{e.incoming.merchant}</li>)}</ul>,
}))
vi.mock('../../help/ContextualExplainer.jsx', () => ({ default: () => null }))
vi.mock('../../help/FeatureExplainer.jsx', () => ({ default: () => null }))
vi.mock('../../help/HelpHoverCard.jsx', () => ({ default: ({ children }) => children }))

const { default: UnifiedDuplicatesDialog } = await import('../UnifiedDuplicatesDialog.jsx')

const IMPORT_REJECT = {
  kind: 'hard_reject', rule_key: 'coverage_in_scope', rule_label: 'Date covered (account)', confidence: 'medium',
  incoming: { row_number: 4, date: '2026-06-01', amount: 12, merchant: 'Harborline Grocer', account_name: 'Harborline Checking' },
  matched: null,
}
const REMOVED = {
  kind: 'hard_reject', removed: true, resolved: true, rule_key: 'replaced_confirmed', rule_label: 'Replaced by another copy',
  confidence: 'medium', reason_text: 'Replaced by another copy of this transaction on this account',
  incoming: { txn_id: 't9', date: '2026-06-02', amount: 9.5, merchant: 'Corner Cafe', account_name: 'Harborline Checking' },
  matched: { id: 'k1', date: '2026-06-02', amount: 9.5, merchant: 'CORNER CAFE', account_name: 'Harborline Checking' },
}

function renderReport(props = {}) {
  const base = {
    entries: [IMPORT_REJECT, REMOVED],
    hardRejectCount: 1,
    removedCount: 1,
    softFlagCount: 0,
    ruleBreakdown: [
      { rule_key: 'coverage_in_scope', rule_label: 'Date covered (account)', confidence: 'medium', count: 1 },
      { rule_key: 'replaced_confirmed', rule_label: 'Replaced by another copy', confidence: 'medium', count: 1 },
    ],
    title: 'harborline-june.csv',
    batchId: 'b1',
    onClose: () => {},
  }
  return render(<UnifiedDuplicatesDialog {...base} {...props} />)
}

afterEach(() => cleanup())

describe('removed duplicates in the report', () => {
  it('counts rows removed later apart from the rows rejected at import', () => {
    renderReport()
    expect(screen.getByText('2 total · 1 rejected at import · 1 removed later · 0 flagged for review')).toBeTruthy()
  })

  it('opens on just the removed rows when asked, and Show all brings back the rest', async () => {
    renderReport({ kindFilter: 'removed', openedWith: { batchId: 'b1', kindFilter: 'removed' } })
    expect(screen.getByText(/removed as duplicates after the import/)).toBeTruthy()
    expect(screen.queryAllByText(/Corner Cafe/).length).toBeGreaterThan(0)
    expect(screen.queryByText(/Harborline Grocer/)).toBeNull()

    await userEvent.click(screen.getByRole('button', { name: 'Show all duplicates in this import' }))
    expect(screen.queryAllByText(/Harborline Grocer/).length).toBeGreaterThan(0)
  })

  it('offers a Removed later pill that filters to them', async () => {
    renderReport()
    expect(screen.queryAllByText(/Harborline Grocer/).length).toBeGreaterThan(0)
    await userEvent.click(screen.getByRole('button', { name: 'Removed later (1)' }))
    expect(screen.queryByText(/Harborline Grocer/)).toBeNull()
    expect(screen.queryAllByText(/Corner Cafe/).length).toBeGreaterThan(0)
  })

  it('starts each open from what that open asked for, even while already mounted', () => {
    const { rerender } = renderReport({ kindFilter: 'removed', openedWith: { batchId: 'b1', kindFilter: 'removed' } })
    expect(screen.queryByText(/Harborline Grocer/)).toBeNull()
    rerender(
      <UnifiedDuplicatesDialog
        entries={[IMPORT_REJECT, REMOVED]} hardRejectCount={1} removedCount={1} softFlagCount={0}
        ruleBreakdown={[]} title="harborline-june.csv" batchId="b1" onClose={() => {}}
        kindFilter={null} openedWith={{ batchId: 'b1', kindFilter: null }}
      />,
    )
    expect(screen.queryAllByText(/Harborline Grocer/).length).toBeGreaterThan(0)
  })
})
