// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from 'react'
import { ActionMenu } from './ActionMenu.jsx'
import CornerTab from './CornerTab.jsx'

/*
 * The menu that chooses which of a table's columns are shown: one on/off item per column, in the table's
 * order, staying open so several can be set in one visit. The last shown column cannot be hidden, since a
 * table with none has nothing to show it by. The layout it edits is a hideable one
 * (`lib/columnVisibility.js`); a table opens it from `ColumnsStrip`, below.
 *
 * `columns` is `[{ key, label, hidden }]`; `onSetHidden(key, hidden)` writes one change.
 */
export default function ColumnsMenu({ anchorElement, columns, onSetHidden, onClose }) {
  const shownCount = columns.filter(col => !col.hidden).length
  return (
    <ActionMenu
      anchorElement={anchorElement}
      minWidth={160}
      label="Columns"
      onClose={onClose}
      items={columns.map(col => {
        const shown = !col.hidden
        const lastShown = shown && shownCount === 1
        return {
          key: col.key,
          label: col.label,
          toggled: shown,
          disabled: lastShown,
          disabledReason: lastShown ? 'At least one column stays shown' : undefined,
          onClick: () => onSetHidden(col.key, shown),
        }
      })}
    />
  )
}

// The gear that opens it, as a text glyph so it takes the surrounding text color.
const COLUMNS_GLYPH = '⚙︎'

/*
 * The strip across the top of a bordered table that holds the gear opening the menu, in a tab set into
 * the table's top-right corner. Column choice is rarely changed, so it sits on the table it adjusts rather
 * than in a toolbar. The strip lies above the scroll viewport, not over it: a tab over the viewport hides
 * the top of its scrollbar and, at either side, part of a header.
 *
 * Place it as the first child of the table's frame, which is bordered, clips its corners and has no
 * padding; `radius` is that frame's corner radius. `columns` and `onSetHidden` are as for the menu.
 */
export function ColumnsStrip({ radius, columns, onSetHidden }) {
  const [anchor, setAnchor] = useState(null)
  return (
    <div style={{ position: 'relative', height: 20, flexShrink: 0 }}>
      <CornerTab
        corner="top-right"
        radius={radius}
        size="sm"
        title="Choose columns"
        aria-label="Choose columns"
        aria-haspopup="menu"
        aria-expanded={Boolean(anchor)}
        onClick={event => {
          const trigger = event.currentTarget
          setAnchor(current => (current ? null : trigger))
        }}
      >
        <span aria-hidden="true" style={{ fontSize: 13, lineHeight: 1 }}>{COLUMNS_GLYPH}</span>
      </CornerTab>
      {anchor ? (
        <ColumnsMenu anchorElement={anchor} columns={columns} onSetHidden={onSetHidden} onClose={() => setAnchor(null)} />
      ) : null}
    </div>
  )
}
