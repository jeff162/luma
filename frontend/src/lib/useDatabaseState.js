// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// Reads Settings -> Database (`components/administration/DatabaseSection.jsx`). Apart from the section
// because the page owns the section's title, and the refresh sits beside the title of what it reloads.
// The backup history comes with it, so a failed check can name the newest backup that passed.

import { useCallback, useEffect, useState } from 'react'
import { api } from './api.js'

// `enabled` is whether the section is open: it reads each time the section opens.
export function useDatabaseState(enabled) {
  const [state, setState] = useState(null)
  const [backups, setBackups] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [result, history] = await Promise.all([
        api.getDatabaseState(),
        api.getBackupHistory().catch(() => null),
      ])
      setState(result)
      setBackups(history?.backups ?? null)
      setError('')
    } catch (err) {
      setError(err?.message || 'The databases could not be read.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (enabled) load()
  }, [enabled, load])

  return { state, setState, backups, error, loading, load }
}
