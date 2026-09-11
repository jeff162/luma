// @vitest-environment jsdom

// The two halves of a deep link into a topic body: splitting the target, and resolving it against a
// rendered body. Both are worth pinning because the failure mode on either side is silent — a link
// that quietly lands at the top of a long topic, which is the behavior anchors exist to replace.

import { describe, it, expect, beforeAll, vi, afterEach } from 'vitest'
import { HELP_ANCHOR_ATTR, parseHelpTarget, scrollToHelpAnchor } from '../helpAnchors.js'

// jsdom implements no layout, so it has no scrollIntoView.
beforeAll(() => { Element.prototype.scrollIntoView = vi.fn() })
afterEach(() => { document.body.innerHTML = '' })

function renderBody(anchors) {
  const container = document.createElement('div')
  container.className = 'help-body'
  container.innerHTML = anchors.map(anchor => `<h4 ${HELP_ANCHOR_ATTR}="${anchor}">${anchor}</h4>`).join('')
  document.body.append(container)
  return container
}

describe('parseHelpTarget', () => {
  it('splits a topic from the heading it addresses', () => {
    expect(parseHelpTarget('/help/parts-of-luma#how-rules-come-into-being'))
      .toEqual({ topicId: 'parts-of-luma', anchor: 'how-rules-come-into-being' })
  })

  it('reports no anchor for a plain topic link', () => {
    expect(parseHelpTarget('/help/parts-of-luma')).toEqual({ topicId: 'parts-of-luma', anchor: null })
  })
})

describe('scrollToHelpAnchor', () => {
  it('scrolls the heading into view and flashes it', () => {
    const container = renderBody(['first', 'second'])
    const cleanup = scrollToHelpAnchor(container, 'second')
    const target = container.querySelector(`[${HELP_ANCHOR_ATTR}="second"]`)

    expect(target.scrollIntoView).toHaveBeenCalled()
    expect(target.className).toContain('help-anchor-flash')

    // Unmounting mid-flash must not leave the highlight behind on a body the reader comes back to.
    cleanup()
    expect(target.className).not.toContain('help-anchor-flash')
  })

  it('returns null for an anchor the body does not contain, so the caller can fall back', () => {
    expect(scrollToHelpAnchor(renderBody(['first']), 'renamed')).toBe(null)
  })

  it('looks only inside the container it was given', () => {
    // The in-place viewer can be open over the same topic's /help page, so two copies of one body are
    // mounted at once — a document-wide lookup would scroll whichever came first.
    const behind = renderBody(['shared'])
    const overlay = renderBody(['shared'])
    scrollToHelpAnchor(overlay, 'shared')

    expect(overlay.querySelector('h4').className).toContain('help-anchor-flash')
    expect(behind.querySelector('h4').className).toBe('')
  })
})
