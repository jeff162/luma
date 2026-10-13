// @vitest-environment jsdom

// Guards the referential-stability contract of useUserPreference: the value it returns must keep a stable
// identity across renders and change only when the preference's *content* changes. Consumers routinely read
// the value into a useEffect/useMemo dependency array (e.g. a pill-table column config that re-syncs local
// state from the saved preference). When the key is unset, the hook falls back to the caller's default —
// and callers write it inline (`useUserPreference(KEY, [])`), a fresh literal every render. Returning that
// literal directly made those effects see a "new" dependency every render and loop forever ("Maximum update
// depth exceeded"). These tests pin the fix at the hook so the whole class of bug can't come back; the
// unset-key case below fails against the pre-fix hook (each render saw a different [] reference).

import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { UserPreferencesProvider, useUserPreference } from '../UserPreferencesContext.jsx'

// A stable initialPreferences keeps the provider from churning on re-render, isolating the hook's own
// stability. With initialPreferences set, the provider skips its async fetch.
function renderHookAcrossRenders(useHook, { initialPreferences = {} } = {}) {
  const observed = []
  function Probe() {
    observed.push(useHook())
    return null
  }
  function Tree() {
    return (
      <UserPreferencesProvider initialPreferences={initialPreferences}>
        <Probe />
      </UserPreferencesProvider>
    )
  }
  const view = render(<Tree />)
  return {
    observed,
    rerender: () => view.rerender(<Tree />),
    unmount: () => view.unmount(),
  }
}

describe('useUserPreference referential stability', () => {
  it('returns a stable value identity across renders for an unset key with an inline non-primitive default', () => {
    // Faithful reproduction of the real consumer pattern: an inline [] default, fresh each render.
    const harness = renderHookAcrossRenders(() => {
      const [value] = useUserPreference('test.unset.column.config', [])
      return value
    })
    harness.rerender()
    harness.rerender()

    expect(harness.observed.length).toBeGreaterThanOrEqual(3)
    // Every render must observe the same reference — that is exactly what a [dep] array needs to settle.
    for (const value of harness.observed) {
      expect(value).toBe(harness.observed[0])
      expect(value).toEqual([])
    }
    harness.unmount()
  })

  it('still reads a stored value when the key is present', () => {
    const stored = [{ key: 'date', width: 120 }]
    const harness = renderHookAcrossRenders(
      () => {
        const [value] = useUserPreference('test.present.column.config', [])
        return value
      },
      { initialPreferences: { 'test.present.column.config': stored } },
    )
    harness.rerender()

    for (const value of harness.observed) {
      expect(value).toEqual(stored)
      expect(value).toBe(harness.observed[0])
    }
    harness.unmount()
  })
})
