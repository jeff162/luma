// @vitest-environment jsdom

// The card has to open inside the window wherever its `?` sits. It used to be positioned inside the
// button's own box, so a `?` near the right edge of a toolbar opened a 340px card past the edge of the screen.
// jsdom does no layout, so the window and element geometry are stated here.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import FeatureExplainer from '../FeatureExplainer.jsx'

const WINDOW = { width: 1000, height: 800 }
const CARD = { width: 340, height: 120 }

function rect(left, top, width, height) {
  return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top }
}

function openAt(trigger) {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function () {
    return this.getAttribute('aria-label') === 'About this feature'
      ? rect(trigger.left, trigger.top, 18, 18)
      : rect(0, 0, CARD.width, CARD.height)
  })
  render(<MemoryRouter><FeatureExplainer topic="page-transactions" placement="bottom-left" /></MemoryRouter>)
  fireEvent.click(screen.getByRole('button', { name: 'About this feature' }))
  return screen.getByRole('dialog')
}

describe('FeatureExplainer placement', () => {
  beforeEach(() => {
    Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: WINDOW.width })
    Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, value: WINDOW.height })
  })
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    delete document.documentElement.clientWidth
    delete document.documentElement.clientHeight
  })

  it('slides a card that would open past the right edge back inside the window', () => {
    const card = openAt({ left: 972, top: 100 })
    expect(card.style.left).toBe(`${WINDOW.width - 8 - CARD.width}px`)
    expect(card.style.top).toBe(`${100 + 18 + 6}px`)
  })

  it('opens above a `?` too close to the bottom for the card to fit below', () => {
    const card = openAt({ left: 100, top: 760 })
    expect(card.style.left).toBe('100px')
    expect(card.style.top).toBe(`${760 - 6 - CARD.height}px`)
  })
})
