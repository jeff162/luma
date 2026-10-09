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
    previewBatchDetailClearing: vi.fn(),
    clearBatchDetail: vi.fn(),
  },
}))

afterEach(() => { cleanup(); vi.clearAllMocks() })

const card = (id, filename, extra = {}) => ({
  id, filename, imported_at: '2026-07-26 20:09:00', ...extra,
})

const rows = [
  {
    key: 'profile:p1',
    kind: 'profile',
    profile: { id: 'p1', name: 'Harborline checking' },
    batches: [
      card('b2019', 'activity-2019.csv', { covers_start: '2019-07-05', covers_end: '2019-12-31' }),
      card('b2020', 'activity-2020.csv', { covers_start: '2020-01-01', covers_end: '2020-11-09' }),
    ],
  },
  {
    key: 'profile:p2',
    kind: 'profile',
    profile: { id: 'p2', name: 'Riverstone card' },
    batches: [card('b-clean', 'nothing-stored.csv')],
  },
]

const storage = {
  b2019: { report_rows: 112, rejected_rows: 0, unreviewed_rows: 5, bytes: 3 * 1024 * 1024 },
  b2020: { report_rows: 59, rejected_rows: 0, unreviewed_rows: 0, bytes: 512 * 1024 },
}

function renderDialog(extra = {}) {
  api.getBatchDetailStorage.mockResolvedValue(storage)
  render(
    <ImportDetailStorageDialog
      dataSourceRows={rows}
      onClose={vi.fn()}
      onCleared={vi.fn()}
      {...extra}
    />,
  )
}

describe('the stored-detail screen', () => {
  it('explains what the record is for before offering to remove it', async () => {
    renderDialog()
    await waitFor(() => expect(screen.getByText(/activity-2019\.csv/)).toBeTruthy())

    expect(screen.getByText(/Import anyway/)).toBeTruthy()
  })

  it('attributes the space, largest source first, and leaves out imports holding nothing', async () => {
    renderDialog()
    await waitFor(() => expect(screen.getByText(/activity-2019\.csv/)).toBeTruthy())

    expect(screen.getByText('3.5 MB')).toBeTruthy()
    expect(screen.queryByText('nothing-stored.csv')).toBeNull()
  })

  // A card can hold rows an import turned away for reasons other than duplication. Counting only the
  // duplicate report listed such a card as "0 rows · 0 B" — offered for clearing while appearing to
  // hold nothing at all.
  it('counts the rows an import refused for other reasons, not only its duplicates', async () => {
    api.getBatchDetailStorage.mockResolvedValue({
      b2019: { report_rows: 0, rejected_rows: 4, unreviewed_rows: 0, bytes: 2048 },
    })
    render(<ImportDetailStorageDialog dataSourceRows={rows} onClose={vi.fn()} onCleared={vi.fn()} />)
    await waitFor(() => expect(screen.getByText(/activity-2019\.csv/)).toBeTruthy())

    expect(screen.getByText('4 rows · 2 KB')).toBeTruthy()
  })

  // The row label is only the institution, so without the qualifier two connections at one institution
  // render as two identical group headings.
  it('tells two connections at the same institution apart, as the history does', async () => {
    api.getBatchDetailStorage.mockResolvedValue({
      c1: { report_rows: 3, rejected_rows: 0, unreviewed_rows: 0, bytes: 1024 },
      c2: { report_rows: 2, rejected_rows: 0, unreviewed_rows: 0, bytes: 1024 },
    })
    render(
      <ImportDetailStorageDialog
        dataSourceRows={[
          { key: 'connection:c1', kind: 'connection', label: 'Northgate', provider: 'simplefin', batches: [card('c1', 'Northgate · August 2026')] },
          { key: 'connection:c2', kind: 'connection', label: 'Northgate', provider: 'plaid', batches: [card('c2', 'Northgate · September 2026')] },
        ]}
        onClose={vi.fn()}
        onCleared={vi.fn()}
      />,
    )
    await waitFor(() => expect(screen.getByText(/SimpleFIN connection/)).toBeTruthy())

    expect(screen.getByText(/Plaid connection/)).toBeTruthy()
  })

  it('names the column, so the figure is not read as the space a clear would leave behind', async () => {
    renderDialog()
    await waitFor(() => expect(screen.getByText(/activity-2019\.csv/)).toBeTruthy())

    expect(screen.getByText('Space used')).toBeTruthy()
  })

  it('says nothing can be cleared until something is picked', async () => {
    renderDialog()
    await waitFor(() => expect(screen.getByText(/activity-2019\.csv/)).toBeTruthy())

    expect(screen.getByRole('button', { name: /^Free/ }).disabled).toBe(true)
  })

  it('offers the size of what is selected, and selects a whole source at once', async () => {
    renderDialog()
    await waitFor(() => expect(screen.getByText(/activity-2019\.csv/)).toBeTruthy())

    await userEvent.click(screen.getAllByRole('checkbox')[0])
    expect(screen.getByRole('button', { name: /3\.5 MB/ })).toBeTruthy()
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

  it('clears exactly what was picked, then re-reads and tells the page', async () => {
    api.previewBatchDetailClearing.mockResolvedValue({
      cards: 1, transactions_kept: 140, report_rows: 112, unreviewed_rows: 5,
      enrichment_undos: 2, rejected_rows: 0, trashed_released: 1, bytes: 3145728,
    })
    api.clearBatchDetail.mockResolvedValue({ cards: 1 })
    const onCleared = vi.fn()
    renderDialog({ onCleared })
    await waitFor(() => expect(screen.getByText(/activity-2019\.csv/)).toBeTruthy())

    await userEvent.click(screen.getAllByRole('checkbox')[1])
    await userEvent.click(screen.getByRole('button', { name: /3\.0 MB/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Clear detail' }))

    expect(api.clearBatchDetail).toHaveBeenCalledWith(['b2019'])
    await waitFor(() => expect(onCleared).toHaveBeenCalled())
    expect(api.getBatchDetailStorage).toHaveBeenCalledTimes(2)
  })

  it('says so plainly when there is nothing stored anywhere', async () => {
    api.getBatchDetailStorage.mockResolvedValue({})
    render(<ImportDetailStorageDialog dataSourceRows={rows} onClose={vi.fn()} onCleared={vi.fn()} />)

    await waitFor(() => expect(screen.getByText('No import is holding detail records')).toBeTruthy())
  })
})
