// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// Reads Settings -> Error log (`components/administration/ErrorLogSection.jsx`). Apart from the section because Settings owns
// the section's title, and the refresh sits beside the title of what it reloads.

import { useCallback, useEffect, useState } from 'react'
import { api } from './api.js'

// `enabled` is whether the section is open: it reads each time the section opens, as it did while the
// section owned its own state and remounted on every open.
export function useErrorLog(enabled) {
  const [log, setLog] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const result = await api.getErrorLog()
      setLog(result)
      setError('')
      // Having been shown is what acknowledging means, so it is done here rather than on a button. Through the
      // count read with these entries, not the latest: an error logged since stays unseen.
      if (result?.unacknowledged > 0) api.acknowledgeErrorLog(result.recorded).catch(() => { })
    } catch (err) {
      setError(err?.message || 'The error log could not be read.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (enabled) load()
  }, [enabled, load])

  return { log, error, loading, load }
}
