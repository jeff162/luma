// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './api.js'
import { useBusyIndicator } from './useBusyIndicator.js'

/*
 * Loading what a view shows: its loading state, its failure, and a way to load again, kept with the view
 * rather than in flags the view shares with others. A flag one mode set and only another mode cleared is
 * what left the Dashboard's Trends on "Loading…" for good after a visit to Balances.
 *
 * `load` is an async function; a change of identity is a change of what the view shows, and loads again.
 * It may return what it loaded (`data`, kept through later loads until one succeeds) or write its own
 * state. While `active` is false nothing loads, and a load in flight no longer counts.
 *
 * Only the newest load may settle the state. A failed load is retried once, quietly; the failure is noted
 * in the server log either way (`POST /diagnostics/log/client`), as a warning when the retry succeeded and
 * as an error when it did not, which is when `error` is set and the view offers `reload`. A session that
 * has ended is not retried or noted: the sign-in handling takes that over.
 *
 * `busy` is `loading` through `useBusyIndicator`, for a first load's spinner, so a quick load shows none.
 */
export function useViewLoad(load, { active = true, view }) {
  const [state, setState] = useState({ loading: false, error: null, data: undefined })
  const runRef = useRef(0)

  const reload = useCallback(async () => {
    const ticket = ++runRef.current
    const isCurrent = () => ticket === runRef.current
    setState(prev => (prev.loading && !prev.error ? prev : { ...prev, loading: true, error: null }))
    let firstError = null
    for (;;) {
      try {
        const data = await load()
        if (!isCurrent()) return
        if (firstError) noteFailure(view, firstError, true)
        setState({ loading: false, error: null, data })
        return
      } catch (error) {
        if (!isCurrent()) return
        if (error?.status === 401) {
          setState(prev => ({ ...prev, loading: false }))
          return
        }
        if (!firstError) {
          firstError = error
          continue
        }
        noteFailure(view, error, false)
        setState(prev => ({ ...prev, loading: false, error }))
        return
      }
    }
  }, [load, view])

  useEffect(() => {
    if (active) {
      reload()
      return
    }
    runRef.current += 1
    setState(prev => (prev.loading || prev.error ? { ...prev, loading: false, error: null } : prev))
  }, [active, reload])
  useEffect(() => () => { runRef.current += 1 }, [])

  const busy = useBusyIndicator(state.loading)
  return { ...state, busy, reload }
}

// Never awaited and never retried: a note that cannot be sent is dropped, so a broken endpoint cannot hold
// up the view or multiply its own failures.
function noteFailure(view, error, recovered) {
  api.logClientLoadFailure({
    view,
    path: typeof error?.path === 'string' ? error.path.slice(0, 300) : null,
    status: Number.isInteger(error?.status) ? error.status : null,
    message: String(error?.message || error || '').slice(0, 300),
    recovered,
  }).catch(() => { })
}
