import { useState, useEffect, useCallback } from 'react'
import { api } from '../lib/api.js'
import { refreshTaskBadge } from '../App.jsx'
import { Card, PageHeader, Button, Spinner, EmptyState } from '../components/ui.jsx'

// Inline confirmation that renders next to the × that triggered it
function DeleteConfirm({ name, onConfirm, onCancel }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      background: 'var(--surface2)', border: '1px solid var(--border)',
      borderRadius: 8, padding: '6px 10px',
      boxShadow: '0 4px 16px rgba(0,0,0,0.2)',
    }}>
      <span style={{ fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap' }}>
        Remove <strong>{name}</strong> and all its transactions?
      </span>
      <button
        onClick={onConfirm}
        style={{
          background: '#ef4444', color: '#fff', border: 'none',
          borderRadius: 5, padding: '4px 10px', fontSize: 12,
          cursor: 'pointer', fontWeight: 600, whiteSpace: 'nowrap',
        }}
      >Remove</button>
      <button
        onClick={onCancel}
        style={{
          background: 'none', border: '1px solid var(--border)', color: 'var(--muted)',
          borderRadius: 5, padding: '4px 8px', fontSize: 12, cursor: 'pointer',
        }}
      >Cancel</button>
    </div>
  )
}

export default function Accounts() {
  const [accounts,    setAccounts]    = useState([])
  const [loading,     setLoading]     = useState(true)
  const [syncing,     setSyncing]     = useState(false)
  const [syncResult,  setSyncResult]  = useState(null)
  const [confirmId,   setConfirmId]   = useState(null)  // account id pending delete confirm

  const loadAccounts = () => {
    setLoading(true)
    api.getAccounts().then(a => { setAccounts(a); setLoading(false) })
  }

  useEffect(() => { loadAccounts() }, [])

  const connectBank = async () => {
    try {
      const { link_token } = await api.getLinkToken()
      const script = document.createElement('script')
      script.src = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js'
      document.head.appendChild(script)
      script.onload = () => {
        const handler = window.Plaid.create({
          token: link_token,
          onSuccess: async (public_token, metadata) => {
            await api.exchangeToken(public_token, metadata.institution?.name)
            loadAccounts()
          },
          onExit: (err) => { if (err) console.error('Plaid Link error', err) },
        })
        handler.open()
      }
    } catch (e) {
      alert('Could not start Plaid Link: ' + e.message)
    }
  }

  const sync = async () => {
    setSyncing(true); setSyncResult(null)
    try {
      const result = await api.runSync(30)
      setSyncResult(result); loadAccounts()
    } catch (e) {
      alert('Sync failed: ' + e.message)
    } finally {
      setSyncing(false)
    }
  }

  const deleteAccount = async (id) => {
    setConfirmId(null)
    setAccounts(prev => prev.filter(a => a.id !== id))   // instant removal, no flash
    await api.deleteAccount(id)
    api.getAccounts().then(setAccounts)                   // silent background sync
    refreshTaskBadge()
  }

  const accountTypeIcon = (type) => {
    const map = { depository: '🏦', credit: '💳', investment: '📈', loan: '🏠' }
    return map[type] || '🏦'
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ padding: '32px 32px 0', flexShrink: 0 }}>
        <PageHeader title="Accounts">
        <Button variant="ghost" small onClick={sync} disabled={syncing}>
          {syncing ? 'Syncing…' : '↻ Sync now (30 days)'}
        </Button>
        <Button small onClick={connectBank}>+ Connect bank</Button>
        </PageHeader>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 32px 32px' }}>

      {syncResult && (
        <div style={{
          background: 'var(--surface2)', border: '1px solid var(--border)',
          borderRadius: 8, padding: '10px 16px', marginBottom: 16,
          fontSize: 13, color: 'var(--muted)',
        }}>
          Sync complete — {syncResult.added} added, {syncResult.updated} updated, {syncResult.skipped} skipped
        </div>
      )}

      {loading ? <Spinner /> : accounts.length === 0 ? (
        <Card>
          <EmptyState message="No accounts connected yet. Click 'Connect bank' to link your first account." />
        </Card>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {accounts.map(acc => (
            <Card key={acc.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 14, flex: 1, minWidth: 0 }}>
                <span style={{ fontSize: 24, flexShrink: 0 }}>{accountTypeIcon(acc.type)}</span>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 15 }}>{acc.name}</div>
                  <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 2 }}>
                    {acc.institution && <span>{acc.institution} · </span>}
                    {acc.subtype && <span style={{ textTransform: 'capitalize' }}>{acc.subtype}</span>}
                    {acc.mask && <span> ···{acc.mask}</span>}
                  </div>
                </div>
              </div>

              {/* Inline confirm — replaces the × button when active */}
              {confirmId === acc.id ? (
                <DeleteConfirm
                  name={acc.name}
                  onConfirm={() => deleteAccount(acc.id)}
                  onCancel={() => setConfirmId(null)}
                />
              ) : (
                <button
                  onClick={() => setConfirmId(acc.id)}
                  style={{
                    background: 'none', border: 'none', color: 'var(--muted)',
                    cursor: 'pointer', fontSize: 18, padding: '4px 8px',
                    borderRadius: 6, flexShrink: 0,
                  }}
                  title="Remove account"
                >×</button>
              )}
            </Card>
          ))}
        </div>
      )}

      <Card style={{ marginTop: 24 }}>
        <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>About Plaid sandbox</h3>
        <p style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.6 }}>
          While <code>PLAID_ENV=sandbox</code>, use test credentials when the bank dialog opens:
          username <code>user_good</code>, password <code>pass_good</code>.
          Switch to <code>PLAID_ENV=development</code> in your <code>.env</code> to connect real accounts
          (requires Plaid developer approval).
        </p>
      </Card>
      </div>
    </div>
  )
}
