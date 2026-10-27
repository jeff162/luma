// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { LinkButton } from '../ui.jsx'
import { useAnchoredPopup } from '../../lib/anchoredPopup.js'
import { useDismissibleLayer } from '../../lib/uiInteractions.js'

/*
 * The "N imported files" count of a multi-file review, opening a list of those files. Choosing one calls
 * `onOpenFile` with its batch, which the page passes to `useBatchDetailPanels` to open that file's
 * transactions. Portaled because the count sits inside the page's scroll container.
 */
export default function ImportedFilesPopover({ files, label, describeFile, onOpenFile }) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef(null)
  const popoverRef = useRef(null)
  const close = () => setOpen(false)

  useDismissibleLayer({ open, onClose: close, refs: [popoverRef, triggerRef] })
  const { popupStyle, contentRef } = useAnchoredPopup({ open, anchorRef: triggerRef, minWidth: 260 })

  return (
    <>
      <LinkButton
        ref={triggerRef}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={!files.length}
        onClick={() => setOpen(value => !value)}
      >
        {label} ▾
      </LinkButton>
      {open && createPortal(
        <div
          ref={popoverRef}
          role="menu"
          style={{
            ...popupStyle,
            zIndex: 1400,
            maxWidth: 'min(480px, calc(100vw - 16px))',
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            padding: 4,
            boxShadow: '0 12px 36px rgba(15, 23, 42, 0.32)',
          }}
        >
          <div ref={contentRef}>
            {files.map(file => (
              <button
                key={file.id}
                type="button"
                role="menuitem"
                onClick={() => { close(); onOpenFile(file) }}
                style={{
                  display: 'block', width: '100%', textAlign: 'left',
                  background: 'none', border: 'none', padding: '6px 10px',
                  borderRadius: 6, cursor: 'pointer', color: 'var(--text)',
                }}
                onMouseEnter={e => { e.currentTarget.style.background = 'var(--surface2)' }}
                onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
              >
                <div style={{ fontSize: 13, overflowWrap: 'anywhere' }}>
                  {file.filename || 'Import'}
                  <span aria-hidden="true" style={{ marginLeft: 6, color: 'var(--accent2)' }}>↗</span>
                </div>
                <div style={{ fontSize: 12, color: 'var(--muted)' }}>{describeFile(file)}</div>
              </button>
            ))}
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}
