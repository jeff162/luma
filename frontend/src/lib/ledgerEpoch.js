// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// Noticing that the ledger changed somewhere else — on another device, or by the server — while this page
// was out of view or left untouched.
//
// The server keeps `ledger_epoch`, a number every write to a table the ledger pages show moves
// (`db/database.py`). This page keeps the latest value it knows of and compares on its return: moved means
// someone else wrote, so the ledger pages reload; unchanged means they are already current and are left
// alone.
//
// **This page's own writes are absorbed, not reported.** They move the epoch too, and a page that reloaded
// after every edit made on it would be reloading to show what it already shows. So after each burst of
// writes here (the api layer's mutation signal) the known value is re-read. A write from elsewhere landing
// in that same moment is folded in with this page's own and missed; that window is a fraction of a second
// against a check that otherwise runs on every return.
//
// **Whose answer counts is decided by when it was asked.** A return check and an absorbing re-read can be
// in flight together, and either may land first. Each check compares against the value known when it
// started, so a re-read landing in between cannot make a moved epoch look unchanged; and the known value
// only ever takes the answer to the most recently *started* read, so a slow early answer cannot overwrite
// a later one.

import { useEffect, useMemo, useRef } from 'react'
import { api } from './api.js'

export function createLedgerEpochTracker({ read, onChanged }) {
  let known = null
  let knownSeq = 0
  let seq = 0

  async function readEpoch() {
    const asked = ++seq
    const epoch = await read().catch(() => null)
    return { asked, epoch }
  }

  function adopt(asked, epoch) {
    if (epoch == null || asked < knownSeq) return
    known = epoch
    knownSeq = asked
  }

  return {
    // Compare against what was known when this check started, then keep the answer. With nothing known
    // yet (the first read failed) there is nothing to compare against, so it only learns the value.
    async check() {
      const base = known
      const { asked, epoch } = await readEpoch()
      if (epoch == null) return
      if (base != null && epoch !== base) onChanged()
      adopt(asked, epoch)
    },
    // Learn the current value without reporting a change: at load, and after this page's own writes.
    async absorb() {
      const { asked, epoch } = await readEpoch()
      adopt(asked, epoch)
    },
  }
}

// The tracker for this page, kept current with this page's own writes. Checking is the caller's: when to
// ask is a question about the whole return-to-the-app sequence (`BackgroundCatchUp` in App.jsx), not
// about the epoch. `onChanged` is read through a ref, so a caller need not keep it stable.
export function useLedgerEpochTracker(onChanged) {
  const onChangedRef = useRef(onChanged)
  onChangedRef.current = onChanged
  const tracker = useMemo(() => createLedgerEpochTracker({
    read: () => api.getLedgerEpoch().then(r => r.epoch),
    onChanged: () => onChangedRef.current(),
  }), [])
  useEffect(() => {
    const onMutated = () => { tracker.absorb() }
    window.addEventListener('luma:data-mutated', onMutated)
    return () => window.removeEventListener('luma:data-mutated', onMutated)
  }, [tracker])
  return tracker
}
