// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useMemo, useState } from 'react'
import { api } from '../../lib/api.js'
import { AppDialog, Button, Input, Select, Spinner } from '../ui.jsx'

// PayPal monthly statements dropped on the importer: which PayPal account each belongs to, and the account
// in the ledger its statements go into, then the import — one card per statement under the PayPal data
// source (routers/import_export/paypal_statement.py). A PayPal account whose statements were imported
// before already has its account, and the backend holds it there, so that account is shown rather than
// offered as a choice; one met for the first time is given a PayPal account here, or a new one.

const NEW_ACCOUNT = '__new__'

function periodLabel(start, end) {
  const [y, m, d] = start.split('-').map(Number)
  const last = new Date(y, m, 0).getDate()
  if (d === 1 && end === `${start.slice(0, 8)}${String(last).padStart(2, '0')}`) {
    return new Date(y, m - 1, 1).toLocaleString(undefined, { month: 'long', year: 'numeric' })
  }
  return `${start} – ${end}`
}

function statementNote(statement) {
  if (statement.already_imported) return 'already imported'
  if (!statement.transaction_count) return 'no activity'
  const count = `${statement.transaction_count} transaction${statement.transaction_count === 1 ? '' : 's'}`
  return statement.foreign_count ? `${count}, ${statement.foreign_count} in another currency (not imported)` : count
}

const importable = statement => !statement.already_imported && statement.transaction_count > 0

function AccountChoice({ group, remembered, options, owners, value, busy, onChange, onCreate }) {
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('PayPal')
  const [ownerId, setOwnerId] = useState('')
  if (remembered) {
    return (
      <div style={{ fontSize: 13 }}>
        Goes into <strong>{remembered.account_name || 'its PayPal account'}</strong>, like this PayPal
        account&apos;s earlier statements.
      </div>
    )
  }
  const submit = async () => {
    if (await onCreate(name.trim(), ownerId || null)) setCreating(false)
  }
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <Select
        value={creating ? NEW_ACCOUNT : value}
        onChange={v => { if (v === NEW_ACCOUNT) setCreating(true); else { setCreating(false); onChange(v) } }}
        options={[
          { value: '', label: options.length ? 'Choose the PayPal account…' : 'No PayPal account yet — create one →' },
          ...options,
          { value: NEW_ACCOUNT, label: '＋ New PayPal account…' },
        ]}
        aria-label={`Account for ${group.paypalAccountId}`}
        disabled={busy}
      />
      {creating ? (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Input value={name} onChange={setName} placeholder="New account name" aria-label="New account name"
            style={{ flex: '1 1 160px' }} />
          {owners.length > 1 ? (
            <Select value={ownerId} onChange={setOwnerId} aria-label="Owner"
              options={[{ value: '', label: 'Owner…' }, ...owners.map(o => ({ value: o.id, label: o.name }))]} />
          ) : null}
          <Button small onClick={submit} disabled={busy || !name.trim()}>Create</Button>
          <Button small variant="ghost" onClick={() => setCreating(false)}>Cancel</Button>
        </div>
      ) : null}
    </div>
  )
}

function ImportResult({ result }) {
  const batches = result.batches || []
  const skipped = result.skipped || []
  return (
    <div style={{ display: 'grid', gap: 8, fontSize: 13 }}>
      {batches.map(b => (
        <div key={b.filename}>
          <strong>{periodLabel(b.period_start, b.period_end)}</strong>
          {' — '}
          {b.imported} imported
          {b.duplicates ? `, ${b.duplicates} already in the ledger${b.enriched ? ` (${b.enriched} given the statement's detail)` : ''}` : ''}
          {b.rejected ? `, ${b.rejected} refused` : ''}
        </div>
      ))}
      {skipped.map(s => (
        <div key={s.filename} style={{ color: 'var(--muted)' }}>
          {s.filename}: {s.reason === 'already_imported' ? 'already imported' : 'no activity'}
        </div>
      ))}
      {!batches.length && !skipped.length ? <div>Nothing was imported.</div> : null}
    </div>
  )
}

export function PaypalStatementImportDialog({ files, accounts, onClose, onImported, onAccountsChanged }) {
  const [scan, setScan] = useState(null)
  const [owners, setOwners] = useState([])
  const [assignments, setAssignments] = useState({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState(null)

  useEffect(() => {
    let cancelled = false
    api.scanPaypalStatements(files)
      .then(next => { if (!cancelled) setScan(next) })
      .catch(e => { if (!cancelled) setError(e?.message || 'The files could not be read.') })
    api.getOwners().then(list => { if (!cancelled) setOwners(list || []) }).catch(() => {})
    return () => { cancelled = true }
  }, [files])

  const groups = useMemo(() => {
    const byId = new Map()
    for (const statement of scan?.statements || []) {
      if (!byId.has(statement.paypal_account_id)) {
        byId.set(statement.paypal_account_id, { paypalAccountId: statement.paypal_account_id, holder: statement.holder, statements: [] })
      }
      byId.get(statement.paypal_account_id).statements.push(statement)
    }
    return [...byId.values()]
  }, [scan])

  // A PayPal account's statements can go only into a PayPal account not already holding another's.
  const optionsFor = (paypalAccountId) => accounts
    .filter(a => (a.type || '').toLowerCase() === 'paypal' && !a.parent_account_id)
    .filter(a => !scan?.claimed_accounts?.[a.id] || scan.claimed_accounts[a.id] === paypalAccountId)
    .map(a => ({ value: a.id, label: a.display_name || a.name }))

  const chosen = (group) => scan?.accounts?.[group.paypalAccountId]?.account_id || assignments[group.paypalAccountId] || ''
  const needed = groups.filter(g => g.statements.some(importable))
  const canImport = needed.length > 0 && needed.every(g => chosen(g)) && !busy

  const createAccount = async (group, name, ownerId) => {
    setBusy(true); setError('')
    try {
      const created = await api.createAccount({ name, type: 'paypal', ...(ownerId ? { owner_id: ownerId } : {}) })
      await onAccountsChanged?.()
      setAssignments(prev => ({ ...prev, [group.paypalAccountId]: created.id }))
      return true
    } catch (e) {
      setError(e?.message || 'Could not create the account')
      return false
    } finally { setBusy(false) }
  }

  const runImport = async () => {
    setBusy(true); setError('')
    try {
      const body = Object.fromEntries(needed.map(g => [g.paypalAccountId, chosen(g)]))
      setResult(await api.importPaypalStatements(files, body))
      onImported?.()
    } catch (e) {
      setError(e?.message || 'The import failed')
    } finally { setBusy(false) }
  }

  const otherFiles = [...(scan?.unrecognized_files || []).map(name => ({ name, reason: 'not a PayPal statement' })),
    ...(scan?.unreadable_files || [])]

  return (
    <AppDialog
      title="Import PayPal statements"
      description={result ? null : 'Each statement becomes its own card under the PayPal data source. Transactions already in the ledger are recognized as duplicates and given the statement’s detail.'}
      onClose={onClose}
      width="min(620px, 100%)"
      actions={result ? (
        <Button onClick={onClose}>Done</Button>
      ) : (
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={runImport} disabled={!canImport}>{busy ? 'Importing…' : 'Import statements'}</Button>
        </>
      )}
    >
      {result ? <ImportResult result={result} /> : !scan && !error ? <Spinner /> : (
        <div style={{ display: 'grid', gap: 18 }}>
          {groups.map(group => (
            <div key={group.paypalAccountId} style={{ display: 'grid', gap: 10 }}>
              <div style={{ fontSize: 13 }}>
                PayPal account <strong>{group.paypalAccountId}</strong>
                {group.holder ? <span style={{ color: 'var(--muted)' }}> · {group.holder}</span> : null}
              </div>
              {group.statements.some(importable) ? (
                <AccountChoice
                  group={group}
                  remembered={scan.accounts?.[group.paypalAccountId]}
                  options={optionsFor(group.paypalAccountId)}
                  owners={owners}
                  value={assignments[group.paypalAccountId] || ''}
                  busy={busy}
                  onChange={v => setAssignments(prev => ({ ...prev, [group.paypalAccountId]: v }))}
                  onCreate={(name, ownerId) => createAccount(group, name, ownerId)}
                />
              ) : null}
              <div style={{ display: 'grid', gap: 4 }}>
                {group.statements.map(statement => (
                  <div key={statement.key} style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 13,
                    color: importable(statement) ? 'var(--text)' : 'var(--muted)' }}>
                    <span style={{ minWidth: 130 }}>{periodLabel(statement.period_start, statement.period_end)}</span>
                    <span>{statementNote(statement)}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
          {scan && !groups.length ? <div style={{ fontSize: 13 }}>No PayPal statements were found in these files.</div> : null}
          {otherFiles.length ? (
            <div style={{ fontSize: 12, color: 'var(--muted)', display: 'grid', gap: 2 }}>
              {otherFiles.map(f => <div key={f.name}>{f.name}: {f.reason}</div>)}
            </div>
          ) : null}
        </div>
      )}
      {error ? <div role="alert" style={{ marginTop: 12, fontSize: 13, color: 'var(--danger, #ef4444)' }}>{error}</div> : null}
    </AppDialog>
  )
}
