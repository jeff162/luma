// @vitest-environment jsdom

// The in-place viewer's topic trail: following cross-links inside the dialog builds a chain that steps back
// one topic at a time, returns the reader to where they followed the link, and never touches the route
// behind the overlay.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import HelpLink from '../HelpLink.jsx'
import HelpTopicDialog from '../HelpTopicDialog.jsx'

// Fixture topics rather than the real registry, so a copy edit to content.jsx cannot break the chain.
vi.mock('../content.jsx', () => ({
  HELP_TOPICS_BY_ID: {
    alpha: { id: 'alpha', title: 'Alpha topic', body: () => <p>Alpha body <HelpLink to="/help/beta">to beta</HelpLink></p> },
    beta: { id: 'beta', title: 'Beta topic', body: () => <p>Beta body <HelpLink to="/help/gamma">to gamma</HelpLink></p> },
    gamma: { id: 'gamma', title: 'Gamma topic', body: () => <p>Gamma body</p> },
  },
}))

function LocationProbe() {
  const location = useLocation()
  return <span data-testid="location">{location.pathname}</span>
}

function renderDialog(topicId) {
  const tree = id => (
    <MemoryRouter initialEntries={['/accounts']}>
      <LocationProbe />
      <HelpTopicDialog topicId={id} onClose={() => {}} />
    </MemoryRouter>
  )
  const utils = render(tree(topicId))
  return { ...utils, rerenderTopic: id => utils.rerender(tree(id)) }
}

// jsdom does not lay anything out, so give the overlay a scroll position that can be written and read back.
function trackScroll() {
  const overlay = document.body.querySelector('[data-modal-overlay]')
  let value = 0
  Object.defineProperty(overlay, 'scrollTop', { configurable: true, get: () => value, set: v => { value = v } })
  return overlay
}

const heading = () => screen.getByRole('heading', { level: 2 }).textContent
const backButton = () => screen.queryByRole('button', { name: /Back to/ })

afterEach(cleanup)

describe('HelpTopicDialog topic trail', () => {
  it('offers no back link for the topic a ? opened', () => {
    renderDialog('alpha')
    expect(heading()).toBe('Alpha topic')
    expect(backButton()).toBeNull()
  })

  it('steps back through a multi-hop chain one topic at a time', () => {
    renderDialog('alpha')
    fireEvent.click(screen.getByText('to beta'))
    expect(heading()).toBe('Beta topic')
    expect(backButton().textContent).toBe('← Back to Alpha topic')

    fireEvent.click(screen.getByText('to gamma'))
    expect(heading()).toBe('Gamma topic')
    expect(backButton().textContent).toBe('← Back to Beta topic')

    fireEvent.click(backButton())
    expect(heading()).toBe('Beta topic')
    expect(backButton().textContent).toBe('← Back to Alpha topic')

    fireEvent.click(backButton())
    expect(heading()).toBe('Alpha topic')
    expect(backButton()).toBeNull()
  })

  it('returns to where the link was followed, while a new topic starts at its top', () => {
    renderDialog('alpha')
    const overlay = trackScroll()
    overlay.scrollTop = 420
    fireEvent.click(screen.getByText('to beta'))
    expect(overlay.scrollTop).toBe(0)

    overlay.scrollTop = 75
    fireEvent.click(backButton())
    expect(heading()).toBe('Alpha topic')
    expect(overlay.scrollTop).toBe(420)
  })

  it('leaves the route behind the overlay alone', () => {
    renderDialog('alpha')
    fireEvent.click(screen.getByText('to beta'))
    fireEvent.click(backButton())
    expect(screen.getByTestId('location').textContent).toBe('/accounts')
  })

  it('starts a new trail when a ? opens a different topic', () => {
    const { rerenderTopic } = renderDialog('alpha')
    fireEvent.click(screen.getByText('to beta'))
    expect(backButton()).not.toBeNull()

    rerenderTopic('gamma')
    expect(heading()).toBe('Gamma topic')
    expect(backButton()).toBeNull()
  })
})
