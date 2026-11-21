// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { ActionMenu } from './ActionMenu.jsx'

/*
 * The menu that chooses which of a table's columns are shown: one on/off item per column, in the table's
 * order, staying open so several can be set in one visit. The last shown column cannot be hidden, since a
 * table with none has nothing to show it by. The layout it edits is a hideable one
 * (`lib/columnVisibility.js`); the host opens it from its own trigger, the gear.
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
export const COLUMNS_GLYPH = '⚙︎'
