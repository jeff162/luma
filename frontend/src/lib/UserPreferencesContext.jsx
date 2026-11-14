// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/* eslint-disable react-refresh/only-export-components -- provider + hooks live together by design */

/*
 * App-wide user preference store. Two model invariants worth knowing about:
 *
 * 1. Optimistic local state + async backend save. `setPreference` updates the in-memory
 *    map immediately so controls feel responsive, then fires `api.saveUserPreference`. If
 *    the save fails AND no newer write has superseded ours in the meantime, we roll the
 *    in-memory map back to the previous value. The "newer write" check matters: a user
 *    rapidly changing the same preference shouldn't have a failed early save roll back a
 *    later successful one.
 *
 * 2. Symmetric reader/setter for defaults. `useUserPreference(key, defaultValue)` plumbs
 *    the default into both the read path (returns defaultValue when no value has been
 *    saved) AND the setter — so a functional updater (`setX(prev => ...)`) sees the same
 *    resolved-with-default value the reader returned, not the raw stored `undefined`. This
 *    matters because callers naturally assume `prev` is the "current value of X" and write
 *    things like `prev.field` against it; without the symmetry, the first ever write for a
 *    key would hand `undefined` to the updater and crash.
 *
 * 3. Another device's change arrives through `refreshPreferences`, which the background catch-up calls on
 *    each return to the page. It takes the server's value for every key except one this page is saving or
 *    has written since the read began, since the server copy of that key may predate the local write.
 *
 * Preferences are gated behind `preferencesReady`: until the initial load resolves, the
 * provider shows a tiny loading state rather than render children with stale defaults that
 * would flash to the real values a moment later.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { api } from './api.js'
import { deviceLayoutPreferenceKey, useDeviceLayoutKey } from './deviceLayout.js'
import { vh } from './displaySize.js'

const UserPreferencesContext = createContext(null)

function normalizePreferences(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function getPreferenceValue(preferences, key, defaultValue) {
  return Object.prototype.hasOwnProperty.call(preferences, key)
    ? preferences[key]
    : defaultValue
}

export function UserPreferencesProvider({ children, initialPreferences = null }) {
  const [preferences, setPreferences] = useState(() => normalizePreferences(initialPreferences))
  const [preferencesReady, setPreferencesReady] = useState(() => initialPreferences !== null)
  const mountedRef = useRef(true)
  const preferencesRef = useRef({})
  // Local writes, for `refreshPreferences`: a running count, the count at each key's latest write, and
  // how many saves of each key are still awaiting the server.
  const writeCountRef = useRef(0)
  const lastWriteRef = useRef(new Map())
  const savingRef = useRef(new Map())

  useEffect(() => {
    preferencesRef.current = preferences
  }, [preferences])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    if (initialPreferences !== null) {
      const normalized = normalizePreferences(initialPreferences)
      preferencesRef.current = normalized
      setPreferences(normalized)
      setPreferencesReady(true)
    }
  }, [initialPreferences])

  useEffect(() => {
    if (initialPreferences !== null) return
    let cancelled = false
    setPreferencesReady(false)

    api.getUserPreferences()
      .then(response => {
        if (cancelled || !mountedRef.current) return
        setPreferences(normalizePreferences(response?.preferences))
      })
      .catch(() => {
        if (cancelled || !mountedRef.current) return
        setPreferences({})
      })
      .finally(() => {
        if (cancelled || !mountedRef.current) return
        setPreferencesReady(true)
      })

    return () => {
      cancelled = true
    }
  }, [initialPreferences])

  // Writes to the backend on EVERY call (optimistic local update + immediate `api.saveUserPreference`),
  // intentionally un-debounced so a discrete change — a toggle, a selection, a column drop — persists
  // right away and survives an immediate navigation/unmount. For a *continuous gesture* (dragging a
  // splitter, a slider) do NOT call this per frame — use `useDeferredPreference` (below), which holds
  // a live value during the gesture and persists once on its end. A blanket debounce here would
  // instead risk dropping the common single-write case (a toggle/selection) on unmount.
  const setPreference = useCallback((key, nextValueOrUpdater, defaultValue) => {
    const currentPreferences = preferencesRef.current
    const hadPreviousValue = Object.prototype.hasOwnProperty.call(currentPreferences, key)
    const previousValue = currentPreferences[key]
    // Fall back to defaultValue (which useUserPreference threads in) so functional updaters
    // see the same value the reader returned, not raw `undefined` from a never-saved key —
    // see "Symmetric reader/setter" in the top-of-file model.
    const updaterInput = hadPreviousValue ? previousValue : defaultValue
    const resolvedNextValue = typeof nextValueOrUpdater === 'function'
      ? nextValueOrUpdater(updaterInput)
      : nextValueOrUpdater

    if (hadPreviousValue && Object.is(previousValue, resolvedNextValue)) {
      return Promise.resolve(true)
    }

    const optimisticPreferences = {
      ...currentPreferences,
      [key]: resolvedNextValue,
    }
    preferencesRef.current = optimisticPreferences
    setPreferences(optimisticPreferences)

    writeCountRef.current += 1
    lastWriteRef.current.set(key, writeCountRef.current)
    savingRef.current.set(key, (savingRef.current.get(key) ?? 0) + 1)
    const saveSettled = () => {
      const left = savingRef.current.get(key) - 1
      if (left > 0) savingRef.current.set(key, left)
      else savingRef.current.delete(key)
    }

    return api.saveUserPreference(key, resolvedNextValue)
      .finally(saveSettled)
      .then(() => true)
      .catch(() => {
        if (mountedRef.current) {
          const rollbackPreferences = hadPreviousValue
            ? {
                ...preferencesRef.current,
                [key]: previousValue,
              }
            : (() => {
                const next = { ...preferencesRef.current }
                delete next[key]
                return next
              })()
          preferencesRef.current = rollbackPreferences
          setPreferences(prev => {
            // Only roll back the failed optimistic write if a newer local change has not already replaced it.
            if (hadPreviousValue && Object.is(prev[key], resolvedNextValue)) {
              return {
                ...prev,
                [key]: previousValue,
              }
            }

            if (!hadPreviousValue && Object.is(prev[key], resolvedNextValue)) {
              const next = { ...prev }
              delete next[key]
              return next
            }

            return prev
          })
        }
        return false
      })
  }, [])

  // Re-reads the stored preferences so a change saved from another device shows here. A value whose content
  // did not change keeps its identity, so consumers that depend on it do not re-run. A failed read leaves
  // everything as it was.
  const refreshPreferences = useCallback(async () => {
    const countAtStart = writeCountRef.current
    const savingAtStart = new Set(savingRef.current.keys())
    let response
    try {
      response = await api.getUserPreferences()
    } catch {
      return
    }
    if (!mountedRef.current) return
    const stored = normalizePreferences(response?.preferences)
    const local = preferencesRef.current
    const keepLocal = key => savingAtStart.has(key)
      || savingRef.current.has(key)
      || (lastWriteRef.current.get(key) ?? 0) > countAtStart
    const has = (map, key) => Object.prototype.hasOwnProperty.call(map, key)
    const next = {}
    let changed = false
    for (const key of new Set([...Object.keys(local), ...Object.keys(stored)])) {
      if (keepLocal(key)) {
        if (has(local, key)) next[key] = local[key]
      } else if (!has(stored, key)) {
        changed = true
      } else if (has(local, key) && JSON.stringify(local[key]) === JSON.stringify(stored[key])) {
        next[key] = local[key]
      } else {
        next[key] = stored[key]
        changed = true
      }
    }
    if (!changed) return
    preferencesRef.current = next
    setPreferences(next)
  }, [])

  const value = useMemo(() => ({
    preferences,
    preferencesReady,
    setPreference,
    refreshPreferences,
    getPreference: (key, defaultValue) => getPreferenceValue(preferences, key, defaultValue),
    hasPreference: key => Object.prototype.hasOwnProperty.call(preferences, key),
  }), [preferences, preferencesReady, setPreference, refreshPreferences])

  if (!preferencesReady) {
    return (
      <div style={{ minHeight: vh(100), display: 'grid', placeItems: 'center' }}>
        {/* Avoid flashing fallback defaults before the saved preference state arrives. */}
        <div style={{ fontSize: 14, color: 'var(--muted)' }}>Loading preferences...</div>
      </div>
    )
  }

  return (
    <UserPreferencesContext.Provider value={value}>
      {children}
    </UserPreferencesContext.Provider>
  )
}

export function useUserPreferences() {
  const context = useContext(UserPreferencesContext)
  if (!context) {
    throw new Error('useUserPreferences must be used within a UserPreferencesProvider.')
  }
  return context
}

// Anchor a value to a referentially-stable identity that only changes when its serialized content does.
// Preferences are JSON-friendly by contract, so structural equality via JSON is sufficient and cheap for
// the small defaults/values involved.
function useStablePreferenceValue(value) {
  const serialized = JSON.stringify(value) ?? 'undefined'
  const ref = useRef({ serialized, value })
  if (ref.current.serialized !== serialized) {
    ref.current = { serialized, value }
  }
  return ref.current.value
}

// Consumers routinely read a preference value into an effect/memo dependency array, so this hook must
// return a value (and setter) whose identity is stable across renders and changes only when the
// preference's content changes. The stored preference object already behaves that way — it is rebuilt
// only on a real write — but a caller's inline default (`useUserPreference(KEY, [])`) is a fresh literal
// each render, and returning it directly made a consumer that re-syncs from the value in an effect loop
// forever whenever the preference was unset. Anchoring the default by content stops that at the source.
export function useUserPreference(key, defaultValue) {
  const { preferences, setPreference } = useUserPreferences()
  const stableDefault = useStablePreferenceValue(defaultValue)
  const value = getPreferenceValue(preferences, key, stableDefault)
  const setValue = useCallback(
    nextValueOrUpdater => setPreference(key, nextValueOrUpdater, stableDefault),
    [key, setPreference, stableDefault],
  )
  return [value, setValue]
}

// Per-device variant for a preference about how the app fits the screen, such as column geometry, the
// display size, a pane's width or whether it is collapsed, and a floating panel's place. A layout tuned on
// a desktop does not reach a tablet.
// The value is saved under `baseKey@<device>` (see `lib/deviceLayout.js`) and also under `baseKey`, which
// keeps the most recent layout saved on any device. A device with no saved layout of its own starts from
// that one, so a new screen never starts from the defaults when a layout exists.
export function useDeviceLayoutPreference(baseKey, defaultValue) {
  const { preferences, setPreference } = useUserPreferences()
  const deviceKey = deviceLayoutPreferenceKey(baseKey, useDeviceLayoutKey())
  const stableDefault = useStablePreferenceValue(defaultValue)
  const seed = getPreferenceValue(preferences, baseKey, stableDefault)
  const value = getPreferenceValue(preferences, deviceKey, seed)
  const setValue = useCallback(nextValueOrUpdater => {
    let next
    const saved = setPreference(deviceKey, previous => {
      next = typeof nextValueOrUpdater === 'function' ? nextValueOrUpdater(previous) : nextValueOrUpdater
      return next
    }, seed)
    setPreference(baseKey, next, stableDefault)
    return saved
  }, [baseKey, deviceKey, seed, setPreference, stableDefault])
  return [value, setValue]
}

// Commit-on-end variant of `useDeviceLayoutPreference` for a layout set by a *continuous* gesture
// (dragging a splitter). `setPreference` persists on every call (see its comment), so driving it per
// frame would spam the backend. This holds a local `live` value during the gesture and persists exactly
// once via `commit()`. The consumer wires its own pointer/keyboard events — the cursor→value math is
// interaction-specific — and calls `setLive(next)` on each change, then `commit()` when the gesture
// ends. `value` is the live value mid-gesture and the persisted value otherwise; `dragging` is true
// while a gesture is in progress; `reset()` restores and persists the default. Clamp/format in the
// consumer before setLive.
export function useDeferredDeviceLayoutPreference(key, defaultValue) {
  const [persisted, setPersisted] = useDeviceLayoutPreference(key, defaultValue)
  const [live, setLive] = useState(null)
  const commit = useCallback(
    () => setLive(current => { if (current != null) setPersisted(current); return null }),
    [setPersisted],
  )
  const reset = useCallback(() => { setLive(null); setPersisted(defaultValue) }, [setPersisted, defaultValue])
  return { value: live != null ? live : persisted, dragging: live != null, setLive, commit, reset }
}
