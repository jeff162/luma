// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: GPL-3.0-or-later

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { api } from './api.js'

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
  /*
   * Preferences are loaded once here and then treated as optimistic local state so controls stay responsive
   * while this provider owns the save/rollback bookkeeping.
   */
  const [preferences, setPreferences] = useState(() => normalizePreferences(initialPreferences))
  const [preferencesReady, setPreferencesReady] = useState(() => initialPreferences !== null)
  const mountedRef = useRef(true)
  const preferencesRef = useRef({})

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

  const setPreference = useCallback((key, nextValueOrUpdater) => {
    const currentPreferences = preferencesRef.current
    const hadPreviousValue = Object.prototype.hasOwnProperty.call(currentPreferences, key)
    const previousValue = currentPreferences[key]
    const resolvedNextValue = typeof nextValueOrUpdater === 'function'
      ? nextValueOrUpdater(previousValue)
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

    return api.saveUserPreference(key, resolvedNextValue)
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

  const value = useMemo(() => ({
    preferences,
    preferencesReady,
    setPreference,
    getPreference: (key, defaultValue) => getPreferenceValue(preferences, key, defaultValue),
    hasPreference: key => Object.prototype.hasOwnProperty.call(preferences, key),
  }), [preferences, preferencesReady, setPreference])

  if (!preferencesReady) {
    return (
      <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center' }}>
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

export function useUserPreference(key, defaultValue) {
  const { preferences, setPreference } = useUserPreferences()
  const value = getPreferenceValue(preferences, key, defaultValue)
  const setValue = useCallback(
    nextValueOrUpdater => setPreference(key, nextValueOrUpdater),
    [key, setPreference],
  )
  return [value, setValue]
}
