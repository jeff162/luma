// @vitest-environment jsdom

// A page that keeps its own copy of what a sync writes — Import/Export's history cards — has to hear when a
// run ends, or it goes on showing the counts it last loaded: rows that had already landed beside chips and
// totals that had not been written yet. `runsFinished` is that signal. These pin that it moves once per
// ended run and never while one is still going, since a reload fired mid-run would read exactly the
// half-written state it exists to replace.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const api = {
  getProviders: vi.fn(),
  runSync: vi.fn(),
}

vi.mock('../../lib/api.js', () => ({ api }))
// The panel is not under test; the provider only imports it for the renderer.
vi.mock('../../components/SyncStatusPanel.jsx', () => ({ SyncStatusPanel: () => null }))

const { SyncStatusProvider, useSyncStatus } = await import('../SyncStatusContext.jsx')

const PROVIDERS = { providers: [{ provider: 'plaid', connections: [{ id: 'c1', institution: 'Northgate', syncing: false }] }] }

function deferred() {
  let resolve
  const promise = new Promise(res => { resolve = res })
  return { promise, resolve }
}

function Probe() {
  const { runsFinished, runSync } = useSyncStatus()
  return (
    <>
      <span data-testid="finished">{runsFinished}</span>
      <button type="button" onClick={() => runSync('plaid', { days: 0 }).catch(() => {})}>sync</button>
    </>
  )
}

const finished = () => screen.getByTestId('finished').textContent

afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('runsFinished', () => {
  it('stays put while a run is in flight and moves once it ends', async () => {
    api.getProviders.mockResolvedValue(PROVIDERS)
    const call = deferred()
    api.runSync.mockReturnValue(call.promise)
    render(<SyncStatusProvider><Probe /></SyncStatusProvider>)
    expect(finished()).toBe('0')

    await userEvent.click(screen.getByRole('button', { name: 'sync' }))
    await waitFor(() => expect(api.runSync).toHaveBeenCalled())
    expect(finished()).toBe('0')

    call.resolve({ historical_complete: true, connections: [], added: 2 })
    await waitFor(() => expect(finished()).toBe('1'))
  })

  it('counts each run, so a second sync reloads again', async () => {
    api.getProviders.mockResolvedValue(PROVIDERS)
    api.runSync.mockResolvedValue({ historical_complete: true, connections: [] })
    render(<SyncStatusProvider><Probe /></SyncStatusProvider>)

    await userEvent.click(screen.getByRole('button', { name: 'sync' }))
    await waitFor(() => expect(finished()).toBe('1'))
    await userEvent.click(screen.getByRole('button', { name: 'sync' }))
    await waitFor(() => expect(finished()).toBe('2'))
  })

  it('also ends a run that failed, since what it recorded before failing is on the cards too', async () => {
    api.getProviders.mockResolvedValue(PROVIDERS)
    api.runSync.mockRejectedValue(new Error('provider unavailable'))
    render(<SyncStatusProvider><Probe /></SyncStatusProvider>)

    await userEvent.click(screen.getByRole('button', { name: 'sync' }))
    await waitFor(() => expect(finished()).toBe('1'))
  })
})
