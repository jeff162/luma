// @vitest-environment jsdom

// A tab used to find out that the backend had gone only if it was the one that asked for the shutdown.
// Every other tab, and every shutdown that did not come from the browser at all (the macOS Dock's Quit,
// Command-Q, a signal), left the page failing silently until it was closed.
//
// What these pin is the judgement, not the plumbing: which rejections mean "the server is gone" as
// opposed to "the server said no", and that one failed request is never enough on its own — the probe
// is what separates a stopped process from a connection dropped mid-graceful-shutdown, which retries
// fine. Getting that wrong in the lenient direction is the expensive one: a modal saying the app has
// stopped, over an app that has not.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

async function freshModule() {
  // Module-level state latches by design (a stopped backend never un-stops in one document), so each
  // test needs its own copy rather than a reset function that exists only for tests.
  vi.resetModules()
  return import('../backendLiveness.js')
}

describe('backendLiveness', () => {
  let stoppedEvents
  let onStopped

  beforeEach(() => {
    stoppedEvents = 0
    onStopped = () => { stoppedEvents += 1 }
    window.addEventListener('luma:backend-stopped', onStopped)
    // Deterministic, and keeps one test's announcement out of another's channel.
    globalThis.BroadcastChannel = class {
      constructor() { this.onmessage = null }
      postMessage() { }
      close() { }
    }
  })

  afterEach(() => {
    window.removeEventListener('luma:backend-stopped', onStopped)
    vi.restoreAllMocks()
  })

  function healthAnswers(alive) {
    return vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      if (alive) return { ok: true }
      throw new TypeError('Failed to fetch')
    })
  }

  it('ignores a server that answered with an error', async () => {
    // `request()` gives every HTTP response an error carrying `.status`. The server refusing a request
    // is the opposite of the server being absent, and treating a 500 or a 403 as a dead backend would
    // put the modal up over a perfectly live app.
    const { noteRequestFailure } = await freshModule()
    const health = healthAnswers(false)

    const error = new Error('Request failed')
    error.status = 500
    noteRequestFailure(error)
    await Promise.resolve()

    expect(health).not.toHaveBeenCalled()
    expect(stoppedEvents).toBe(0)
  })

  it('ignores a request the app cancelled itself', async () => {
    // Aborting a request that is no longer wanted is routine — a filter changed, a panel closed. It
    // rejects with no `.status`, exactly like a transport failure, so the name is the only thing that
    // separates them.
    const { noteRequestFailure } = await freshModule()
    const health = healthAnswers(false)

    const aborted = new Error('The operation was aborted.')
    aborted.name = 'AbortError'
    noteRequestFailure(aborted)
    await Promise.resolve()

    expect(health).not.toHaveBeenCalled()
    expect(stoppedEvents).toBe(0)
  })

  it('does not cry stopped when the next request would have worked', async () => {
    // The case that makes a single failure insufficient: a graceful shutdown closes idle keep-alive
    // connections, and a request riding one fails while the server is still answering. So does a
    // request in flight across a network hiccup. The probe is what settles it.
    const { noteRequestFailure } = await freshModule()
    healthAnswers(true)

    noteRequestFailure(new TypeError('Failed to fetch'))
    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalled())

    expect(stoppedEvents).toBe(0)
  })

  it('reports the backend stopped when the probe fails too', async () => {
    const { noteRequestFailure, backendHasStopped } = await freshModule()
    healthAnswers(false)

    noteRequestFailure(new TypeError('Failed to fetch'))
    await vi.waitFor(() => expect(stoppedEvents).toBe(1))

    expect(backendHasStopped()).toBe(true)
  })

  it('probes once for a burst of failures', async () => {
    // A page that loads four things at once loses all four at the same instant. Each asking separately
    // would turn one piece of news into a burst of identical probes against a server already known to
    // be in trouble.
    const { noteRequestFailure } = await freshModule()
    const health = healthAnswers(false)

    for (let i = 0; i < 4; i += 1) noteRequestFailure(new TypeError('Failed to fetch'))
    await vi.waitFor(() => expect(stoppedEvents).toBe(1))

    expect(health).toHaveBeenCalledTimes(1)
  })

  it('does not look for a return until something has gone', async () => {
    // The gesture watch is installed for the whole life of the page but means nothing while the app is
    // working: a probe per click would be a request for every interaction, answering a question nobody
    // has asked.
    const { checkForBackendReturn } = await freshModule()
    const health = healthAnswers(true)

    expect(await checkForBackendReturn()).toBe(false)
    expect(health).not.toHaveBeenCalled()
  })

  it('reports a backend that has not come back yet', async () => {
    // What the dialog's button needs in order to say something. A press that found nothing has to be
    // distinguishable from a press that did nothing.
    const { announceBackendStopped, checkForBackendReturn } = await freshModule()
    healthAnswers(false)
    announceBackendStopped()

    expect(await checkForBackendReturn()).toBe(false)
  })

  it('announces the backend coming back', async () => {
    // Reported rather than acted on: reloading is the app's decision, and the same event carries it to
    // the tab that found out and the tabs that were told.
    const { announceBackendStopped, checkForBackendReturn } = await freshModule()
    let returned = 0
    const onReturned = () => { returned += 1 }
    window.addEventListener('luma:backend-returned', onReturned)
    try {
      healthAnswers(false)
      announceBackendStopped()
      const health = healthAnswers(true)

      expect(await checkForBackendReturn()).toBe(true)
      expect(health).toHaveBeenCalledTimes(1)
      expect(returned).toBe(1)
    } finally {
      window.removeEventListener('luma:backend-returned', onReturned)
    }
  })

  it('asks once when the button and a stray click land together', async () => {
    const { announceBackendStopped, checkForBackendReturn } = await freshModule()
    healthAnswers(false)
    announceBackendStopped()
    const health = healthAnswers(false)

    await Promise.all([checkForBackendReturn(), checkForBackendReturn(), checkForBackendReturn()])

    expect(health).toHaveBeenCalledTimes(1)
  })

  it('hands a failed module load back to the caller as a settled probe', async () => {
    // The error boundary awaits this to decide which panel to show, so it has to resolve even for the
    // errors that are none of this module's business — otherwise a real crash waits forever behind a
    // placeholder.
    const { noteRequestFailure } = await freshModule()
    healthAnswers(true)

    const ignored = new Error('Request failed')
    ignored.status = 404
    await expect(noteRequestFailure(ignored)).resolves.toBeUndefined()
    await expect(noteRequestFailure(new TypeError('Importing a module script failed.'))).resolves.toBeUndefined()
  })

  it('announces a shutdown it asked for without probing', async () => {
    // The one case where the outcome is known rather than discovered: the server accepted the request
    // and is on its way down. Probing would only ask a process that is mid-exit whether it has exited.
    const { announceBackendStopped } = await freshModule()
    const health = healthAnswers(true)

    announceBackendStopped()

    expect(stoppedEvents).toBe(1)
    expect(health).not.toHaveBeenCalled()
  })

  it('says so once, however many times it is told', async () => {
    // Every later request fails too, and each failure arrives here. A dialog that re-announced itself
    // per failed request would fight anything the user did next.
    const { noteRequestFailure, announceBackendStopped } = await freshModule()
    healthAnswers(false)

    announceBackendStopped()
    announceBackendStopped()
    noteRequestFailure(new TypeError('Failed to fetch'))
    await Promise.resolve()

    expect(stoppedEvents).toBe(1)
  })
})
