// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// The update-check state behind Settings -> About (`components/UpdateCheck.jsx`): what the server last
// learned, plus the two things an administrator can do about it.

import { useEffect, useState } from 'react'
import { api } from './api.js'

export function useUpdateCheck() {
  const [status, setStatus] = useState(null)
  const [checking, setChecking] = useState(false)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState('')

  useEffect(() => {
    let cancelled = false
    api.getUpdateCheck()
      .then(result => { if (!cancelled) setStatus(result) })
      .catch(() => { })
    return () => { cancelled = true }
  }, [])

  async function setEnabled(enabled) {
    setSaving(true)
    setNotice('')
    try {
      setStatus(await api.setUpdateCheckEnabled(enabled))
    } catch (err) {
      setNotice(err?.message || 'Could not save the setting.')
    } finally {
      setSaving(false)
    }
  }

  async function checkNow() {
    setChecking(true)
    setNotice('')
    try {
      const result = await api.checkForUpdateNow()
      setStatus(result)
      if (!result.reached) setNotice('The release list could not be reached.')
    } catch (err) {
      setNotice(err?.message || 'The check could not be run.')
    } finally {
      setChecking(false)
    }
  }

  return { status, checking, saving, notice, setEnabled, checkNow }
}
