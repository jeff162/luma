// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState, useEffect } from 'react'
import { api } from '../../lib/api.js'
import { Button, Spinner, getFormControlStyle, AppConfirmDialog } from '../ui.jsx'
import { DEFAULT_LEDGER_CURRENCY, applyLedgerCurrency, currencySymbolFor } from '../../lib/moneyDisplay.js'

export default function CurrencySection() {
  // The ledger holds one currency at a time, and this is it. Nothing about the stored data changes when
  // it does — no amount is converted or rewritten — which is exactly why the change needs confirming
  // rather than blocking: it silently relabels every historical figure, and only the user can tell a
  // correction from a mistake. It is equally cheap to reverse, and the dialog says so.
  const [state, setState] = useState(null)
  const [selected, setSelected] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [pendingChange, setPendingChange] = useState(null)

  useEffect(() => {
    let cancelled = false
    api.getLedgerCurrency()
      .then(result => {
        if (cancelled) return
        setState(result)
        setSelected(result?.code || DEFAULT_LEDGER_CURRENCY)
      })
      .catch(err => { if (!cancelled) setError(err?.message || 'Could not read the currency setting.') })
    return () => { cancelled = true }
  }, [])

  async function save(code, confirm = false) {
    setSaving(true)
    setError('')
    try {
      const result = await api.setLedgerCurrency(code, confirm)
      setState(result)
      setSelected(result.code)
      setPendingChange(null)
      applyLedgerCurrency(result.code)
      // Reloaded rather than re-rendered. The money formatters read the symbol at call time from a shared
      // config object, so every amount already on screen was formatted with the old one and nothing tells
      // those components to run again. A reload is honest about what changed — every figure in the app —
      // and is cheaper than making a global display constant reactive everywhere it is read.
      window.location.reload()
    } catch (err) {
      setSaving(false)
      const detail = err?.detail
      if (detail?.code === 'currency_change_needs_confirmation') {
        setPendingChange(detail)
        return
      }
      setError(err?.message || 'Could not save the currency.')
    }
  }

  if (!state) {
    return error
      ? <div style={{ fontSize: 13, color: 'var(--danger)' }}>{error}</div>
      : <Spinner />
  }

  const symbol = currencySymbolFor(selected)
  const options = state.common || []
  // A code the user set that is not on the shortlist still has to be selectable, or saving anything else
  // would silently drop it. The list is a convenience, never a whitelist.
  const known = options.some(o => o.code === selected)

  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <select
          name="ledger-currency"
          value={selected}
          disabled={saving}
          onChange={e => setSelected(e.target.value)}
          style={{ ...getFormControlStyle(), width: 'auto', minWidth: 220 }}
        >
          {!known ? <option value={selected}>{selected}</option> : null}
          {options.map(o => (
            <option key={o.code} value={o.code}>{o.code} — {o.label}</option>
          ))}
        </select>
        <span style={{ fontSize: 13, color: 'var(--muted)' }}>
          Amounts show as <strong style={{ color: 'var(--text)' }}>{symbol}1,234.56</strong>
        </span>
        <Button
          small
          disabled={saving || selected === state.code}
          onClick={() => save(selected)}
        >
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
      <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.55 }}>
        Amounts are stored as plain numbers. This sets what those numbers <em>mean</em> and how
        they are shown — it does not convert anything. The more interesting feature is that transactions from a data provider in
        a different currency are not imported.
      </div>
      {error ? <div style={{ fontSize: 12, color: 'var(--danger)' }}>{error}</div> : null}

      {pendingChange ? (
        <AppConfirmDialog
          title={`Switch this ledger to ${pendingChange.to}?`}
          description={pendingChange.message}
          confirmLabel={`Switch to ${pendingChange.to}`}
          confirmVariant="danger"
          borderColor="color-mix(in srgb, var(--danger) 35%, var(--border))"
          onConfirm={() => save(pendingChange.to, true)}
          onCancel={() => { setPendingChange(null); setSelected(state.code) }}
          width="min(560px, 100%)"
        />
      ) : null}
    </div>
  )
}
