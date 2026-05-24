// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect, useState, useCallback } from 'react'
import { useLocation } from 'react-router-dom'
import { api } from '../lib/api.js'
import { formatCurrency, formatDate } from '../lib/utils.js'
import { Button, Card, EmptyState, PageHeader, Spinner } from '../components/ui.jsx'

/*
 * Review surface for transactions flagged as soft-duplicates of an existing row on a different
 * account. Each pair renders side-by-side; the action buttons resolve the suspect (either
 * "keep" — flag clears, both rows stay — or "trash" — the suspect row is sent to the trash).
 * Optionally accepts a `?batch=<id>` query string to scope the report to one import batch,
 * which the import-card link uses.
 */

function reasonLabel(reason) {
  if (reason === 'import_new_account') return 'Detected at import (new account)'
  if (reason === 'account_merge') return 'Detected after account merge'
  return 'Possible duplicate'
}

function PairSide({ side, row, onAction, working, disabled }) {
  const amountColor = (Number(row[`${side}_amount`]) || 0) < 0 ? 'var(--success)' : 'var(--text)'
  const account = row[`${side}_account_display_name`] || row[`${side}_account_name`] || '—'
  const category = row[`${side}_category_name`] || 'Uncategorized'
  const txnId = row[`${side}_id`]
  const canTrash = side === 'new'
  return (
    <div style={{
      display: 'grid', gap: 6,
      padding: 14,
      border: '1px solid var(--border)', borderRadius: 10,
      background: 'var(--surface2)',
    }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
        {side === 'new' ? 'New (flagged)' : 'Existing'}
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 14, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {row[`${side}_payee`] || '—'}
        </div>
        <div style={{ fontSize: 14, fontWeight: 600, color: amountColor }}>
          {formatCurrency(row[`${side}_amount`])}
        </div>
      </div>
      <div style={{ fontSize: 12, color: 'var(--muted)' }}>
        {formatDate(row[`${side}_date`])} · {account} · {category}
      </div>
      <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
        {canTrash ? (
          <Button
            small
            variant="danger"
            disabled={disabled}
            onClick={() => onAction(txnId, 'trash')}
          >
            {working === txnId + ':trash' ? 'Trashing…' : 'Trash this one'}
          </Button>
        ) : null}
      </div>
    </div>
  )
}

export default function SuspectDuplicates() {
  const location = useLocation()
  const batchId = new URLSearchParams(location.search).get('batch') || null

  const [pairs, setPairs] = useState([])
  const [loading, setLoading] = useState(true)
  const [working, setWorking] = useState('')
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const resp = await api.getSuspectDuplicates(batchId ? { batchId } : {})
      setPairs(Array.isArray(resp?.pairs) ? resp.pairs : [])
      setError('')
    } catch (err) {
      setError(err.message || 'Failed to load suspect duplicates')
    } finally {
      setLoading(false)
    }
  }, [batchId])

  useEffect(() => { load() }, [load])

  async function handleAction(txnId, action) {
    setWorking(`${txnId}:${action}`)
    setError('')
    try {
      await api.resolveSuspectDuplicate(txnId, action)
      setPairs(prev => prev.filter(p => p.new_id !== txnId))
    } catch (err) {
      setError(err.message || 'Failed to resolve duplicate')
    } finally {
      setWorking('')
    }
  }

  async function handleKeepAll() {
    setError('')
    for (const pair of pairs) {
      try {
        await api.resolveSuspectDuplicate(pair.new_id, 'keep')
      } catch (err) {
        setError(err.message || 'Failed to keep all')
        break
      }
    }
    await load()
  }

  return (
    <div data-browser-context-passthrough="true" style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ padding: '32px 32px 0', flexShrink: 0 }}>
        <PageHeader title="Possible duplicate transactions">
          {pairs.length > 0 ? (
            <Button small variant="ghost" onClick={handleKeepAll}>
              Keep all
            </Button>
          ) : null}
        </PageHeader>
        <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: -8, maxWidth: 720 }}>
          Each row was detected as a possible duplicate of another transaction on a different account.
          Trash the flagged copy if you imported the same activity twice, or Keep to dismiss the warning.
          {batchId ? ' Filtered to one import batch.' : ''}
        </div>
      </div>
      <div data-browser-context-passthrough="true" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '20px 32px 32px' }}>
        {loading ? <Spinner /> : pairs.length === 0 ? (
          <EmptyState message="No suspect duplicates to review." />
        ) : (
          <div style={{ display: 'grid', gap: 14, maxWidth: 1100 }}>
            {pairs.map(pair => (
              <Card key={pair.new_id} style={{ display: 'grid', gap: 12 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                  <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                    {reasonLabel(pair.reason)}
                  </div>
                  <Button
                    small
                    variant="ghost"
                    disabled={working === `${pair.new_id}:keep`}
                    onClick={() => handleAction(pair.new_id, 'keep')}
                  >
                    {working === `${pair.new_id}:keep` ? 'Keeping…' : 'Keep both'}
                  </Button>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <PairSide
                    side="new"
                    row={pair}
                    onAction={handleAction}
                    working={working}
                    disabled={Boolean(working)}
                  />
                  <PairSide
                    side="existing"
                    row={pair}
                    onAction={handleAction}
                    working={working}
                    disabled={Boolean(working)}
                  />
                </div>
              </Card>
            ))}
          </div>
        )}
        {error ? (
          <div style={{ fontSize: 12, color: 'var(--danger)', marginTop: 12 }}>{error}</div>
        ) : null}
      </div>
    </div>
  )
}
