// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * The owner lens's control (`lib/ownerLens.js`): a tab folded into the top-right corner of the page area,
 * drawn once by the app shell for every scoped page. Most people set the view once and leave it, so the tab
 * is quiet and folds down to the switch and the menu's ▾, collapsing toward the edge as the navigation pane
 * does. It tints while the view is narrowing, so a narrowed page is plain at a glance, and its hover says
 * who is included. It sits under floating panels, which open over the page.
 */

import { useLayoutEffect, useRef, useState } from 'react'
import { useOwnerLens } from '../lib/OwnerLensContext.jsx'
import { UNASSIGNED_OWNER_ID } from '../lib/ownerLens.js'
import { useAnchoredPopup } from '../lib/anchoredPopup.js'
import { useDismissibleLayer } from '../lib/uiInteractions.js'
import { useDeviceLayoutPreference } from '../lib/UserPreferencesContext.jsx'
import { ownerChipLabels } from './OwnerChip.jsx'
import { FloatingPanel, Toggle, Tooltip } from './ui.jsx'

const UNASSIGNED_LABEL = 'Unassigned'

const COLLAPSED_PREF_KEY = 'ui.ownerLensTab.collapsed'

// The custom property the tab sets on its host to its own width while it is shown, so the FilterBar under
// it can keep its right end clear of the tab.
export const OWNER_LENS_TAB_WIDTH_VAR = '--owner-lens-tab-width'

const checkRowStyle = checked => ({
  display: 'flex', alignItems: 'center', gap: 8, padding: '4px 8px', borderRadius: 6,
  cursor: 'pointer', fontSize: 13,
  background: checked ? 'color-mix(in srgb, var(--accent) 16%, var(--surface2))' : 'transparent',
})

const glyphButtonStyle = {
  display: 'inline-flex', alignItems: 'center', gap: 4, background: 'none', border: 'none',
  padding: '0 4px', font: 'inherit', color: 'inherit', cursor: 'pointer',
}

function Swatch({ color }) {
  return (
    <span aria-hidden="true" style={{
      width: 8, height: 8, borderRadius: 999, flexShrink: 0, boxSizing: 'border-box',
      background: color || 'transparent', border: color ? 'none' : '1px solid var(--muted)',
    }} />
  )
}

function LensPopover({ anchorRef, onClose }) {
  const { owners, on, ownerIds, lens, setOwnerIds } = useOwnerLens()
  const ref = useRef(null)
  useDismissibleLayer({ open: true, onClose, refs: [ref, anchorRef] })
  const { popupStyle, contentRef } = useAnchoredPopup({ open: true, anchorRef, align: 'end', gap: 6, minWidth: 240 })
  const rows = [...owners.map(owner => ({ id: owner.id, label: owner.name, color: owner.color })),
  { id: UNASSIGNED_OWNER_ID, label: UNASSIGNED_LABEL, color: null }]
  const toggle = id => setOwnerIds(ownerIds.includes(id) ? ownerIds.filter(x => x !== id) : [...ownerIds, id])

  return (
    <FloatingPanel ref={ref} radius={10} style={{ ...popupStyle, zIndex: 300 }}>
      <div ref={contentRef} style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div>
          <div style={{ fontSize: 12, color: 'var(--muted)', margin: '0 0 4px' }}>Owner view shows</div>
          <div role="group" aria-label="Owners the owner view shows" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {rows.map(row => {
              const checked = ownerIds.includes(row.id)
              return (
                <label key={row.id} style={checkRowStyle(checked)}>
                  <input type="checkbox" checked={checked} onChange={() => toggle(row.id)}
                    style={{ accentColor: 'var(--accent)', cursor: 'pointer' }} />
                  <Swatch color={row.color} />
                  <span>{row.label}</span>
                </label>
              )
            })}
          </div>
        </div>
        {on && !lens ? (
          <div style={{ fontSize: 12, color: 'var(--muted)', maxWidth: 240 }}>
            Choose an owner for the view to show.
          </div>
        ) : null}
      </div>
    </FloatingPanel>
  )
}

export default function OwnerLensTab() {
  const { owners, ready, applies: lensApplies, on, ownerIds, lens, setOn } = useOwnerLens()
  // Drawn once the owner list is known, so it never shows for a household that turns out to have one owner.
  const applies = lensApplies && ready
  const [open, setOpen] = useState(false)
  const [collapsed, setCollapsed] = useDeviceLayoutPreference(COLLAPSED_PREF_KEY, false)
  const tabRef = useRef(null)

  useLayoutEffect(() => {
    const tab = tabRef.current
    const host = tab?.parentElement
    if (!tab || !host) return undefined
    const publish = () => host.style.setProperty(OWNER_LENS_TAB_WIDTH_VAR, `${tab.offsetWidth}px`)
    publish()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(publish)
    observer?.observe(tab)
    return () => { observer?.disconnect(); host.style.removeProperty(OWNER_LENS_TAB_WIDTH_VAR) }
  }, [applies])

  if (!applies) return null

  const short = ownerChipLabels(owners)
  // In the menu's order, whatever order the owners were ticked in.
  const names = [...owners.filter(owner => ownerIds.includes(owner.id)).map(owner => short.get(owner.id)),
  ...(ownerIds.includes(UNASSIGNED_OWNER_ID) ? [UNASSIGNED_LABEL] : [])].join(', ')
  const chosen = ownerIds.some(id => id !== UNASSIGNED_OWNER_ID)
  const hint = lens ? `Owner view: ${names}`
    : chosen ? `Owner view is off, so all owners are shown. On shows ${names}.`
      : 'Owner view is off, so all owners are shown. Choose the owners to show from the menu.'

  // Switching on with no owner chosen opens the menu, since the view has no one to show yet.
  function switchTo(next) {
    setOn(next)
    if (next && !chosen) setOpen(true)
  }

  return (
    <div ref={tabRef} style={{
      position: 'absolute', top: 0, right: 0, zIndex: 5,
      display: 'inline-flex', alignItems: 'center', gap: 2, minHeight: 26, padding: '2px 8px 2px 2px',
      boxSizing: 'border-box', fontSize: 12, fontWeight: 500, whiteSpace: 'nowrap',
      borderLeft: '1px solid var(--border)', borderBottom: '1px solid var(--border)', borderBottomLeftRadius: 10,
      background: lens ? 'color-mix(in srgb, var(--accent) 16%, var(--surface2))' : 'var(--surface2)',
      color: lens ? 'var(--accent2)' : 'var(--muted)',
    }}>
      <button
        type="button"
        onClick={() => setCollapsed(v => !v)}
        aria-label={collapsed ? 'Expand owner view' : 'Collapse owner view'}
        aria-expanded={!collapsed}
        title={collapsed ? 'Expand' : 'Collapse'}
        style={{ ...glyphButtonStyle, fontSize: 14 }}
      >
        {collapsed ? '‹' : '›'}
      </button>
      <Tooltip content={hint} align="right" triggerStyle={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        <Toggle checked={on} onChange={switchTo} ariaLabel="Owner view" size="compact" />
        <button
          type="button"
          onClick={() => setOpen(v => !v)}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label="Choose the owners the owner view shows"
          style={glyphButtonStyle}
        >
          {collapsed ? null : 'Owner view'}
          <span aria-hidden="true" style={{ fontSize: 10, opacity: 0.8 }}>▾</span>
        </button>
      </Tooltip>
      {open ? <LensPopover anchorRef={tabRef} onClose={() => setOpen(false)} /> : null}
    </div>
  )
}
