// @vitest-environment jsdom

// Settings -> Error log. The server orders and filters the entries, so what is pinned here is what the
// section says: each error's message up front with its traceback folded away, a plain statement when there
// is nothing, where the file is, and a read failure that says so rather than showing an empty log.

import { afterEach, describe, it, expect, vi } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ErrorLogSection from '../ErrorLogSection.jsx'
import { useErrorLog } from '../../../lib/useErrorLog.js'
import { RefreshButton } from '../../ui.jsx'
import { api } from '../../../lib/api.js'

vi.mock('../../../lib/api.js', () => ({ api: { getErrorLog: vi.fn() } }))

afterEach(() => { cleanup(); vi.clearAllMocks() })

const CRASH = {
  time: '2026-09-13T21:40:02Z', level: 'ERROR', logger: 'uvicorn.error',
  message: 'Exception in ASGI application',
  detail: 'Traceback (most recent call last):\nsqlite3.OperationalError: database is locked',
}
// Settings reads the log and puts the refresh on the section's title; this is that arrangement without the
// rest of the page.
function OpenSection() {
  const errorLog = useErrorLog(true)
  return (
    <>
      <RefreshButton onRefresh={errorLog.load} loading={errorLog.loading} />
      <ErrorLogSection log={errorLog.log} error={errorLog.error} />
    </>
  )
}

const PLAIN = { time: '2026-09-13T20:10:00Z', level: 'ERROR', logger: 'luma', message: 'first failure', detail: '' }

describe('ErrorLogSection', () => {
  it('lists each error with its traceback folded behind Details', async () => {
    api.getErrorLog.mockResolvedValue({ path: '/data/luma.log', present: true, total: 2, entries: [CRASH, PLAIN] })
    render(<OpenSection />)
    expect(await screen.findByText('Exception in ASGI application')).toBeTruthy()
    expect(screen.getByText('first failure')).toBeTruthy()
    // One disclosure: the plain error has no detail, so it gets none.
    expect(screen.getAllByText('Details')).toHaveLength(1)
    expect(screen.getByText(/database is locked/)).toBeTruthy()
    expect(screen.getByText('/data/luma.log')).toBeTruthy()
  })

  it('says when an entry was cut short, and only then', async () => {
    api.getErrorLog.mockResolvedValue({
      path: '/data/luma.log', present: true, total: 2, entries: [{ ...CRASH, truncated: true }, { ...PLAIN, truncated: false }],
    })
    render(<OpenSection />)
    expect(await screen.findByText('Exception in ASGI application')).toBeTruthy()
    expect(screen.getAllByText('Cut short here. The full text is in the log file.')).toHaveLength(1)
  })

  it('says so when nothing has been recorded', async () => {
    api.getErrorLog.mockResolvedValue({ path: '/data/luma.log', present: false, total: 0, entries: [] })
    render(<OpenSection />)
    expect(await screen.findByText('No errors have been recorded.')).toBeTruthy()
  })

  it('says how many it is not showing', async () => {
    api.getErrorLog.mockResolvedValue({ path: '/data/luma.log', present: true, total: 120, entries: [CRASH] })
    render(<OpenSection />)
    expect(await screen.findByText('Showing the 1 most recent of 120.')).toBeTruthy()
  })

  it('reports a failed read rather than an empty log', async () => {
    api.getErrorLog.mockRejectedValue(new Error('Admin access required'))
    render(<OpenSection />)
    expect((await screen.findByRole('alert')).textContent).toBe('Admin access required')
    expect(screen.queryByText('No errors have been recorded.')).toBeNull()
  })

  it('reads the log again on Refresh', async () => {
    api.getErrorLog.mockResolvedValue({ path: '/data/luma.log', present: false, total: 0, entries: [] })
    render(<OpenSection />)
    await userEvent.click(await screen.findByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(api.getErrorLog).toHaveBeenCalledTimes(2))
  })
})
