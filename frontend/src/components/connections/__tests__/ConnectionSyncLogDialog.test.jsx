// @vitest-environment jsdom

// What the dialog is opened with is a starting filter, not a binding one. The Connections
// tab opens it with arrays built inline — one provider, or a single connection — so the page behind the dialog
// re-rendering must not snap the user's own pill choices back to that starting set, while opening it on a
// genuinely different set must.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ConnectionSyncLogDialog } from '../ConnectionSyncLogDialog.jsx'
import { api } from '../../../lib/api.js'

// A floating dialog remembers where it was left, a saved preference; local state stands in for the
// app's provider.
vi.mock('../../../lib/UserPreferencesContext.jsx', async (importOriginal) => {
  const { useState } = await import('react')
  return { ...(await importOriginal()), useUserPreference: (_key, initial) => useState(initial), useDeviceLayoutPreference: (_key, initial) => useState(initial) }
})

vi.mock('../../../lib/api.js', () => ({
  api: {
    getSyncDiagnostics: vi.fn(),
    clearSyncDiagnostics: vi.fn(),
    setSyncLogRetention: vi.fn(),
  },
}))

const COUNTS = [
  { subject: 'c1', connection_id: 'c1', provider: 'simplefin', institution: 'Northgate', count: 3 },
  { subject: 'c2', connection_id: 'c2', provider: 'plaid', institution: 'Riverstone', count: 2 },
  { subject: 'c3', connection_id: 'c3', provider: 'plaid', institution: 'Harborline', disconnected: true, count: 1 },
  { subject: 'connect:plaid', connection_id: null, provider: 'plaid', institution: 'plaid', count: 1 },
]

function lastCall() {
  const calls = api.getSyncDiagnostics.mock.calls
  return calls[calls.length - 1][0]
}

function lastScope() {
  return lastCall().subjects
}

describe('ConnectionSyncLogDialog scoping', () => {
  beforeEach(() => {
    api.getSyncDiagnostics.mockResolvedValue({ entries: [], counts: COUNTS })
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('opens filtered to the connections it was given', async () => {
    render(<ConnectionSyncLogDialog initialConnectionIds={['c1', 'c2']} onClose={() => {}} />)

    await waitFor(() => expect(api.getSyncDiagnostics).toHaveBeenCalled())
    expect(lastScope()).toEqual(['c1', 'c2'])
    expect((await screen.findByRole('button', { name: /Northgate/ })).getAttribute('aria-pressed')).toBe('true')
  })

  it('keeps a pill the user turned off when the page behind it re-renders', async () => {
    const user = userEvent.setup()
    const { rerender } = render(
      <ConnectionSyncLogDialog initialConnectionIds={['c1', 'c2']} onClose={() => {}} />,
    )
    await user.click(await screen.findByRole('button', { name: /Northgate/ }))
    await waitFor(() => expect(lastScope()).toEqual(['c2']))

    // A fresh array holding the same ids, as an inline prop produces on every render.
    rerender(<ConnectionSyncLogDialog initialConnectionIds={['c1', 'c2']} onClose={() => {}} />)

    expect(lastScope()).toEqual(['c2'])
    expect(screen.getByRole('button', { name: /Northgate/ }).getAttribute('aria-pressed')).toBe('false')
  })

  it('starts over when it is given a different set of connections', async () => {
    const { rerender } = render(
      <ConnectionSyncLogDialog initialConnectionIds={['c1', 'c2']} onClose={() => {}} />,
    )
    await waitFor(() => expect(lastScope()).toEqual(['c1', 'c2']))

    rerender(<ConnectionSyncLogDialog initialConnectionIds={['c2']} onClose={() => {}} />)

    await waitFor(() => expect(lastScope()).toEqual(['c2']))
  })
})

describe('ConnectionSyncLogDialog provider scope', () => {
  beforeEach(() => {
    api.getSyncDiagnostics.mockResolvedValue({ entries: [], counts: COUNTS })
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('opened from a provider, shows every pill of that provider as selected', async () => {
    render(<ConnectionSyncLogDialog initialProviders={['plaid']} onClose={() => {}} />)

    await waitFor(() => expect(lastCall()).toEqual({ subjects: [], providers: ['plaid'] }))
    expect((await screen.findByRole('button', { name: /Riverstone/ })).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: /Harborline \(disconnected\)/ }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: /Plaid connect attempts/ }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: /Northgate/ }).getAttribute('aria-pressed')).toBe('false')
  })

  it('turning off one of those pills keeps the rest of the provider selected', async () => {
    const user = userEvent.setup()
    render(<ConnectionSyncLogDialog initialProviders={['plaid']} onClose={() => {}} />)

    await user.click(await screen.findByRole('button', { name: /Riverstone/ }))

    await waitFor(() => expect(lastCall().providers).toEqual([]))
    expect([...lastCall().subjects].sort()).toEqual(['c3', 'connect:plaid'])
  })
})

describe('ConnectionSyncLogDialog rows', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it("keeps the provider's own account of a failure behind Details", async () => {
    const user = userEvent.setup()
    api.getSyncDiagnostics.mockResolvedValue({
      entries: [{
        id: 'e1', event: 'connect', provider: 'plaid', connection_id: null, started_at: '2026-09-19T13:08:37Z',
        error: 'Plaid did not accept the app\'s client ID or secret. (INVALID_API_KEYS)',
        detail: { provider_error: { error_code: 'INVALID_API_KEYS', request_id: 'req-7' } },
      }],
      counts: [],
      total: 1,
    })
    render(<ConnectionSyncLogDialog onClose={() => {}} />)

    await screen.findByText(/INVALID_API_KEYS\)/)
    expect(screen.queryByText('req-7')).toBeNull()
    await user.click(screen.getByRole('button', { name: /Details/ }))
    expect(screen.getByText('req-7')).toBeTruthy()
  })
})
