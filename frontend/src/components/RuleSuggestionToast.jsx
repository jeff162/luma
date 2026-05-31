// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: GPL-3.0-or-later

import { useState, useEffect, useRef } from 'react'
import { api } from '../lib/api.js'
import { txnMutations } from '../lib/txnMutations.js'
import { Badge, OverlayBackdrop, FloatingPanel, FloatingPanelHeader } from './ui.jsx'
import RuleForm from './RuleForm.jsx'

const TIMEOUT_MS = 8000

/*
 * This prompt is intentionally low-commitment: it rides on the moment right after a manual recategorization,
 * lets the user ignore it without losing flow, and only expands into full rule editing if they opt in.
 */

function RuleModal({ prompt, onSave, onCancel }) {
  const [categories, setCategories] = useState([])
  const [owners,     setOwners]     = useState([])
  const [accounts,   setAccounts]   = useState([])
  const [existingRule, setExistingRule] = useState(null)
  const [loading,    setLoading]    = useState(true)
  const [error,      setError]      = useState('')
  // A save that collided with another rule on the same matcher and is awaiting the user's confirm to
  // merge. Shape: { ruleData, applyToExisting, existingRuleId }.
  const [pendingMerge, setPendingMerge] = useState(null)

  useEffect(() => {
    let cancelled = false

    Promise.all([
      api.getCategories(),
      api.getOwners(),
      api.getAccounts(),
      prompt.transactionId ? api.getMatchingRuleForTransaction(prompt.transactionId) : Promise.resolve({ rule_id: null }),
    ]).then(async ([cats, own, acc, match]) => {
      if (cancelled) return
      setCategories(cats)
      setOwners(own)
      setAccounts(acc)

      if (match?.rule_id) {
        // Reopen the existing rule when one already matched this transaction so we do not encourage duplicate rules for the same pattern.
        const rules = await api.getRules()
        if (cancelled) return
        setExistingRule(rules.find(rule => rule.id === match.rule_id) || null)
      }

      if (!cancelled) setLoading(false)
    }).catch(() => {
      if (!cancelled) setLoading(false)
    })

    return () => { cancelled = true }
  }, [prompt.transactionId])

  async function handleSave(data) {
    const { applyToExisting, ...ruleData } = data
    setError('')
    if (existingRule) {
      // Editing the matched rule can make it collide with a different rule; reconcile the same way
      // (merge folds this rule into the other and removes it).
      const updated = await api.updateRule(existingRule.id, ruleData)
      if (updated?.status === 'conflict') {
        setError('Your changes make this match another rule that assigns a different category. Edit that rule instead, or narrow the scope.')
        return
      }
      if (updated?.status === 'mergeable' || updated?.status === 'duplicate') {
        setPendingMerge({ ruleData, applyToExisting, existingRuleId: updated.existing_rule_id, fromEdit: true, editedRuleId: existingRule.id })
        return
      }
      if (applyToExisting) {
        await txnMutations.applyRule(existingRule.id)
      }
      onSave({ applyToExisting, ruleData, ruleId: existingRule.id, updatedExisting: true })
      return
    }

    // No rule matched this transaction, but the proposed matcher may still collide with another rule.
    // Default create only classifies (it doesn't write): a conflict (different category on the same
    // matcher) is surfaced so the user edits that rule instead; a mergeable save asks before folding
    // in; a pure duplicate already exists, so we just resolve to it.
    setError('')
    const created = await api.createRule(ruleData)
    if (created?.status === 'conflict') {
      setError('Another rule already matches this merchant and scope but assigns a different category. Edit that rule instead, or narrow this one’s scope.')
      return
    }
    if (created?.status === 'mergeable') {
      setPendingMerge({ ruleData, applyToExisting, existingRuleId: created.existing_rule_id })
      return
    }
    // 'created' (new rule) or 'duplicate' (already exists — resolve to it).
    const ruleId = created?.id
    if (applyToExisting && ruleId) {
      await txnMutations.applyRule(ruleId)
    }
    onSave({ applyToExisting, ruleData, ruleId, updatedExisting: created?.status === 'duplicate' })
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
    onSave({ applyToExisting, ruleData, ruleId: existingRuleId, updatedExisting: true })
  }

  return (
    <OverlayBackdrop zIndex={900} tint="rgba(0,0,0,0.5)" blur={0}>
      <FloatingPanel style={{ width: 540, maxWidth: '94vw', maxHeight: '90vh', overflowY: 'auto' }}>
        <FloatingPanelHeader style={{ padding: '16px 20px' }}>
          <div style={{ fontSize: 15, fontWeight: 600 }}>⚙️ Create categorization rule</div>
          <button onClick={onCancel} style={{
            background: 'none', border: 'none', color: 'var(--muted)',
            cursor: 'pointer', fontSize: 20, lineHeight: 1, padding: 2,
          }}>×</button>
        </FloatingPanelHeader>

        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--muted)' }}>Loading…</div>
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
                ? 'Your changes make this match another rule. Fold them into it? This rule will then be removed.'
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
            initialValues={{
              keyword: existingRule?.keyword ?? (prompt.keywordSource || prompt.merchantName || '').toLowerCase().trim(),
              amount_min: existingRule?.amount_min ?? null,
              amount_max: existingRule?.amount_max ?? null,
              owner_id: existingRule?.owner_id || '',
              account_id: existingRule?.account_id || '',
              cleanName: existingRule?.clean_name || '',
              catId: prompt.categoryId || existingRule?.category_id || '',
              tagIds: existingRule?.tag_ids || [],
            }}
            categories={categories}
            owners={owners}
            accounts={accounts}
            onSave={handleSave}
            onCancel={onCancel}
            saveLabel={existingRule ? 'Save changes' : 'Save rule'}
            transactionData={prompt.transactionData}
          />
          </>
        )}
      </FloatingPanel>
    </OverlayBackdrop>
  )
}

export default function RuleSuggestionToast({ prompt, onDismiss, onSaved }) {
  const [showModal, setShowModal] = useState(false)
  const [progress,  setProgress]  = useState(100)
  const [saved,     setSaved]     = useState(false)
  const [appliedExisting, setAppliedExisting] = useState(false)
  const [updatedExistingRule, setUpdatedExistingRule] = useState(false)
  const timerRef    = useRef(null)
  const intervalRef = useRef(null)
  const startRef    = useRef(Date.now())

  useEffect(() => {
    startRef.current = Date.now()
    intervalRef.current = setInterval(() => {
      const pct = Math.max(0, 100 - ((Date.now() - startRef.current) / TIMEOUT_MS) * 100)
      setProgress(pct)
    }, 50)
    timerRef.current = setTimeout(onDismiss, TIMEOUT_MS)

    return () => { clearTimeout(timerRef.current); clearInterval(intervalRef.current) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (showModal) {
      clearTimeout(timerRef.current)
      clearInterval(intervalRef.current)
    }
  }, [showModal])

  function handleSaved(result) {
    setSaved(true)
    setAppliedExisting(!!result?.applyToExisting)
    setUpdatedExistingRule(!!result?.updatedExisting)
    setShowModal(false)
    onSaved?.(result)
    setTimeout(onDismiss, 1800)
  }

  function handleCancel() {
    setShowModal(false)
    // Give the user a short grace period after closing the modal so the suggestion does not disappear immediately.
    clearTimeout(timerRef.current)
    clearInterval(intervalRef.current)
    startRef.current = Date.now() - (TIMEOUT_MS - 3000)
    intervalRef.current = setInterval(() => {
      const pct = Math.max(0, 100 - ((Date.now() - startRef.current) / TIMEOUT_MS) * 100)
      setProgress(pct)
    }, 50)
    timerRef.current = setTimeout(onDismiss, 3000)
  }

  const merchantDisplay = prompt.merchantName || 'this merchant'

  return (
    <>
      <div style={{
        position: 'fixed', bottom: 28, right: 28, zIndex: 800,
        background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 12, boxShadow: '0 8px 32px rgba(0,0,0,0.35)',
        width: 320, overflow: 'hidden',
        animation: 'slideInToast 0.2s ease-out',
      }}>
        <div style={{ height: 3, background: 'var(--surface2)' }}>
          <div style={{
            height: '100%', background: 'var(--accent)',
            width: `${progress}%`, transition: 'width 0.1s linear',
          }} />
        </div>

        <div style={{ padding: '14px 16px' }}>
          {saved ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 18 }}>✅</span>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600 }}>Rule created!</div>
                <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
                  {updatedExistingRule
                    ? (appliedExisting
                        ? `The existing ${merchantDisplay} rule was updated and reapplied`
                        : `The existing ${merchantDisplay} rule was updated`)
                    : (appliedExisting
                        ? `Matching existing ${merchantDisplay} transactions were updated too`
                        : `Future ${merchantDisplay} transactions will be updated automatically`)}
                </div>
              </div>
            </div>
          ) : (
            <>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 12 }}>
                <span style={{ fontSize: 18, flexShrink: 0, marginTop: 1 }}>⚙️</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 3 }}>Create a rule?</div>
                  <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.4 }}>
                    Auto-categorize future{' '}
                    <span style={{ fontWeight: 500, color: 'var(--text)' }}>{merchantDisplay}</span>{' '}
                    transactions as{' '}
                    <Badge
                      label={prompt.categoryName}
                      toneKey={prompt.categoryId || prompt.categoryName}
                    />
                  </div>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 7 }}>
                <button onClick={() => setShowModal(true)} style={{
                  flex: 1, background: 'var(--accent)', color: '#fff',
                  border: 'none', borderRadius: 7, padding: '7px 0',
                  fontSize: 13, fontWeight: 500, cursor: 'pointer',
                }}>Create rule</button>
                <button onClick={onDismiss} style={{
                  background: 'var(--surface2)', color: 'var(--muted)',
                  border: '1px solid var(--border)', borderRadius: 7,
                  padding: '7px 11px', fontSize: 12, cursor: 'pointer',
                }}>Dismiss</button>
              </div>
            </>
          )}
        </div>
      </div>

      {showModal && (
        <RuleModal prompt={prompt} onSave={handleSaved} onCancel={handleCancel} />
      )}

      <style>{`
        @keyframes slideInToast {
          from { transform: translateY(20px); opacity: 0; }
          to   { transform: translateY(0);    opacity: 1; }
        }
      `}</style>
    </>
  )
}
