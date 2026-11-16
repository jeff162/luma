// @vitest-environment jsdom

// The maintenance screen for what imports store beyond their transactions. What these cover is the
// reason it is a screen and not a control on each card: it has to attribute the space, explain what the
// record is for, and state consequences that no button label could carry — and the figures it states
// have to be the server's count of what the write will do, not a total assembled here.

import { afterEach, describe, it, expect, vi } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { api } from '../../../lib/api.js'
import { ImportDetailStorageDialog } from '../ImportDetailStorageDialog.jsx'

vi.mock('../../../lib/api.js', () => ({
  api: {
    getBatchDetailStorage: vi.fn(),
    getStorageSummary: vi.fn(),
    listBatches: vi.fn(),
    getImportProfiles: vi.fn(),
    previewBatchDetailClearing: vi.fn(),
    clearBatchDetail: vi.fn(),
  },
}))

afterEach(() => { cleanup(); vi.clearAllMocks() })

const card = (id, filename, extra = {}) => ({
  id, filename, imported_at: '2024-07-26 20:09:00', ...extra,
})

const profiles = [
  { id: 'p1', name: 'Harborline checking' },
  { id: 'p2', name: 'Riverstone card' },
]

const batches = [
  card('b2019', 'activity-2019.csv', { profile_id: 'p1', covers_start: '2019-07-05', covers_end: '2019-12-31' }),
  // Imported today, so it is not among the year-old ones whatever day the suite runs.
  card('b2020', 'activity-2020.csv', {
    profile_id: 'p1', covers_start: '2020-01-01', covers_end: '2020-11-09', imported_at: new Date().toISOString(),
  }),
  card('b-clean', 'nothing-stored.csv', { profile_id: 'p2' }),
]

const storage = {
  b2019: { report_rows: 112, rejected_rows: 0, unreviewed_rows: 5, enriched_rows: 2, bytes: 3 * 1024 * 1024 },
  b2020: { report_rows: 59, rejected_rows: 0, unreviewed_rows: 0, enriched_rows: 0, bytes: 512 * 1024 },
}

function renderDialog({ stored = storage, cards = batches, databaseBytes = 0 } = {}) {
  api.getBatchDetailStorage.mockResolvedValue(stored)
  api.getStorageSummary.mockResolvedValue({ database_bytes: databaseBytes })
  api.listBatches.mockResolvedValue(cards)
  api.getImportProfiles.mockResolvedValue(profiles)
  render(<ImportDetailStorageDialog onClose={vi.fn()} />)
}

describe('the stored-detail screen', () => {
  it('attributes the space, largest source first, and leaves out imports holding nothing', async () => {
    renderDialog()
    await waitFor(() => expect(screen.getByText(/activity-2019\.csv/)).toBeTruthy())

    expect(screen.getByText('3.5 MB')).toBeTruthy()
    expect(screen.queryByText('nothing-stored.csv')).toBeNull()
  })

  // 3.5 MB means nothing without the size it would come out of.
  it('states what is held against the size of the database', async () => {
    renderDialog({ databaseBytes: 35 * 1024 * 1024 })
    await waitFor(() => expect(screen.getByText(/activity-2019\.csv/)).toBeTruthy())

    expect(screen.getByText(/3\.5 MB \(about 10%\) of a 35\.0 MB database/)).toBeTruthy()
  })

  // Nothing left in a report is a row nobody could want, so what a clear would take is stated per
  // import before anything is ticked — not only in the confirmation.
  it('says what each import holds, by what clearing it would lose', async () => {
    renderDialog()
    await screen.findByText('activity-2019.csv')

    expect(screen.getByText('5 to review · 2 enrichments · 105 duplicates')).toBeTruthy()
  })

  // A card can hold rows an import turned away for reasons other than duplication. Counting only the
  // duplicate report listed such a card as holding nothing — offered for clearing while appearing empty.
  it('counts the rows an import refused for other reasons, not only its duplicates', async () => {
    renderDialog({ stored: { b2019: { report_rows: 0, rejected_rows: 4, unreviewed_rows: 0, bytes: 2048 } } })
    await screen.findByText('activity-2019.csv')

    expect(screen.getByText('4 rejected')).toBeTruthy()
    expect(screen.getAllByText('2 KB').length).toBeGreaterThan(0)
  })

  // The row label is only the institution, so without the qualifier two connections at one institution
  // render as two identical group headings.
  it('tells two connections at the same institution apart, as the history does', async () => {
    const sync = (id, filename, connectionId, provider) => card(id, filename, {
      source_kind: 'connection_sync', connection_id: connectionId,
      connection_institution: 'Northgate', connection_name: 'Northgate', connection_provider: provider,
    })
    renderDialog({
      stored: {
        c1: { report_rows: 3, rejected_rows: 0, unreviewed_rows: 0, bytes: 1024 },
        c2: { report_rows: 2, rejected_rows: 0, unreviewed_rows: 0, bytes: 1024 },
      },
      cards: [
        sync('c1', 'Northgate · August 2026', 'conn-1', 'simplefin'),
        sync('c2', 'Northgate · September 2026', 'conn-2', 'plaid'),
      ],
    })
    await waitFor(() => expect(screen.getByText(/SimpleFIN connection/)).toBeTruthy())

    expect(screen.getByText(/Plaid connection/)).toBeTruthy()
  })

  it('gives each source the period its listed imports cover between them', async () => {
    renderDialog()
    await screen.findByText('activity-2019.csv')

    expect(screen.getByText('Jul 5, 2019 – Nov 9, 2020')).toBeTruthy()
  })

  // By when the import was made: a backfill of old statements imported last week has not aged.
  it('picks out the imports made over a year ago, and only those', async () => {
    renderDialog()
    await screen.findByText('activity-2019.csv')

    await userEvent.click(screen.getByRole('button', { name: 'Select imports over a year old' }))

    expect(screen.getByRole('button', { name: /^Clear detail · 3\.0 MB/ })).toBeTruthy()
  })

  it('offers the size of what is selected, and selects a whole source at once', async () => {
    renderDialog()
    await waitFor(() => expect(screen.getByText(/activity-2019\.csv/)).toBeTruthy())

    await userEvent.click(screen.getAllByRole('checkbox')[0])
    expect(screen.getByRole('button', { name: /3\.5 MB/ })).toBeTruthy()
  })

  // A folded source still holds whatever was ticked inside it, and the buttons will act on it, so the
  // source row has to say so once its imports are out of sight.
  it('folds a source away without hiding what is selected inside it', async () => {
    renderDialog()
    await screen.findByText('activity-2019.csv')

    await userEvent.click(screen.getAllByRole('checkbox')[1])
    await userEvent.click(screen.getByRole('button', { name: 'Collapse Harborline checking' }))

    expect(screen.queryByText('activity-2019.csv')).toBeNull()
    expect(screen.getAllByRole('checkbox')[0].indeterminate).toBe(true)
    expect(screen.getByText(/1 selected/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /3\.0 MB/ })).toBeTruthy()
  })

  // The dialog's numbers come from the server, not from the rows on screen — that is what keeps the
  // sentence agreed to and the write that follows from drifting apart.
  it('states the server\'s count of what the clear will do, and warns about unreviewed rows', async () => {
    api.previewBatchDetailClearing.mockResolvedValue({
      cards: 2, transactions_kept: 350, report_rows: 171, unreviewed_rows: 5,
      enrichment_undos: 4, rejected_rows: 0, trashed_released: 3, bytes: 3670016,
    })
    renderDialog()
    await waitFor(() => expect(screen.getByText(/activity-2019\.csv/)).toBeTruthy())

    await userEvent.click(screen.getAllByRole('checkbox')[0])
    await userEvent.click(screen.getByRole('button', { name: /3\.5 MB/ }))

    expect(screen.getByText(/171 duplicate rows go permanently, including 5 rows still flagged for review/)).toBeTruthy()
    expect(screen.getByText(/4 enrichments can no longer be undone/)).toBeTruthy()
    expect(screen.getByText(/3 removed duplicates move to Trash/)).toBeTruthy()
    expect(screen.getByText(/350 transactions stay in the ledger, and the imports stay in the history/)).toBeTruthy()
    expect(api.clearBatchDetail).not.toHaveBeenCalled()
  })

  it('clears exactly what was picked, then re-reads what is left', async () => {
    api.previewBatchDetailClearing.mockResolvedValue({
      cards: 1, transactions_kept: 140, report_rows: 112, unreviewed_rows: 5,
      enrichment_undos: 2, rejected_rows: 0, trashed_released: 1, bytes: 3145728,
    })
    api.clearBatchDetail.mockResolvedValue({ cards: 1 })
    renderDialog()
    await waitFor(() => expect(screen.getByText(/activity-2019\.csv/)).toBeTruthy())

    await userEvent.click(screen.getAllByRole('checkbox')[1])
    await userEvent.click(screen.getByRole('button', { name: /3\.0 MB/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Clear detail' }))

    expect(api.clearBatchDetail).toHaveBeenCalledWith(['b2019'])
    await waitFor(() => expect(api.getBatchDetailStorage).toHaveBeenCalledTimes(2))
  })
})

