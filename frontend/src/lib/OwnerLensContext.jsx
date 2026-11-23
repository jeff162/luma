// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/* eslint-disable react-refresh/only-export-components -- provider + hooks live together by design */

/*
 * The owner lens as app state (`lib/ownerLens.js` says what it means). The choice is a per-user preference,
 * so it follows the user to another device, and it applies only on the scoped pages: on any other route
 * `lens` is null, so a report opened from the Categories page is not narrowed by a control that page does
 * not show. `choiceParams` is the choice without that route check, for a surface that previews a scoped page.
 *
 * The owner list is held here because the control and every consumer need the same one, and refetched
 * after any write, since owners are created and deleted from the Accounts page.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { api } from './api.js'
import { useUserPreference } from './UserPreferencesContext.jsx'
import {
  DEFAULT_OWNER_LENS, OWNER_LENS_PREF_KEY, OWNER_LENS_ROUTES, effectiveLens, lensOwnerIds,
} from './ownerLens.js'

const OwnerLensContext = createContext(null)
const NO_PARAMS = {}

export function OwnerLensProvider({ children }) {
  const { pathname } = useLocation()
  const [stored, setStored] = useUserPreference(OWNER_LENS_PREF_KEY, DEFAULT_OWNER_LENS)
  // null until the first answer. The list is refetched after every write and kept only when it changed,
  // so a write that touched no owner leaves everything below it as it was.
  const [owners, setOwners] = useState(null)

  useEffect(() => {
    let cancelled = false
    const load = () => api.getOwners().then(list => {
      if (cancelled) return
      const next = list || []
      setOwners(prev => (prev && JSON.stringify(prev) === JSON.stringify(next) ? prev : next))
    }).catch(() => {})
    load()
    window.addEventListener('luma:data-mutated', load)
    return () => { cancelled = true; window.removeEventListener('luma:data-mutated', load) }
  }, [])

  const ready = owners !== null
  const ownerIds = useMemo(() => lensOwnerIds(stored, owners || []), [stored, owners])
  const on = !!stored?.on
  // With one owner there is nothing to narrow between. Until the list arrives the saved choice is taken
  // as it stands, which preferences have already loaded: a page then makes its first request already
  // narrowed instead of loading everything and loading again once the owners are known. An id saved for
  // an owner since deleted narrows to nothing of its own in that moment, which is harmless.
  const available = ready ? owners.length > 1 : true
  const applies = available && OWNER_LENS_ROUTES.includes(pathname)
  const chosenIds = ready ? ownerIds : (Array.isArray(stored?.ownerIds) ? stored.ownerIds : [])
  const chosenLens = effectiveLens({ on, ownerIds: chosenIds })
  // The lens and its params are keyed by value, so they keep their identity while the same owners are
  // chosen, and a page whose requests depend on them reloads only when the choice really changes.
  const lensKey = applies && chosenLens ? chosenLens.join(',') : ''
  const lens = useMemo(() => (lensKey ? lensKey.split(',') : null), [lensKey])
  const params = useMemo(() => (lensKey ? { owner_lens: lensKey } : NO_PARAMS), [lensKey])
  // The lens as chosen, whatever page is showing: for something on every page that previews a scoped one
  // (the nav's Tasks badge), which has to count what that page will show rather than what this one does.
  const choiceKey = available && chosenLens ? chosenLens.join(',') : ''
  const choiceParams = useMemo(() => (choiceKey ? { owner_lens: choiceKey } : NO_PARAMS), [choiceKey])

  const setOn = useCallback(next => setStored(prev => ({ ...DEFAULT_OWNER_LENS, ...prev, on: next })), [setStored])
  const setOwnerIds = useCallback(
    next => setStored(prev => ({ ...DEFAULT_OWNER_LENS, ...prev, ownerIds: next })),
    [setStored],
  )

  const value = useMemo(() => ({
    owners: owners || [], ready, available, applies, on, ownerIds, lens, params, choiceParams, setOn, setOwnerIds,
  }), [owners, ready, available, applies, on, ownerIds, lens, params, choiceParams, setOn, setOwnerIds])

  return <OwnerLensContext.Provider value={value}>{children}</OwnerLensContext.Provider>
}

const INERT = {
  owners: [], ready: true, available: false, applies: false, on: false, ownerIds: [], lens: null, params: NO_PARAMS,
  choiceParams: NO_PARAMS, setOn: () => {}, setOwnerIds: () => {},
}

// Outside the provider (a component rendered on its own in a test) the lens is simply off.
export function useOwnerLens() {
  return useContext(OwnerLensContext) || INERT
}
