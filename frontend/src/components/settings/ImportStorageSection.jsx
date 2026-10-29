// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from 'react'
import { Button } from '../ui.jsx'
import { formatBytes, formatShare } from '../../lib/storageFormat.js'
import { ImportDetailStorageDialog } from '../importExport/ImportDetailStorageDialog.jsx'

// Here rather than on Import because it is housekeeping over what imports left behind, not a
// step of importing: what remains in those records after migration v72 is small and wanted, and clearing
// it is an occasional choice rather than part of the work the import history exists for.
//
// `storage` is the page's summary of what is held, shown beside the button so the choice to open the
// screen at all can be made on how much there is to gain.
export default function ImportStorageSection({ storage = null, onChanged }) {
  const [open, setOpen] = useState(false)
  const bytes = storage?.import_detail?.bytes || 0
  const share = formatShare(bytes, storage?.database_bytes)
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <Button variant="secondary" size="compact" onClick={() => setOpen(true)}>Free up import space</Button>
        {storage ? (
          <span style={{ fontSize: 13, color: 'var(--muted)' }}>
            {bytes
              ? `${formatBytes(bytes)} of a ${formatBytes(storage.database_bytes)} database${share ? ` (${share})` : ''}`
              : 'Nothing stored'}
          </span>
        ) : null}
      </div>
      {open ? <ImportDetailStorageDialog onClose={() => setOpen(false)} onChanged={onChanged} /> : null}
    </>
  )
}
