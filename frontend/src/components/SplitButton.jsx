// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * A button with a caret beside it: the body does the common thing, the caret opens a small menu of the
 * alternatives. The two halves are `Button`s joined edge to edge, so the control takes the same sizes,
 * variants, `pressed` state and label centring as every other button.
 *
 * - Without `onClick` there is nothing for the body to do yet, so the control is a single button that
 *   opens the menu (the attribute filter before anything is picked).
 * - The menu is the shared `ActionMenu`, anchored under the whole control; `menuItems` are its items.
 */

import { useRef, useState } from 'react'
import { ActionMenu } from './ActionMenu.jsx'
import { Button } from './ui.jsx'

export default function SplitButton({
  children, onClick, pressed, title, menuLabel, menuItems, menuMinWidth = 160,
  size = 'compact', variant = 'secondary',
}) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef(null)
  const toggle = () => setOpen(value => !value)
  const split = typeof onClick === 'function'

  return (
    <span ref={wrapRef} style={{ display: 'inline-flex', alignItems: 'stretch' }}>
      <Button
        size={size}
        variant={variant}
        pressed={pressed}
        title={title}
        onClick={split ? onClick : toggle}
        aria-haspopup={split ? undefined : 'menu'}
        aria-expanded={split ? undefined : open}
        style={split ? { borderTopRightRadius: 0, borderBottomRightRadius: 0 } : undefined}
      >
        {children}
      </Button>
      {split ? (
        <Button
          size={size}
          variant={variant}
          aria-label={menuLabel}
          title={menuLabel}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={toggle}
          // The two halves share their middle border, so the caret steps back over the body's edge.
          style={{
            marginLeft: -1, borderTopLeftRadius: 0, borderBottomLeftRadius: 0,
            paddingLeft: 6, paddingRight: 6, fontSize: 9,
          }}
        >
          ▾
        </Button>
      ) : null}
      {open ? (
        <ActionMenu
          anchorElement={wrapRef.current}
          label={menuLabel}
          minWidth={menuMinWidth}
          onClose={() => setOpen(false)}
          items={menuItems}
        />
      ) : null}
    </span>
  )
}
