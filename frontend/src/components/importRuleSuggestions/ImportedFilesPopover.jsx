// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useRef, useState } from 'react'
import { LinkButton } from '../ui.jsx'
import { ActionMenu } from '../ActionMenu.jsx'

/*
 * The "N imported files" count of a multi-file review, opening a list of those files. Choosing one calls
 * `onOpenFile` with its batch, which the page passes to `useBatchDetailPanels` to open that file's
 * transactions.
 */
export default function ImportedFilesPopover({ files, label, describeFile, onOpenFile }) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef(null)

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
      {open ? (
        <ActionMenu
          anchorElement={triggerRef.current}
          align="start"
          minWidth={260}
          label="Imported files"
          onClose={() => setOpen(false)}
          items={files.map(file => ({
            key: file.id,
            label: (
              <>
                {file.filename || 'Import'}
                <span aria-hidden="true" style={{ marginLeft: 6, color: 'var(--accent2)' }}>↗</span>
              </>
            ),
            description: describeFile(file),
            onClick: () => onOpenFile(file),
          }))}
        />
      ) : null}
    </>
  )
}
