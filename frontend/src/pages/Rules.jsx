import { useState, useEffect, useCallback } from 'react'
import { api } from '../lib/api.js'
import { Card, PageHeader, Button, Input, Badge, Spinner, EmptyState } from '../components/ui.jsx'
import RuleForm, { amountConditionSummary } from '../components/RuleForm.jsx'

// ── Plain-text rule description ───────────────────────────────────────────────
// Builds a natural-language summary of a rule's conditions and actions.
// Shown in the second column of the rules list.
// Example: "and amount >= $10 and owner is Paul → Groceries, rename to Whole Foods"

function describeRule(rule, owners, accounts) {
  const parts = []

  // Amount
  if (rule.amount_min != null || rule.amount_max != null) {
    const isEquals = rule.amount_min != null && rule.amount_max != null && rule.amount_min === rule.amount_max
    if (isEquals) {
      parts.push(`amount = $${rule.amount_min}`)
    } else {
      if (rule.amount_min != null) parts.push(`amount >= $${rule.amount_min}`)
      if (rule.amount_max != null) parts.push(`amount <= $${rule.amount_max}`)
    }
  }

  // Owner
  if (rule.owner_id) {
    const ownerObj = owners.find(o => o.id === rule.owner_id)
    if (ownerObj) parts.push(`owner is ${ownerObj.name}`)
  }

  // Account — rules don't store account_id yet, but ready for when they do

  return parts
}

// ── RuleRow ───────────────────────────────────────────────────────────────────

function RuleRow({ rule, categories, owners, accounts, onSave, onDelete }) {
  const [editing,     setEditing]     = useState(false)
  const [confirmDel,  setConfirmDel]  = useState(false)

  async function handleSave(data) {
    const { applyToExisting, ...ruleData } = data
    await onSave(rule.id, ruleData)
    if (applyToExisting) await api.recategorize()
    setEditing(false)
  }

  if (editing) {
    return (
      <div style={{ borderBottom: '1px solid var(--border)' }}>
        <RuleForm
          initialValues={{
            keyword:   rule.keyword,
            amtMin:    rule.amount_min ?? null,
            amtMax:    rule.amount_max ?? null,
            ownerId:   rule.owner_id  || '',
            catId:     rule.category_id,
            cleanName: rule.clean_name || '',
          }}
          categories={categories}
          owners={owners}
          accounts={accounts}
          onSave={handleSave}
          onCancel={() => setEditing(false)}
          saveLabel="Save changes"
        />
      </div>
    )
  }

  const conditions = describeRule(rule, owners, accounts)
  const hasConditions = conditions.length > 0

  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '200px 1fr 80px',
      padding: '10px 16px', alignItems: 'center',
      borderBottom: '1px solid var(--border)', gap: 12,
    }}>
      {/* Keyword */}
      <span style={{ fontFamily: 'monospace', fontSize: 13, fontWeight: 500 }}>
        {rule.keyword}
      </span>

      {/* Conditions + actions in plain text */}
      <div style={{ fontSize: 13, lineHeight: 1.5, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '2px 6px' }}>
        {/* Conditions */}
        {hasConditions && (
          <span style={{ color: 'var(--muted)' }}>
            {conditions.map((c, i) => (
              <span key={i}>
                {i > 0 && <span style={{ color: 'var(--border)', margin: '0 2px' }}>&</span>}
                {c}
              </span>
            ))}
          </span>
        )}

        {/* Arrow */}
        <span style={{ color: 'var(--muted)', opacity: 0.4, margin: '0 2px' }}>→</span>

        {/* Category */}
        <Badge
          label={rule.category_name}
          color={rule.category_color}
          icon={rule.category_icon}
        />

        {/* Rename */}
        {rule.clean_name && (
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>
            · rename to <span style={{ color: 'var(--text)', fontStyle: 'italic' }}>{rule.clean_name}</span>
          </span>
        )}
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
        <button
          onClick={() => setEditing(true)}
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

// ── Main page ─────────────────────────────────────────────────────────────────

export default function Rules() {
  const [rules,      setRules]      = useState([])
  const [categories, setCategories] = useState([])
  const [owners,     setOwners]     = useState([])
  const [accounts,   setAccounts]   = useState([])
  const [loading,    setLoading]    = useState(true)
  const [search,     setSearch]     = useState('')
  const [showAdd,    setShowAdd]    = useState(false)

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
    loadRules()
  }

  async function handleSave(id, data) {
    await api.updateRule(id, data)
    loadRules()
  }

  async function handleDelete(id) {
    await api.deleteRule(id)
    loadRules()
  }

  async function runRecategorize() {
    const result = await api.recategorize()
    alert(`Re-categorized ${result.updated} transactions.`)
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>

      {/* Page header */}
      <div style={{ padding: '32px 32px 0', flexShrink: 0 }}>
        <PageHeader title="Rules">
          <Button variant="ghost" small onClick={runRecategorize}>↻ Re-run categorization</Button>
          <Button small onClick={() => setShowAdd(v => !v)}>
            {showAdd ? 'Cancel' : 'Add rule'}
          </Button>
        </PageHeader>
      </div>

      {/* Sticky toolbar */}
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

      {/* Scrollable content */}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '20px 32px 32px' }}>

        {/* Add rule form */}
        {showAdd && (
          <Card style={{ padding: 0, overflow: 'hidden', marginBottom: 20 }}>
            <div style={{ padding: '12px 20px', borderBottom: '1px solid var(--border)', background: 'var(--surface2)', fontSize: 14, fontWeight: 600 }}>
              New rule
            </div>
            <RuleForm
              categories={categories}
              owners={owners}
              accounts={accounts}
              onSave={handleAdd}
              onCancel={() => setShowAdd(false)}
              saveLabel="Add rule"
            />
          </Card>
        )}

        {/* Rules list */}
        <Card style={{ padding: 0, overflow: 'hidden' }}>
          {/* Column headers */}
          <div style={{
            display: 'grid', gridTemplateColumns: '200px 1fr 80px',
            padding: '8px 16px', gap: 12,
            fontSize: 11, fontWeight: 600, color: 'var(--muted)',
            textTransform: 'uppercase', letterSpacing: '0.05em',
            borderBottom: '1px solid var(--border)',
          }}>
            <span>Keyword</span>
            <span>Conditions → Action</span>
            <span />
          </div>

          {loading ? <Spinner /> : rules.length === 0 ? (
            <EmptyState message={search ? 'No rules match that keyword' : 'No rules yet — click "Add rule" to create one'} />
          ) : rules.map(rule => (
            <RuleRow
              key={rule.id}
              rule={rule}
              categories={categories}
              owners={owners}
              accounts={accounts}
              onSave={handleSave}
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
    </div>
  )
}
