// @vitest-environment jsdom

// `refreshPreferences` brings in a change saved from another device without undoing one this page is
// still saving: the server's copy of that key may have been read before the local write reached it.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, render } from '@testing-library/react'

const getUserPreferences = vi.hoisted(() => vi.fn())
const saveUserPreference = vi.hoisted(() => vi.fn())
vi.mock('../api.js', () => ({ api: { getUserPreferences, saveUserPreference } }))

import { UserPreferencesProvider, useUserPreferences } from '../UserPreferencesContext.jsx'

function deferred() {
  let resolve
  const promise = new Promise(r => { resolve = r })
  return { promise, resolve }
}

function renderProvider(initialPreferences) {
  const context = {}
  function Probe() {
    Object.assign(context, useUserPreferences())
    return null
  }
  render(
    <UserPreferencesProvider initialPreferences={initialPreferences}>
      <Probe />
    </UserPreferencesProvider>,
  )
  return context
}

describe('refreshPreferences', () => {
  beforeEach(() => {
    getUserPreferences.mockReset()
    saveUserPreference.mockReset()
  })

  it("takes another device's changes and keeps the identity of values that did not change", async () => {
    const unchanged = { collapsed: true }
    const context = renderProvider({ 'filters': [{ id: 'a', name: 'Old' }], 'section': unchanged, 'gone': 1 })
    getUserPreferences.mockResolvedValue({
      preferences: { 'filters': [{ id: 'a', name: 'New' }], 'section': { collapsed: true } },
    })

    await act(() => context.refreshPreferences())

    expect(context.preferences.filters).toEqual([{ id: 'a', name: 'New' }])
    expect(context.preferences.section).toBe(unchanged)
    expect(context.preferences).not.toHaveProperty('gone')
  })

  it('keeps a value this page is saving, and one it wrote while the read was out', async () => {
    const context = renderProvider({ 'saving': 'old', 'writtenDuring': 'old' })
    const save = deferred()
    saveUserPreference.mockReturnValueOnce(save.promise)
    act(() => { context.setPreference('saving', 'local') })

    const read = deferred()
    getUserPreferences.mockReturnValue(read.promise)
    let refreshed
    act(() => { refreshed = context.refreshPreferences() })
    saveUserPreference.mockResolvedValueOnce({})
    await act(() => context.setPreference('writtenDuring', 'local'))
    save.resolve({})
    read.resolve({ preferences: { 'saving': 'old', 'writtenDuring': 'old' } })
    await act(() => refreshed)

    expect(context.preferences.saving).toBe('local')
    expect(context.preferences.writtenDuring).toBe('local')

    // Once both saves have settled, the next read is taken as it comes.
    getUserPreferences.mockResolvedValue({ preferences: { 'saving': 'other', 'writtenDuring': 'other' } })
    await act(() => context.refreshPreferences())
    expect(context.preferences).toEqual({ 'saving': 'other', 'writtenDuring': 'other' })
  })
})
