// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect, useState } from 'react'
import { api } from '../lib/api.js'
import { AppDialog, Button } from './ui.jsx'

// Opt-in starter rules shown as a transparent select-before-add list (all checked by default) so the
// user sees exactly which keyword → category rules they are adding before any transaction data is
// touched. The checkboxes only choose what to include; full editing happens later through normal rule
// editing. Adding selected rules also seeds their target categories, so a chosen rule can never be
// silently dropped for want of its leaf (see POST /categories/generate-starter).
export default function StarterRulesDialog({ onClose, onAdded }) {
  const [catalog, setCatalog] = useState(null) // null = loading, [] = loaded/empty
  const [selected, setSelected] = useState(() => new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    api.getStarterRules()
      .then(resp => {
        if (cancelled) return
        const rules = resp?.rules || []
        setCatalog(rules)
        setSelected(new Set(rules.map(rule => rule.keyword)))
      })
      .catch(() => {
        if (cancelled) return
        setCatalog([])
        setError('Could not load the starter rules.')
      })
    return () => { cancelled = true }
  }, [])

  const total = catalog?.length || 0
  const allChecked = total > 0 && selected.size === total
  const noneChecked = selected.size === 0

  function toggle(keyword) {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(keyword)) next.delete(keyword)
      else next.add(keyword)
      return next
    })
  }

  function toggleAll() {
    setSelected(allChecked ? new Set() : new Set((catalog || []).map(rule => rule.keyword)))
  }

  async function addSelected() {
    if (noneChecked || busy) return
    setBusy(true)
    setError('')
    try {
      const result = await api.generateStarterSet({ rule_keywords: Array.from(selected) })
      onAdded?.(result)
      onClose?.()
    } catch (err) {
      setError(err?.message || 'Could not add the rules.')
      setBusy(false)
    }
  }

  return (
    <AppDialog
      title="Add starter rules"
      description="Rules automatically assign a category to matching transactions as you import. Pick the ones you want — you can change or remove any of them later."
      width="min(520px, 100%)"
      onClose={busy ? undefined : onClose}
      actions={(
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={addSelected} disabled={noneChecked || busy || total === 0}>
            {busy ? 'Adding…' : `Add ${selected.size} rule${selected.size === 1 ? '' : 's'}`}
          </Button>
        </>
      )}
    >
      {catalog === null ? (
        <div style={{ fontSize: 13, color: 'var(--muted)' }}>Loading…</div>
      ) : total === 0 ? (
        <div style={{ fontSize: 13, color: 'var(--muted)' }}>{error || 'No starter rules available.'}</div>
      ) : (
        <>
          <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={allChecked}
              ref={el => { if (el) el.indeterminate = !allChecked && !noneChecked }}
              onChange={toggleAll}
            />
            Select all
          </label>
          <div style={{
            maxHeight: 320,
            overflowY: 'auto',
            display: 'grid',
            gap: 2,
            border: '1px solid var(--border)',
            borderRadius: 10,
            padding: 8,
          }}>
            {catalog.map(rule => (
              <label
                key={rule.keyword}
                style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, padding: '6px 8px', borderRadius: 8, cursor: 'pointer' }}
              >
                <input type="checkbox" checked={selected.has(rule.keyword)} onChange={() => toggle(rule.keyword)} />
                <span style={{ flex: 1, minWidth: 0 }}>
                  <strong style={{ fontWeight: 600 }}>{rule.keyword}</strong>
                  <span style={{ color: 'var(--muted)' }}> → {rule.category_name}</span>
                </span>
              </label>
            ))}
          </div>
          {error ? <div style={{ fontSize: 12, color: 'var(--danger)' }}>{error}</div> : null}
        </>
      )}
    </AppDialog>
  )
}
