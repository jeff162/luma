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

export function UserPreferencesProvider({ children }) {
  const [preferences, setPreferences] = useState({})
  const [preferencesReady, setPreferencesReady] = useState(false)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
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
  }, [])

  const setPreference = useCallback((key, nextValueOrUpdater) => {
    let previousValue
    let hadPreviousValue = false
    let resolvedNextValue

    setPreferences(prev => {
      hadPreviousValue = Object.prototype.hasOwnProperty.call(prev, key)
      previousValue = prev[key]
      resolvedNextValue = typeof nextValueOrUpdater === 'function'
        ? nextValueOrUpdater(previousValue)
        : nextValueOrUpdater

      if (hadPreviousValue && Object.is(previousValue, resolvedNextValue)) {
        return prev
      }

      return {
        ...prev,
        [key]: resolvedNextValue,
      }
    })

    return api.saveUserPreference(key, resolvedNextValue)
      .then(() => true)
      .catch(() => {
      if (mountedRef.current) {
        setPreferences(prev => {
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
