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
import { HELP_ANCHOR_ATTR, parseHelpTarget } from '../helpAnchors.js'

const SECTION_KEYS = new Set(HELP_SECTIONS.map(section => section.key))
const TOPIC_IDS = new Set(HELP_TOPICS.map(topic => topic.id))
// Anchors become part of a URL, and are matched by attribute selector — so the same shape as a topic id.
const ANCHOR_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/

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
      .map(link => parseHelpTarget(link.getAttribute('href')))
    const anchors = [...container.querySelectorAll(`[${HELP_ANCHOR_ATTR}]`)]
      .map(heading => heading.getAttribute(HELP_ANCHOR_ATTR))
    cleanup()
    return { id: topic.id, html, links, anchors }
  })
  const ANCHORS_BY_TOPIC = new Map(rendered.map(entry => [entry.id, new Set(entry.anchors)]))

  it('renders', () => {
    const empty = rendered.filter(entry => !entry.html.trim()).map(entry => entry.id)
    expect(empty).toEqual([])
  })

  it('cross-links only to topics that exist', () => {
    const broken = rendered.flatMap(entry => entry.links
      .filter(target => !TOPIC_IDS.has(target.topicId))
      .map(target => `${entry.id} → ${target.topicId}`))
    expect(broken).toEqual([])
  })

  it('cross-links only to anchors that exist in the destination topic', () => {
    // A deep link that misses degrades to the top of the destination — which is silent, and is exactly
    // the behavior the anchor was added to fix, so a renamed heading would undo the fix invisibly.
    const broken = rendered.flatMap(entry => entry.links
      .filter(target => target.anchor && !ANCHORS_BY_TOPIC.get(target.topicId)?.has(target.anchor))
      .map(target => `${entry.id} → ${target.topicId}#${target.anchor}`))
    expect(broken).toEqual([])
  })

  it('gives each anchored heading a unique, URL-shaped anchor', () => {
    // Duplicates are the worse half: the scroll finds whichever copy comes first in the body, so the
    // link silently points at the wrong heading rather than at none.
    const bad = rendered.flatMap(entry => [
      ...entry.anchors.filter(anchor => !ANCHOR_PATTERN.test(anchor))
        .map(anchor => `${entry.id} → ${anchor} (not lowercase-hyphenated)`),
      ...(entry.anchors.length === new Set(entry.anchors).size
        ? []
        : [`${entry.id} → duplicate anchors`]),
    ])
    expect(bad).toEqual([])
  })

  it('has the getting-started tour hand off to every page hub', () => {
    // The tour carries one item per nav surface and defers the depth to that page's hub topic, so a new
    // page needs a tour item as well as a hub — and a tour that quietly stops covering the app is the
    // kind of omission nobody notices from the inside. Recurring's hub predates the `page-` prefix
    // (`recurring-transactions`) and is linked too; it just cannot be found by the naming pattern.
    const tour = rendered.find(entry => entry.id === 'parts-of-luma')
    const linked = new Set(tour.links.map(target => target.topicId))
    const missing = [...TOPIC_IDS].filter(id => id.startsWith('page-') && !linked.has(id))
    expect(missing).toEqual([])
  })

  it('does not link a topic to itself', () => {
    const selfLinked = rendered
      .filter(entry => entry.links.some(target => target.topicId === entry.id))
      .map(entry => entry.id)
    expect(selfLinked).toEqual([])
  })
})
