// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * Settings -> New transactions: whether an imported or synced transaction arrives flagged for review
 * (`backend/services/review_flagging.py`).
 *
 * - The setting belongs to the ledger, not to whoever is looking, so it is read from and written to the
 *   server rather than kept as a user preference.
 * - Nothing is rendered until the value has been read. A switch drawn at an assumed position and then
 *   corrected would show, for a moment, a setting the ledger does not have.
 */

import { useEffect, useState } from 'react'
import { api } from '../../lib/api.js'
import { Toggle } from '../ui.jsx'

export default function ReviewFlaggingSection() {
  const [enabled, setEnabled] = useState(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    api.getReviewFlagging()
      .then(result => { if (!cancelled) setEnabled(!!result.enabled) })
      .catch(err => { if (!cancelled) setError(err?.message || 'Could not read the setting.') })
    return () => { cancelled = true }
  }, [])

  async function save(next) {
    setSaving(true)
    setError('')
    try {
      const result = await api.setReviewFlagging(next)
      setEnabled(!!result.enabled)
    } catch (err) {
      setError(err?.message || 'Could not save the setting.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ display: 'grid', gap: 8 }}>
      {enabled !== null ? (
        <Toggle
          checked={enabled}
          onChange={save}
          disabled={saving}
          label="Flag new transactions for review"
        />
      ) : null}
      {error ? <div role="alert" style={{ fontSize: 12, color: 'var(--danger)' }}>{error}</div> : null}
    </div>
  )
}
