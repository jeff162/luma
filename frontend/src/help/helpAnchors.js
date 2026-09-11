// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * Deep links to a heading *inside* a help topic.
 *
 * Some cross-links name a heading rather than a whole topic ("how rules come into being" lives two
 * thirds of the way down "The parts of Luma"). Landing at the top of the destination hides the very
 * thing the link promised, so those links carry an anchor -- `/help/<topic>#<anchor>` -- and the
 * destination scrolls that heading into view instead of resetting to the top.
 *
 * An anchor is a `data-help-anchor` attribute (see HelpHeading) found by a query **scoped to the
 * element that rendered the body**, never a document-wide `id` lookup. Topic bodies render in two
 * places -- the /help route and the portal'd HelpTopicDialog -- and both can be mounted at once,
 * since the dialog opens over whatever page is behind it, which may be the same topic's /help page.
 * Document ids would be ambiguous exactly then. The URL hash is only the carrier.
 *
 * A missing anchor is not an error: the caller falls back to its normal top-of-topic behavior, so a
 * heading renamed out from under a link degrades to today's behavior rather than leaving the reader
 * somewhere unexplained. `content.test.jsx` is what catches that case before a user does.
 */

export const HELP_ANCHOR_ATTR = 'data-help-anchor'

const FLASH_CLASS = 'help-anchor-flash'
// Matches the index's card-highlight duration, so arriving at a heading and returning to a topic
// card read as the same gesture.
const FLASH_MS = 1100

// Appended to HELP_BODY_CSS so both render targets style anchored headings identically. The flash
// fakes its padding with a box-shadow spread rather than real padding: a padded flash class would
// shift the heading's layout for the second it is applied.
export const HELP_ANCHOR_CSS = `
  .help-body [${HELP_ANCHOR_ATTR}] { scroll-margin-top: 16px; }
  .help-body .${FLASH_CLASS} {
    border-radius: 4px;
    animation: ${FLASH_CLASS} ${FLASH_MS}ms ease-out;
  }
  @keyframes ${FLASH_CLASS} {
    from {
      background: color-mix(in srgb, var(--accent2) 24%, transparent);
      box-shadow: 0 0 0 6px color-mix(in srgb, var(--accent2) 24%, transparent);
    }
    to { background: transparent; box-shadow: 0 0 0 6px transparent; }
  }
`

const HELP_PATH_PREFIX = '/help/'

/*
 * Split a `HelpLink` target into the topic it addresses and the anchor within it, for the two
 * consumers that need the halves separately: the in-place viewer (which switches topic without
 * routing, so it never sees a `location.hash`) and the registry's link guard.
 */
export function parseHelpTarget(to) {
  const [path, anchor] = String(to).split('#')
  const topicId = path.startsWith(HELP_PATH_PREFIX) ? path.slice(HELP_PATH_PREFIX.length) : path
  return { topicId, anchor: anchor || null }
}

/*
 * Bring `anchor` into view within the body rendered inside `container` and flash it so the jump is
 * legible rather than looking like a mis-positioned page. Returns a cleanup for the flash timer, or
 * `null` when the container holds no such anchor -- which is the caller's cue to fall back.
 */
export function scrollToHelpAnchor(container, anchor) {
  const target = container?.querySelector(`[${HELP_ANCHOR_ATTR}="${anchor}"]`)
  if (!target) return null
  target.scrollIntoView({ block: 'start' })
  target.classList.add(FLASH_CLASS)
  const timer = setTimeout(() => target.classList.remove(FLASH_CLASS), FLASH_MS)
  return () => {
    clearTimeout(timer)
    target.classList.remove(FLASH_CLASS)
  }
}
