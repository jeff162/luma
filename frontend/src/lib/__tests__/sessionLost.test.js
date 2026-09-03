// @vitest-environment jsdom

/*
 * The api layer's "the session is gone" signal.
 *
 * A 401 means the server no longer knows who is asking, which the surface that happened to make the
 * request can never resolve. Left to the callers it surfaced as whatever error text each one renders —
 * a red "Not authenticated" inside a report dialog, with nothing to act on — and every screen had its
 * own version of that. Noticing it here is what lets one listener answer it for the whole app.
 *
 * The two rules worth pinning are the ones whose failure is a loop rather than a wrong message: the
 * auth endpoints must not signal (their 401 is the bootstrap's answer, not a lapse), and a burst must
 * collapse to one signal (a page holds several requests in flight, and the bootstrap the signal starts
 * makes more calls that may 401 while it works).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, SESSION_LOST_EVENT } from '../api.js'

let heard
let listener
// The quiet window is module state in api.js, shared by every test in this file. Each test therefore
// starts a minute later than the last, so one test's signal cannot mute the next one's.
let clock = new Date('2026-09-02T12:00:00Z').getTime()
const MINUTE = 60_000

function unauthorized() {
  return Promise.resolve({
    ok: false,
    status: 401,
    statusText: 'Unauthorized',
    json: () => Promise.resolve({ detail: 'Not authenticated' }),
  })
}

function ok(body = {}) {
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) })
}

beforeEach(() => {
  heard = 0
  listener = () => { heard += 1 }
  window.addEventListener(SESSION_LOST_EVENT, listener)
  vi.useFakeTimers()
  clock += MINUTE
  vi.setSystemTime(new Date(clock))
})

afterEach(() => {
  window.removeEventListener(SESSION_LOST_EVENT, listener)
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('a 401 from the api layer', () => {
  it('announces the lost session as well as throwing', async () => {
    vi.stubGlobal('fetch', vi.fn(unauthorized))
    await expect(api.getTransactions({ ids: 't1', limit: 1 })).rejects.toThrow('Not authenticated')
    expect(heard).toBe(1)
  })

  it('stays quiet for an ordinary failure', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
      ok: false, status: 500, statusText: 'Server Error',
      json: () => Promise.resolve({ detail: 'boom' }),
    })))
    await expect(api.getTransactions({ ids: 't1', limit: 1 })).rejects.toThrow('boom')
    expect(heard).toBe(0)
  })

  it('stays quiet on a success', async () => {
    vi.stubGlobal('fetch', vi.fn(() => ok({ transactions: [] })))
    await api.getTransactions({ ids: 't1', limit: 1 })
    expect(heard).toBe(0)
  })

  it('collapses a burst into one signal', async () => {
    // One lapse, several requests in flight. Signalling per response would restart the shell's
    // bootstrap once per pending call.
    vi.stubGlobal('fetch', vi.fn(unauthorized))
    await Promise.all([
      api.getTransactions({ ids: 't1', limit: 1 }).catch(() => {}),
      api.getTransactions({ ids: 't2', limit: 1 }).catch(() => {}),
      api.getTransactions({ ids: 't3', limit: 1 }).catch(() => {}),
    ])
    expect(heard).toBe(1)
  })

  it('signals again once the quiet window has passed', async () => {
    // The window bounds a feedback loop; it must not mute a genuinely later lapse.
    vi.stubGlobal('fetch', vi.fn(unauthorized))
    await api.getTransactions({ ids: 't1', limit: 1 }).catch(() => {})
    expect(heard).toBe(1)
    vi.setSystemTime(new Date(clock + 6000))
    await api.getTransactions({ ids: 't1', limit: 1 }).catch(() => {})
    expect(heard).toBe(2)
  })

  it('does not signal for the auth endpoints themselves', async () => {
    // Their 401 is how the bootstrap learns nobody is signed in. Signalling would ask the shell to
    // restart the check that produced it.
    vi.stubGlobal('fetch', vi.fn(unauthorized))
    await api.getAuthStatus().catch(() => {})
    await api.getIdentities().catch(() => {})
    expect(heard).toBe(0)
  })
})
