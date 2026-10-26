// @vitest-environment jsdom

// Column layouts are kept per kind of screen, so a resize on a desktop never reaches a tablet. These pin
// what that promise rests on: the device key tells a mouse screen from a touch one and a portrait tablet
// from a landscape one, a device with no layout of its own starts from the latest one saved anywhere, and
// a save on one device leaves another device's saved layout alone.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { readDeviceLayoutKey } from '../deviceLayout.js'
import { UserPreferencesProvider, useDeviceLayoutPreference } from '../UserPreferencesContext.jsx'

const saveUserPreference = vi.hoisted(() => vi.fn(() => Promise.resolve()))
vi.mock('../api.js', () => ({ api: { saveUserPreference } }))

function emulateDevice({ touch, portrait = false, width, height }) {
  vi.stubGlobal('screen', { width, height })
  window.matchMedia = query => ({
    matches: query === '(pointer: coarse)' ? touch : query === '(orientation: portrait)' ? portrait : false,
    addEventListener: () => {},
    removeEventListener: () => {},
  })
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  delete window.matchMedia
  saveUserPreference.mockClear()
})

describe('readDeviceLayoutKey', () => {
  it('names the pointer and the screen, shorter side first', () => {
    emulateDevice({ touch: false, width: 1920, height: 1080 })
    expect(readDeviceLayoutKey()).toBe('mouse-1080x1920')
  })

  it('adds the orientation on a touch screen, whichever way the browser reports the screen', () => {
    emulateDevice({ touch: true, portrait: true, width: 810, height: 1080 })
    expect(readDeviceLayoutKey()).toBe('touch-810x1080-portrait')
    emulateDevice({ touch: true, portrait: false, width: 810, height: 1080 })
    expect(readDeviceLayoutKey()).toBe('touch-810x1080-landscape')
  })
})

describe('useDeviceLayoutPreference', () => {
  function renderLayout(initialPreferences) {
    const seen = {}
    function Probe() {
      const [value, setValue] = useDeviceLayoutPreference('ui.test.columns', null)
      seen.value = value
      seen.setValue = setValue
      return null
    }
    render(<UserPreferencesProvider initialPreferences={initialPreferences}><Probe /></UserPreferencesProvider>)
    return seen
  }

  it('starts a device with no layout of its own from the latest layout saved anywhere', () => {
    emulateDevice({ touch: true, portrait: true, width: 810, height: 1080 })
    const seen = renderLayout({ 'ui.test.columns': [{ key: 'date', width: 120 }] })
    expect(seen.value).toEqual([{ key: 'date', width: 120 }])
  })

  it('saves under this device and leaves another device’s layout alone', () => {
    emulateDevice({ touch: false, width: 1920, height: 1080 })
    const tablet = [{ key: 'date', width: 80 }]
    const seen = renderLayout({ 'ui.test.columns@touch-810x1080-portrait': tablet })
    act(() => { seen.setValue([{ key: 'date', width: 200 }]) })

    const saved = Object.fromEntries(saveUserPreference.mock.calls)
    expect(saved).toEqual({
      'ui.test.columns@mouse-1080x1920': [{ key: 'date', width: 200 }],
      'ui.test.columns': [{ key: 'date', width: 200 }],
    })
    expect(seen.value).toEqual([{ key: 'date', width: 200 }])
  })
})
