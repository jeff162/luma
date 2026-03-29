/**
 * RuleSuggestionToast — Non-intrusive "Create a rule?" prompt
 *
 * Appears after a transaction is manually categorized. Floats fixed
 * bottom-right, never steals focus, auto-dismisses after TIMEOUT_MS.
 *
 * Clicking "Create rule" opens a full-screen modal containing the shared
 * RuleForm component — same UI as the Rules page, pre-filled with the
 * merchant name as keyword and the chosen category as the action.
 *
 * After saving, the toast briefly shows a confirmation before dismissing.
 *
 * TRANSACTION DEFAULTS:
 *   When prompt.transactionData is provided, RuleForm will auto-populate
 *   the amount filter and debit/credit selector based on the transaction.
 */

import { useState, useEffect, useRef } from 'react'
import { api } from '../lib/api.js'
import { Badge } from './ui.jsx'
import RuleForm from './RuleForm.jsx'

const TIMEOUT_MS = 8000

// ── RuleModal — full-screen modal wrapping RuleForm ───────────────────────────

function RuleModal({ prompt, onSave, onCancel }) {
  const [categories, setCategories] = useState([])
  const [owners,     setOwners]     = useState([])
  const [accounts,   setAccounts]   = useState([])
  const [existingRule, setExistingRule] = useState(null)
  const [loading,    setLoading]    = useState(true)

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
    if (existingRule) {
      await api.updateRule(existingRule.id, ruleData)
      if (applyToExisting) {
        await api.recategorize()
      }
      onSave({ applyToExisting, ruleData, ruleId: existingRule.id, updatedExisting: true })
      return
    }

    const created = await api.createRule(ruleData)
    if (applyToExisting) {
      await api.applyRule(created.id)
    }
    onSave({ applyToExisting, ruleData, ruleId: created.id, updatedExisting: false })
  }

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 900,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(0,0,0,0.5)',
      }}
    >
      <div
        style={{
          background: 'var(--surface)', border: '1px solid var(--border)',
          borderRadius: 14, width: 540, maxWidth: '94vw', maxHeight: '90vh',
          overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,0.45)',
        }}
      >
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '16px 20px', borderBottom: '1px solid var(--border)',
        }}>
          <div style={{ fontSize: 15, fontWeight: 600 }}>⚙️ Create categorization rule</div>
          <button onClick={onCancel} style={{
            background: 'none', border: 'none', color: 'var(--muted)',
            cursor: 'pointer', fontSize: 20, lineHeight: 1, padding: 2,
          }}>×</button>
        </div>

        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--muted)' }}>Loading…</div>
        ) : (
          <RuleForm
            initialValues={{
              keyword: existingRule?.keyword ?? (prompt.keywordSource || prompt.merchantName || '').toLowerCase().trim(),
              amount_min: existingRule?.amount_min ?? null,
              amount_max: existingRule?.amount_max ?? null,
              owner_id: existingRule?.owner_id || '',
              account_id: existingRule?.account_id || '',
              cleanName: existingRule?.clean_name || '',
              catId: prompt.categoryId || existingRule?.category_id || '',
            }}
            categories={categories}
            owners={owners}
            accounts={accounts}
            onSave={handleSave}
            onCancel={onCancel}
            saveLabel={existingRule ? 'Save changes' : 'Save rule'}
            transactionData={prompt.transactionData}
          />
        )}
      </div>
    </div>
  )
}

// ── RuleSuggestionToast ───────────────────────────────────────────────────────

export default function RuleSuggestionToast({ prompt, onDismiss, onSaved }) {
  const [showModal, setShowModal] = useState(false)
  const [progress,  setProgress]  = useState(100)
  const [saved,     setSaved]     = useState(false)
  const [appliedExisting, setAppliedExisting] = useState(false)
  const [updatedExistingRule, setUpdatedExistingRule] = useState(false)
  const timerRef    = useRef(null)
  const intervalRef = useRef(null)
  const startRef    = useRef(Date.now())

  // Auto-dismiss countdown
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

  // Pause countdown while modal is open
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
    // Resume with 3s remaining
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
      {/* Toast */}
      <div style={{
        position: 'fixed', bottom: 28, right: 28, zIndex: 800,
        background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 12, boxShadow: '0 8px 32px rgba(0,0,0,0.35)',
        width: 320, overflow: 'hidden',
        animation: 'slideInToast 0.2s ease-out',
      }}>
        {/* Progress bar */}
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
                      color={prompt.categoryColor}
                      icon={prompt.categoryIcon}
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
