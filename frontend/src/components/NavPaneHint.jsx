// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Tooltip } from './ui.jsx'

// A row trigger spans the pane, so its row keeps the full width it has without the hint.
const ROW_TRIGGER_STYLE = { display: 'flex', flexDirection: 'column' }

// The hover label of an item in the collapsed nav pane, where the icon is all that shows. It opens at once
// rather than after a native `title`'s fixed delay, because the icons cannot be told apart without it, and
// beside the icon so it does not cover the one below. An expanded pane shows the item's text, so there it
// renders nothing. `content` may hold line breaks.
export function NavPaneHint({ collapsed, content, row = false, describeTrigger = false, children }) {
  return (
    <Tooltip
      content={collapsed && content ? <span style={{ whiteSpace: 'pre-line' }}>{content}</span> : null}
      side="right"
      maxWidth={420}
      triggerStyle={row ? ROW_TRIGGER_STYLE : null}
      describeTrigger={describeTrigger}
    >
      {children}
    </Tooltip>
  )
}
