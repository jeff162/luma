// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../../lib/api.js'
import { Card } from '../ui.jsx'
import { StatusPill } from '../connections/ConnectionStatus.jsx'

// Settings -> Security checklist: the installation set against the documented best practices, one row
// each. Which practices apply, and whether each is met, is the server's to say
// (`backend/services/security_checklist.py`); this only lays the answer out.
const STATUS = {
  met: { tone: 'accent2', label: 'Met' },
  not_met: { tone: 'warning', label: 'Not met' },
  unknown: { tone: 'muted', label: 'Unknown' },
}

export default function SecurityChecklistSection() {
  const [items, setItems] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    api.getSecurityChecklist()
      .then(result => { if (!cancelled) setItems(result.items || []) })
      .catch(err => { if (!cancelled) setError(err.message || 'Could not read the security checklist') })
    return () => { cancelled = true }
  }, [])

  if (error) return <Card style={{ padding: 20, color: 'var(--danger)', fontSize: 13 }}>{error}</Card>
  if (!items) return null

  return (
    <Card style={{ padding: 0 }}>
      {items.map((item, index) => {
        const status = STATUS[item.status] || STATUS.unknown
        return (
          <div
            key={item.id}
            style={{
              padding: '14px 20px',
              display: 'grid',
              gap: 6,
              borderTop: index ? '1px solid var(--border)' : 'none',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <StatusPill tone={status.tone}>{status.label}</StatusPill>
              <span style={{ fontSize: 13, fontWeight: 600 }}>{item.title}</span>
            </div>
            <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.55 }}>
              {item.detail}
              {item.link && item.status !== 'met' ? (
                <>
                  {' '}
                  <Link to={item.link} style={{ color: 'var(--accent2)' }}>{item.link_label}</Link>
                </>
              ) : null}
            </div>
          </div>
        )
      })}
    </Card>
  )
}
