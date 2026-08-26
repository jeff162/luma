// @vitest-environment jsdom

/*
 * Floating-panel sizing under a changing viewport.
 *
 * The panel's size has to survive a window that gets smaller and then bigger again. The clamp is
 * therefore applied on the way out rather than written back into state: a clamp that overwrote the
 * stored size would lose the user's request the first time the window narrowed, leaving nothing to
 * restore when it widened.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { act } from 'react'
import {
  useDetailPanelChrome,
  DETAIL_PANEL_MIN_HEIGHT,
  DETAIL_FLOATING_TOP_GUTTER,
  DETAIL_FLOATING_EDGE_GUTTER,
} from '../detailShared.jsx'

const VERTICAL_GUTTERS = DETAIL_FLOATING_TOP_GUTTER + DETAIL_FLOATING_EDGE_GUTTER
const REQUESTED = { width: 900, height: 800 }

let chrome

function Probe({ initialSize }) {
  chrome = useDetailPanelChrome(() => {}, { forceFloating: true, initialSize })
  return <div ref={chrome.panelRef} />
}

function setViewport(width, height) {
  window.innerWidth = width
  window.innerHeight = height
  act(() => { window.dispatchEvent(new Event('resize')) })
}

afterEach(() => {
  cleanup()
  setViewport(1024, 768)
})

describe('a floating panel against a resizing window', () => {
  it('gives back height when the window shrinks and takes it straight back when it grows', () => {
    setViewport(1400, 1000)
    render(<Probe initialSize={REQUESTED} />)
    expect(chrome.size.height).toBe(REQUESTED.height)

    setViewport(1400, 500)
    expect(chrome.size.height).toBe(500 - VERTICAL_GUTTERS)

    setViewport(1400, 1000)
    expect(chrome.size.height).toBe(REQUESTED.height)
  })

  it('does not grow a panel past the size that was asked for', () => {
    setViewport(1400, 1000)
    render(<Probe initialSize={REQUESTED} />)

    setViewport(2400, 2000)
    expect(chrome.size).toEqual(REQUESTED)
  })

  it('keeps a panel usable in a window too small to hold its minimum', () => {
    setViewport(1400, 1000)
    render(<Probe initialSize={REQUESTED} />)

    setViewport(300, 200)
    expect(chrome.size.height).toBe(DETAIL_PANEL_MIN_HEIGHT)
  })

  it('leaves a content-sized panel unsized, so the shell keeps deciding its height', () => {
    render(<Probe initialSize={null} />)
    expect(chrome.size).toBeNull()

    setViewport(1400, 1000)
    expect(chrome.size).toBeNull()
  })
})
