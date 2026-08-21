// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * Noticing that the backend has stopped, and telling every open tab at once.
 *
 * The desktop shape can be shut down from three places — the app's own control, the macOS Dock's Quit
 * or Command-Q, and whatever stops the process from outside it — and only the first of those ever went
 * through the browser. A tab that did not press the button had no idea, and decayed into unexplained
 * failures instead of saying what had happened.
 *
 * **There is no heartbeat here, and that is deliberate.** The signal already exists and is free: a
 * request to a port nothing is listening on is refused by the kernel immediately, and `fetch` rejects
 * within milliseconds. Every call the app already makes is therefore its own liveness check, and the
 * work is not detecting the failure but *acting* on the one that was always arriving and being thrown
 * away. Two additions carry the cases a failed request cannot reach on its own:
 *
 * - **Other tabs**, over `BroadcastChannel`. The first tab to find out tells the rest, so exactly one
 *   of them has to run into a failure — and the deliberate case (the in-app shutdown) announces itself
 *   before anything has failed anywhere.
 * - **A tab that has been sitting idle**, on becoming visible again. This is the Dock-Quit case: quit
 *   the app, switch to the browser, and nothing has been requested since. One probe per return to
 *   visibility, driven by the user's own gesture rather than a timer, and it doubles as the answer to
 *   a machine that has been asleep — where the honest question after waking is not "was I asleep?" but
 *   "is it still there?", which is the same probe.
 *
 * Being sure enough to say so is what the probe is for. A single failed request is not proof: the
 * process may be mid-graceful-shutdown, closing a keep-alive connection under a request that will
 * succeed on retry. So a failure asks `/api/health`, and only a failure of *that* is reported. The
 * probe is the one call here with a timeout, because it is the one call whose duration is known.
 *
 * The state latches: once the backend is gone there is nothing to recover to *in this document*, since
 * every piece of state on screen belongs to a process that no longer exists — a restart may be on a
 * different port, with a different session, against a different database. So coming back is a reload
 * rather than an unlatching, and the watch inverts once stopped: the same gestures that would have
 * looked for a failure now look for a return, plus any click or keypress, since somebody staring at the
 * banner after starting the app again is the likeliest moment for the answer to have changed. A gesture
 * probe stays silent about a backend that is still absent — the dialog's own button is the visible
 * path, and it is what reports back.
 */

const CHANNEL_NAME = 'luma-backend-liveness'
// Dispatched on `window` rather than exposed as a subscriber list, matching `luma:data-mutated` — the
// listener is a React effect either way, and this keeps one convention for app-wide signals.
export const BACKEND_STOPPED_EVENT = 'luma:backend-stopped'
// Reported rather than acted on here: reloading is the application's decision, and keeping it there
// means one listener covers both the tab that found out and the tabs that were told.
export const BACKEND_RETURNED_EVENT = 'luma:backend-returned'
// Generous for a call that is a dict literal over loopback, and short enough that a stalled socket —
// the state a machine wakes up from a long sleep in — is reported rather than waited on.
const PROBE_TIMEOUT_MS = 3000

let stopped = false
let confirming = null
let checking = null
let leaving = false
let channel = null

/** Whether a rejected request means the server never answered, as opposed to answering with a failure.
 *
 * `request()` turns every HTTP response into an error carrying `.status`, so the absence of one is what
 * identifies a transport failure. A deliberate cancellation is excluded: aborting a request the app no
 * longer wants is routine, and reporting it as a dead backend would be a lie told by a working one. A
 * *timeout* is not excluded — nothing answering in time is exactly the case worth probing. */
function isTransportFailure(error) {
  if (!error || error.status != null) return false
  return error.name !== 'AbortError'
}

function otherTabs() {
  if (channel === null && typeof BroadcastChannel !== 'undefined') {
    channel = new BroadcastChannel(CHANNEL_NAME)
    // A channel never delivers to the tab that posted, so this cannot echo back into a loop.
    channel.onmessage = event => {
      if (event?.data?.type === 'stopped') markStopped({ tell: false })
      // Only a tab that thinks the backend is gone has anything to do with this: one that never noticed
      // is already working, and reloading it would interrupt whatever it is in the middle of.
      else if (event?.data?.type === 'returned' && stopped) announceReturn({ tell: false })
    }
  }
  return channel
}

function markStopped({ tell }) {
  if (stopped) return
  stopped = true
  if (tell) otherTabs()?.postMessage({ type: 'stopped' })
  window.dispatchEvent(new CustomEvent(BACKEND_STOPPED_EVENT))
}

function announceReturn({ tell }) {
  if (tell) otherTabs()?.postMessage({ type: 'returned' })
  window.dispatchEvent(new CustomEvent(BACKEND_RETURNED_EVENT))
}

async function backendAnswers() {
  // `AbortSignal.timeout` is guarded rather than assumed: without it the probe simply waits, which is
  // the behaviour that existed before any of this and not a failure worth reporting as one.
  const signal = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(PROBE_TIMEOUT_MS) : undefined
  try {
    const res = await fetch('/api/health', { cache: 'no-store', signal })
    return res.ok
  } catch {
    return false
  }
}

/** Settle whether the backend is really gone, and announce it if so.
 *
 * Coalesced: a page that fires several requests at once produces several failures at once, and each of
 * them asking separately would turn one piece of news into a burst of identical probes. */
function confirmStopped() {
  if (stopped || leaving) return confirming
  if (!confirming) {
    confirming = backendAnswers().then(alive => {
      confirming = null
      if (!alive) markStopped({ tell: true })
    })
  }
  return confirming
}

/** Called by the API layer for every rejected request. Most are not this — a cancelled request, or a
 * page being navigated away from — so the filtering happens here rather than at each call site. */
export function noteRequestFailure(error) {
  if (!isTransportFailure(error)) return Promise.resolve()
  return Promise.resolve(confirmStopped())
}

/** Ask whether the backend has come back, and say so if it has.
 *
 * Coalesced like the failure probe, so the dialog's button and a click that reached the document watch
 * at the same moment ask once and get the same answer. Returns what the probe found, which is what lets
 * the button report a backend that is still absent rather than appearing to have done nothing. */
export function checkForBackendReturn() {
  if (!stopped || leaving) return Promise.resolve(false)
  if (!checking) {
    checking = backendAnswers().then(alive => {
      checking = null
      if (alive) announceReturn({ tell: true })
      return alive
    })
  }
  return checking
}

/** Say so directly, without a probe: the shutdown was asked for and accepted, so the outcome is known
 * and the server is on its way down rather than already gone. Announcing it here is what gets the other
 * tabs told at the moment of the decision instead of whenever each next runs into a failure. */
export function announceBackendStopped() {
  markStopped({ tell: true })
}

export function backendHasStopped() {
  return stopped
}

/** Install the watches that do not depend on a request being made. Returns a teardown for the effect
 * that owns it. */
export function watchBackendLiveness() {
  otherTabs()

  // One set of listeners, whose meaning turns over when the backend goes: before, the question is
  // whether it is still there; after, whether it is back.
  function onVisibilityChange() {
    if (document.visibilityState !== 'visible') return
    if (stopped) checkForBackendReturn()
    else confirmStopped()
  }

  // Gestures are watched only in the stopped state, deliberately. Probing on every click of a working
  // app would be a request per interaction to answer a question nothing has asked.
  function onGesture() {
    if (stopped) checkForBackendReturn()
  }

  // A page being torn down cancels its in-flight requests, and those rejections look exactly like a
  // backend that vanished. Nothing should be announced on the way out of a document — least of all to
  // other tabs, which are not going anywhere.
  function onPageHide() {
    leaving = true
  }

  document.addEventListener('visibilitychange', onVisibilityChange)
  document.addEventListener('click', onGesture)
  document.addEventListener('keydown', onGesture)
  window.addEventListener('online', onGesture)
  window.addEventListener('pagehide', onPageHide)
  return () => {
    document.removeEventListener('visibilitychange', onVisibilityChange)
    document.removeEventListener('click', onGesture)
    document.removeEventListener('keydown', onGesture)
    window.removeEventListener('online', onGesture)
    window.removeEventListener('pagehide', onPageHide)
  }
}
