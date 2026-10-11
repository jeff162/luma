// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from 'react'
import { Button } from '../ui.jsx'
import { ImportDetailStorageDialog } from '../importExport/ImportDetailStorageDialog.jsx'

// Here rather than on Import / Export because it is housekeeping over what imports left behind, not a
// step of importing: what remains in those records after migration v72 is small and wanted, and clearing
// it is an occasional choice rather than part of the work the import history exists for.
export default function ImportStorageSection() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button small variant="ghost" onClick={() => setOpen(true)}>Free up import space</Button>
      {open ? <ImportDetailStorageDialog onClose={() => setOpen(false)} /> : null}
    </>
  )
}
