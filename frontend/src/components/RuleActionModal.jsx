// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * The create / edit-matching-rule modal launched from a transaction's right-click menu. It is
 * shared so every transaction surface (the Transactions ledger and every report list built on
 * TransactionListTable) opens the same rule editor rather than re-implementing the conflict /
 * merge handling. `state` is { mode: 'create', txnId, categoryId, keywordSource, transactionData }
 * or { mode: 'edit', ruleId, txnId }; `onSaved` lets the host reconcile after a save/apply.
 */

import { useState, useEffect } from 'react'
import { api } from '../lib/api.js'
import { txnMutations } from '../lib/txnMutations.js'
import RuleForm from './RuleForm.jsx'
import { OverlayBackdrop, FloatingPanel, FloatingPanelHeader } from './ui.jsx'

export default function RuleActionModal({ state, onClose, onSaved }) {
  const [categories, setCategories] = useState([])
  const [owners, setOwners] = useState([])
  const [accounts, setAccounts] = useState([])
  const [rule, setRule] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  // A save that collided with another rule on the same matcher, awaiting confirm to merge.
  const [pendingMerge, setPendingMerge] = useState(null)

  useEffect(() => {
    if (!state) return
    let cancelled = false
    async function loadModalData() {
      try {
        const [cats, own, acc, rules] = await Promise.all([
          api.getCategories(),
          api.getOwners(),
          api.getAccounts(),
          state.mode === 'edit' ? api.getRules() : Promise.resolve([]),
        ])
        if (cancelled) return
        setCategories(cats)
        setOwners(own)
        setAccounts(acc)
        setRule(state.mode === 'edit' ? rules.find(item => item.id === state.ruleId) || null : null)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    loadModalData()
    return () => { cancelled = true }
  }, [state])

  if (!state) return null

  const conflictMessage = 'Another rule already matches this merchant and scope but assigns a different category. Edit that rule instead, or narrow this one’s scope.'

  async function handleSave(data) {
    const { applyToExisting, ...ruleData } = data
    setError('')
    if (state.mode === 'edit') {
      // An edit can make this rule collide with another. Default update only classifies; merging
      // folds this rule into the other and removes this one, so we ask first.
      const updated = await api.updateRule(state.ruleId, ruleData)
      if (updated?.status === 'conflict') {
        setError(conflictMessage)
        return
      }
      if (updated?.status === 'mergeable' || updated?.status === 'duplicate') {
        setPendingMerge({ ruleData, applyToExisting, existingRuleId: updated.existing_rule_id, fromEdit: true, editedRuleId: state.ruleId })
        return
      }
      if (applyToExisting) await txnMutations.applyRule(state.ruleId)
      onSaved?.({ applyToExisting, mode: 'edit', ruleId: state.ruleId })
      onClose()
      return
    }

    // Default create only classifies a same-matcher collision (it doesn't write): a conflict is
    // surfaced so the user edits that rule instead; a mergeable save asks before folding in; a
    // duplicate already exists, so we resolve to it.
    const created = await api.createRule(ruleData)
    if (created?.status === 'conflict') {
      setError(conflictMessage)
      return
    }
    if (created?.status === 'mergeable') {
      setPendingMerge({ ruleData, applyToExisting, existingRuleId: created.existing_rule_id })
      return
    }
    // A rule with this exact matcher already exists (nothing to add category-wise), but turning it
    // recurring is purely additive — apply it to that rule so "Mark as recurring" isn't a silent no-op.
    if (created?.status === 'duplicate' && ruleData.is_recurring) {
      await api.createRule(ruleData, { onExisting: 'merge' })
      onSaved?.({ applyToExisting, mode: 'create', ruleId: created.existing_rule_id })
      onClose()
      return
    }
    if (applyToExisting && created?.id) {
      await txnMutations.applyRule(created.id)
    }
    onSaved?.({ applyToExisting, mode: 'create', ruleId: created?.id })
    onClose()
  }

  async function confirmMerge() {
    const { ruleData, applyToExisting, existingRuleId, fromEdit, editedRuleId } = pendingMerge
    if (fromEdit) {
      await api.updateRule(editedRuleId, ruleData, { onExisting: 'merge' })
    } else {
      await api.createRule(ruleData, { onExisting: 'merge' })
    }
    if (applyToExisting && existingRuleId) {
      await txnMutations.applyRule(existingRuleId)
    }
    setPendingMerge(null)
    onSaved?.({ applyToExisting, mode: fromEdit ? 'edit' : 'create', ruleId: existingRuleId })
    onClose()
  }

  const initialValues = state.mode === 'edit'
    ? (rule ? {
      keyword: rule.keyword,
      amount_min: rule.amount_min ?? null,
      amount_max: rule.amount_max ?? null,
      debit_credit: rule.debit_credit || 'both',
      owner_id: rule.owner_id || '',
      account_id: rule.account_id || '',
      catId: rule.category_id,
      cleanName: rule.clean_name || '',
      tagIds: rule.tag_ids || [],
      is_recurring: !!rule.is_recurring,
      cadence: rule.recurring_cadence || 'monthly',
    } : null)
    : {
      keyword: (state.keywordSource || '').toLowerCase().trim(),
      cleanName: '',
      catId: state.categoryId || '',
      tagIds: [],
      // Opened via "Mark as recurring…": pre-check the recurring box so the action is one step.
      is_recurring: !!state.recurringDefault,
      cadence: 'monthly',
    }

  return (
    <OverlayBackdrop zIndex={950} tint="rgba(10, 15, 26, 0.32)">
      <FloatingPanel style={{ width: 640, maxWidth: '94vw', maxHeight: '90vh' }}>
        <FloatingPanelHeader style={{ padding: '14px 20px' }}>
          <div style={{ fontSize: 15, fontWeight: 600 }}>
            {state.mode === 'edit'
              ? (rule?.is_recurring ? 'Edit recurring rule' : 'Edit matching rule')
              : (state.recurringDefault ? 'Mark as recurring' : 'Create rule')}
          </div>
          <button onClick={onClose} style={{
            background: 'none', border: 'none', color: 'var(--muted)',
            cursor: 'pointer', fontSize: 20, lineHeight: 1, padding: 2,
          }}>×</button>
        </FloatingPanelHeader>
        <div style={{ maxHeight: 'calc(90vh - 56px)', overflowY: 'auto' }}>
          {loading || !initialValues ? (
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--muted)' }}>
              {state.mode === 'edit' ? 'Loading rule…' : 'Loading…'}
            </div>
          ) : (
            <>
              {error ? (
                <div style={{
                  margin: '12px 20px 0', padding: '10px 12px', borderRadius: 8,
                  border: '1px solid var(--danger)', background: 'color-mix(in srgb, var(--danger) 10%, transparent)',
                  color: 'var(--danger)', fontSize: 13, lineHeight: 1.5,
                }}>
                  {error}
                </div>
              ) : null}
              {pendingMerge ? (
                <div style={{
                  margin: '12px 20px 0', padding: '10px 12px', borderRadius: 8,
                  border: '1px solid var(--border)', background: 'var(--surface2)',
                  fontSize: 13, lineHeight: 1.5, display: 'flex', flexDirection: 'column', gap: 8,
                }}>
                  <span>{pendingMerge.fromEdit
                    ? 'This edit makes the rule match another rule. Fold your changes into it? This rule will then be removed.'
                    : 'A rule already matches this merchant and scope. Add your changes to it instead of creating a second rule?'}</span>
                  <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                    <button onClick={() => setPendingMerge(null)} style={{
                      background: 'none', border: '1px solid var(--border)', borderRadius: 6,
                      padding: '5px 12px', fontSize: 13, cursor: 'pointer', color: 'var(--text)',
                    }}>Cancel</button>
                    <button onClick={confirmMerge} style={{
                      background: 'var(--accent)', border: 'none', borderRadius: 6,
                      padding: '5px 12px', fontSize: 13, cursor: 'pointer', color: '#fff',
                    }}>Add to existing rule</button>
                  </div>
                </div>
              ) : null}
              <RuleForm
                initialValues={initialValues}
                categories={categories}
                owners={owners}
                accounts={accounts}
                onSave={handleSave}
                onCancel={onClose}
                saveLabel={state.mode === 'edit' ? 'Save changes' : 'Save rule'}
                transactionData={state.mode === 'create' ? state.transactionData : null}
              />
            </>
          )}
        </div>
      </FloatingPanel>
    </OverlayBackdrop>
  )
}
