// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { Card, PageHeader, Button, Spinner } from '../components/ui.jsx'
import ImportRuleSuggestionReview from '../components/ImportRuleSuggestionReview.jsx'
import { api } from '../lib/api.js'
import { useUserPreference } from '../lib/UserPreferencesContext.jsx'

const IMPORT_RULE_MERCHANT_FILTER_OPEN_PREF_KEY = 'ui.importRuleSuggestions.merchantFilterOpen'
const IMPORT_RULE_OWNER_FILTER_OPEN_PREF_KEY = 'ui.importRuleSuggestions.ownerFilterOpen'

function formatImportSummary(batch) {
  if (!batch) return ''
  const parts = []
  if (batch.row_count != null) parts.push(`${batch.row_count} rows`)
  if (batch.skipped_count) parts.push(`${batch.skipped_count} skipped`)
  if (batch.deduped_count) parts.push(`${batch.deduped_count} deduped`)
  return parts.join(' · ')
}

function formatImportedAt(value) {
  return value ? value.slice(0, 16).replace('T', ' ') : ''
}

function buildReviewSummary(suggestions) {
  return {
    total_count: suggestions.length,
    pending_count: suggestions.filter(suggestion => suggestion.review_status === 'pending').length,
    accepted_count: suggestions.filter(suggestion => suggestion.review_status === 'accepted').length,
    skipped_count: suggestions.filter(suggestion => suggestion.review_status === 'skipped').length,
    discarded_count: suggestions.filter(suggestion => suggestion.review_status === 'discarded').length,
  }
}

export default function ImportRuleSuggestions() {
  const { batchId } = useParams()
  const navigate = useNavigate()
  const [owners, setOwners] = useState([])
  const [accounts, setAccounts] = useState([])
  const [categories, setCategories] = useState([])
  const [batches, setBatches] = useState([])
  const [loadingBatchContext, setLoadingBatchContext] = useState(true)
  const [batchContextError, setBatchContextError] = useState('')
  const [ruleSuggestionState, setRuleSuggestionState] = useState({
    loading: false,
    error: '',
    suggestions: [],
    present_owner_ids: [],
    requires_owner_resolution: false,
    unowned_accounts: [],
    review_summary: null,
    generated_at: null,
  })
  // Owner resolution is intentionally one-at-a-time: ambiguous imports need a
  // single ownership lens before the suggested rules are meaningful.
  const [selectedOwnerIds, setSelectedOwnerIds] = useState([])
  const [editingSuggestionId, setEditingSuggestionId] = useState(null)
  const [reviewFilter, setReviewFilter] = useState('pending')
  const [merchantFilterOpen, setMerchantFilterOpen] = useUserPreference(IMPORT_RULE_MERCHANT_FILTER_OPEN_PREF_KEY, true)
  const [ownerFilterOpen, setOwnerFilterOpen] = useUserPreference(IMPORT_RULE_OWNER_FILTER_OPEN_PREF_KEY, false)
  const [undoStack, setUndoStack] = useState([])
  const MAX_UNDO = 10

  const batch = useMemo(
    () => batches.find(item => item.id === batchId) || null,
    [batches, batchId],
  )

  useEffect(() => {
    let cancelled = false
    setLoadingBatchContext(true)
    setBatchContextError('')

    Promise.all([
      api.getOwners(),
      api.getAccounts(),
      api.getCategories(),
      api.listBatches(),
    ]).then(([nextOwners, nextAccounts, nextCategories, nextBatches]) => {
      if (cancelled) return
      setOwners(nextOwners)
      setAccounts(nextAccounts)
      setCategories(nextCategories)
      setBatches(nextBatches)
    }).catch(err => {
      if (cancelled) return
      setBatchContextError(err.message || 'Unable to load import context.')
    }).finally(() => {
      if (cancelled) return
      setLoadingBatchContext(false)
    })

    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    let cancelled = false
    if (!batchId) return undefined

    async function loadRuleSuggestions() {
      setRuleSuggestionState(prev => ({ ...prev, loading: true, error: '' }))
      try {
        const result = await api.getBatchRuleSuggestions(batchId, selectedOwnerIds)
        if (cancelled) return
        setRuleSuggestionState({
          loading: false,
          error: '',
          suggestions: result.suggestions || [],
          present_owner_ids: result.present_owner_ids || [],
          requires_owner_resolution: !!result.requires_owner_resolution,
          unowned_accounts: result.unowned_accounts || [],
          review_summary: result.review_summary || null,
          generated_at: result.generated_at || null,
        })
      } catch (err) {
        if (cancelled) return
        setRuleSuggestionState({
          loading: false,
          error: err.message || 'Unable to load rule suggestions.',
          suggestions: [],
          present_owner_ids: [],
          requires_owner_resolution: false,
          unowned_accounts: [],
          review_summary: null,
          generated_at: null,
        })
      }
    }

    loadRuleSuggestions()
    return () => { cancelled = true }
  }, [batchId, selectedOwnerIds])

  useEffect(() => {
    const availableOwnerIds = new Set(owners.map(owner => owner.id))
    if (selectedOwnerIds.some(ownerId => !availableOwnerIds.has(ownerId))) {
      setSelectedOwnerIds([])
    }
  }, [owners, selectedOwnerIds])

  function toggleOwner(ownerId) {
    setEditingSuggestionId(null)
    setSelectedOwnerIds(prev => (
      prev.includes(ownerId) ? [] : [ownerId]
    ))
  }

  async function reloadSuggestions() {
    const result = await api.getBatchRuleSuggestions(batchId, selectedOwnerIds)
    setRuleSuggestionState({
      loading: false,
      error: '',
      suggestions: result.suggestions || [],
      present_owner_ids: result.present_owner_ids || [],
      requires_owner_resolution: !!result.requires_owner_resolution,
      unowned_accounts: result.unowned_accounts || [],
      review_summary: result.review_summary || null,
      generated_at: result.generated_at || null,
    })
  }

  function applyLocalSuggestionUpdates(updatesById, options = {}) {
    setRuleSuggestionState(prev => {
      const nextSuggestions = prev.suggestions.map(suggestion => (
        Object.prototype.hasOwnProperty.call(updatesById, suggestion.id)
          ? { ...suggestion, ...updatesById[suggestion.id] }
          : suggestion
      ))
      return {
        ...prev,
        loading: false,
        error: '',
        suggestions: nextSuggestions,
        review_summary: options.review_summary || buildReviewSummary(nextSuggestions),
        generated_at: options.generated_at || prev.generated_at,
      }
    })
  }

  function pushUndo(suggestionIds) {
    const idSet = new Set(suggestionIds)
    const snapshot = {}
    for (const s of ruleSuggestionState.suggestions) {
      if (idSet.has(s.id)) {
        snapshot[s.id] = { review_status: s.review_status, rule_id: s.rule_id ?? null }
      }
    }
    setUndoStack(prev => [...prev.slice(-(MAX_UNDO - 1)), snapshot])
  }

  async function performUndo() {
    if (undoStack.length === 0) return
    const snapshot = undoStack[undoStack.length - 1]
    setUndoStack(prev => prev.slice(0, -1))
    // Accepted suggestions may have created or linked rules, so undo has to replay
    // the server-side review state instead of only rolling back local UI state.
    for (const [suggestionId, prev] of Object.entries(snapshot)) {
      await api.updateBatchRuleSuggestionReview(batchId, {
        suggestion_id: suggestionId,
        status: prev.review_status,
      }).catch(() => {})
    }
    await reloadSuggestions()
  }

  function getCategoryName(categoryId) {
    return categories.find(category => String(category.id) === String(categoryId))?.name || null
  }

  async function setSuggestionStatus(suggestion, status) {
    setEditingSuggestionId(null)
    pushUndo([suggestion.id])
    const result = await api.updateBatchRuleSuggestionReview(batchId, {
      suggestion_id: suggestion.id,
      status,
      merchant_label: suggestion.merchant_label,
      target_category_name: suggestion.target_category_name,
      keyword: suggestion.keyword,
    })
    applyLocalSuggestionUpdates({
      [suggestion.id]: { review_status: status },
    }, {
      review_summary: result.review_summary || undefined,
      generated_at: result.generated_at || undefined,
    })
  }

  async function setSuggestionStatusBulk(suggestions, status) {
    setEditingSuggestionId(null)
    setRuleSuggestionState(prev => ({ ...prev, error: '' }))
    pushUndo(suggestions.map(s => s.id))
    try {
      let lastResult = null
      for (const suggestion of suggestions) {
        lastResult = await api.updateBatchRuleSuggestionReview(batchId, {
          suggestion_id: suggestion.id,
          status,
          merchant_label: suggestion.merchant_label,
          target_category_name: suggestion.target_category_name,
          keyword: suggestion.keyword,
        })
      }
      const updatesById = Object.fromEntries(
        suggestions.map(suggestion => [suggestion.id, { review_status: status }]),
      )
      applyLocalSuggestionUpdates(updatesById, {
        review_summary: lastResult?.review_summary || undefined,
        generated_at: lastResult?.generated_at || undefined,
      })
    } catch (err) {
      setRuleSuggestionState(prev => ({
        ...prev,
        loading: false,
        error: err.message || 'Unable to update selected suggestions.',
      }))
    }
  }

  async function saveSuggestion(suggestion, data) {
    const { applyToExisting, ...ruleData } = data
    pushUndo([suggestion.id])
    const createdRule = await api.createRule(ruleData)
    const result = await api.updateBatchRuleSuggestionReview(batchId, {
      suggestion_id: suggestion.id,
      status: 'accepted',
      rule_id: createdRule?.id || null,
      merchant_label: suggestion.merchant_label,
      target_category_name: suggestion.target_category_name,
      keyword: suggestion.keyword,
    })
    if (applyToExisting) await api.recategorize()
    setEditingSuggestionId(null)
    applyLocalSuggestionUpdates({
      [suggestion.id]: {
        review_status: 'accepted',
        rule_id: createdRule?.id || null,
        keyword: data.keyword,
        target_category_id: data.category_id || null,
        target_category_name: data.category_id ? getCategoryName(data.category_id) : null,
        amount_min: data.amount_min,
        amount_max: data.amount_max,
        clean_name_suggestion: data.clean_name || null,
        owner_id: data.owner_id || null,
        account_id: data.account_id || null,
      },
    }, {
      review_summary: result.review_summary || undefined,
      generated_at: result.generated_at || undefined,
    })
  }

  async function saveAcceptedSuggestion(suggestion, data) {
    const { applyToExisting, ...ruleData } = data
    let ruleId = suggestion.rule_id || null
    pushUndo([suggestion.id])

    if (ruleId) {
      await api.updateRule(ruleId, ruleData)
    } else {
      const createdRule = await api.createRule(ruleData)
      ruleId = createdRule?.id || null
    }

    const result = await api.updateBatchRuleSuggestionReview(batchId, {
      suggestion_id: suggestion.id,
      status: 'accepted',
      rule_id: ruleId,
      merchant_label: suggestion.merchant_label,
      target_category_name: data.category_id ? getCategoryName(data.category_id) : null,
      keyword: data.keyword,
    })

    applyLocalSuggestionUpdates({
      [suggestion.id]: {
        review_status: 'accepted',
        rule_id: ruleId,
        keyword: data.keyword,
        target_category_id: data.category_id || null,
        target_category_name: data.category_id ? getCategoryName(data.category_id) : null,
        amount_min: data.amount_min,
        amount_max: data.amount_max,
        clean_name_suggestion: data.clean_name || null,
        owner_id: data.owner_id || null,
        account_id: data.account_id || null,
      },
    }, {
      review_summary: result.review_summary || undefined,
      generated_at: result.generated_at || undefined,
    })
    setEditingSuggestionId(null)
  }

  async function saveSuggestionAsIs(suggestion) {
    await saveSuggestion(suggestion, {
      keyword: suggestion.keyword,
      category_id: suggestion.target_category_id,
      amount_min: suggestion.amount_min,
      amount_max: suggestion.amount_max,
      clean_name: suggestion.clean_name_suggestion || null,
      owner_id: suggestion.owner_id || null,
      account_id: suggestion.account_id || null,
      applyToExisting: false,
    })
  }

  async function saveSuggestionsAsIsBulk(suggestions) {
    setEditingSuggestionId(null)
    setRuleSuggestionState(prev => ({ ...prev, error: '' }))
    pushUndo(suggestions.map(s => s.id))
    try {
      let lastResult = null
      const updatesById = {}
      for (const suggestion of suggestions) {
        const createdRule = await api.createRule({
          keyword: suggestion.keyword,
          category_id: suggestion.target_category_id,
          amount_min: suggestion.amount_min,
          amount_max: suggestion.amount_max,
          clean_name: suggestion.clean_name_suggestion || null,
          owner_id: suggestion.owner_id || null,
          account_id: suggestion.account_id || null,
        })
        lastResult = await api.updateBatchRuleSuggestionReview(batchId, {
          suggestion_id: suggestion.id,
          status: 'accepted',
          rule_id: createdRule?.id || null,
          merchant_label: suggestion.merchant_label,
          target_category_name: suggestion.target_category_name,
          keyword: suggestion.keyword,
        })
        updatesById[suggestion.id] = {
          review_status: 'accepted',
          rule_id: createdRule?.id || null,
        }
      }
      applyLocalSuggestionUpdates(updatesById, {
        review_summary: lastResult?.review_summary || undefined,
        generated_at: lastResult?.generated_at || undefined,
      })
    } catch (err) {
      setRuleSuggestionState(prev => ({
        ...prev,
        loading: false,
        error: err.message || 'Unable to save selected rules.',
      }))
    }
  }

  return (
    <div data-browser-context-passthrough="true" style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ padding: '20px 32px 0', flexShrink: 0 }}>
        <div style={{ marginBottom: 8, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Link to="/import-export" style={{ fontSize: 13, color: 'var(--accent2)', textDecoration: 'none' }}>
            ← Back to Import / Export
          </Link>
          {undoStack.length > 0 && (
            <Button variant="ghost" small onClick={performUndo}>
              ↩ Undo ({undoStack.length})
            </Button>
          )}
        </div>
        <PageHeader title="Imported Rule Suggestions" />
      </div>

      <div data-browser-context-passthrough="true" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '4px 32px 32px' }}>
        <div style={{ width: '100%', maxWidth: 1120, display: 'grid', gap: 18 }}>
          {loadingBatchContext ? (
            <Spinner />
          ) : batchContextError ? (
            <Card>
              <div style={{ fontSize: 14, color: 'var(--danger)' }}>{batchContextError}</div>
            </Card>
          ) : !batch ? (
            <Card>
              <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>Import not found</div>
              <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 14 }}>
                This import may have been undone or is no longer available in Recent imports.
              </div>
              <Button onClick={() => navigate('/import-export')}>
                Return to Import / Export
              </Button>
            </Card>
          ) : !batch.has_imported_categories ? (
            <Card>
              <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>No categorized rows were imported</div>
              <div style={{ fontSize: 13, color: 'var(--muted)' }}>
                This import does not contain categorized rows that can be used to infer rules.
              </div>
            </Card>
          ) : (
            <>
              <Card style={{ display: 'grid', gap: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}>
                  <div>
                    <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>{batch.filename}</div>
                    <div style={{ fontSize: 13, color: 'var(--muted)' }}>
                      Imported {formatImportedAt(batch.imported_at)}{formatImportSummary(batch) ? ` · ${formatImportSummary(batch)}` : ''}
                    </div>
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                    {ruleSuggestionState.generated_at
                      ? `Generated ${ruleSuggestionState.generated_at.slice(0, 16).replace('T', ' ')}`
                      : 'Suggestions will be generated from this imported data.'}
                  </div>
                </div>
                <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.6 }}>
                  Generate categorization rules from the category assignments from the transactions in the file.
                </div>
              </Card>

              <ImportRuleSuggestionReview
                batchId={batchId}
                ruleSuggestionState={ruleSuggestionState}
                selectedOwnerIds={selectedOwnerIds}
                reviewFilter={reviewFilter}
                onChangeReviewFilter={setReviewFilter}
                onToggleOwner={toggleOwner}
                merchantFilterOpen={merchantFilterOpen}
                onMerchantFilterOpenChange={setMerchantFilterOpen}
                ownerFilterOpen={ownerFilterOpen}
                onOwnerFilterOpenChange={setOwnerFilterOpen}
                onEditSuggestion={setEditingSuggestionId}
                onCancelEdit={() => setEditingSuggestionId(null)}
                onSaveSuggestion={saveSuggestion}
                onSaveAcceptedSuggestion={saveAcceptedSuggestion}
                onSaveSuggestionAsIs={saveSuggestionAsIs}
                onSetSuggestionStatusBulk={setSuggestionStatusBulk}
                onSaveSuggestionsAsIsBulk={saveSuggestionsAsIsBulk}
                onSetSuggestionStatus={setSuggestionStatus}
                editingSuggestionId={editingSuggestionId}
                categories={categories}
                owners={owners}
                accounts={accounts}
              />
            </>
          )}
        </div>
      </div>
    </div>
  )
}
