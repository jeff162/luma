// @vitest-environment jsdom

// The panel's job is narrow — report what a scan refused and hand each file to the import flow — and
// its risks are all about *when it calls the server*. The page-entry scan must run once per mount
// however the host re-renders around it (the host passes an inline arrow, which is what the real page
// does), and a source with no folder must render nothing at all rather than an empty card on a page
// nobody has configured this for.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const autoScanWatchedFolders = vi.fn(async () => ({ sources: [] }))
const scanWatchedFolders = vi.fn(async () => ({ sources: [{ imported: 1 }] }))
const getWatchStatus = vi.fn()
const getWatchedFile = vi.fn(async () => new Blob(['Date,Amount\n2026-02-01,1.00\n'], { type: 'text/csv' }))
const dismissWatchedFile = vi.fn(async () => ({ ok: true }))

vi.mock('../../../lib/api.js', () => ({
  api: {
    autoScanWatchedFolders: (...args) => autoScanWatchedFolders(...args),
    scanWatchedFolders: (...args) => scanWatchedFolders(...args),
    getWatchStatus: (...args) => getWatchStatus(...args),
    getWatchedFile: (...args) => getWatchedFile(...args),
    dismissWatchedFile: (...args) => dismissWatchedFile(...args),
  },
}))

const WatchedFoldersPanel = (await import('../WatchedFoldersPanel.jsx')).default

const SOURCE = { id: 'src-1', name: 'Harborline Checking', watch_dir: '/srv/statements', watch_enabled: 1 }
const PARKED = {
  id: 'f1', profile_id: 'src-1', filename: 'january.csv', state: 'parked',
  reason: 'This source has no account mapped for "Savings".',
}

afterEach(() => {
  cleanup()
  autoScanWatchedFolders.mockClear()
  scanWatchedFolders.mockClear()
  getWatchStatus.mockReset()
  getWatchedFile.mockClear()
  dismissWatchedFile.mockClear()
})

describe('WatchedFoldersPanel', () => {
  it('renders nothing when no data source names a folder', async () => {
    getWatchStatus.mockResolvedValue({ sources: [], files: [], attention: { total: 0 } })
    const { container } = render(<WatchedFoldersPanel />)
    await waitFor(() => expect(getWatchStatus).toHaveBeenCalled())
    expect(container.innerHTML).toBe('')
  })

  it('scans once per mount even when the host re-renders with a new callback each time', async () => {
    getWatchStatus.mockResolvedValue({ sources: [SOURCE], files: [], attention: { total: 0 } })
    const { rerender } = render(<WatchedFoldersPanel onImported={() => { }} />)
    await screen.findByText('Watched folders')
    rerender(<WatchedFoldersPanel onImported={() => { }} />)
    rerender(<WatchedFoldersPanel onImported={() => { }} />)
    await waitFor(() => expect(autoScanWatchedFolders).toHaveBeenCalledTimes(1))
  })

  it('lists a refused file with its reason and opens it in the import flow', async () => {
    getWatchStatus.mockResolvedValue({ sources: [SOURCE], files: [PARKED], attention: { total: 1 } })
    const onOpenFile = vi.fn()
    render(<WatchedFoldersPanel onOpenFile={onOpenFile} />)
    expect(await screen.findByText('january.csv')).toBeTruthy()
    expect(screen.getByText(/no account mapped/)).toBeTruthy()

    await userEvent.click(screen.getByRole('button', { name: /Import…/ }))
    await waitFor(() => expect(onOpenFile).toHaveBeenCalled())
    const [file, profileId] = onOpenFile.mock.calls[0]
    expect(file.name).toBe('january.csv')
    expect(profileId).toBe('src-1')
  })

  it('hands a parked statement PDF over as a PDF, not as text', async () => {
    getWatchStatus.mockResolvedValue({
      sources: [SOURCE], files: [{ ...PARKED, filename: 'statement-Apr-2026.pdf' }], attention: { total: 1 },
    })
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0xff])
    getWatchedFile.mockResolvedValueOnce(new Blob([pdf], { type: 'application/pdf' }))
    const onOpenFile = vi.fn()
    render(<WatchedFoldersPanel onOpenFile={onOpenFile} />)
    await userEvent.click(await screen.findByRole('button', { name: /Import…/ }))
    await waitFor(() => expect(onOpenFile).toHaveBeenCalled())
    const [file] = onOpenFile.mock.calls[0]
    expect(file.type).toBe('application/pdf')
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(pdf)
  })

  it('offers no import for a file that failed to be deleted, since there is nothing to import', async () => {
    getWatchStatus.mockResolvedValue({
      sources: [SOURCE],
      files: [{ ...PARKED, state: 'purge_failed', reason: 'This file could not be deleted: Permission denied' }],
      attention: { total: 1, purge_failed: 1 },
    })
    render(<WatchedFoldersPanel />)
    expect(await screen.findByText('january.csv')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Import…/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeTruthy()
  })

  it('tells the host when Check now imported something, so the history behind it refreshes', async () => {
    getWatchStatus.mockResolvedValue({ sources: [SOURCE], files: [], attention: { total: 0 } })
    const onImported = vi.fn()
    render(<WatchedFoldersPanel onImported={onImported} />)
    await screen.findByText('Watched folders')
    await userEvent.click(screen.getByRole('button', { name: 'Check now' }))
    await waitFor(() => expect(onImported).toHaveBeenCalled())
  })

  it('shows a source whose folder is not there, without hiding the rest', async () => {
    getWatchStatus.mockResolvedValue({
      sources: [{ ...SOURCE, watch_notice: 'This folder is not there right now.' }],
      files: [], attention: { total: 0 },
    })
    render(<WatchedFoldersPanel />)
    expect(await screen.findByText(/not there right now/)).toBeTruthy()
    expect(screen.getByText('Harborline Checking')).toBeTruthy()
  })
})
