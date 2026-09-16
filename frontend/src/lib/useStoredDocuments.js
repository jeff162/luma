// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useState } from 'react'
import { api } from './api.js'

/*
 * The stored documents — those waiting for a transaction — for a surface that shows them or their count.
 *
 * Refetched on the api layer's `luma:data-mutated` signal rather than invalidated by hand, because the set
 * changes from surfaces that do not know about each other: attaching from a transaction's panel empties an
 * entry the Transactions page is counting, and a restore or a demo clear can change it wholesale. The read is
 * one indexed query over a short list, which is the price that signal asks for. A surface that has just
 * changed the set itself calls `reload` so it does not wait out the signal's debounce.
 *
 * Mounted once per panel or page, never per row.
 */
export function useStoredDocuments() {
  // null until the first answer, so a count is not rendered as "0" before anything is known.
  const [documents, setDocuments] = useState(null)

  const reload = useCallback(async () => {
    try {
      const result = await api.getStoredDocuments()
      setDocuments(result.documents || [])
    } catch {
      setDocuments(prev => prev ?? [])
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    api.getStoredDocuments()
      .then(result => { if (!cancelled) setDocuments(result.documents || []) })
      .catch(() => { if (!cancelled) setDocuments(prev => prev ?? []) })
    window.addEventListener('luma:data-mutated', reload)
    return () => {
      cancelled = true
      window.removeEventListener('luma:data-mutated', reload)
    }
  }, [reload])

  return { documents, reload }
}
