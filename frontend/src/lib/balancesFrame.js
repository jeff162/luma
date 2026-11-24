// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useState } from 'react'
import { api } from './api.js'
import { useUserPreference } from './UserPreferencesContext.jsx'

/*
 * Whether the Dashboard offers its Balances frame. A household whose files carry no balances has nothing
 * for it to show, so the frame can be hidden, and the choice stored is "hide it while no account has a
 * balance" rather than "hidden": the first balance to arrive, from a file or a connection, brings it back
 * with nothing to clear. Settings → Appearance offers to turn the choice off only while the frame is hidden,
 * judged once as the page opens, since at any other time the switch would do nothing. Per user, since
 * another member may have the balances this one lacks.
 *
 * Whether a balance exists is asked only once the choice is made, and asked again after every write, which
 * the background catch-up also raises for what a sync or another device changed. Until the answer comes the
 * frame stays hidden, so it does not show and then vanish.
 */
export const BALANCES_HIDDEN_WHEN_EMPTY_PREF_KEY = 'ui.dashboard.balances.hiddenWhenEmpty'

export function useBalancesHiddenWhenEmpty() {
  return useUserPreference(BALANCES_HIDDEN_WHEN_EMPTY_PREF_KEY, false)
}

export function useBalancesFrameShown() {
  const [hiddenWhenEmpty] = useBalancesHiddenWhenEmpty()
  const [anyBalance, setAnyBalance] = useState(null)
  useEffect(() => {
    if (!hiddenWhenEmpty) return undefined
    let cancelled = false
    const load = () => api.getAnyBalance()
      .then(r => { if (!cancelled) setAnyBalance(!!r?.any_balance) })
      .catch(() => { })
    load()
    window.addEventListener('luma:data-mutated', load)
    return () => {
      cancelled = true
      window.removeEventListener('luma:data-mutated', load)
    }
  }, [hiddenWhenEmpty])
  return !hiddenWhenEmpty || anyBalance === true
}

// Whether the frame was hidden when the calling page opened. Judged once and kept for the visit, so the
// switch that brings the frame back does not vanish under the click that turns it on.
export function useBalancesHiddenAtOpen() {
  const [hiddenWhenEmpty] = useBalancesHiddenWhenEmpty()
  const [hidden, setHidden] = useState(hiddenWhenEmpty ? null : false)
  useEffect(() => {
    if (hidden !== null) return undefined
    let cancelled = false
    api.getAnyBalance()
      .then(r => { if (!cancelled) setHidden(!r?.any_balance) })
      .catch(() => { if (!cancelled) setHidden(false) })
    return () => { cancelled = true }
  }, [hidden])
  return hidden === true
}
