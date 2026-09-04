// @vitest-environment jsdom

/*
 * Every edit the detail panel persists must also reach the row behind it.
 *
 * The panel re-seeds from that row when it is reopened, so a host left holding the old value does not
 * merely look stale — it looks like the save was *rejected*. A rename saved to the database, displayed
 * correctly while the panel was open, and came back wrong on the next open, which is indistinguishable
 * from the write having failed.
 *
 * Notes and tags each carried their own copy of the reconcile call and were fine; the rename did not,
 * and nothing about the code said a caller owed one. The fix moved the reconcile into the shared patch
 * function, so all three now travel the same line of code — which is what makes exercising one of them
 * a test of the wiring rather than of one feature. The rename is the one driven here because it is the
 * one that was broken; a second case through the same call would assert the same line twice.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import TransactionDetail from '../TransactionDetail.jsx'
import { api } from '../../lib/api.js'

// The panel calls a long tail of api methods just to render. Only the three writes matter here, so the
// rest resolve to something harmless rather than being enumerated — a list that would need extending
// every time the panel grew a section, for no gain to what this file asserts.
vi.mock('../../lib/api.js', () => {
  const writes = {
    updateMerchant: vi.fn(() => Promise.resolve({ ok: true })),
    updateNotes: vi.fn(() => Promise.resolve({ ok: true })),
    updateTransactionTag: vi.fn(() => Promise.resolve({
      tags: [{ id: 'g1', name: 'Bills' }], blocked_tags: [],
    })),
  }
  return {
    api: new Proxy(writes, {
      get: (target, prop) => target[prop]
        // An empty array satisfies both shapes the panel reads: a bare list (the payee trend, the tag
        // list) and a `{ transactions }` / `{ documents }` envelope, whose missing key falls through the
        // callers' own `|| []`.
        || (target[prop] = vi.fn(() => Promise.resolve([]))),
    }),
  }
})

vi.mock('../../lib/UserPreferencesContext.jsx', () => ({
  useUserPreference: (_key, fallback) => [fallback, vi.fn()],
}))
vi.mock('../../help/FeatureExplainer.jsx', () => ({ default: () => null }))
// Orthogonal to what this file is about; the panel only needs them to mount.
vi.mock('../../contexts/TransactionShareContext.jsx', () => ({
  useTransactionShare: () => ({ open: vi.fn(), share: vi.fn() }),
  TransactionShareProvider: ({ children }) => children,
}))

const TXN = {
  id: 't1', date: '2026-08-03', amount: -245.84,
  merchant_name: 'Arbella Insurance Debitpmt', display_name: 'Arbella Insurance Debitpmt',
  raw_name: 'Arbella Insurance Debitpmt', category_id: null, notes: '', tags: [],
}

// The floating panel measures itself; jsdom has no layout and no ResizeObserver.
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
Element.prototype.scrollIntoView = vi.fn()

let onReconcile
beforeEach(() => { onReconcile = vi.fn() })
afterEach(() => { cleanup(); vi.clearAllMocks() })

function renderPanel() {
  return render(
    <MemoryRouter>
      <TransactionDetail txn={TXN} categories={[]} onClose={() => {}} onReconcile={onReconcile} />
    </MemoryRouter>,
  )
}

describe('TransactionDetail reconciles what it persists', () => {
  it('tells the host about a rename', async () => {
    renderPanel()
    // The heading is static text; the pencil beside it is what begins the edit. Driven with fireEvent
    // rather than userEvent because the panel's busy wrapper leaves `pointer-events: none` on its
    // subtree under jsdom, which has no layout to clear it — the wiring is what this asserts, not the CSS.
    fireEvent.click(await screen.findByTitle('Edit merchant name'))
    const field = await screen.findByDisplayValue('Arbella Insurance Debitpmt')
    fireEvent.change(field, { target: { value: 'Arbella Insurance: Umbrella' } })
    fireEvent.keyDown(field, { key: 'Enter' })

    await waitFor(() => expect(api.updateMerchant).toHaveBeenCalledWith('t1', 'Arbella Insurance: Umbrella'))
    // The write is not the property under test — the host hearing about it is.
    await waitFor(() => {
      expect(onReconcile).toHaveBeenCalledWith('t1', { display_name: 'Arbella Insurance: Umbrella' })
    })
  })
})
