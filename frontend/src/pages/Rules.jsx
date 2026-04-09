// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: GPL-3.0-or-later

import { useState, useEffect, useCallback } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { api } from '../lib/api.js'
import { Card, PageHeader, Button, Input, Badge, Spinner, EmptyState } from '../components/ui.jsx'
import RuleForm, { amountConditionSummary } from '../components/RuleForm.jsx'

function describeRule(rule, owners, accounts) {
  const parts = []

  if (rule.amount_min != null || rule.amount_max != null) {
    const isEquals = rule.amount_min != null && rule.amount_max != null && rule.amount_min === rule.amount_max
    if (isEquals) {
      parts.push(`amount = $${rule.amount_min}`)
    } else {
      if (rule.amount_min != null) parts.push(`amount >= $${rule.amount_min}`)
      if (rule.amount_max != null) parts.push(`amount <= $${rule.amount_max}`)
    }
  }

  if (rule.owner_id) {
    const ownerObj = owners.find(o => o.id === rule.owner_id)
    if (ownerObj) parts.push(`owner is ${ownerObj.name}`)
  }

  if (rule.account_id) {
    const accountObj = accounts.find(a => a.id === rule.account_id)
    if (accountObj) {
      const mask = accountObj.mask ? ` •••${accountObj.mask}` : ''
      parts.push(`account is ${accountObj.name}${mask}`)
    }
  }

  return parts
}

function RuleRow({ rule, owners, accounts, onSave, onDelete }) {
  const [confirmDel,  setConfirmDel]  = useState(false)

  const conditions = describeRule(rule, owners, accounts)
  const hasConditions = conditions.length > 0

  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '360px 1fr 80px',
      padding: '10px 16px', alignItems: 'center',
      borderBottom: '1px solid var(--border)', gap: 12,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, overflow: 'hidden' }}>
        <span style={{ fontFamily: 'monospace', fontSize: 13, fontWeight: 500, flexShrink: 0, whiteSpace: 'nowrap' }}>
          {rule.keyword}
        </span>
        {hasConditions && (
          <div style={{ fontSize: 13, lineHeight: 1.5, color: 'var(--muted)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {conditions.map((c, i) => (
              <span key={i}>
                {i > 0 && <span style={{ color: 'var(--border)', margin: '0 4px' }}>&</span>}
                {c}
              </span>
            ))}
          </div>
        )}
      </div>

      <div style={{ fontSize: 13, lineHeight: 1.5, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '2px 6px' }}>
        <span style={{ color: 'var(--muted)', opacity: 0.4, margin: '0 2px' }}>→</span>
        <Badge
          label={rule.category_name}
          toneKey={rule.category_id || rule.category_name}
        />

        {rule.clean_name && (
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>
            · rename to <span style={{ color: 'var(--text)', fontStyle: 'italic' }}>{rule.clean_name}</span>
          </span>
        )}
      </div>

      <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
        <button
          onClick={() => onSave(rule.id)}
          style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 12, padding: '2px 6px', borderRadius: 4 }}
          title="Edit rule"
        >✎</button>
        {confirmDel ? (
          <>
            <button
              onClick={() => { setConfirmDel(false); onDelete(rule.id) }}
              style={{ background: '#ef4444', color: '#fff', border: 'none', borderRadius: 4, padding: '2px 7px', fontSize: 11, cursor: 'pointer', fontWeight: 600 }}
            >Del</button>
            <button
              onClick={() => setConfirmDel(false)}
              style={{ background: 'none', border: '1px solid var(--border)', color: 'var(--muted)', borderRadius: 4, padding: '2px 6px', fontSize: 11, cursor: 'pointer' }}
            >✕</button>
          </>
        ) : (
          <button
            onClick={() => setConfirmDel(true)}
            style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 14, padding: '2px 6px', borderRadius: 4 }}
            title="Delete rule"
          >×</button>
        )}
      </div>
    </div>
  )
}

function EditRuleOverlay({ rule, categories, owners, accounts, onSave, onCancel }) {
  if (!rule) return null

  return (
    <div style={{
      position: 'fixed',
      inset: 0,
      zIndex: 120,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '28px 32px',
      background: 'rgba(10, 15, 26, 0.38)',
      backdropFilter: 'blur(2px)',
    }}>
      <Card style={{
        width: 'min(760px, 100%)',
        maxHeight: 'calc(100vh - 160px)',
        padding: 0,
        overflow: 'hidden',
        boxShadow: '0 24px 70px rgba(0,0,0,0.28)',
        border: '1px solid color-mix(in srgb, var(--accent) 18%, var(--border))',
      }}>
        <div style={{
          padding: '12px 20px',
          borderBottom: '1px solid var(--border)',
          background: 'var(--surface2)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
        }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 600 }}>Edit rule</div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
              Update conditions and actions without leaving the rules list
            </div>
          </div>
          <button
            onClick={onCancel}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--muted)',
              cursor: 'pointer',
              fontSize: 22,
              lineHeight: 1,
              padding: 2,
            }}
            title="Close editor"
          >
            ×
          </button>
        </div>
        <div style={{ maxHeight: 'calc(100vh - 230px)', overflowY: 'auto' }}>
          <RuleForm
            initialValues={{
              keyword: rule.keyword,
              amount_min: rule.amount_min ?? null,
              amount_max: rule.amount_max ?? null,
              owner_id: rule.owner_id || '',
              account_id: rule.account_id || '',
              catId: rule.category_id,
              cleanName: rule.clean_name || '',
            }}
            categories={categories}
            owners={owners}
            accounts={accounts}
            onSave={onSave}
            onCancel={onCancel}
            saveLabel="Save changes"
          />
        </div>
      </Card>
    </div>
  )
}

export default function Rules() {
  const location = useLocation()
  const navigate = useNavigate()
  const [rules,      setRules]      = useState([])
  const [categories, setCategories] = useState([])
  const [owners,     setOwners]     = useState([])
  const [accounts,   setAccounts]   = useState([])
  const [loading,    setLoading]    = useState(true)
  const [search,     setSearch]     = useState('')
  const [showAdd,    setShowAdd]    = useState(false)
  const [editingRuleId, setEditingRuleId] = useState(null)
  const [createInitialValues, setCreateInitialValues] = useState({})
  const [createTransactionData, setCreateTransactionData] = useState(null)
  const [recategorizeResult, setRecategorizeResult] = useState(null)

  const loadRules = useCallback(() => {
    api.getRules(search || undefined).then(r => { setRules(r); setLoading(false) })
  }, [search])
  const loadCategories = useCallback(() => { api.getCategories().then(setCategories) }, [])

  useEffect(() => { loadRules() },      [loadRules])
  useEffect(() => { loadCategories() }, [loadCategories])
  useEffect(() => { api.getOwners().then(setOwners) }, [])
  useEffect(() => { api.getAccounts().then(setAccounts) }, [])

  async function handleAdd(data) {
    const { applyToExisting, ...ruleData } = data
    await api.createRule(ruleData)
    if (applyToExisting) await api.recategorize()
    setShowAdd(false)
    setCreateInitialValues({})
    setCreateTransactionData(null)
    loadRules()
  }

  async function handleEditSave(data) {
    const { applyToExisting, ...ruleData } = data
    await api.updateRule(editingRuleId, ruleData)
    if (applyToExisting) await api.recategorize()
    setEditingRuleId(null)
    loadRules()
  }

  async function handleDelete(id) {
    await api.deleteRule(id)
    if (editingRuleId === id) setEditingRuleId(null)
    loadRules()
  }

  async function runRecategorize() {
    setRecategorizeResult(null)
    const result = await api.recategorize()
    setRecategorizeResult(result.updated)
    setTimeout(() => setRecategorizeResult(null), 6000)
  }

  const editingRule = editingRuleId ? rules.find(rule => rule.id === editingRuleId) : null
  const showCreateForm = showAdd
  const showAnyEditor = showAdd || !!editingRule

  function openCreateForm() {
    setEditingRuleId(null)
    setShowAdd(true)
    setCreateInitialValues({})
    setCreateTransactionData(null)
  }

  function openEditForm(id) {
    setShowAdd(false)
    setEditingRuleId(id)
    setCreateInitialValues({})
    setCreateTransactionData(null)
  }

  function closeForm() {
    setShowAdd(false)
    setEditingRuleId(null)
    setCreateInitialValues({})
    setCreateTransactionData(null)
  }

  useEffect(() => {
    const editorState = location.state?.openRuleEditor
    const creatorState = location.state?.openRuleCreator
    if (!editorState && !creatorState) return

    // Other screens deep-link into the rules page with editor state; clear it
    // immediately after consuming it so refresh/back does not reopen stale overlays.
    if (editorState?.ruleId) {
      setShowAdd(false)
      setEditingRuleId(editorState.ruleId)
      setCreateInitialValues({})
      setCreateTransactionData(null)
    } else if (creatorState) {
      setEditingRuleId(null)
      setShowAdd(true)
      setCreateInitialValues(creatorState.initialValues || {})
      setCreateTransactionData(creatorState.transactionData || null)
    }

    navigate(location.pathname, { replace: true, state: null })
  }, [location.pathname, location.state, navigate])

  return (
    <div data-browser-context-passthrough="true" style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>

      <div style={{ padding: '32px 32px 0', flexShrink: 0 }}>
        <PageHeader title="Rules">
          <Button variant="ghost" small onClick={runRecategorize}>↻ Re-run categorization</Button>
          <Button small onClick={() => (showAnyEditor ? closeForm() : openCreateForm())}>
            {showAnyEditor ? 'Cancel' : 'Add rule'}
          </Button>
        </PageHeader>
      </div>

      {recategorizeResult !== null && (
        <div style={{
          margin: '12px 32px 0',
          padding: '10px 16px',
          borderRadius: 8,
          background: recategorizeResult > 0
            ? 'color-mix(in srgb, var(--success) 10%, var(--surface2))'
            : 'var(--surface2)',
          border: `1px solid ${recategorizeResult > 0
            ? 'color-mix(in srgb, var(--success) 30%, var(--border))'
            : 'var(--border)'}`,
          fontSize: 13,
          color: recategorizeResult > 0 ? 'var(--success)' : 'var(--muted)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          flexShrink: 0,
        }}>
          <span>
            {recategorizeResult > 0
              ? `↻ ${recategorizeResult} transaction${recategorizeResult === 1 ? '' : 's'} re-categorized.`
              : '↻ No transactions needed re-categorization.'}
          </span>
          <button
            onClick={() => setRecategorizeResult(null)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', fontSize: 16, lineHeight: 1, padding: 0 }}
          >×</button>
        </div>
      )}

      <div style={{
        padding: '8px 32px', flexShrink: 0,
        borderBottom: '1px solid var(--border)',
        background: 'var(--surface)',
        display: 'flex', alignItems: 'center', gap: 12,
      }}>
        <Input value={search} onChange={setSearch} placeholder="Filter by keyword…" style={{ width: 280 }} />
        <span style={{ fontSize: 12, color: 'var(--muted)', marginLeft: 'auto' }}>
          {rules.length} rule{rules.length !== 1 ? 's' : ''}
        </span>
      </div>

      <div data-browser-context-passthrough="true" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '20px 32px 32px' }}>
        {showCreateForm && (
          <Card style={{ padding: 0, overflow: 'hidden', marginBottom: 20 }}>
            <div style={{ padding: '12px 20px', borderBottom: '1px solid var(--border)', background: 'var(--surface2)', fontSize: 14, fontWeight: 600 }}>
              New rule
            </div>
            <RuleForm
              initialValues={createInitialValues}
              categories={categories}
              owners={owners}
              accounts={accounts}
              onSave={handleAdd}
              onCancel={closeForm}
              saveLabel="Add rule"
              transactionData={createTransactionData}
            />
          </Card>
        )}

        <Card style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{
            display: 'grid', gridTemplateColumns: '360px 1fr 80px',
            padding: '8px 16px', gap: 12,
            fontSize: 11, fontWeight: 600, color: 'var(--muted)',
            textTransform: 'uppercase', letterSpacing: '0.05em',
            borderBottom: '1px solid var(--border)',
          }}>
            <span>Keyword + Condition</span>
            <span style={{ paddingLeft: 28 }}>Action</span>
            <span />
          </div>

          {loading ? <Spinner /> : rules.length === 0 ? (
            <EmptyState message={search ? 'No rules match that keyword' : 'No rules yet — click "Add rule" to create one'} />
          ) : rules.map(rule => (
            <RuleRow
              key={rule.id}
              rule={rule}
              owners={owners}
              accounts={accounts}
              onSave={openEditForm}
              onDelete={handleDelete}
            />
          ))}
        </Card>
        <p style={{ marginTop: 12, fontSize: 12, color: 'var(--muted)', lineHeight: 1.6 }}>
          Rules are evaluated most-specific first: longer keywords beat shorter ones,
          and rules with more conditions beat those with fewer. Owner-scoped rules always
          beat global ones. The list shows rules in the reverse order — general rules
          at the top, specific overrides at the bottom.
        </p>
      </div>

      <EditRuleOverlay
        rule={editingRule}
        categories={categories}
        owners={owners}
        accounts={accounts}
        onSave={handleEditSave}
        onCancel={closeForm}
      />
    </div>
  )
}
