// @vitest-environment jsdom

// What the dialog is opened with is a starting filter, not a binding one. Accounts → Connections opens it
// with an array built inline — one provider's connections, or a single connection — so the page behind
// the dialog re-rendering must not snap the user's own pill choices back to that starting set, while
// opening it on a genuinely different set must.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ConnectionSyncLogDialog } from '../ConnectionSyncLogDialog.jsx'
import { api } from '../../../lib/api.js'

vi.mock('../../../lib/api.js', () => ({
  api: {
    getSyncDiagnostics: vi.fn(),
    clearSyncDiagnostics: vi.fn(),
  },
}))

const COUNTS = [
  { connection_id: 'c1', provider: 'simplefin', institution: 'Northgate', count: 3 },
  { connection_id: 'c2', provider: 'plaid', institution: 'Riverstone', count: 2 },
]

function lastScope() {
  const calls = api.getSyncDiagnostics.mock.calls
  return calls[calls.length - 1][1]
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
