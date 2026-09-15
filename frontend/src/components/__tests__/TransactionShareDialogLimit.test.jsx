// @vitest-environment jsdom

// A list copy stops at TRANSACTION_COPY_ROW_LIMIT. What matters is that a larger list is never fetched
// whole — the host states its size up front so a whole ledger is not pulled into the browser just to be
// refused — and that the dialog offers the two ways on: the first rows to the clipboard, or every row as a
// download.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import TransactionShareDialog from '../TransactionShareDialog.jsx'
import { copyShare, TRANSACTION_COPY_ROW_LIMIT } from '../../lib/transactionShare.js'

vi.mock('../../lib/transactionShare.js', async importOriginal => ({
  ...(await importOriginal()),
  copyShare: vi.fn().mockResolvedValue(true),
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const ROW = { id: 't1', date: '2026-05-10', amount: 12, merchant_name: 'Corner Cafe', display_name: 'Corner Cafe', account_name: 'Checking' }

describe('TransactionShareDialog copy limit', () => {
  it('does not load a list past the limit, and offers it as a download', () => {
    const loadRows = vi.fn()
    const onDownload = vi.fn().mockResolvedValue(undefined)
    render(
      <TransactionShareDialog
        mode="list" rows={[]} loadRows={loadRows} total={TRANSACTION_COPY_ROW_LIMIT + 1}
        onDownload={onDownload} onClose={() => {}}
      />,
    )

    expect(loadRows).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Copy' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Download CSV' }))
    expect(onDownload).toHaveBeenCalledTimes(1)
  })

  it('copies only the first rows of a list past the limit when asked to', async () => {
    const loadRows = vi.fn().mockResolvedValue([ROW])
    render(
      <TransactionShareDialog
        mode="list" rows={[]} loadRows={loadRows} total={TRANSACTION_COPY_ROW_LIMIT + 1}
        onDownload={vi.fn()} onClose={() => {}}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: `Copy first ${TRANSACTION_COPY_ROW_LIMIT}` }))

    await waitFor(() => expect(copyShare).toHaveBeenCalledTimes(1))
    expect(loadRows).toHaveBeenCalledWith({ limit: TRANSACTION_COPY_ROW_LIMIT })
    expect(copyShare.mock.calls[0][0].text).toContain('Corner Cafe')
    expect(await screen.findByText('Corner Cafe')).toBeTruthy()
  })

  it('loads and previews a list at the limit', async () => {
    const loadRows = vi.fn().mockResolvedValue([ROW])
    render(
      <TransactionShareDialog
        mode="list" rows={[]} loadRows={loadRows} total={TRANSACTION_COPY_ROW_LIMIT}
        onDownload={vi.fn()} onClose={() => {}}
      />,
    )

    expect(await screen.findByText('Corner Cafe')).toBeTruthy()
    expect(loadRows).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: 'Download CSV' })).toBeNull()
    expect(copyShare).not.toHaveBeenCalled()
  })
})
