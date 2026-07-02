// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState, useEffect, useCallback, useId, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { api } from '../lib/api.js'
import { txnMutations } from '../lib/txnMutations.js'
import { Card, PageHeader, Button, Input, Badge, Spinner, EmptyState, AppDialog } from '../components/ui.jsx'
import PillGridTable from '../components/PillGridTable.jsx'
import StarterRulesDialog from '../components/StarterRulesDialog.jsx'
import RuleForm, { amountConditionSummary } from '../components/RuleForm.jsx'
import { TagBadge } from '../components/TagUi.jsx'
import { useRecategorize, RecategorizeButton, RecategorizeResultBanner } from '../components/RecategorizeControl.jsx'
import { ActionCountBadge } from '../components/importExport/importPresentational.jsx'
import { countPendingRuleSuggestions, hasRuleSuggestionWork } from '../lib/importExport/ruleSuggestionWork.js'

// Static, non-interactive columns: the rules list isn't sorted/reordered/resized by the user,
// it just needs the consistent table chrome and a pinned header. Sticky header is wired below
// via PillGridTable's `headerStyle`.
const RULE_COLUMNS = [
  { key: 'keyword', label: 'Keyword + Condition', width: 360, sortable: false, draggable: false, resizable: false },
  { key: 'action',  label: 'Action',              width: '1fr', sortable: false, draggable: false, resizable: false },
  { key: 'rowActions', label: '',                 width: 80,  sortable: false, draggable: false, resizable: false },
]

function describeRule(rule, owners, accounts) {
  const parts = []

  if (rule.amount_min != null || rule.amount_max != null || (rule.debit_credit && rule.debit_credit !== 'both')) {
    parts.push(amountConditionSummary(rule.amount_min, '>=', rule.amount_max, '<=', rule.debit_credit || 'both'))
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

  if (rule.match_source_text) {
    parts.push('matches source text')
  }

  return parts
}

function RuleRow({ rule, owners, accounts, onSave, onDelete, gridTemplateColumns }) {
  const [confirmDel,  setConfirmDel]  = useState(false)

  const conditions = describeRule(rule, owners, accounts)
  const hasConditions = conditions.length > 0

  return (
    <div style={{
      display: 'grid', gridTemplateColumns,
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
        {rule.category_name ? (
          <Badge
            label={rule.category_name}
            toneKey={rule.category_id || rule.category_name}
          />
        ) : null}

        {rule.clean_name && (
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>
            · rename to <span style={{ color: 'var(--text)', fontStyle: 'italic' }}>{rule.clean_name}</span>
          </span>
        )}
        {Array.isArray(rule.tags) && rule.tags.map(tag => (
          <TagBadge key={tag.id} tag={tag} />
        ))}
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
              style={{ background: 'var(--danger)', color: '#fff', border: 'none', borderRadius: 4, padding: '2px 7px', fontSize: 11, cursor: 'pointer', fontWeight: 600 }}
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
  const formRef = useRef(null)
  const [draftState, setDraftState] = useState({
    data: null,
    canSave: Boolean(rule?.keyword && (rule?.category_id || rule?.clean_name || rule?.tag_ids?.length)),
  })
  const [working, setWorking] = useState(false)
  const [error, setError] = useState('')

  if (!rule) return null

  async function handleSave() {
    const currentDraftState = formRef.current?.getDraftState?.() || draftState
    if (!currentDraftState.canSave || working) return
    setWorking(true)
    setError('')
    try {
      await onSave(currentDraftState.data)
    } catch (err) {
      setError(err.message || 'Failed to save rule')
      setWorking(false)
    }
  }

  const quietHeaderButtonStyle = {
    background: 'transparent',
    color: 'var(--muted)',
    border: '1px solid var(--border)',
    borderRadius: 8,
    padding: '5px 11px',
    fontSize: 12,
    fontWeight: 500,
    cursor: working ? 'not-allowed' : 'pointer',
    opacity: working ? 0.65 : 1,
  }
  const primaryHeaderButtonStyle = {
    background: draftState.canSave ? 'color-mix(in srgb, var(--accent) 12%, var(--surface))' : 'var(--surface)',
    color: draftState.canSave ? 'var(--accent2)' : 'var(--muted)',
    border: `1px solid ${draftState.canSave ? 'color-mix(in srgb, var(--accent) 40%, var(--border))' : 'var(--border)'}`,
    borderRadius: 8,
    padding: '5px 12px',
    fontSize: 12,
    fontWeight: 600,
    cursor: working || !draftState.canSave ? 'not-allowed' : 'pointer',
    opacity: working ? 0.65 : 1,
  }

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
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto', flexShrink: 0 }}>
            <button
              type="button"
              onClick={handleSave}
              disabled={working || !draftState.canSave}
              style={primaryHeaderButtonStyle}
            >
              {working ? 'Saving…' : 'Save changes'}
            </button>
            <button
              type="button"
              onClick={onCancel}
              disabled={working}
              style={quietHeaderButtonStyle}
            >
              Cancel
            </button>
          </div>
        </div>
        <div style={{ maxHeight: 'calc(100vh - 230px)', overflowY: 'auto' }}>
          {error ? (
            <div style={{ padding: '8px 20px 0', fontSize: 12, color: 'var(--danger)' }}>
              {error}
            </div>
          ) : null}
          <RuleForm
            ref={formRef}
            initialValues={{
              keyword: rule.keyword,
              amount_min: rule.amount_min ?? null,
              amount_max: rule.amount_max ?? null,
              debit_credit: rule.debit_credit || 'both',
              owner_id: rule.owner_id || '',
              account_id: rule.account_id || '',
              catId: rule.category_id,
              cleanName: rule.clean_name || '',
              tagIds: rule.tag_ids || [],
              match_source_text: !!rule.match_source_text,
            }}
            categories={categories}
            owners={owners}
            accounts={accounts}
            onSave={onSave}
            onCancel={onCancel}
            hideFooterActions
            onDraftChange={setDraftState}
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
  // Recent import batches, fetched only to drive the "Generate rules from imported data" entry button's
  // pending-suggestion count and dim state — the review itself lives on the Import / Export route.
  const [batches,    setBatches]    = useState([])
  const [loading,    setLoading]    = useState(true)
  const [search,     setSearch]     = useState('')
  const searchId = useId()
  const [showAdd,    setShowAdd]    = useState(false)
  const [showStarterRules, setShowStarterRules] = useState(false)
  const [editingRuleId, setEditingRuleId] = useState(null)
  // A pending rule save that collided with an existing same-matcher rule, awaiting the user's choice
  // (merge into it / open it / cancel). Shape: { status, existingRuleId, ruleData, applyToExisting }.
  const [collision, setCollision] = useState(null)
  const [createInitialValues, setCreateInitialValues] = useState({})
  const [createTransactionData, setCreateTransactionData] = useState(null)
  const {
    pendingCount: recategorizePendingCount,
    result: recategorizeResult,
    run: runRecategorize,
    reloadPreview: loadRecategorizePreview,
    dismissResult: dismissRecategorizeResult,
  } = useRecategorize()

  const loadRules = useCallback(() => {
    api.getRules(search || undefined).then(r => { setRules(r); setLoading(false) })
  }, [search])
  const loadCategories = useCallback(() => { api.getCategories().then(setCategories) }, [])

  useEffect(() => { loadRules() },      [loadRules])
  useEffect(() => { loadCategories() }, [loadCategories])
  useEffect(() => { api.getOwners().then(setOwners) }, [])
  useEffect(() => { api.getAccounts().then(setAccounts) }, [])
  useEffect(() => { api.listBatches().then(setBatches).catch(() => setBatches([])) }, [])

  const importedRuleSuggestionCount = countPendingRuleSuggestions(batches)
  const hasImportedRuleSuggestionWork = hasRuleSuggestionWork(batches)

  async function handleAdd(data) {
    const { applyToExisting, ...ruleData } = data
    // Default create only classifies a same-matcher collision (it doesn't write). On a collision we
    // ask the user rather than fork a duplicate; the add form stays open behind the dialog so they
    // can cancel and adjust scope instead.
    const created = await api.createRule(ruleData)
    if (created?.status && created.status !== 'created') {
      setCollision({ status: created.status, existingRuleId: created.existing_rule_id, ruleData, applyToExisting })
      return
    }
    if (applyToExisting) await txnMutations.applyRule(created.id)
    closeAddAfterSave()
  }

  function closeAddAfterSave() {
    setShowAdd(false)
    setCreateInitialValues({})
    setCreateTransactionData(null)
    loadRules()
    loadRecategorizePreview()
  }

  async function mergeCollision() {
    const { ruleData, applyToExisting, existingRuleId, fromEdit, editedRuleId } = collision
    if (fromEdit) {
      // Folds this rule's actions into the other rule and deletes this one (backend).
      await api.updateRule(editedRuleId, ruleData, { onExisting: 'merge' })
    } else {
      await api.createRule(ruleData, { onExisting: 'merge' })
    }
    if (applyToExisting && existingRuleId) await txnMutations.applyRule(existingRuleId)
    setCollision(null)
    if (fromEdit) {
      setEditingRuleId(null)
      loadRules()
      loadRecategorizePreview()
    } else {
      closeAddAfterSave()
    }
  }

  function openExistingFromCollision() {
    const id = collision.existingRuleId
    setCollision(null)
    setShowAdd(false)
    setCreateInitialValues({})
    setCreateTransactionData(null)
    setEditingRuleId(id)
  }

  async function handleEditSave(data) {
    const { applyToExisting, ...ruleData } = data
    // An edit can make this rule's matcher collide with another rule. Default update only classifies;
    // we ask before merging (which removes this rule) or surfacing a conflict.
    const result = await api.updateRule(editingRuleId, ruleData)
    if (result?.status && result.status !== 'updated') {
      setCollision({ status: result.status, existingRuleId: result.existing_rule_id, ruleData, applyToExisting, fromEdit: true, editedRuleId: editingRuleId })
      return
    }
    if (applyToExisting) await txnMutations.applyRule(editingRuleId)
    setEditingRuleId(null)
    loadRules()
    loadRecategorizePreview()
  }

  async function handleDelete(id) {
    await api.deleteRule(id)
    if (editingRuleId === id) setEditingRuleId(null)
    loadRules()
    loadRecategorizePreview()
  }

  const editingRule = editingRuleId ? rules.find(rule => rule.id === editingRuleId) : null
  const showCreateForm = showAdd
  const showAnyEditor = showAdd || !!editingRule
  const addRuleButtonStyle = {
    background: showAnyEditor
      ? 'color-mix(in srgb, var(--surface2) 82%, var(--accent) 6%)'
      : 'color-mix(in srgb, var(--accent) 88%, black 8%)',
    boxShadow: showAnyEditor
      ? '0 8px 18px rgba(0,0,0,0.10)'
      : '0 10px 22px rgba(0,0,0,0.12)',
  }

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
          <RecategorizeButton pendingCount={recategorizePendingCount} onRun={runRecategorize} />
          <Button
            small
            variant="ghost"
            onClick={() => navigate('/import-export/rule-suggestions', { state: { backTo: '/rules', backLabel: 'Rules' } })}
            disabled={!hasImportedRuleSuggestionWork}
            title={hasImportedRuleSuggestionWork
              ? 'Review rules suggested from your imported transactions'
              : 'Mark a categorized import as clean to generate rule suggestions'}
            style={hasImportedRuleSuggestionWork
              ? {
                background: 'color-mix(in srgb, var(--surface2) 70%, var(--accent) 5%)',
                border: '1px solid color-mix(in srgb, var(--accent2) 18%, var(--border))',
                boxShadow: '0 1px 0 rgba(255,255,255,0.03), 0 4px 12px rgba(0,0,0,0.07)',
              }
              : {
                background: 'color-mix(in srgb, var(--surface2) 82%, var(--surface))',
                color: 'color-mix(in srgb, var(--muted) 88%, var(--text) 12%)',
                border: '1px solid color-mix(in srgb, var(--border) 92%, transparent)',
                boxShadow: 'none',
              }}
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              <span>Generate rules from imported data</span>
              <ActionCountBadge count={importedRuleSuggestionCount} />
            </span>
          </Button>
          {/* Empty-state-only, like the Categories starter offer: a head start shown only while there
              are no rules yet. Once any rule exists it's gone (add more via "Add rule"). */}
          {!loading && rules.length === 0 ? (
            <Button
              small
              variant="ghost"
              onClick={() => setShowStarterRules(true)}
              title="Add a curated set of common keyword → category rules"
            >
              Starter rules
            </Button>
          ) : null}
          <Button small onClick={() => (showAnyEditor ? closeForm() : openCreateForm())} style={addRuleButtonStyle}>
            {showAnyEditor ? 'Cancel' : 'Add rule'}
          </Button>
        </PageHeader>
      </div>

      <RecategorizeResultBanner
        result={recategorizeResult}
        onDismiss={dismissRecategorizeResult}
        style={{ margin: '12px 32px 0' }}
      />

      <div style={{
        padding: '8px 32px', flexShrink: 0,
        borderBottom: '1px solid var(--border)',
        background: 'var(--surface)',
        display: 'flex', alignItems: 'center', gap: 12,
      }}>
        {/* Visually-hidden but real <label htmlFor> — Chrome's "no label associated" check wants an
            actual label association (a placeholder/aria-label alone doesn't satisfy it). */}
        <label htmlFor={searchId} style={{
          position: 'absolute', width: 1, height: 1, padding: 0, margin: -1,
          overflow: 'hidden', clip: 'rect(0, 0, 0, 0)', whiteSpace: 'nowrap', border: 0,
        }}>
          Filter rules by keyword
        </label>
        <Input id={searchId} value={search} onChange={setSearch} placeholder="Filter by keyword…" style={{ width: 280 }} />
        <span style={{ fontSize: 12, color: 'var(--muted)', marginLeft: 'auto' }}>
          {rules.length} rule{rules.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* No padding-top on this scroll container — the rules Card's sticky header references
          top: 0 of the scrollport, and any padding-top here would leave a band above the
          pinned header where scrolling rows are visible. */}
      <div data-browser-context-passthrough="true" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 32px 32px' }}>
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

        <Card style={{ padding: 0 }}>
          <PillGridTable
            columns={RULE_COLUMNS}
            headerStyle={{
              padding: '8px 16px',
              background: 'var(--surface)',
              borderBottom: '1px solid var(--border)',
              position: 'sticky',
              top: 0,
              zIndex: 2,
            }}
            renderBody={({ gridTemplateColumns }) => (
              loading ? <Spinner /> : rules.length === 0 ? (
                <EmptyState message={search ? 'No rules match that keyword' : 'No rules yet — click "Add rule" to create one'} />
              ) : (
                <div>
                  {rules.map(rule => (
                    <RuleRow
                      key={rule.id}
                      rule={rule}
                      owners={owners}
                      accounts={accounts}
                      onSave={openEditForm}
                      onDelete={handleDelete}
                      gridTemplateColumns={gridTemplateColumns}
                    />
                  ))}
                </div>
              )
            )}
          />
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

      {collision ? (
        <AppDialog
          title={collision.fromEdit ? 'This edit matches another rule' : 'A rule for this already exists'}
          description={
            collision.status === 'conflict'
              ? `Another rule matches the same merchant and scope but assigns a different category. Open it to edit, ${collision.fromEdit ? 'delete one of the two,' : ''} or narrow this rule’s scope (owner, account, or amount) so they don’t overlap.`
              : collision.fromEdit
              ? (collision.status === 'duplicate'
                ? 'This rule is now identical to another rule. You can remove this one and keep the other.'
                : 'This edit makes the rule match the same merchant and scope as another rule. Fold your changes into it — this rule will then be removed.')
              : collision.status === 'mergeable'
              ? 'Another rule already matches the same merchant and scope. Your changes can be folded into it instead of creating a second rule.'
              : 'An identical rule already exists, so nothing was created. Open it to review or edit.'
          }
          borderColor={collision.status === 'conflict' ? 'var(--danger)' : 'var(--border)'}
          onClose={() => setCollision(null)}
          actions={(
            <>
              <Button variant="ghost" onClick={() => setCollision(null)}>Cancel</Button>
              <Button variant="ghost" onClick={openExistingFromCollision}>Open the other rule</Button>
              {(collision.status === 'mergeable' || (collision.fromEdit && collision.status === 'duplicate')) ? (
                <Button onClick={mergeCollision}>
                  {collision.fromEdit ? (collision.status === 'duplicate' ? 'Remove this rule' : 'Merge & remove this rule') : 'Add to existing rule'}
                </Button>
              ) : null}
            </>
          )}
        />
      ) : null}

      {showStarterRules ? (
        <StarterRulesDialog
          onClose={() => setShowStarterRules(false)}
          onAdded={() => {
            loadRules()
            loadRecategorizePreview()
          }}
        />
      ) : null}
    </div>
  )
}
