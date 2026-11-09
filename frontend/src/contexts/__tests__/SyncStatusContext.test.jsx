// @vitest-environment jsdom

// A page that keeps its own copy of what a sync writes — the Import page's history cards — has to hear when a
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
  const { runsFinished, ledgerChanges, runSync } = useSyncStatus()
  return (
    <>
      <span data-testid="finished">{runsFinished}</span>
      <span data-testid="ledger">{ledgerChanges}</span>
      <button type="button" onClick={() => runSync('plaid', { days: 0 }).catch(() => {})}>sync</button>
    </>
  )
}

const finished = () => screen.getByTestId('finished').textContent
const ledger = () => screen.getByTestId('ledger').textContent

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

// The pages showing transactions reload on this one, so a sync that brought nothing in must leave them be.
describe('ledgerChanges', () => {
  it('moves only for a run that brought something in', async () => {
    api.getProviders.mockResolvedValue(PROVIDERS)
    const answer = added => ({
      historical_complete: true,
      connections: [{ connection_id: 'c1', institution: 'Northgate', added, updated: 0, removed: 0, skipped: 0, error: null }],
    })
    api.runSync.mockResolvedValueOnce(answer(0)).mockResolvedValueOnce(answer(3))
    render(<SyncStatusProvider><Probe /></SyncStatusProvider>)

    await userEvent.click(screen.getByRole('button', { name: 'sync' }))
    await waitFor(() => expect(finished()).toBe('1'))
    expect(ledger()).toBe('0')

    await userEvent.click(screen.getByRole('button', { name: 'sync' }))
    await waitFor(() => expect(finished()).toBe('2'))
    expect(ledger()).toBe('1')
  })
})

describe('returning to the foreground', () => {
  // A tablet keeps a backgrounded page alive for days, so a sync run elsewhere has to reach this page when
  // it comes back into view: the freshness it shows, and the import cards holding their own copy of it.
  function ForegroundProbe() {
    const { providers, runsFinished, ledgerChanges } = useSyncStatus()
    return (
      <>
        <span data-testid="synced">{providers?.[0]?.connections?.[0]?.last_synced_at || 'none'}</span>
        <span data-testid="finished">{runsFinished}</span>
        <span data-testid="ledger">{ledgerChanges}</span>
      </>
    )
  }
  const listing = at => ({ providers: [{ provider: 'plaid', connections: [{ id: 'c1', syncing: false, last_synced_at: at }] }] })
  const synced = () => screen.getByTestId('synced').textContent
  const comeBack = () => document.dispatchEvent(new Event('visibilitychange'))

  // Not as a ledger change: whether the sync wrote anything is the ledger epoch's to say.
  it('counts a sync that finished elsewhere as a run ending', async () => {
    api.getProviders.mockResolvedValueOnce(listing('2026-09-03T07:40:00Z'))
    render(<SyncStatusProvider><ForegroundProbe /></SyncStatusProvider>)
    await waitFor(() => expect(synced()).toBe('2026-09-03T07:40:00Z'))
    expect(finished()).toBe('0')

    api.getProviders.mockResolvedValueOnce(listing('2026-09-05T07:40:00Z'))
    comeBack()
    await waitFor(() => expect(synced()).toBe('2026-09-05T07:40:00Z'))
    expect(finished()).toBe('1')
    expect(ledger()).toBe('0')
  })

  it('leaves the counters alone when nothing synced while away', async () => {
    api.getProviders.mockResolvedValue(listing('2026-09-03T07:40:00Z'))
    render(<SyncStatusProvider><ForegroundProbe /></SyncStatusProvider>)
    await waitFor(() => expect(synced()).toBe('2026-09-03T07:40:00Z'))

    comeBack()
    await waitFor(() => expect(api.getProviders).toHaveBeenCalledTimes(2))
    expect(finished()).toBe('0')
    expect(ledger()).toBe('0')
  })
})
