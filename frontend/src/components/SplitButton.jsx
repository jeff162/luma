// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * A button with a caret beside it: the body does the common thing, the caret opens a small menu of the
 * alternatives. The two halves are `Button`s joined edge to edge, so the control takes the same sizes,
 * variants, `pressed` state and label centring as every other button.
 *
 * The caret leads. On a touch screen a caret on the trailing edge sits against whatever follows the
 * control in its toolbar, and a tap that misses it lands there instead; leading, it has the body on one
 * side and the toolbar's gap on the other.
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
      {split ? (
        <Button
          size={size}
          variant={variant}
          aria-label={menuLabel}
          title={menuLabel}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={toggle}
          style={{
            borderTopRightRadius: 0, borderBottomRightRadius: 0,
            paddingLeft: 8, paddingRight: 8, fontSize: 9,
          }}
        >
          ▾
        </Button>
      ) : null}
      <Button
        size={size}
        variant={variant}
        pressed={pressed}
        title={title}
        onClick={split ? onClick : toggle}
        aria-haspopup={split ? undefined : 'menu'}
        aria-expanded={split ? undefined : open}
        // The two halves share their middle border, so the body steps back over the caret's edge.
        style={split ? { marginLeft: -1, borderTopLeftRadius: 0, borderBottomLeftRadius: 0 } : undefined}
      >
        {children}
      </Button>
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
