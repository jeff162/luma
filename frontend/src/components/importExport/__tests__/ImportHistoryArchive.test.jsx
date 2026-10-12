// @vitest-environment jsdom

// An expanded data source lists only its recent cards and files the rest into a by-year archive. What
// these cover is the promise that makes the archive safe: a card is still *reachable*, and a card that
// wants something done still says so from behind the disclosure — the failure of the old global cap was
// that it hid imports with no indication at all.

import { afterEach, describe, it, expect, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ImportHistorySection } from '../ImportHistorySection.jsx'
import { MarketplaceImportHistory } from '../MarketplaceImportHistory.jsx'

vi.mock('../../../help/ContextualExplainer.jsx', () => ({ default: () => null }))
vi.mock('../../../help/useTipCallout.js', () => ({ useTipCallout: () => ({ showing: true, dismiss: () => {} }) }))
vi.mock('../../../contexts/ReconciliationViewerContext.jsx', () => ({ useReconciliationViewer: () => ({ open: vi.fn() }) }))
vi.mock('../../../contexts/AmazonImportDetailViewerContext.jsx', () => ({ useAmazonImportDetailViewer: () => ({ open: vi.fn() }) }))

afterEach(() => { cleanup(); vi.clearAllMocks() })

const card = (name, importedAt, extra = {}) => ({
  id: name,
  filename: name,
  imported_at: importedAt,
  row_count: 10,
  accounts: [],
  ...extra,
})

// Twelve monthly imports, newest first, none of them inside the recency window.
const monthlyCards = () => [
  card('2026-03.csv', '2026-03-04 09:00:00'),
  card('2026-02.csv', '2026-02-04 09:00:00'),
  card('2026-01.csv', '2026-01-04 09:00:00'),
  card('2025-12.csv', '2025-12-04 09:00:00'),
  card('2025-11.csv', '2025-11-04 09:00:00'),
  card('2025-10.csv', '2025-10-04 09:00:00'),
  card('2025-09.csv', '2025-09-04 09:00:00'),
  card('2025-08.csv', '2025-08-04 09:00:00'),
  card('2025-07.csv', '2025-07-04 09:00:00'),
  card('2025-06.csv', '2025-06-04 09:00:00'),
  card('2025-05.csv', '2025-05-04 09:00:00'),
  card('2025-04.csv', '2025-04-04 09:00:00'),
]

function sourceRow(batches) {
  return {
    key: 'profile:p1',
    kind: 'profile',
    profile: { id: 'p1', name: 'Harborline checking' },
    hasImportedCategories: false,
    batches,
    latestBatch: batches[0],
  }
}

function renderExpanded(row, extra = {}) {
  render(
    <ImportHistorySection
      dataSourceRows={[row]}
      profiles={[row.profile].filter(Boolean)}
      expandedSourceRows={{ [row.key]: true }}
      setExpandedSourceRows={vi.fn()}
      buildBatchImportedCategoryChoices={() => []}
      totalSystemCategoryWorkspaceCount={0}
      pendingSystemCategoryCount={0}
      hasSystemRuleSuggestionWork={false}
      pendingSystemRuleSuggestionCount={0}
      getSourceNameEditKey={() => ''}
      {...extra}
    />,
  )
}

describe('an expanded data source with years of imports', () => {
  it('lists only its recent cards, with the rest behind one disclosure', () => {
    renderExpanded(sourceRow(monthlyCards()))

    expect(screen.getByText('2026-03.csv')).toBeTruthy()
    expect(screen.getByText('2025-12.csv')).toBeTruthy()
    expect(screen.queryByText('2025-11.csv')).toBeNull()
    expect(screen.getByRole('button', { name: /Older imports · 8/ })).toBeTruthy()
  })

  it('opens the archive to its years, newest expanded and older ones one click away', async () => {
    renderExpanded(sourceRow(monthlyCards()))

    await userEvent.click(screen.getByRole('button', { name: /Older imports · 8/ }))
    // 2025 is the only archived year here, so its cards are on screen with the archive.
    expect(screen.getByRole('button', { name: /2025 · 8 imports/ })).toBeTruthy()
    expect(screen.getByText('2025-11.csv')).toBeTruthy()
    expect(screen.getByText('2025-04.csv')).toBeTruthy()
  })

  it('collapses a year without closing the archive', async () => {
    renderExpanded(sourceRow(monthlyCards()))

    await userEvent.click(screen.getByRole('button', { name: /Older imports · 8/ }))
    await userEvent.click(screen.getByRole('button', { name: /2025 · 8 imports/ }))
    expect(screen.queryByText('2025-11.csv')).toBeNull()
    expect(screen.getByRole('button', { name: /2025 · 8 imports/ })).toBeTruthy()
  })

  it('says what the cards inside still want done, before anything is opened', () => {
    const batches = monthlyCards()
    batches[9] = { ...batches[9], needs_review_count: 4 }
    batches[10] = { ...batches[10], suspect_duplicate_count: 2 }
    renderExpanded(sourceRow(batches))

    const archive = screen.getByRole('button', { name: /Older imports/ })
    expect(archive.textContent).toContain('4 to review')
    expect(archive.textContent).toContain('2 duplicates')
  })

  it('leaves a short history alone rather than hiding a card or two', () => {
    renderExpanded(sourceRow(monthlyCards().slice(0, 6)))

    expect(screen.getByText('2025-10.csv')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Older imports/ })).toBeNull()
  })

  it('calls a connection\'s archived period cards cards, not imports', () => {
    renderExpanded({
      ...sourceRow(monthlyCards()),
      key: 'connection:c1',
      kind: 'connection',
      connectionId: 'c1',
      label: 'Northgate',
      profile: null,
    })

    expect(screen.getByRole('button', { name: /Older cards · 8/ })).toBeTruthy()
  })
})

// A marketplace vendor's cards are listed by the data they cover rather than by import time, so a
// multi-year drop imported in one sitting has to archive by the years its purchases fall in — windowing
// it on `imported_at` would hold the whole drop "recent" and file every card under one year.
// The three facts a card states about itself once the history is organized by period.
describe('an import card', () => {
  const statement = {
    id: 's1',
    filename: 'statement-Feb-2025.pdf',
    imported_at: '2026-10-07 00:43:06',
    covers_start: '2025-02-01',
    covers_end: '2025-02-28',
    covers_source: 'statement',
    row_count: 4,
    deduped_count: 4,
    duplicate_row_count: 4,
    enriched_duplicate_count: 2,
    accounts: [],
  }

  it('leads with the period it covers and keeps the import date underneath', () => {
    renderExpanded(sourceRow([statement, ...monthlyCards()]))

    expect(screen.getByText('Feb 1 – 28, 2025')).toBeTruthy()
    expect(screen.getByText('imported 2026-10-07 00:43')).toBeTruthy()
  })

  it('says a statement period is a statement period, not a guess from its rows', () => {
    renderExpanded(sourceRow([statement, ...monthlyCards()]))

    expect(screen.getByText('Feb 1 – 28, 2025').getAttribute('title')).toBe('Statement period')
  })

  // The PayPal case: statements imported over an activity export that already held every row. The card
  // landed nothing and the arithmetic saying so was "4 rows" above a 4-row duplicates pill.
  it('states plainly when it added no transactions, and what it did add', () => {
    renderExpanded(sourceRow([statement, ...monthlyCards()]))

    expect(screen.getByText(/No new transactions — every row was already in the ledger, and 2 existing rows gained detail from it/)).toBeTruthy()
  })
})

describe('a marketplace vendor whose history arrived as one multi-year drop', () => {
  const dropped = (year, index) => ({
    id: `amazon-${year}`,
    filename: `amazon-${year}.csv`,
    imported_at: `2026-09-01 09:00:0${index}`,
    newest_txn_date: `${year}-11-02`,
    row_count: 40,
    import_summary: {},
  })

  it('archives by the years it covers, not by the day it was imported', async () => {
    render(
      <MarketplaceImportHistory
        row={{
          vendor: 'amazon',
          label: 'Amazon',
          batches: [2026, 2025, 2024, 2023, 2022, 2021, 2020].map(dropped),
          latestBatch: dropped(2026, 0),
        }}
        expanded
        onToggleExpand={vi.fn()}
        onOpenLedger={vi.fn()}
        onUndo={vi.fn()}
        onMarkReviewed={vi.fn()}
      />,
    )

    expect(screen.getByText('amazon-2023.csv')).toBeTruthy()
    expect(screen.queryByText('amazon-2022.csv')).toBeNull()

    await userEvent.click(screen.getByRole('button', { name: /Older imports · 3/ }))
    expect(screen.getByRole('button', { name: /2022 · 1 import/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /2020 · 1 import/ })).toBeTruthy()
    expect(screen.getByText('amazon-2022.csv')).toBeTruthy()
  })
})

// Clearing a card's stored detail leaves the card and its counts, so what it must not leave is a pill
// offering to open a report that no longer has anything in it.
describe('a card whose stored detail has been cleared', () => {
  const cleared = {
    id: 'cleared',
    filename: 'activity-2019.csv',
    imported_at: '2026-07-26 20:09:00',
    covers_start: '2019-07-05',
    covers_end: '2019-12-31',
    row_count: 112,
    deduped_count: 112,
    detail_cleared_at: '2026-10-09 09:00:00',
    accounts: [],
  }

  it('says why its duplicates are no longer listed', () => {
    renderExpanded(sourceRow([cleared, ...monthlyCards()]))

    expect(screen.getByText(/Stored detail cleared/)).toBeTruthy()
  })

  it('stops offering a report with nothing left in it', () => {
    renderExpanded(sourceRow([cleared, ...monthlyCards()]))

    expect(screen.queryByRole('button', { name: /112 duplicates/ })).toBeNull()
  })

  it('keeps offering the rows that survive the clear, which the report can still show', () => {
    renderExpanded(sourceRow([{ ...cleared, removed_duplicate_count: 4 }, ...monthlyCards()]))

    expect(screen.getByRole('button', { name: /4 duplicates/ })).toBeTruthy()
  })

  it('still says the import added nothing, which the clear does not change', () => {
    renderExpanded(sourceRow([cleared, ...monthlyCards()]))

    expect(screen.getByText(/No new transactions — every row was already in the ledger/)).toBeTruthy()
  })

  it('says the same for a file whose rows were all restatements, which keep no report', () => {
    // These never reach `deduped_count` — keyed on that alone, a wholly-restated file reported
    // nothing at all, which reads as a failed import rather than the ordinary outcome it is.
    const restated = {
      ...cleared, id: 'restated', detail_cleared_at: null, deduped_count: 0, ignored_count: 112,
    }
    renderExpanded(sourceRow([restated, ...monthlyCards()]))

    expect(screen.getByText(/No new transactions — every row was already in the ledger/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /duplicates/ })).toBeNull()
  })

  it('states restated rows as a count beside what a mixed file did import', () => {
    const mixed = {
      ...cleared, id: 'mixed', detail_cleared_at: null, row_count: 120, deduped_count: 0, ignored_count: 112,
    }
    renderExpanded(sourceRow([mixed, ...monthlyCards()]))

    expect(screen.getByText(/112 rows already in the ledger/)).toBeTruthy()
  })
})
