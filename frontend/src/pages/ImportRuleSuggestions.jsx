// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: GPL-3.0-or-later

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useLocation } from 'react-router-dom'
import { Card, PageHeader, Button, Spinner } from '../components/ui.jsx'
import { useRecategorize, RecategorizeButton, RecategorizeResultBanner } from '../components/RecategorizeControl.jsx'
import ImportRuleSuggestionReview from '../components/ImportRuleSuggestionReview.jsx'
import FeatureExplainer from '../help/FeatureExplainer.jsx'
import { api } from '../lib/api.js'
import { txnMutations } from '../lib/txnMutations.js'
import { useUserPreference } from '../lib/UserPreferencesContext.jsx'
import { isReturningAcceptedSuggestionToPending, reverseAcceptedSuggestionSideEffects } from '../lib/importExport/ruleSuggestionReviewStatus.js'

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

function normalizeRuleKeyword(value) {
  const normalized = String(value || '').trim().toLowerCase().replace(/\s+/g, ' ')
  if (!normalized) return ''
  const tokens = normalized.split(' ')
  while (tokens.length > 1) {
    const compact = tokens[tokens.length - 1].replace(/[^a-z0-9]/g, '')
    if (/^\d{4,}$/.test(compact)) {
      tokens.pop()
      continue
    }
    break
  }
  const sanitized = tokens.join(' ').trim()
  return /^\d+$/.test(sanitized.replace(/[^a-z0-9]/g, '')) ? '' : sanitized
}

function ruleSuggestionRangeCovers(coveringMin, coveringMax, coveredMin, coveredMax) {
  if (coveringMin != null && (coveredMin == null || coveringMin > coveredMin)) return false
  if (coveringMax != null && (coveredMax == null || coveringMax < coveredMax)) return false
  return true
}

export default function ImportRuleSuggestions() {
  const { batchId, profileId } = useParams()
  const navigate = useNavigate()
  // The back affordance follows where the user came from: the Rules page stamps {backTo, backLabel}
  // when it opens this surface, otherwise it falls back to Import / Export (its canonical home).
  const location = useLocation()
  const backTo = location.state?.backTo || '/import-export'
  const backLabel = location.state?.backLabel || 'Import / Export'
  const isProfileContext = !!profileId
  const isSystemContext = !batchId && !profileId
  const contextKey = isSystemContext
    ? 'system'
    : isProfileContext
      ? `profile:${profileId}`
      : `batch:${batchId}`
  const [owners, setOwners] = useState([])
  const [accounts, setAccounts] = useState([])
  const [categories, setCategories] = useState([])
  const [tags, setTags] = useState([])
  const [batches, setBatches] = useState([])
  const [profiles, setProfiles] = useState([])
  const [loadingBatchContext, setLoadingBatchContext] = useState(true)
  const [batchContextError, setBatchContextError] = useState('')
  const [initialSuggestionLoadComplete, setInitialSuggestionLoadComplete] = useState(false)
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
  // Recap of the last accept action's collision reconciliation (merged into / skipped as duplicate of
  // an existing rule, or conflicts left pending for the user). Kept outside ruleSuggestionState so a
  // reload doesn't wipe it. `conflicts` carries one entry per unresolved conflict so the banner can show
  // the colliding rule and offer Replace/Keep inline; `reconciledRuleIds` collects the existing rules a
  // merge/replace changed, so the banner can offer to re-categorize the transactions those rules already
  // match. Shape: { created, merged, skipped, replaced, conflicts: ConflictEntry[], reconciledRuleIds:
  // string[] } | null (see buildConflictEntry).
  const [resolveSummary, setResolveSummary] = useState(null)
  // Suggestion id whose conflict is mid-resolution, so the banner can disable that row's actions.
  const [resolvingConflictId, setResolvingConflictId] = useState(null)
  // In-flight flag + result note for the banner's "re-categorize matching transactions" action.
  const [recategorizingMatches, setRecategorizingMatches] = useState(false)
  const [reconcileApplyNote, setReconcileApplyNote] = useState(null)
  // Owner resolution is intentionally one-at-a-time: ambiguous imports need a
  // single ownership lens before the suggested rules are meaningful.
  const [selectedOwnerIds, setSelectedOwnerIds] = useState([])
  const [editingSuggestionId, setEditingSuggestionId] = useState(null)
  const [reviewFilter, setReviewFilter] = useState('pending')
  const [merchantFilterOpen, setMerchantFilterOpen] = useUserPreference(IMPORT_RULE_MERCHANT_FILTER_OPEN_PREF_KEY, true)
  const [ownerFilterOpen, setOwnerFilterOpen] = useUserPreference(IMPORT_RULE_OWNER_FILTER_OPEN_PREF_KEY, false)
  const [undoStack, setUndoStack] = useState([])
  const [applyingConflict, setApplyingConflict] = useState(false)
  const MAX_UNDO = 10
  const {
    pendingCount: recategorizePendingCount,
    result: recategorizeResult,
    run: runRecategorizeWithoutTrace,
    reloadPreview: reloadRecategorizePreview,
    dismissResult: dismissRecategorizeResult,
  } = useRecategorize()
  const traceSequenceRef = useRef(0)

  // Temporary Generate Rules diagnostic trail:
  // - Correlation ids tie one user action to its API writes and later Undo.
  // - The backend enriches these identities from committed DB state and writes the local JSONL trace.
  // - Trace failures are isolated from the workflow so instrumentation cannot change the reproduction.
  function newTraceCorrelation(action) {
    const randomPart = typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2)
    return `${action}:${Date.now()}:${randomPart}`
  }

  function compactUndoSnapshot(snapshot) {
    if (!snapshot) return null
    return {
      statuses: snapshot.statuses || {},
      rows: (snapshot.rows || []).map(row => ({
        id: row.id,
        category_id: row.category_id ?? null,
        category_source: row.category_source ?? null,
        category_overridden: row.category_overridden ?? 0,
      })),
      rule_ids: snapshot.ruleIds || [],
      suggestions: snapshot.suggestions || [],
      trace: snapshot.trace || null,
    }
  }

  async function traceRuleSuggestionAction({
    correlationId,
    event,
    phase,
    suggestions = [],
    transactionIds = [],
    ruleIds = [],
    keywords = [],
    undoSnapshot = null,
    details = {},
  }) {
    const sequence = traceSequenceRef.current + 1
    traceSequenceRef.current = sequence
    try {
      await api.traceImportRuleSuggestionAction({
        correlation_id: correlationId,
        client_sequence: sequence,
        event,
        phase,
        context_type: isSystemContext ? 'system' : (isProfileContext ? 'profile' : 'batch'),
        context_id: isSystemContext ? null : (isProfileContext ? profileId : batchId),
        suggestion_ids: suggestions.map(suggestion => suggestion.id).filter(Boolean),
        transaction_ids: [...new Set([
          ...transactionIds,
          ...suggestions.flatMap(suggestion => suggestion.source_row_ids || []),
        ])],
        rule_ids: ruleIds.filter(Boolean),
        keywords: [...new Set([
          ...keywords,
          ...suggestions.map(suggestion => suggestion.keyword),
        ].filter(Boolean))],
        undo_snapshot: compactUndoSnapshot(undoSnapshot),
        details: {
          client_timestamp: new Date().toISOString(),
          ...details,
        },
      })
    } catch {
      // Diagnostics must never alter or block the workflow being diagnosed.
    }
  }

  const batch = useMemo(
    () => batches.find(item => item.id === batchId) || null,
    [batches, batchId],
  )
  const profile = useMemo(
    () => profiles.find(item => item.id === profileId) || null,
    [profiles, profileId],
  )
  const profileBatches = useMemo(
    () => batches.filter(item => item.profile_id === profileId),
    [batches, profileId],
  )
  const loadSuggestionsForContext = useCallback((ownerIds = []) => (
    isSystemContext
      ? api.getSystemRuleSuggestions(ownerIds)
      : isProfileContext
        ? api.getProfileRuleSuggestions(profileId, ownerIds)
        : api.getBatchRuleSuggestions(batchId, ownerIds)
  ), [isSystemContext, isProfileContext, profileId, batchId])
  const updateSuggestionReviewForContext = payload => (
    isSystemContext
      ? api.updateSystemRuleSuggestionReview(payload)
      : isProfileContext
        ? api.updateProfileRuleSuggestionReview(profileId, payload)
        : api.updateBatchRuleSuggestionReview(batchId, payload)
  )
  const refineSuggestionMatchForContext = payload => (
    isSystemContext
      ? api.refineSystemRuleSuggestionMatch(payload)
      : isProfileContext
        ? api.refineProfileRuleSuggestionMatch(profileId, payload)
        : api.refineBatchRuleSuggestionMatch(batchId, payload)
  )
  const loadSuggestionMatchesForContext = payload => (
    isSystemContext
      ? api.getSystemRuleSuggestionMatches(payload)
      : isProfileContext
        ? api.getProfileRuleSuggestionMatches(profileId, payload)
        : api.getBatchRuleSuggestionMatches(batchId, payload)
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
      api.getImportProfiles(),
      api.getTags(),
    ]).then(([nextOwners, nextAccounts, nextCategories, nextBatches, nextProfiles, nextTags]) => {
      if (cancelled) return
      setOwners(nextOwners)
      setAccounts(nextAccounts)
      setCategories(nextCategories)
      setBatches(nextBatches)
      setProfiles(nextProfiles)
      setTags(nextTags || [])
    }).catch(err => {
      if (cancelled) return
      setBatchContextError(err.message || 'Unable to load import context.')
    }).finally(() => {
      if (cancelled) return
      setLoadingBatchContext(false)
    })

    return () => { cancelled = true }
  }, [])

  async function reloadCategories() {
    const nextCategories = await api.getCategories()
    setCategories(nextCategories)
    return nextCategories
  }

  useEffect(() => {
    setInitialSuggestionLoadComplete(false)
  }, [contextKey])

  useEffect(() => {
    let cancelled = false
    async function loadRuleSuggestions() {
      setRuleSuggestionState(prev => ({ ...prev, loading: true, error: '' }))
      try {
        const result = await loadSuggestionsForContext(selectedOwnerIds)
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
        setInitialSuggestionLoadComplete(true)
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
        setInitialSuggestionLoadComplete(true)
      }
    }

    loadRuleSuggestions()
    return () => { cancelled = true }
  }, [batchId, profileId, selectedOwnerIds, isSystemContext, loadSuggestionsForContext])

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
    const result = await loadSuggestionsForContext(selectedOwnerIds)
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
    // Accepting/replacing suggestions creates or repoints rules, so the retroactive-apply preview
    // count can change — refresh it alongside the suggestion reload.
    reloadRecategorizePreview()
  }

  async function runRecategorize() {
    const correlationId = newTraceCorrelation('run-categorization')
    const suggestions = ruleSuggestionState.suggestions.map(suggestion => ({
      id: suggestion.id,
      keyword: suggestion.keyword,
      source_row_ids: suggestion.source_row_ids || [],
    }))
    await traceRuleSuggestionAction({
      correlationId,
      event: 'run-categorization',
      phase: 'before',
      suggestions,
      details: { preview_count: recategorizePendingCount },
    })
    try {
      const result = await runRecategorizeWithoutTrace()
      await traceRuleSuggestionAction({
        correlationId,
        event: 'run-categorization',
        phase: 'after',
        suggestions,
        details: { updated: result?.updated ?? null },
      })
      return result
    } catch (err) {
      await traceRuleSuggestionAction({
        correlationId,
        event: 'run-categorization',
        phase: 'error',
        suggestions,
        details: { error: err.message || 'Unable to apply categorization rules.' },
      })
      throw err
    }
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

  // `rowRestore` (optional) is the prior-state snapshot of transactions an action changed (a reject
  // disposition, or a rule an accept applied to its rows), so undo can put the rows back as well as the
  // suggestion's review status. `ruleIdsToDelete` (optional) are rules an accept *created*; undo must
  // delete them, otherwise the rule keeps owning the rows and the suggestion can never regenerate —
  // it vanishes and the total silently drops.
  function pushUndo(suggestionIds, rowRestore = null, ruleIdsToDelete = null, trace = null) {
    const idSet = new Set(suggestionIds)
    const statuses = {}
    const tracedSuggestions = []
    for (const s of ruleSuggestionState.suggestions) {
      if (idSet.has(s.id)) {
        statuses[s.id] = {
          review_status: s.review_status,
          rule_id: s.rule_id ?? null,
          created_rule_id: s.created_rule_id ?? null,
          accepted_prior_rows: s.accepted_prior_rows || [],
        }
        tracedSuggestions.push({
          id: s.id,
          keyword: s.keyword,
          source_row_ids: s.source_row_ids || [],
        })
      }
    }
    const snapshot = {
      statuses,
      rows: rowRestore && rowRestore.length ? rowRestore : null,
      ruleIds: ruleIdsToDelete && ruleIdsToDelete.length ? ruleIdsToDelete : null,
      suggestions: tracedSuggestions,
      trace,
    }
    setUndoStack(prev => [...prev.slice(-(MAX_UNDO - 1)), snapshot])
    const correlationId = trace?.correlationId || newTraceCorrelation('undo-entry')
    void traceRuleSuggestionAction({
      correlationId,
      event: trace?.action || 'undo-entry',
      phase: 'undo-entry-pushed',
      suggestions: tracedSuggestions,
      ruleIds: snapshot.ruleIds || [],
      undoSnapshot: snapshot,
    })
    return snapshot
  }

  async function performUndo() {
    if (undoStack.length === 0) return
    const snapshot = undoStack[undoStack.length - 1]
    const correlationId = newTraceCorrelation('undo')
    const tracedSuggestions = snapshot.suggestions || Object.keys(snapshot.statuses || {}).map(id => ({ id }))
    const transactionIds = (snapshot.rows || []).map(row => row.id)
    const ruleIds = snapshot.ruleIds || []
    await traceRuleSuggestionAction({
      correlationId,
      event: 'undo',
      phase: 'before',
      suggestions: tracedSuggestions,
      transactionIds,
      ruleIds,
      undoSnapshot: snapshot,
      details: {
        undoes_correlation_id: snapshot.trace?.correlationId || null,
        undoes_action: snapshot.trace?.action || null,
        remaining_undo_depth: undoStack.length - 1,
      },
    })
    setUndoStack(prev => prev.slice(0, -1))
    // Delete any rules the accept created, so the accept is truly reversed: with the rule gone its rows
    // are import-candidates again and the suggestion regenerates instead of disappearing.
    for (const ruleId of snapshot.ruleIds || []) {
      await api.deleteRule(ruleId).catch(() => { })
    }
    await traceRuleSuggestionAction({
      correlationId,
      event: 'undo',
      phase: 'after-rule-delete',
      suggestions: tracedSuggestions,
      transactionIds,
      ruleIds,
      undoSnapshot: snapshot,
    })
    // Restore any row categorization the action changed, so the rows are back to their prior state before
    // the suggestion returns to the queue.
    if (snapshot.rows && snapshot.rows.length) {
      await txnMutations.restoreCategorization(snapshot.rows).catch(() => { })
    }
    await traceRuleSuggestionAction({
      correlationId,
      event: 'undo',
      phase: 'after-row-restore',
      suggestions: tracedSuggestions,
      transactionIds,
      ruleIds,
      undoSnapshot: snapshot,
    })
    // Replay the server-side review status (an accept also touched it, and covered suggestions were
    // auto-discarded), restoring each captured suggestion to where it was before the action.
    for (const [suggestionId, prev] of Object.entries(snapshot.statuses || {})) {
      await updateSuggestionReviewForContext({
        suggestion_id: suggestionId,
        status: prev.review_status,
        rule_id: prev.rule_id || null,
        created_rule_id: prev.created_rule_id || null,
        accepted_prior_rows: prev.accepted_prior_rows || [],
      }).catch(() => { })
    }
    await reloadSuggestions()
    await traceRuleSuggestionAction({
      correlationId,
      event: 'undo',
      phase: 'after',
      suggestions: tracedSuggestions,
      transactionIds,
      ruleIds,
      undoSnapshot: snapshot,
    })
  }

  function getCategoryName(categoryId) {
    return categories.find(category => String(category.id) === String(categoryId))?.name || null
  }

  function getCoveredSuggestionIds(sourceSuggestion, data) {
    const coveringKeyword = normalizeRuleKeyword(data.keyword)
    if (!coveringKeyword) return []

    const coveringCategoryId = String(data.category_id || '').trim()
    const coveringCategoryName = String(getCategoryName(data.category_id) || sourceSuggestion.target_category_name || '').trim().toLowerCase()
    const coveringOwnerId = String(data.owner_id || '').trim()
    const coveringAccountId = String(data.account_id || '').trim()

    return ruleSuggestionState.suggestions
      .filter(otherSuggestion => {
        if (otherSuggestion.id === sourceSuggestion.id) return false
        if (otherSuggestion.review_status === 'accepted' || otherSuggestion.review_status === 'discarded') return false

        const otherKeyword = normalizeRuleKeyword(otherSuggestion.keyword)
        if (!otherKeyword || otherKeyword === coveringKeyword || !otherKeyword.includes(coveringKeyword)) return false

        const otherCategoryId = String(otherSuggestion.target_category_id || '').trim()
        const otherCategoryName = String(otherSuggestion.target_category_name || '').trim().toLowerCase()
        if (coveringCategoryId && otherCategoryId) {
          if (coveringCategoryId !== otherCategoryId) return false
        } else if (coveringCategoryName !== otherCategoryName) {
          return false
        }

        const otherOwnerId = String(otherSuggestion.owner_id || '').trim()
        if (coveringOwnerId && coveringOwnerId !== otherOwnerId) return false

        const otherAccountId = String(otherSuggestion.account_id || '').trim()
        if (coveringAccountId && coveringAccountId !== otherAccountId) return false

        return ruleSuggestionRangeCovers(
          data.amount_min,
          data.amount_max,
          otherSuggestion.amount_min,
          otherSuggestion.amount_max,
        )
      })
      .map(suggestion => suggestion.id)
  }

  // Write a suggestion's review status (no undo bookkeeping — callers push the undo entry, so a reject
  // with a row disposition can record both in one entry).
  async function applySuggestionStatus(suggestion, status) {
    setEditingSuggestionId(null)
    const returningAcceptedToPending = isReturningAcceptedSuggestionToPending(suggestion, status)
    if (returningAcceptedToPending) {
      await reverseAcceptedSuggestion(suggestion)
    }
    const result = await updateSuggestionReviewForContext({
      suggestion_id: suggestion.id,
      status,
      merchant_label: suggestion.merchant_label,
      target_category_name: suggestion.target_category_name,
      keyword: suggestion.keyword,
    })
    if (returningAcceptedToPending) {
      await reloadSuggestions()
      return
    }
    applyLocalSuggestionUpdates({
      [suggestion.id]: { review_status: status },
    }, {
      review_summary: result.review_summary || undefined,
      generated_at: result.generated_at || undefined,
    })
  }

  async function reverseAcceptedSuggestion(suggestion) {
    await reverseAcceptedSuggestionSideEffects(suggestion, {
      restoreCategorization: txnMutations.restoreCategorization,
      deleteRule: api.deleteRule,
    })
  }

  async function setSuggestionStatus(suggestion, status) {
    pushUndo([suggestion.id])
    await applySuggestionStatus(suggestion, status)
  }

  // Reject a suggestion (no rule) and settle the rows it covered. 'keep' records the file's category
  // as a manual decision; 'clear' discards it to the `cleared` source. The disposition returns the rows'
  // prior state, which rides in the undo entry so undo restores the rows and the suggestion together.
  // The disposition is best-effort: a failure there still records the rejection so the suggestion leaves
  // the queue (the rows keep their imported category and can be settled by hand).
  async function rejectSuggestionWithDisposition(suggestion, mode) {
    const rowIds = suggestion?.source_row_ids || []
    let priorRows = null
    if (rowIds.length) {
      try {
        const result = await txnMutations.setRejectedSuggestionDisposition(rowIds, mode)
        priorRows = result?.rows || null
      } catch {
        // fall through to record the rejection regardless
      }
    }
    pushUndo([suggestion.id], priorRows)
    await applySuggestionStatus(suggestion, 'discarded')
  }

  // Bulk reject + settle, in one undo entry. 'keep' leaves the rows imported (status-only — the rows
  // keep their category and stay reclaimable by a later apply); 'clear' clears their categories. Mirrors
  // rejectSuggestionWithDisposition but bundles every selected suggestion's row snapshots into one undo
  // entry, like applyConflictSet. A disposition failure still records the rejections (best-effort).
  async function bulkRejectWithDisposition(suggestions, mode) {
    setEditingSuggestionId(null)
    setRuleSuggestionState(prev => ({ ...prev, error: '' }))
    let priorRows = null
    if (mode === 'clear') {
      const rowIds = suggestions.flatMap(s => s.source_row_ids || [])
      if (rowIds.length) {
        try {
          const result = await txnMutations.setRejectedSuggestionDisposition(rowIds, 'clear')
          priorRows = result?.rows || null
        } catch {
          // fall through to record the rejections regardless
        }
      }
    }
    pushUndo(suggestions.map(s => s.id), priorRows)
    try {
      let lastResult = null
      for (const suggestion of suggestions) {
        lastResult = await updateSuggestionReviewForContext({
          suggestion_id: suggestion.id,
          status: 'discarded',
          merchant_label: suggestion.merchant_label,
          target_category_name: suggestion.target_category_name,
          keyword: suggestion.keyword,
        })
      }
      const updatesById = Object.fromEntries(
        suggestions.map(suggestion => [suggestion.id, { review_status: 'discarded' }]),
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

  async function setSuggestionStatusBulk(suggestions, status) {
    setEditingSuggestionId(null)
    setRuleSuggestionState(prev => ({ ...prev, error: '' }))
    pushUndo(suggestions.map(s => s.id))
    try {
      let lastResult = null
      let shouldReload = false
      for (const suggestion of suggestions) {
        if (isReturningAcceptedSuggestionToPending(suggestion, status)) {
          await reverseAcceptedSuggestion(suggestion)
          shouldReload = true
        }
        lastResult = await updateSuggestionReviewForContext({
          suggestion_id: suggestion.id,
          status,
          merchant_label: suggestion.merchant_label,
          target_category_name: suggestion.target_category_name,
          keyword: suggestion.keyword,
        })
      }
      if (shouldReload) {
        await reloadSuggestions()
        return
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

  // A same-matcher 'conflict' from the rule API: the existing rule keeps a different category/rename
  // than the suggestion wants. The matcher is identical by definition, so the only meaningful diff is
  // the action — capture both sides so the banner can let the user Replace or Keep.
  function buildConflictEntry(suggestion, data, conflictResponse) {
    return {
      suggestion_id: suggestion.id,
      merchant_label: suggestion.merchant_label || suggestion.keyword,
      keyword: data?.keyword ?? suggestion.keyword,
      proposed_category_id: data?.category_id ?? suggestion.target_category_id ?? null,
      proposed_clean_name: data?.clean_name ?? suggestion.clean_name_suggestion ?? null,
      existing_rule_id: conflictResponse?.existing_rule_id || null,
      existing_category_id: conflictResponse?.existing_category_id || null,
      existing_clean_name: conflictResponse?.existing_clean_name || null,
    }
  }

  function describeRuleAction(categoryId, cleanName) {
    const categoryName = getCategoryName(categoryId)
    if (categoryName) return categoryName
    if (cleanName) return `rename to "${cleanName}"`
    return 'no category'
  }

  function dropConflictEntry(suggestionId) {
    setResolveSummary(prev => {
      if (!prev) return prev
      const conflicts = prev.conflicts.filter(entry => entry.suggestion_id !== suggestionId)
      const empty = !conflicts.length && !prev.merged && !prev.skipped && !prev.replaced && !(prev.reconciledRuleIds?.length)
      if (empty) return null
      return { ...prev, conflicts }
    })
  }

  // Track an existing rule whose categorization a merge/replace just changed, so the banner can offer to
  // re-categorize the transactions it already matches. `kind` bumps the matching count for the recap line.
  function recordReconciledRule(ruleId, kind) {
    if (!ruleId) return
    setReconcileApplyNote(null)
    setResolveSummary(prev => {
      const base = prev || { created: 0, merged: 0, skipped: 0, replaced: 0, conflicts: [], reconciledRuleIds: [] }
      const reconciledRuleIds = base.reconciledRuleIds?.includes(ruleId)
        ? base.reconciledRuleIds
        : [...(base.reconciledRuleIds || []), ruleId]
      return {
        created: base.created || 0,
        merged: (base.merged || 0) + (kind === 'merged' ? 1 : 0),
        skipped: base.skipped || 0,
        replaced: (base.replaced || 0) + (kind === 'replaced' ? 1 : 0),
        conflicts: base.conflicts || [],
        reconciledRuleIds,
      }
    })
  }

  // Banner action: re-apply each merged/replaced rule to the transactions it already matches. Uses the
  // preserve-manual mode (reclaims import-locked and rule-owned rows, leaves manual edits alone), since a
  // merge/replace deliberately changes the governing rule but a manual per-transaction edit still wins.
  async function recategorizeReconciledMatches() {
    const ids = resolveSummary?.reconciledRuleIds || []
    if (!ids.length || recategorizingMatches) return
    setRecategorizingMatches(true)
    setRuleSuggestionState(prev => ({ ...prev, error: '' }))
    try {
      let total = 0
      for (const ruleId of ids) {
        const result = await txnMutations.applyRule(ruleId, { preserveManual: true })
        total += result?.updated || 0
      }
      setReconcileApplyNote(total)
      setResolveSummary(prev => (prev ? { ...prev, reconciledRuleIds: [] } : prev))
      reloadRecategorizePreview()
    } catch (err) {
      setRuleSuggestionState(prev => ({ ...prev, error: err.message || 'Unable to re-categorize matching transactions.' }))
    } finally {
      setRecategorizingMatches(false)
    }
  }

  // Replace: overwrite the colliding rule's action with the suggestion's (preserving the rule's id and
  // tags), then accept the suggestion linked to that rule. The matcher is unchanged, so this edit can't
  // re-collide unless a *third* rule shares it — in that case we leave the conflict for manual handling.
  async function replaceConflictingRule(entry) {
    if (!entry.existing_rule_id || resolvingConflictId) return
    setResolvingConflictId(entry.suggestion_id)
    setRuleSuggestionState(prev => ({ ...prev, error: '' }))
    try {
      const updated = await api.updateRule(entry.existing_rule_id, {
        category_id: entry.proposed_category_id || null,
        clean_name: entry.proposed_clean_name || null,
      }, { onExisting: 'merge' })
      if (updated?.status === 'conflict') {
        setRuleSuggestionState(prev => ({
          ...prev,
          error: `Another rule also matches “${entry.keyword}” with a different category. Resolve it from the Rules page first.`,
        }))
        return
      }
      const ruleId = updated?.id || entry.existing_rule_id
      const suggestion = ruleSuggestionState.suggestions.find(item => item.id === entry.suggestion_id)
      const applyResult = suggestion ? await applyRuleToSuggestionRows(ruleId, suggestion) : null
      pushUndo([entry.suggestion_id], applyResult?.prior_rows || null)
      await updateSuggestionReviewForContext({
        suggestion_id: entry.suggestion_id,
        status: 'accepted',
        rule_id: ruleId,
        accepted_prior_rows: applyResult?.prior_rows || [],
        merchant_label: suggestion?.merchant_label ?? entry.merchant_label,
        target_category_name: getCategoryName(entry.proposed_category_id),
        target_category_id: entry.proposed_category_id || null,
        keyword: entry.keyword,
        clean_name_suggestion: entry.proposed_clean_name || null,
      })
      recordReconciledRule(ruleId, 'replaced')
      dropConflictEntry(entry.suggestion_id)
      await reloadSuggestions()
    } catch (err) {
      setRuleSuggestionState(prev => ({ ...prev, error: err.message || 'Unable to replace the existing rule.' }))
    } finally {
      setResolvingConflictId(null)
    }
  }

  // Keep: leave the existing rule untouched and defer the suggestion so it drops out of the pending view.
  async function keepExistingRule(entry) {
    if (resolvingConflictId) return
    setResolvingConflictId(entry.suggestion_id)
    setRuleSuggestionState(prev => ({ ...prev, error: '' }))
    try {
      const suggestion = ruleSuggestionState.suggestions.find(item => item.id === entry.suggestion_id)
      if (suggestion) {
        pushUndo([entry.suggestion_id])
        await updateSuggestionReviewForContext({
          suggestion_id: entry.suggestion_id,
          status: 'skipped',
          merchant_label: suggestion.merchant_label,
          target_category_name: suggestion.target_category_name,
          keyword: suggestion.keyword,
        })
      }
      dropConflictEntry(entry.suggestion_id)
      await reloadSuggestions()
    } catch (err) {
      setRuleSuggestionState(prev => ({ ...prev, error: err.message || 'Unable to defer the suggestion.' }))
    } finally {
      setResolvingConflictId(null)
    }
  }

  // Accepting a suggestion applies the rule's outputs (category / clean name / tags) to the rows that
  // generated it — and only those rows. The backend uses preserve_manual, so any row a user Preserved
  // (manual exception) is left untouched, and rows belonging to other (conflicting) suggestions aren't
  // in this set — they're left alone rather than silently reassigned to this rule's category.
  // Returns the apply result (notably `prior_rows`, the rows' pre-apply categorization snapshot) so the
  // caller can stash it for Undo; null if there was nothing to apply or the apply failed.
  async function applyRuleToSuggestionRows(ruleId, suggestion, trace = null) {
    const rowIds = suggestion?.source_row_ids || []
    if (!ruleId || !rowIds.length) return null
    if (trace) {
      await traceRuleSuggestionAction({
        correlationId: trace.correlationId,
        event: trace.action,
        phase: `${trace.phasePrefix || 'apply'}-before`,
        suggestions: [suggestion],
        ruleIds: [ruleId],
      })
    }
    try {
      const result = await txnMutations.applyRuleToTransactions(ruleId, rowIds)
      if (trace) {
        await traceRuleSuggestionAction({
          correlationId: trace.correlationId,
          event: trace.action,
          phase: `${trace.phasePrefix || 'apply'}-after`,
          suggestions: [suggestion],
          ruleIds: [ruleId],
          details: {
            updated: result?.updated || 0,
            prior_row_count: result?.prior_rows?.length || 0,
          },
        })
      }
      return result
    } catch {
      if (trace) {
        await traceRuleSuggestionAction({
          correlationId: trace.correlationId,
          event: trace.action,
          phase: `${trace.phasePrefix || 'apply'}-error`,
          suggestions: [suggestion],
          ruleIds: [ruleId],
        })
      }
      // The rule itself saved; a failure to back-apply to its own rows shouldn't fail the accept.
      // The user can still re-apply from the rule, and the rows surface again on the next generate.
      return null
    }
  }

  async function saveSuggestion(suggestion, data) {
    const correlationId = newTraceCorrelation('save-suggestion')
    await traceRuleSuggestionAction({
      correlationId,
      event: 'save-suggestion',
      phase: 'before',
      suggestions: [suggestion],
      details: { apply_to_existing: !!data.applyToExisting },
    })
    setResolveSummary(null)
    setReconcileApplyNote(null)
    const { applyToExisting, ...ruleData } = data
    // Auto-resolve against an existing same-matcher rule (Generate Rules is the bulk flow): merge a
    // mergeable/duplicate save into it. A conflict (a different category/rename on the same matcher)
    // is left for the user — we don't fork or overwrite, so the suggestion stays pending and is named
    // in the summary banner.
    const createdRule = await api.createRule(ruleData, { onExisting: 'merge' })
    await traceRuleSuggestionAction({
      correlationId,
      event: 'save-suggestion',
      phase: 'after-rule-create',
      suggestions: [suggestion],
      ruleIds: [createdRule?.id],
      details: {
        rule_status: createdRule?.status || null,
        rule_relation: createdRule?.relation || null,
      },
    })
    if (createdRule?.status === 'conflict') {
      setResolveSummary({ created: 0, merged: 0, skipped: 0, conflicts: [buildConflictEntry(suggestion, data, createdRule)] })
      setEditingSuggestionId(null)
      await reloadSuggestions()
      return
    }
    const coveredSuggestionIds = getCoveredSuggestionIds(suggestion, data)
    // Auto-apply the rule's outputs to this suggestion's own source rows (no extra step), capturing the
    // rows' prior categorization *first* so Undo can restore it. The broad "apply to all matches" action
    // below is opt-in and a superset; this scoped pass is the default.
    const applyResult = await applyRuleToSuggestionRows(createdRule?.id, suggestion, {
      correlationId,
      action: 'save-suggestion',
      phasePrefix: 'scoped-apply',
    })
    // Only a freshly *created* rule is ours to delete on undo; a save that merged into a pre-existing
    // rule must not delete that rule (it wasn't created here).
    const ruleIdsToDelete = createdRule?.id && createdRule?.status === 'created' ? [createdRule.id] : null
    pushUndo(
      [suggestion.id, ...coveredSuggestionIds],
      applyResult?.prior_rows || null,
      ruleIdsToDelete,
      { correlationId, action: 'save-suggestion' },
    )
    await updateSuggestionReviewForContext({
      suggestion_id: suggestion.id,
      status: 'accepted',
      rule_id: createdRule?.id || null,
      created_rule_id: createdRule?.status === 'created' ? createdRule.id : null,
      accepted_prior_rows: applyResult?.prior_rows || [],
      merchant_label: suggestion.merchant_label,
      target_category_name: data.category_id ? getCategoryName(data.category_id) : suggestion.target_category_name,
      target_category_id: data.category_id || null,
      keyword: data.keyword,
      owner_id: data.owner_id || null,
      account_id: data.account_id || null,
      amount_min: data.amount_min,
      amount_max: data.amount_max,
      clean_name_suggestion: data.clean_name || null,
      match_source_text: !!data.match_source_text,
    })
    if (applyToExisting && createdRule?.id) await txnMutations.applyRule(createdRule.id)
    // A merge that actually changed the existing rule (filled a category/rename or added tags — i.e. not
    // a pure duplicate) is a candidate for re-categorizing the rows it already matches.
    if (createdRule?.status === 'merged' && createdRule.relation !== 'duplicate') {
      recordReconciledRule(createdRule.id, 'merged')
    }
    setEditingSuggestionId(null)
    await reloadSuggestions()
    await traceRuleSuggestionAction({
      correlationId,
      event: 'save-suggestion',
      phase: 'after',
      suggestions: [suggestion],
      ruleIds: [createdRule?.id],
      undoSnapshot: {
        rows: applyResult?.prior_rows || null,
        ruleIds: ruleIdsToDelete,
      },
    })
  }

  async function saveAcceptedSuggestion(suggestion, data) {
    setReconcileApplyNote(null)
    // applyToExisting is irrelevant for already-accepted suggestions (just edits/re-saves
    // the rule); destructure-and-discard so it isn't forwarded into the rule API payload.
    // eslint-disable-next-line no-unused-vars
    const { applyToExisting, ...ruleData } = data
    let ruleId = suggestion.rule_id || null
    let mergedRuleId = null
    let createdRuleIdToDelete = null
    let acceptedCreatedRuleId = suggestion.created_rule_id || null
    const coveredSuggestionIds = getCoveredSuggestionIds(suggestion, data)

    if (ruleId) {
      // Editing an accepted suggestion's rule can make it collide with another rule; auto-resolve
      // (merge folds it in and removes this one). A conflict can't be auto-merged — surface it.
      const updated = await api.updateRule(ruleId, ruleData, { onExisting: 'merge' })
      if (updated?.status === 'conflict') {
        setResolveSummary({ created: 0, merged: 0, skipped: 0, conflicts: [buildConflictEntry(suggestion, data, updated)] })
        setEditingSuggestionId(null)
        await reloadSuggestions()
        return
      }
      if (updated?.status === 'merged' && updated.id) {
        ruleId = updated.id
        createdRuleIdToDelete = null
        acceptedCreatedRuleId = null
        if (updated.relation !== 'duplicate') mergedRuleId = updated.id
      }
    } else {
      const createdRule = await api.createRule(ruleData, { onExisting: 'merge' })
      if (createdRule?.status === 'conflict') {
        setResolveSummary({ created: 0, merged: 0, skipped: 0, conflicts: [buildConflictEntry(suggestion, data, createdRule)] })
        setEditingSuggestionId(null)
        await reloadSuggestions()
        return
      }
      ruleId = createdRule?.id || null
      if (createdRule?.status === 'merged' && createdRule.relation !== 'duplicate') mergedRuleId = createdRule.id
      // A brand-new rule created here is ours to delete on undo (an updated/merged pre-existing rule is not).
      if (createdRule?.status === 'created' && createdRule?.id) {
        createdRuleIdToDelete = createdRule.id
        acceptedCreatedRuleId = createdRule.id
      } else {
        acceptedCreatedRuleId = null
      }
    }

    // Apply to the suggestion's rows first so undo can restore their prior categorization, then record the
    // undo entry (the created rule to delete + the row snapshot) before flipping the review status.
    const applyResult = await applyRuleToSuggestionRows(ruleId, suggestion)
    pushUndo([suggestion.id, ...coveredSuggestionIds], applyResult?.prior_rows || null, createdRuleIdToDelete ? [createdRuleIdToDelete] : null)
    await updateSuggestionReviewForContext({
      suggestion_id: suggestion.id,
      status: 'accepted',
      rule_id: ruleId,
      created_rule_id: acceptedCreatedRuleId,
      accepted_prior_rows: applyResult?.prior_rows || suggestion.accepted_prior_rows || [],
      merchant_label: suggestion.merchant_label,
      target_category_name: data.category_id ? getCategoryName(data.category_id) : null,
      target_category_id: data.category_id || null,
      keyword: data.keyword,
      owner_id: data.owner_id || null,
      account_id: data.account_id || null,
      amount_min: data.amount_min,
      amount_max: data.amount_max,
      clean_name_suggestion: data.clean_name || null,
      match_source_text: !!data.match_source_text,
    })

    if (mergedRuleId) recordReconciledRule(mergedRuleId, 'merged')
    setEditingSuggestionId(null)
    await reloadSuggestions()
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
      tag_ids: suggestion.tag_ids || [],
      match_source_text: !!suggestion.match_source_text,
      applyToExisting: false,
    })
  }

  // Resolve a whole conflict set in one action, driven entirely by each member's *target* category.
  // `winnerId` null = no rule: every member is settled to its target as a manual decision. With a
  // winner, that member becomes the rule, and each other member is classified by its target:
  //   - target == the winner's category -> the rule owns those rows (reclaimed via preserve-manual);
  //   - target is another category       -> kept as a manual exception at that target;
  //   - target is empty (category removed)-> cleared to the rule-eligible `cleared` source.
  // Everything lands in ONE combined undo entry — prior member statuses captured up front, the manual/
  // clear row snapshots gathered as we go (rows the rule reclaims aren't snapshotted, matching the
  // single-accept path, since undo replays the review status rather than the rule apply).
  async function applyConflictSet(members, winnerId) {
    if (applyingConflict) return
    const correlationId = newTraceCorrelation('apply-conflict-set')
    await traceRuleSuggestionAction({
      correlationId,
      event: 'apply-conflict-set',
      phase: 'before',
      suggestions: members,
      details: { winner_id: winnerId || null },
    })
    setApplyingConflict(true)
    setResolveSummary(null)
    setReconcileApplyNote(null)
    setRuleSuggestionState(prev => ({ ...prev, error: '' }))

    const idSet = new Set(members.map(member => member.id))
    const priorStatuses = {}
    for (const s of ruleSuggestionState.suggestions) {
      if (idSet.has(s.id)) {
        priorStatuses[s.id] = {
          review_status: s.review_status,
          rule_id: s.rule_id ?? null,
          created_rule_id: s.created_rule_id ?? null,
          accepted_prior_rows: s.accepted_prior_rows || [],
        }
      }
    }
    const rowSnapshots = []
    const ruleRowIds = []

    try {
      const winner = winnerId ? members.find(member => member.id === winnerId) : null
      const winnerCategoryId = winner ? winner.target_category_id : null
      let createdRuleId = null
      let winnerRuleWasCreated = false

      if (winner) {
        const ruleData = {
          keyword: winner.keyword,
          category_id: winner.target_category_id,
          amount_min: winner.amount_min,
          amount_max: winner.amount_max,
          clean_name: winner.clean_name_suggestion || null,
          owner_id: winner.owner_id || null,
          account_id: winner.account_id || null,
          tag_ids: winner.tag_ids || [],
          match_source_text: !!winner.match_source_text,
        }
        const createdRule = await api.createRule(ruleData, { onExisting: 'merge' })
        if (createdRule?.status === 'conflict') {
          setResolveSummary({ created: 0, merged: 0, skipped: 0, conflicts: [buildConflictEntry(winner, ruleData, createdRule)] })
          await reloadSuggestions()
          return
        }
        createdRuleId = createdRule?.id || null
        winnerRuleWasCreated = createdRule?.status === 'created'
        await updateSuggestionReviewForContext({
          suggestion_id: winner.id,
          status: 'accepted',
          rule_id: createdRuleId,
          created_rule_id: winnerRuleWasCreated ? createdRuleId : null,
          merchant_label: winner.merchant_label,
          target_category_name: winner.target_category_name,
          target_category_id: winner.target_category_id,
          keyword: winner.keyword,
          owner_id: winner.owner_id || null,
          account_id: winner.account_id || null,
          amount_min: winner.amount_min,
          amount_max: winner.amount_max,
          clean_name_suggestion: winner.clean_name_suggestion || null,
          match_source_text: !!winner.match_source_text,
        })
        if (winner.source_row_ids?.length) ruleRowIds.push(...winner.source_row_ids)
        if (createdRule?.status === 'merged' && createdRule.relation !== 'duplicate') {
          recordReconciledRule(createdRule.id, 'merged')
        }
      }

      for (const member of members) {
        if (member.id === winnerId) continue
        const targetId = member.target_category_id || null
        const rowIds = member.source_row_ids || []
        if (winner && String(targetId) === String(winnerCategoryId)) {
          // The rule's category — let the rule reclaim these rows alongside the winner's own.
          if (rowIds.length) ruleRowIds.push(...rowIds)
        } else if (rowIds.length) {
          // A different target keeps the rows as a manual exception there; an empty target clears them.
          const mode = targetId ? 'keep' : 'clear'
          try {
            const result = await txnMutations.setRejectedSuggestionDisposition(rowIds, mode, targetId)
            if (result?.rows?.length) rowSnapshots.push(...result.rows)
          } catch {
            // best-effort; still record the discard below
          }
        }
        // Write the discard server-side WITHOUT a per-member local update: touching local state here
        // drops the member from the pending view mid-loop, so the card would visibly shed rows one by
        // one. The single reloadSuggestions() below swaps the whole card out in one render instead.
        await updateSuggestionReviewForContext({
          suggestion_id: member.id,
          status: 'discarded',
          merchant_label: member.merchant_label,
          target_category_name: member.target_category_name,
          keyword: member.keyword,
        })
      }

      // Apply the rule to every row it should own (winner's rows + non-winners retargeted to it),
      // preserve-manual so import-locked rows are reclaimed but deliberate manual edits are spared.
      // Capture those rows' prior categorization too, so undo restores them as well as the disposed ones.
      if (createdRuleId && ruleRowIds.length) {
        try {
          const applyResult = await txnMutations.applyRuleToTransactions(createdRuleId, ruleRowIds)
          if (applyResult?.prior_rows?.length) {
            rowSnapshots.push(...applyResult.prior_rows)
            if (winner) {
              await updateSuggestionReviewForContext({
                suggestion_id: winner.id,
                status: 'accepted',
                rule_id: createdRuleId,
                created_rule_id: winnerRuleWasCreated ? createdRuleId : null,
                accepted_prior_rows: applyResult.prior_rows,
                merchant_label: winner.merchant_label,
                target_category_name: winner.target_category_name,
                target_category_id: winner.target_category_id,
                keyword: winner.keyword,
                owner_id: winner.owner_id || null,
                account_id: winner.account_id || null,
                amount_min: winner.amount_min,
                amount_max: winner.amount_max,
                clean_name_suggestion: winner.clean_name_suggestion || null,
                match_source_text: !!winner.match_source_text,
              })
            }
          }
        } catch {
          // The rule saved; failing to back-apply to its rows shouldn't fail the resolution.
        }
      }

      const conflictUndoSnapshot = {
        statuses: priorStatuses,
        rows: rowSnapshots.length ? rowSnapshots : null,
        ruleIds: winnerRuleWasCreated && createdRuleId ? [createdRuleId] : null,
        suggestions: members.map(member => ({
          id: member.id,
          keyword: member.keyword,
          source_row_ids: member.source_row_ids || [],
        })),
        trace: { correlationId, action: 'apply-conflict-set' },
      }
      setUndoStack(prev => [
        ...prev.slice(-(MAX_UNDO - 1)),
        conflictUndoSnapshot,
      ])
      await traceRuleSuggestionAction({
        correlationId,
        event: 'apply-conflict-set',
        phase: 'undo-entry-pushed',
        suggestions: members,
        ruleIds: conflictUndoSnapshot.ruleIds || [],
        undoSnapshot: conflictUndoSnapshot,
      })
      setEditingSuggestionId(null)
      await reloadSuggestions()
      await traceRuleSuggestionAction({
        correlationId,
        event: 'apply-conflict-set',
        phase: 'after',
        suggestions: members,
        ruleIds: [createdRuleId],
        undoSnapshot: conflictUndoSnapshot,
      })
    } finally {
      setApplyingConflict(false)
    }
  }

  async function saveSuggestionsAsIsBulk(suggestions) {
    const correlationId = newTraceCorrelation('bulk-save')
    await traceRuleSuggestionAction({
      correlationId,
      event: 'bulk-save',
      phase: 'before',
      suggestions,
      details: { selected_count: suggestions.length },
    })
    setEditingSuggestionId(null)
    setResolveSummary(null)
    setReconcileApplyNote(null)
    setRuleSuggestionState(prev => ({ ...prev, error: '' }))
    const undoSnapshot = pushUndo(
      suggestions.map(s => s.id),
      null,
      null,
      { correlationId, action: 'bulk-save' },
    )
    try {
      let lastResult = null
      const updatesById = {}
      // Auto-resolve collisions without interrupting the batch: 'merge' folds mergeable saves into the
      // existing rule and no-ops pure duplicates; conflicts are left pending and named in the summary.
      const summary = { created: 0, merged: 0, skipped: 0, replaced: 0, conflicts: [], reconciledRuleIds: [] }
      for (const suggestion of suggestions) {
        const createdRule = await api.createRule({
          keyword: suggestion.keyword,
          category_id: suggestion.target_category_id,
          amount_min: suggestion.amount_min,
          amount_max: suggestion.amount_max,
          clean_name: suggestion.clean_name_suggestion || null,
          owner_id: suggestion.owner_id || null,
          account_id: suggestion.account_id || null,
          tag_ids: suggestion.tag_ids || [],
          match_source_text: !!suggestion.match_source_text,
        }, { onExisting: 'merge' })
        await traceRuleSuggestionAction({
          correlationId,
          event: 'bulk-save',
          phase: 'after-rule-create',
          suggestions: [suggestion],
          ruleIds: [createdRule?.id],
          undoSnapshot,
          details: {
            rule_status: createdRule?.status || null,
            rule_relation: createdRule?.relation || null,
          },
        })
        if (createdRule?.status === 'conflict') {
          summary.conflicts.push(buildConflictEntry(suggestion, {
            keyword: suggestion.keyword,
            category_id: suggestion.target_category_id,
            clean_name: suggestion.clean_name_suggestion || null,
          }, createdRule))
          continue
        }
        if (createdRule?.status === 'merged') {
          if (createdRule.relation === 'duplicate') {
            summary.skipped += 1
          } else {
            summary.merged += 1
            if (createdRule.id) summary.reconciledRuleIds.push(createdRule.id)
          }
        } else {
          summary.created += 1
        }
        const applyResult = await applyRuleToSuggestionRows(createdRule?.id, suggestion, {
          correlationId,
          action: 'bulk-save',
          phasePrefix: 'scoped-apply',
        })
        lastResult = await updateSuggestionReviewForContext({
          suggestion_id: suggestion.id,
          status: 'accepted',
          rule_id: createdRule?.id || null,
          created_rule_id: createdRule?.status === 'created' ? createdRule.id : null,
          accepted_prior_rows: applyResult?.prior_rows || [],
          merchant_label: suggestion.merchant_label,
          target_category_name: suggestion.target_category_name,
          keyword: suggestion.keyword,
          match_source_text: !!suggestion.match_source_text,
        })
        await traceRuleSuggestionAction({
          correlationId,
          event: 'bulk-save',
          phase: 'after-suggestion',
          suggestions: [suggestion],
          ruleIds: [createdRule?.id],
          undoSnapshot,
          details: {
            prior_row_count: applyResult?.prior_rows?.length || 0,
            undo_row_count: undoSnapshot.rows?.length || 0,
            undo_rule_count: undoSnapshot.ruleIds?.length || 0,
          },
        })
        updatesById[suggestion.id] = {
          review_status: 'accepted',
          rule_id: createdRule?.id || null,
          created_rule_id: createdRule?.status === 'created' ? createdRule.id : null,
          accepted_prior_rows: applyResult?.prior_rows || [],
        }
      }
      applyLocalSuggestionUpdates(updatesById, {
        review_summary: lastResult?.review_summary || undefined,
        generated_at: lastResult?.generated_at || undefined,
      })
      if (summary.merged || summary.skipped || summary.conflicts.length || summary.reconciledRuleIds.length) {
        setReconcileApplyNote(null)
        setResolveSummary(summary)
      }
      await traceRuleSuggestionAction({
        correlationId,
        event: 'bulk-save',
        phase: 'after',
        suggestions,
        ruleIds: summary.reconciledRuleIds,
        undoSnapshot,
        details: summary,
      })
    } catch (err) {
      await traceRuleSuggestionAction({
        correlationId,
        event: 'bulk-save',
        phase: 'error',
        suggestions,
        undoSnapshot,
        details: { error: err.message || 'Unable to save selected rules.' },
      })
      setRuleSuggestionState(prev => ({
        ...prev,
        loading: false,
        error: err.message || 'Unable to save selected rules.',
      }))
    }
  }

  const systemCleanBatches = useMemo(
    () => batches.filter(item => item.use_imported_categories),
    [batches],
  )
  const contextMissing = isSystemContext ? false : (isProfileContext ? !profile : !batch)
  const contextHasImportedCategories = isSystemContext
    ? systemCleanBatches.some(item => item.has_imported_categories)
    : isProfileContext
      ? profileBatches.some(item => item.has_imported_categories)
      : !!batch?.has_imported_categories
  const contextTitle = isSystemContext
    ? 'All categorized imports'
    : isProfileContext
      ? (profile?.name || 'Data source')
      : (batch?.filename || 'Import')
  const contextSummary = isSystemContext
    ? `Using ${systemCleanBatches.length} imported file${systemCleanBatches.length === 1 ? '' : 's'
    }.`
    : isProfileContext
      ? `${profileBatches.length} imported file${profileBatches.length === 1 ? '' : 's'} `
      : `Imported ${formatImportedAt(batch?.imported_at)}${formatImportSummary(batch) ? ` · ${formatImportSummary(batch)}` : ''} `
  const emptyStateTitle = isSystemContext ? 'No categorized imports yet' : (isProfileContext ? 'Data source not found' : 'Import not found')
  const emptyStateDescription = isSystemContext
    ? 'Use the categories present in the data from Import / Export to include an imported file in rule suggestions.'
    : isProfileContext
      ? 'This data source may have been deleted or no longer has imported files attached.'
      : 'This import may have been undone or is no longer available in Recent imports.'
  const showBlockingLoading = loadingBatchContext || (!batchContextError && !initialSuggestionLoadComplete)

  return (
    <div data-browser-context-passthrough="true" style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {showBlockingLoading ? (
        <div data-browser-context-passthrough="true" style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 32 }}>
          <Spinner />
        </div>
      ) : (
        <>
          <div style={{ padding: '20px 32px 0', flexShrink: 0 }}>
            <div style={{ marginBottom: 8, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <Link to={backTo} style={{ fontSize: 13, color: 'var(--accent2)', textDecoration: 'none' }}>
                ← Back to {backLabel}
              </Link>
              {undoStack.length > 0 && (
                <Button variant="ghost" small onClick={performUndo}>
                  ↩ Undo ({undoStack.length})
                </Button>
              )}
            </div>
            <PageHeader
              title="Imported Rule Suggestions"
              help={<FeatureExplainer topic="generate-rules" placement="bottom-left" />}
            >
              <RecategorizeButton
                pendingCount={recategorizePendingCount}
                onRun={runRecategorize}
                label="↻ Apply categorization rules"
                showCount
              />
            </PageHeader>
          </div>

          <RecategorizeResultBanner
            result={recategorizeResult}
            onDismiss={dismissRecategorizeResult}
            style={{ margin: '12px 32px 0' }}
          />

          {/* Reserve the scrollbar gutter so a short view (no scrollbar) and a tall one (scrollbar) keep
              the same content width — otherwise the width change re-wraps the header description and the
              whole panel jumps when switching filters. */}
          <div data-browser-context-passthrough="true" style={{ flex: 1, minHeight: 0, overflow: 'auto', scrollbarGutter: 'stable', padding: '4px 32px 32px' }}>
            {/* minmax(0, 1fr) lets the single column shrink below its children's min-content so the cards
                reflow as the window narrows, instead of the implicit `auto` track holding them wide and
                getting clipped. overflow:auto above is the safety net: anything that still can't shrink
                scrolls rather than truncating. */}
            <div style={{ width: '100%', maxWidth: 1120, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 18 }}>
              {batchContextError ? (
                <Card>
                  <div style={{ fontSize: 14, color: 'var(--danger)' }}>{batchContextError}</div>
                </Card>
              ) : contextMissing ? (
                <Card>
                  <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>{emptyStateTitle}</div>
                  <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 14 }}>
                    {emptyStateDescription}
                  </div>
                  <Button onClick={() => navigate(backTo)}>
                    Return to {backLabel}
                  </Button>
                </Card>
              ) : !contextHasImportedCategories ? (
                <Card>
                  <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>{isSystemContext ? 'No categorized imports available yet' : 'No categories from the data were used'}</div>
                  <div style={{ fontSize: 13, color: 'var(--muted)' }}>
                    {isSystemContext
                      ? 'Imported files that are marked as having useful category information contribute category and rule patterns to this system-wide review.'
                      : isProfileContext
                        ? 'This data source does not indicate that the imported transactions carry useful information that can be used to suggest rules.'
                        : 'This imported file does not indicate that the transactions contain useful categorization information.'}
                  </div>
                </Card>
              ) : (
                <>
                  <Card style={{ display: 'grid', gap: 10 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}>
                      <div>
                        <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>{contextTitle}</div>
                        <div style={{ fontSize: 13, color: 'var(--muted)' }}>
                          {contextSummary}
                        </div>
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                        {ruleSuggestionState.generated_at
                          ? `Generated ${ruleSuggestionState.generated_at.slice(0, 16).replace('T', ' ')} `
                          : 'Suggestions will be generated from this imported data.'}
                      </div>
                    </div>
                    <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.6 }}>
                      {isSystemContext
                        ? 'Generate categorization rules from the imported files which are marked as having useful categorization data.'
                        : isProfileContext
                          ? 'Generate categorization rules from imported transactions attached to this data source with category information.'
                          : 'Generate categorization rules from imported transactions in this file that contain category information.'}
                    </div>
                  </Card>

                  {resolveSummary ? (
                    <Card style={{
                      display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16,
                      borderColor: resolveSummary.conflicts.length ? 'var(--danger)' : 'var(--border)',
                    }}>
                      <div style={{ fontSize: 13, lineHeight: 1.6, flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 600, marginBottom: 2 }}>Existing rules reconciled</div>
                        {(resolveSummary.replaced || resolveSummary.merged || resolveSummary.skipped) ? (
                          <div style={{ color: 'var(--muted)' }}>
                            {[
                              resolveSummary.replaced ? `${resolveSummary.replaced} existing rule${resolveSummary.replaced === 1 ? '' : 's'} replaced` : null,
                              resolveSummary.merged ? `${resolveSummary.merged} merged into an existing rule` : null,
                              resolveSummary.skipped ? `${resolveSummary.skipped} already existed(skipped)` : null,
                            ].filter(Boolean).join(' · ')}
                          </div>
                        ) : null}
                        {resolveSummary.conflicts.length ? (
                          <div style={{ marginTop: 8, display: 'grid', gap: 8 }}>
                            <div style={{ color: 'var(--danger)' }}>
                              {resolveSummary.conflicts.length === 1
                                ? 'An existing rule for this merchant assigns a different category. Replace it with the suggestion, or keep the existing rule and defer the suggestion.'
                                : 'Existing rules for these merchants assign a different category. Resolve each below.'}
                            </div>
                            {resolveSummary.conflicts.map(entry => (
                              <div key={entry.suggestion_id} style={{
                                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                                gap: 12, flexWrap: 'wrap',
                                padding: '8px 10px', borderRadius: 8,
                                border: '1px solid color-mix(in srgb, var(--danger) 24%, var(--border))',
                                background: 'color-mix(in srgb, var(--danger) 6%, var(--surface2))',
                              }}>
                                <div style={{ minWidth: 0 }}>
                                  <div style={{ fontWeight: 600 }}>
                                    {entry.merchant_label}{' '}
                                    <code style={{ fontSize: 12, color: 'var(--muted)' }}>{entry.keyword}</code>
                                  </div>
                                  <div style={{ color: 'var(--muted)', fontSize: 12.5, marginTop: 2 }}>
                                    existing rule → {describeRuleAction(entry.existing_category_id, entry.existing_clean_name)}
                                    {'  ·  '}
                                    suggestion → {describeRuleAction(entry.proposed_category_id, entry.proposed_clean_name)}
                                  </div>
                                </div>
                                <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                                  <Button
                                    small
                                    onClick={() => replaceConflictingRule(entry)}
                                    disabled={resolvingConflictId === entry.suggestion_id}
                                  >
                                    Replace existing
                                  </Button>
                                  <Button
                                    small
                                    variant="ghost"
                                    onClick={() => keepExistingRule(entry)}
                                    disabled={resolvingConflictId === entry.suggestion_id}
                                  >
                                    Keep existing
                                  </Button>
                                </div>
                              </div>
                            ))}
                          </div>
                        ) : null}
                        {reconcileApplyNote != null ? (
                          <div style={{ marginTop: 8, fontSize: 12.5, color: reconcileApplyNote > 0 ? 'var(--success)' : 'var(--muted)' }}>
                            {reconcileApplyNote > 0
                              ? `↻ ${reconcileApplyNote} transaction${reconcileApplyNote === 1 ? '' : 's'} re - categorized.`
                              : '↻ No matching transactions needed re-categorization.'}
                          </div>
                        ) : resolveSummary.reconciledRuleIds?.length ? (
                          <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                            <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>
                              {resolveSummary.replaced && !resolveSummary.merged
                                ? 'This rule now categorizes differently. Update the transactions it already matches?'
                                : 'These rules now categorize differently. Update the transactions they already match?'}
                            </span>
                            <Button
                              small
                              onClick={recategorizeReconciledMatches}
                              disabled={recategorizingMatches}
                              title="Re-categorizes matches set by import or a rule; leaves manual edits unchanged."
                            >
                              {recategorizingMatches ? 'Re-categorizing…' : '↻ Re-categorize matching transactions'}
                            </Button>
                          </div>
                        ) : null}
                      </div>
                      <Button variant="ghost" small onClick={() => { setResolveSummary(null); setReconcileApplyNote(null) }}>Dismiss</Button>
                    </Card>
                  ) : null}

                  <ImportRuleSuggestionReview
                    onLoadSuggestionMatches={loadSuggestionMatchesForContext}
                    onReloadSuggestions={reloadSuggestions}
                    ruleSuggestionState={ruleSuggestionState}
                    persistKey={contextKey}
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
                    onRejectSuggestionDisposition={rejectSuggestionWithDisposition}
                    onBulkRejectDisposition={bulkRejectWithDisposition}
                  onApplyConflictSet={applyConflictSet}
                  applyingConflict={applyingConflict}
                  editingSuggestionId={editingSuggestionId}
                  onRefineConflictMatch={async payload => {
                    const correlationId = newTraceCorrelation('refine-match')
                    const sourceSuggestions = payload.source_suggestions || []
                    await traceRuleSuggestionAction({
                      correlationId,
                      event: 'refine-match',
                      phase: 'before',
                      suggestions: sourceSuggestions,
                      keywords: [payload.keyword],
                      details: {
                        owner_id: payload.owner_id || null,
                        account_id: payload.account_id || null,
                        amount_min: payload.amount_min ?? null,
                        amount_max: payload.amount_max ?? null,
                        match_source_text: !!payload.match_source_text,
                      },
                    })
                    setResolveSummary(null)
                    setReconcileApplyNote(null)
                    setRuleSuggestionState(prev => ({ ...prev, error: '' }))
                    try {
                      const result = await refineSuggestionMatchForContext(payload)
                      setEditingSuggestionId(null)
                      await reloadSuggestions()
                      await traceRuleSuggestionAction({
                        correlationId,
                        event: 'refine-match',
                        phase: 'after',
                        suggestions: sourceSuggestions,
                        keywords: [payload.keyword],
                        details: {
                          review_summary: result?.review_summary || null,
                        },
                      })
                    } catch (err) {
                      await traceRuleSuggestionAction({
                        correlationId,
                        event: 'refine-match',
                        phase: 'error',
                        suggestions: sourceSuggestions,
                        keywords: [payload.keyword],
                        details: { error: err.message || 'Unable to refine this match.' },
                      })
                      setRuleSuggestionState(prev => ({ ...prev, error: err.message || 'Unable to refine this match.' }))
                    }
                  }}
                  categories={categories}
                  owners={owners}
                  accounts={accounts}
                    tags={tags}
                    onTagCreated={created => setTags(prev => (prev.some(tag => tag.id === created.id) ? prev : [...prev, created]))}
                    onCategoriesChanged={reloadCategories}
                  />
                </>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
