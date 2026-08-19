// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// Whether a busy state has lasted long enough to be worth telling the user about.
//
// A request that returns in 10ms does not need a spinner — it needs to not repaint the screen. Wiring a
// `loading` flag straight into a label or a spinner turns every fast operation into a flicker: the sync
// log's Refresh button changed to "Loading…" and back whenever a filter pill was clicked, which reads as
// the UI twitching rather than as feedback, because it is over before it can be read.
//
// Two rules, and both are needed — a delay alone just moves the flicker to the operations that finish
// either side of the threshold:
//
//   - **Late on.** Stay quiet until the work has run past `delayMs`. Anything quicker shows nothing at all.
//   - **Then long enough to read.** Once shown, stay for at least `minVisibleMs`, even if the work
//     finishes immediately after. An indicator that appears at 150ms and vanishes at 160ms is the exact
//     jitter this exists to remove.
//
// Off is always immediate in the sense that matters: the *work* being done is never delayed by this, only
// the announcement of it. `useBusyIndicator(loading)` is a drop-in replacement wherever a raw loading flag
// currently drives a label, a spinner, or a skeleton. It deliberately does not drive `disabled` — a button
// must stop accepting presses the instant the work starts, whether or not anyone is told about it.

import { useEffect, useRef, useState } from 'react'

// Long enough that a local request or a warm cache never trips it, short enough that a user who is waiting
// gets told before they wonder. Kept here rather than at the call sites so the app's operations feel alike.
export const BUSY_INDICATOR_DELAY_MS = 150
export const BUSY_INDICATOR_MIN_VISIBLE_MS = 400

export function useBusyIndicator(busy, {
  delayMs = BUSY_INDICATOR_DELAY_MS,
  minVisibleMs = BUSY_INDICATOR_MIN_VISIBLE_MS,
} = {}) {
  const [shown, setShown] = useState(false)
  // When the indicator went up, so the minimum can be measured from it. A ref rather than state: it is
  // read by the effect that decides when to take the indicator down, and storing it in state would
  // re-run that effect at the moment it sets it.
  const shownAtRef = useRef(0)

  useEffect(() => {
    if (busy) {
      if (shown) return undefined
      const id = setTimeout(() => {
        shownAtRef.current = Date.now()
        setShown(true)
      }, delayMs)
      return () => clearTimeout(id)
    }
    if (!shown) return undefined
    const remaining = minVisibleMs - (Date.now() - shownAtRef.current)
    if (remaining <= 0) {
      setShown(false)
      return undefined
    }
    const id = setTimeout(() => setShown(false), remaining)
    return () => clearTimeout(id)
  }, [busy, shown, delayMs, minVisibleMs])

  return shown
}
