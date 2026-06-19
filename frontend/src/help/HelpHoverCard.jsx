// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: GPL-3.0-or-later

import { Tooltip } from '../components/ui.jsx'
import { HELP_TOPICS_BY_ID } from './content.jsx'
import { HelpPopoverPanel } from './helpPanel.jsx'
import { useHelpTopicViewer } from './useHelpTopicViewer.jsx'

/*
 * Wrap a trigger (e.g. a report pill) so hovering it shows that topic's help summary in a hover
 * popover, with a "Read more" that opens the full body in the in-place viewer (above any floating
 * panel). The trigger keeps its own click behavior — for the pills, click still filters — so the help
 * lives entirely in the hover popover. Content comes from the same registry as the `?` popover and the
 * /help pages, so nothing drifts. Renders the trigger unchanged when the topic id is unknown.
 */
const HOVER_CARD_STYLE = {
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 10,
  boxShadow: '0 12px 32px rgba(15,23,42,0.32)',
  padding: '11px 13px',
  width: 'min(320px, calc(100vw - 24px))',
  fontSize: 13,
  lineHeight: 1.5,
  color: 'var(--text)',
}

export default function HelpHoverCard({ topic, children }) {
  const { openTopic, viewerNode } = useHelpTopicViewer()
  if (!HELP_TOPICS_BY_ID[topic]) return children
  return (
    <>
      <Tooltip
        interactive
        bare
        content={(
          <HelpPopoverPanel
            topic={topic}
            onReadMore={() => openTopic(topic)}
            style={HOVER_CARD_STYLE}
          />
        )}
      >
        {children}
      </Tooltip>
      {viewerNode}
    </>
  )
}
