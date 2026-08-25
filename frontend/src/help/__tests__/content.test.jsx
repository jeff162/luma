// @vitest-environment jsdom

// Integrity of the help registry, which nothing else checks.
//
// Every failure this catches is silent in the app: a topic whose `section` matches no heading quietly
// falls into a trailing "More" group, a cross-link to a topic id that no longer exists routes to a Help
// page with nothing on it, and a mistake inside a topic `body` throws only for the person who happens to
// open that topic. Registry entries are hand-authored prose that gets edited long after it is written,
// which is exactly the case the repo's fail-on-omission guards exist for.

import { describe, it, expect } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { HELP_SECTIONS, HELP_TOPICS } from '../content.jsx'

const SECTION_KEYS = new Set(HELP_SECTIONS.map(section => section.key))
const TOPIC_IDS = new Set(HELP_TOPICS.map(topic => topic.id))

describe('the help topic registry', () => {
  it('gives every topic a unique id', () => {
    const ids = HELP_TOPICS.map(topic => topic.id)
    expect(ids.length).toBe(new Set(ids).size)
  })

  it('files every topic under a declared section', () => {
    // An unmatched key still renders, under "More" — which is graceful and also invisible, so a typo
    // here loses a topic from the section it was written for without anything going wrong.
    const orphaned = HELP_TOPICS.filter(topic => !SECTION_KEYS.has(topic.section))
      .map(topic => `${topic.id} → ${topic.section}`)
    expect(orphaned).toEqual([])
  })

  it('gives every topic the title and summary both surfaces render', () => {
    // The popover shows the summary alone, so a topic without one opens on an empty card.
    const incomplete = HELP_TOPICS
      .filter(topic => !topic.title || !topic.summary || typeof topic.body !== 'function')
      .map(topic => topic.id)
    expect(incomplete).toEqual([])
  })
})

describe('every topic body', () => {
  // Rendered rather than inspected: a body is JSX, so this is the only way to find out that it renders
  // at all, and it is also what makes the cross-links below readable as hrefs.
  const rendered = HELP_TOPICS.map(topic => {
    const { container } = render(
      <MemoryRouter><topic.body /></MemoryRouter>,
    )
    const html = container.innerHTML
    const links = [...container.querySelectorAll('a[href^="/help/"]')]
      .map(anchor => anchor.getAttribute('href').replace(/^\/help\//, ''))
    cleanup()
    return { id: topic.id, html, links }
  })

  it('renders', () => {
    const empty = rendered.filter(entry => !entry.html.trim()).map(entry => entry.id)
    expect(empty).toEqual([])
  })

  it('cross-links only to topics that exist', () => {
    const broken = rendered.flatMap(entry =>
      entry.links.filter(target => !TOPIC_IDS.has(target)).map(target => `${entry.id} → ${target}`))
    expect(broken).toEqual([])
  })

  it('does not link a topic to itself', () => {
    const selfLinked = rendered
      .filter(entry => entry.links.includes(entry.id))
      .map(entry => entry.id)
    expect(selfLinked).toEqual([])
  })
})
