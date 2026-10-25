// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState, useEffect, useCallback } from 'react'
import { api } from '../../lib/api.js'
import { Card, Button, Spinner, EmptyState } from '../ui.jsx'
import { formatCurrency, formatDate } from '../../lib/utils.js'
import { notifyAccountsChanged } from '../../App.jsx'

/*
 * Transaction pairs the user judged "not the same charge" by clicking Keep on a flagged duplicate.
 *
 * Here for the same reason its account-level neighbour below is: the judgement is durable, it suppresses
 * detection for that pair from then on, and it can only have been made in passing — so it has to be
 * inspectable somewhere. The toast on Keep is the immediate escape hatch; this is the one for a decision
 * regretted later.
 *
 * Reopening is not destructive: it lifts the judgement *and* restores the finding, so the pair returns to
 * the duplicate report exactly as it was rather than waiting for some later scan to notice it again.
 */
export function DismissedDuplicatePairsSection() {
  const [pairs, setPairs] = useState([])
  const [loading, setLoading] = useState(true)
  const [workingKey, setWorkingKey] = useState('')
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const resp = await api.getDismissedDuplicatePairs()
      setPairs(resp.pairs || [])
      setError('')
    } catch (err) {
      setError(err.message || 'Failed to load dismissed pairs')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  async function reopen(pair) {
    const key = `${pair.txn_id_low}:${pair.txn_id_high}`
    setWorkingKey(key)
    setError('')
    try {
      await api.reopenDuplicatePairs([[pair.txn_id_low, pair.txn_id_high]])
      await load()
    } catch (err) {
      setError(err.message || 'Failed to reopen the pair')
    } finally {
      setWorkingKey('')
    }
  }

  const side = (name, date, amount, account) => (
    <div style={{ fontSize: 13, minWidth: 0 }}>
      <span style={{ fontWeight: 600 }}>{name || 'Transaction'}</span>
      <span style={{ color: 'var(--muted)' }}>
        {' · '}{formatDate(String(date || '').slice(0, 10))}
        {' · '}{formatCurrency(amount)}
        {account ? ` · ${account}` : ''}
      </span>
    </div>
  )

  return (
    <Card style={{ display: 'grid', gap: 14 }}>
      <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.6, maxWidth: 620 }}>
        Pairs you have said are two different charges rather than one recorded twice. Neither a later
        import nor a re-scan flags them again. Reopening one brings the finding back so it can be
        decided differently.
      </div>
      {error ? <div style={{ fontSize: 13, color: 'var(--danger)' }}>{error}</div> : null}
      {loading && pairs.length === 0 ? <Spinner /> : pairs.length === 0 ? (
        <EmptyState message="No duplicate pairs have been dismissed." />
      ) : (
        <div style={{ border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
          {pairs.map((pair, index) => {
            const key = `${pair.txn_id_low}:${pair.txn_id_high}`
            return (
              <div
                key={key}
                style={{
                  display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 16,
                  alignItems: 'center', padding: '12px 14px',
                  borderTop: index === 0 ? 'none' : '1px solid var(--border)',
                  background: 'var(--surface2)',
                }}
              >
                <div style={{ minWidth: 0 }}>
                  {side(pair.low_name, pair.low_date, pair.low_amount, pair.low_account)}
                  {side(pair.high_name, pair.high_date, pair.high_amount, pair.high_account)}
                  <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
                    Dismissed {formatDate(String(pair.asserted_at || '').slice(0, 10)) || 'recently'}
                    {pair.flagged_txn_id ? '' : ' · reopening can only lift the judgement, not restore the finding'}
                  </div>
                </div>
                <Button variant="secondary" disabled={!!workingKey} onClick={() => reopen(pair)}>
                  {workingKey === key ? 'Reopening…' : 'Reopen'}
                </Button>
              </div>
            )
          })}
        </div>
      )}
    </Card>
  )
}


export function DistinctAccountPairsSection() {
  /*
   * The "these two accounts are different physical accounts" assertions, and the one place they can be
   * seen and undone.
   *
   * Each one permanently switches off cross-account duplicate detection between its pair, so it is
   * exactly the kind of durable, invisible decision that has to be inspectable. It was not: the
   * assertion could only be made as a side effect of clicking Keep on a flagged transaction, and these
   * endpoints existed with no screen calling them — so a user could suppress detection between two
   * accounts without knowing they had, and had no way to look or reverse it.
   *
   * Forgetting one is deliberately not destructive: it only re-enables checking. Rows the user already
   * resolved individually stay resolved; what comes back is future detection, plus any match the
   * assertion had been suppressing.
   */
  const [pairs, setPairs] = useState([])
  const [loading, setLoading] = useState(true)
  const [workingKey, setWorkingKey] = useState('')
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const resp = await api.getDistinctAccountPairs()
      setPairs(resp.pairs || [])
      setError('')
    } catch (err) {
      setError(err.message || 'Failed to load account pairs')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  async function forget(pair) {
    const key = `${pair.account_id_low}:${pair.account_id_high}`
    setWorkingKey(key)
    setError('')
    try {
      await api.forgetDistinctAccountPair(pair.account_id_low, pair.account_id_high)
      notifyAccountsChanged()
      await load()
    } catch (err) {
      setError(err.message || 'Failed to forget the assertion')
    } finally {
      setWorkingKey('')
    }
  }

  const label = (name, displayName, mask) => {
    const base = (displayName || '').trim() || (name || '').trim() || 'Account'
    return mask ? `${base} ···${mask}` : base
  }

  return (
    <Card style={{ display: 'grid', gap: 14 }}>
      <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.6, maxWidth: 620 }}>
        Pairs you have said are different real-world accounts. Imports stop checking for duplicate
        transactions between them. Forgetting a pair turns that checking back on — it does not undo
        decisions already made about individual transactions.
      </div>
      {error ? <div style={{ fontSize: 13, color: 'var(--danger)' }}>{error}</div> : null}
      {loading && pairs.length === 0 ? <Spinner /> : pairs.length === 0 ? (
        <EmptyState message="No account pairs have been marked as distinct." />
      ) : (
        <div style={{ border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
          {pairs.map((pair, index) => {
            const key = `${pair.account_id_low}:${pair.account_id_high}`
            return (
              <div
                key={key}
                style={{
                  display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 16,
                  alignItems: 'center', padding: '12px 14px',
                  borderTop: index === 0 ? 'none' : '1px solid var(--border)',
                  background: 'var(--surface2)',
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 600 }}>
                    {label(pair.account_low_name, pair.account_low_display_name, pair.account_low_mask)}
                    <span style={{ color: 'var(--muted)', fontWeight: 400 }}> and </span>
                    {label(pair.account_high_name, pair.account_high_display_name, pair.account_high_mask)}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
                    Marked distinct {formatDate(String(pair.asserted_at || '').slice(0, 10)) || 'recently'}.
                  </div>
                </div>
                <Button variant="secondary" disabled={!!workingKey} onClick={() => forget(pair)}>
                  {workingKey === key ? 'Forgetting…' : 'Forget'}
                </Button>
              </div>
            )
          })}
        </div>
      )}
    </Card>
  )
}
