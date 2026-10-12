// @vitest-environment jsdom

// A collapsed data-source row says how many of its transactions still need review. The per-card "to review"
// pill and Mark all reviewed only render inside the expanded row, so without this a connection whose sync
// just brought in new rows looked as though it had nothing waiting — which read as the control not existing
// for data connections at all.

import { afterEach, describe, it, expect, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ImportHistorySection } from '../ImportHistorySection.jsx'

vi.mock('../../../help/ContextualExplainer.jsx', () => ({ default: () => null }))
vi.mock('../../../help/useTipCallout.js', () => ({ useTipCallout: () => ({ showing: true, dismiss: () => {} }) }))

afterEach(() => { cleanup(); vi.clearAllMocks() })

function connectionRow(batches, lastSyncedAt = null) {
  return {
    lastSyncedAt,
    key: 'connection:c1',
    kind: 'connection',
    connectionId: 'c1',
    disconnected: false,
    label: 'Northgate',
    provider: 'simplefin',
    profile: null,
    batches,
    latestBatch: batches[0],
  }
}

const card = (id, needsReview) => ({
  id, filename: `Northgate · ${id}`, imported_at: '2026-09-01T10:00:00', needs_review_count: needsReview,
  suspect_duplicate_count: 0, accounts: [],
})

function renderSection(rows, setExpandedSourceRows = vi.fn(), expandedSourceRows = {}) {
  render(
    <ImportHistorySection
      dataSourceRows={rows}
      profiles={[]}
      expandedSourceRows={expandedSourceRows}
      buildBatchImportedCategoryChoices={() => []}
      setExpandedSourceRows={setExpandedSourceRows}
      totalSystemCategoryWorkspaceCount={0}
      pendingSystemCategoryCount={0}
      hasSystemRuleSuggestionWork={false}
      pendingSystemRuleSuggestionCount={0}
      getSourceNameEditKey={() => ''}
    />,
  )
  return setExpandedSourceRows
}

describe('a collapsed data-source row', () => {
  it('totals the rows needing review across its cards and expands to them when clicked', async () => {
    const setExpanded = renderSection([connectionRow([card('August 2026', 3), card('September 2026', 2)])])

    await userEvent.click(screen.getByRole('button', { name: '5 to review' }))
    const updater = setExpanded.mock.calls[0][0]
    expect(updater({})).toEqual({ 'connection:c1': true })
  })

  it('shows nothing when every card has been reviewed', () => {
    renderSection([connectionRow([card('August 2026', 0)])])
    expect(screen.queryByRole('button', { name: /to review/ })).toBeNull()
  })

  it('says when the connection last synced, not how many cards it has or when the newest was created', () => {
    renderSection([connectionRow([card('September 2026', 0), card('August 2026', 0)], '2026-09-12T13:23:40.025846Z')])
    expect(screen.getByText('Last synced 2026-09-12 13:23')).toBeTruthy()
    expect(screen.queryByText(/imported file/)).toBeNull()
    expect(screen.queryByText(/Last used/)).toBeNull()
  })

  it('says nothing about recency once disconnected, since the sync record went with the connection', () => {
    renderSection([{ ...connectionRow([card('August 2026', 0)]), connectionId: null, disconnected: true }])
    expect(screen.queryByText(/Last synced|Last used|imported file/)).toBeNull()
  })

  it('counts rows removed after the import in the card\'s duplicates pill, so its report stays reachable', async () => {
    const openReport = vi.fn()
    render(
      <ImportHistorySection
        dataSourceRows={[connectionRow([{ ...card('August 2026', 0), deduped_count: 2, removed_duplicate_count: 1 }])]}
        profiles={[]}
        expandedSourceRows={{ 'connection:c1': true }}
        buildBatchImportedCategoryChoices={() => []}
        setExpandedSourceRows={vi.fn()}
        totalSystemCategoryWorkspaceCount={0}
        pendingSystemCategoryCount={0}
        hasSystemRuleSuggestionWork={false}
        pendingSystemRuleSuggestionCount={0}
        getSourceNameEditKey={() => ''}
        openUnifiedDuplicatesViewer={openReport}
      />,
    )
    await userEvent.click(screen.getByRole('button', { name: '3 duplicates' }))
    expect(openReport).toHaveBeenCalled()
  })

  it('shows a duplicates pill for a card whose only duplicates were removed after the import', () => {
    renderSection([connectionRow([{ ...card('August 2026', 0), removed_duplicate_count: 2 }])], vi.fn(), { 'connection:c1': true })
    expect(screen.getByRole('button', { name: '2 duplicates' })).toBeTruthy()
  })

  it('totals what its cards\' PayPal reconciliations need, counting a row listed by two cards once', async () => {
    const setExpanded = vi.fn()
    render(
      <ImportHistorySection
        dataSourceRows={[connectionRow([
          { ...card('August 2026', 0), paypal_recon_rows: 4, paypal_recon_attention_ids: ['p1', 'bank1'] },
          { ...card('September 2026', 0), paypal_recon_rows: 2, paypal_recon_attention_ids: ['bank1'] },
        ])]}
        profiles={[]}
        expandedSourceRows={{}}
        buildBatchImportedCategoryChoices={() => []}
        setExpandedSourceRows={setExpanded}
        totalSystemCategoryWorkspaceCount={0}
        pendingSystemCategoryCount={0}
        hasSystemRuleSuggestionWork={false}
        pendingSystemRuleSuggestionCount={0}
        getSourceNameEditKey={() => ''}
        openReconciliationViewer={vi.fn()}
      />,
    )
    await userEvent.click(screen.getByRole('button', { name: '⚠ 2 to resolve' }))
    expect(setExpanded.mock.calls[0][0]({})).toEqual({ 'connection:c1': true })
  })

  // A card's own duplicates pill counts advisory rejections in its "(N to review)". Summing only the
  // soft-flag suspects here left a source whose entire outstanding workload was of that kind — every
  // PayPal card in a real ledger — reading as completely clean while its cards showed amber.
  it('counts rejections still flagged amber, not only the soft-flag suspects', () => {
    renderSection([connectionRow([
      { ...card('August 2026', 0), advisory_review_count: 5 },
      { ...card('September 2026', 0), suspect_duplicate_count: 1, advisory_review_count: 2 },
    ])])

    expect(screen.getByRole('button', { name: '⚠ 8 duplicates' })).toBeTruthy()
  })

  it('points its review count at the connection\'s cards rather than at imported files', () => {
    renderSection([connectionRow([card('August 2026', 2)])])
    expect(screen.getByRole('button', { name: '2 to review' }).getAttribute('title'))
      .toBe("2 transactions across this connection's cards still need review — expand to review or mark them reviewed")
  })
})
