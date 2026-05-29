// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect, useState, useCallback } from 'react'
import { useLocation } from 'react-router-dom'
import { api } from '../lib/api.js'
import { notifyAccountsChanged } from '../App.jsx'
import { formatCurrency, formatDate } from '../lib/utils.js'
import { Button, Card, EmptyState, PageHeader, Spinner } from '../components/ui.jsx'

/*
 * Review surface for transactions flagged as soft-duplicates of an existing row on a different
 * account. Each pair renders side-by-side; the action buttons resolve the suspect — either
 * "Mark accounts distinct" (the broad reading of Keep: clears the flag here AND on every
 * other suspect between the same two accounts, and records the pair so future imports skip
 * the check) or "Trash this one" (the suspect row is confirmed as a duplicate and moves to
 * trash). Optionally accepts a `?batch=<id>` query string to scope the report to one import
 * batch, which the import-card link uses.
 *
 * Two sub-surfaces coexist:
 *   - The pair-by-pair review list (always shown when there are unresolved suspects).
 *   - The `DistinctPairsManager` (only shown in the global, non-batch-scoped view) — lists
 *     every `account_pair_distinct` assertion the user has previously recorded via Keep, with
 *     a Forget button that re-enables cross-account detection between that pair on the next
 *     import. This is the escape hatch for "I marked these distinct by mistake."
 */

function reasonLabel(reason) {
  if (reason === 'cross_account') return 'Cross-account match'
  // Legacy reasons retained so labels still render for any pre-migration rows that may exist.
  if (reason === 'import_new_account') return 'Cross-account match'
  if (reason === 'account_merge') return 'Cross-account match'
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

function accountDisplay(name, displayName, mask) {
  const base = displayName || name || '—'
  return mask ? `${base} (…${mask})` : base
}

function DistinctPairsManager({ batchId }) {
  // The page is global (batchId == null) when the user gets here from the nav; only show the
  // manager in that mode. When scoped to a single batch the pairs list could be confusing
  // because it's not batch-scoped — these assertions span the whole database.
  const [pairs, setPairs] = useState([])
  const [loading, setLoading] = useState(false)
  const [working, setWorking] = useState('')
  const [error, setError] = useState('')
  const [expanded, setExpanded] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const resp = await api.getDistinctAccountPairs()
      setPairs(Array.isArray(resp?.pairs) ? resp.pairs : [])
      setError('')
    } catch (err) {
      setError(err.message || 'Failed to load distinct account pairs')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { if (!batchId) load() }, [batchId, load])

  async function handleForget(pair) {
    const key = `${pair.account_id_low}:${pair.account_id_high}`
    setWorking(key)
    setError('')
    try {
      await api.forgetDistinctAccountPair(pair.account_id_low, pair.account_id_high)
      setPairs(prev => prev.filter(p =>
        !(p.account_id_low === pair.account_id_low && p.account_id_high === pair.account_id_high)
      ))
      notifyAccountsChanged()
    } catch (err) {
      setError(err.message || 'Failed to forget pair')
    } finally {
      setWorking('')
    }
  }

  if (batchId) return null

  return (
    <Card style={{ display: 'grid', gap: 10, marginTop: 18, maxWidth: 1100 }}>
      <button
        type="button"
        onClick={() => setExpanded(v => !v)}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', color: 'inherit',
          textAlign: 'left',
        }}
      >
        <div style={{ display: 'grid', gap: 2 }}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>Account pairs marked distinct</div>
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>
            Pairs you've declared distinct — imports skip the cross-account check for these.
            Forget a pair to re-enable detection between the two accounts.
          </div>
        </div>
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>
          {loading ? '…' : `${pairs.length}`} {expanded ? '−' : '+'}
        </span>
      </button>
      {expanded ? (
        loading ? <Spinner /> : pairs.length === 0 ? (
          <EmptyState message="No distinct-account assertions recorded yet." />
        ) : (
          <div style={{ display: 'grid', gap: 6 }}>
            {pairs.map(pair => {
              const key = `${pair.account_id_low}:${pair.account_id_high}`
              return (
                <div
                  key={key}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
                    padding: '8px 12px', border: '1px solid var(--border)', borderRadius: 8,
                    background: 'var(--surface2)',
                  }}
                >
                  <div style={{ display: 'grid', gap: 2 }}>
                    <div style={{ fontSize: 13 }}>
                      {accountDisplay(pair.account_low_name, pair.account_low_display_name, pair.account_low_mask)}
                      <span style={{ color: 'var(--muted)' }}> ↔ </span>
                      {accountDisplay(pair.account_high_name, pair.account_high_display_name, pair.account_high_mask)}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                      Asserted {formatDate(pair.asserted_at)}
                    </div>
                  </div>
                  <Button
                    small
                    variant="ghost"
                    disabled={working === key}
                    onClick={() => handleForget(pair)}
                    title="Forgets the assertion. Future imports between these two accounts will re-evaluate cross-account matches and may surface fresh suspects."
                  >
                    {working === key ? 'Forgetting…' : 'Forget'}
                  </Button>
                </div>
              )
            })}
          </div>
        )
      ) : null}
      {error ? (
        <div style={{ fontSize: 12, color: 'var(--danger)' }}>{error}</div>
      ) : null}
    </Card>
  )
}

export default function SuspectDuplicates() {
  const location = useLocation()
  const batchId = new URLSearchParams(location.search).get('batch') || null

  const [pairs, setPairs] = useState([])
  const [loading, setLoading] = useState(true)
  const [working, setWorking] = useState('')
  const [error, setError] = useState('')
  const [distinctVersion, setDistinctVersion] = useState(0)

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
      if (action === 'keep') {
        // Cascade: server-side a keep may resolve more than just this row. Refetch so the list
        // matches reality (don't trust client-side filtering for the cascade case).
        await load()
        setDistinctVersion(v => v + 1)
      } else {
        setPairs(prev => prev.filter(p => p.new_id !== txnId))
      }
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
    setDistinctVersion(v => v + 1)
  }

  return (
    <div data-browser-context-passthrough="true" style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ padding: '32px 32px 0', flexShrink: 0 }}>
        <PageHeader title="Possible duplicate transactions">
          {pairs.length > 0 ? (
            <Button small variant="ghost" onClick={handleKeepAll}>
              Mark all accounts distinct
            </Button>
          ) : null}
        </PageHeader>
        <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: -8, maxWidth: 720 }}>
          Each row matches a transaction on a different account. Trash the flagged copy if you
          imported the same activity twice. Mark accounts distinct if the two accounts genuinely
          have separate transactions that happen to share a date, amount, and payee — that
          decision is remembered, clears every other flagged row between the same two accounts,
          and stops future imports from re-flagging the pair.
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
                    title="Records the two accounts as distinct, clears every other flagged row between this same pair, and stops future imports from re-flagging the pair."
                  >
                    {working === `${pair.new_id}:keep` ? 'Marking…' : 'Mark accounts distinct'}
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
        <DistinctPairsManager key={distinctVersion} batchId={batchId} />
      </div>
    </div>
  )
}
