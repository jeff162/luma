// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useState } from 'react'
import { api } from './api.js'
import { reimbursementListedCount } from './reimbursements.js'

/*
 * How many entries the reimbursements report lists, for the button that opens it.
 *
 * Refetched on `luma:data-mutated`, as `useStoredDocuments` is, because the set changes from surfaces
 * that do not know about this one: recategorizing a row into or out of the Reimbursable group, pairing
 * in the dialog, completing from a transaction's panel. The outstanding report is already run at that
 * cadence for the Tasks reminders, and costs a few small lookups where reimbursements are not used
 * (`docs/scale-and-limits.md` → *The Tasks list is recomputed on every mutation*).
 *
 * Mounted once per page, never per row.
 */
export function useReimbursementCount() {
  // null until the first answer, so a count is not rendered as "0" before anything is known.
  const [count, setCount] = useState(null)

  const reload = useCallback(async () => {
    try {
      setCount(reimbursementListedCount(await api.getOutstandingReimbursements()))
    } catch {
      setCount(prev => prev ?? 0)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    api.getOutstandingReimbursements()
      .then(report => { if (!cancelled) setCount(reimbursementListedCount(report)) })
      .catch(() => { if (!cancelled) setCount(prev => prev ?? 0) })
    window.addEventListener('luma:data-mutated', reload)
    return () => {
      cancelled = true
      window.removeEventListener('luma:data-mutated', reload)
    }
  }, [reload])

  return { count, reload }
}
