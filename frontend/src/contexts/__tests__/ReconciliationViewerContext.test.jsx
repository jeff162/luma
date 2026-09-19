// @vitest-environment jsdom

// The one app-level viewer every reconciliation report opens through. Pins the two things a page depends
// on: a report is fetched through its vendor's loader, and `version` advances on every load *including the
// first* — the page refreshes its file cards' counts off that number, and treats 0 as "nothing loaded".

import { StrictMode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const api = vi.hoisted(() => ({ getAmazonReconciliation: vi.fn() }))
vi.mock('../../lib/api.js', () => ({ api }))
vi.mock('../../components/importExport/reconciliation/ReconciliationReportDialog.jsx', () => ({
  ReconciliationReportDialog: ({ vendor }) => <div>{vendor} report open</div>,
}))

const {
  ReconciliationViewerProvider, ReconciliationViewerRenderer, MinimizedReconciliationNavItem, useReconciliationViewer,
} = await import('../ReconciliationViewerContext.jsx')

let handle = null
function Probe() {
  handle = useReconciliationViewer()
  return <div>version {handle.viewer?.data?.version ?? 0}</div>
}

function renderViewer() {
  return render(
    <StrictMode>
      <ReconciliationViewerProvider>
        <Probe />
        <ReconciliationViewerRenderer />
        <MinimizedReconciliationNavItem />
      </ReconciliationViewerProvider>
    </StrictMode>,
  )
}

afterEach(() => { cleanup(); handle = null })

describe('ReconciliationViewerContext', () => {
  it('loads a report through its vendor and counts the first load as version 1', async () => {
    api.getAmazonReconciliation.mockResolvedValue({ duplicate: [{}], amazon_unmatched: [{}, {}] })
    renderViewer()
    expect(screen.getByText('version 0')).toBeTruthy()

    await act(() => handle.open({ vendor: 'amazon', batchId: 'b1', title: 'orders.csv' }))
    expect(api.getAmazonReconciliation).toHaveBeenCalledWith('b1')
    expect(screen.getByText('version 1')).toBeTruthy()
    expect(await screen.findByText('amazon report open')).toBeTruthy()

    await act(() => handle.reload())
    expect(screen.getByText('version 2')).toBeTruthy()
  })

  it('stashes to a nav pill named for the report, flagging what still needs resolving', async () => {
    api.getAmazonReconciliation.mockResolvedValue({ duplicate: [{}], amazon_unmatched: [{}, {}] })
    renderViewer()
    await act(() => handle.open({ vendor: 'amazon', batchId: 'b1', title: 'orders.csv' }))
    act(() => handle.minimize())

    expect(screen.queryByText('amazon report open')).toBeNull()
    const pill = screen.getByRole('button', { name: /Amazon reconciliation — orders\.csv/ })
    expect(pill.textContent).toContain('3')
    await userEvent.click(pill)
    expect(await screen.findByText('amazon report open')).toBeTruthy()
  })
})
