// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * A button with a caret beside it: the body does the common thing, the caret opens a small menu of the
 * alternatives. The two halves are `Button`s joined edge to edge, so the control takes the same sizes,
 * variants, `pressed` state and label centring as every other button.
 *
 * - Without `onClick` there is nothing for the body to do yet, so the control is a single button that
 *   opens the menu (the attribute filter before anything is picked).
 * - The menu's frame, its placement under the control and its dismissal live here; its rows are the
 *   caller's, through `renderMenu(close)`, since each caller's rows are a different kind of choice.
 */

import { useRef, useState } from 'react'
import { useDismissibleLayer } from '../lib/uiInteractions.js'
import { Button, getFloatingPanelSurfaceStyle } from './ui.jsx'

export default function SplitButton({
  children, onClick, pressed, title, menuLabel, renderMenu, menuMinWidth = 160,
  size = 'compact', variant = 'secondary',
}) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef(null)
  useDismissibleLayer({ open, onClose: () => setOpen(false), refs: [wrapRef] })
  const close = () => setOpen(false)
  const toggle = () => setOpen(value => !value)
  const split = typeof onClick === 'function'

  return (
    <span ref={wrapRef} style={{ position: 'relative', display: 'inline-flex', alignItems: 'stretch' }}>
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
        <div
          role="menu"
          aria-label={menuLabel}
          style={{
            ...getFloatingPanelSurfaceStyle({ radius: 8 }),
            position: 'absolute', top: 'calc(100% + 4px)', right: 0, zIndex: 300,
            padding: 4, minWidth: menuMinWidth, maxHeight: 320, overflowY: 'auto',
          }}
        >
          {renderMenu(close)}
        </div>
      ) : null}
    </span>
  )
}
