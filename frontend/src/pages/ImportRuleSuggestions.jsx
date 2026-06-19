// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: GPL-3.0-or-later

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams, useLocation } from 'react-router-dom'
import { Card, PageHeader, Button, Spinner } from '../components/ui.jsx'
import { useRecategorize, RecategorizeButton, RecategorizeResultBanner } from '../components/RecategorizeControl.jsx'
import ImportRuleSuggestionReview from '../components/ImportRuleSuggestionReview.jsx'
import FeatureExplainer from '../help/FeatureExplainer.jsx'
import { api } from '../lib/api.js'
import { txnMutations } from '../lib/txnMutations.js'
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
  const MAX_UNDO = 10
  const {
    pendingCount: recategorizePendingCount,
    result: recategorizeResult,
    run: runRecategorize,
    reloadPreview: reloadRecategorizePreview,
    dismissResult: dismissRecategorizeResult,
  } = useRecategorize()

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
      await updateSuggestionReviewForContext({
        suggestion_id: suggestionId,
        status: prev.review_status,
      }).catch(() => {})
    }
    await reloadSuggestions()
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

  async function setSuggestionStatus(suggestion, status) {
    setEditingSuggestionId(null)
    pushUndo([suggestion.id])
    const result = await updateSuggestionReviewForContext({
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
        lastResult = await updateSuggestionReviewForContext({
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
      pushUndo([entry.suggestion_id])
      await updateSuggestionReviewForContext({
        suggestion_id: entry.suggestion_id,
        status: 'accepted',
        rule_id: ruleId,
        merchant_label: suggestion?.merchant_label ?? entry.merchant_label,
        target_category_name: getCategoryName(entry.proposed_category_id),
        target_category_id: entry.proposed_category_id || null,
        keyword: entry.keyword,
        clean_name_suggestion: entry.proposed_clean_name || null,
      })
      if (suggestion) await applyRuleToSuggestionRows(ruleId, suggestion)
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
  async function applyRuleToSuggestionRows(ruleId, suggestion) {
    const rowIds = suggestion?.source_row_ids || []
    if (!ruleId || !rowIds.length) return
    try {
      await txnMutations.applyRuleToTransactions(ruleId, rowIds)
    } catch {
      // The rule itself saved; a failure to back-apply to its own rows shouldn't fail the accept.
      // The user can still re-apply from the rule, and the rows surface again on the next generate.
    }
  }

  async function saveSuggestion(suggestion, data) {
    setResolveSummary(null)
    setReconcileApplyNote(null)
    const { applyToExisting, ...ruleData } = data
    // Auto-resolve against an existing same-matcher rule (Generate Rules is the bulk flow): merge a
    // mergeable/duplicate save into it. A conflict (a different category/rename on the same matcher)
    // is left for the user — we don't fork or overwrite, so the suggestion stays pending and is named
    // in the summary banner.
    const createdRule = await api.createRule(ruleData, { onExisting: 'merge' })
    if (createdRule?.status === 'conflict') {
      setResolveSummary({ created: 0, merged: 0, skipped: 0, conflicts: [buildConflictEntry(suggestion, data, createdRule)] })
      setEditingSuggestionId(null)
      await reloadSuggestions()
      return
    }
    const coveredSuggestionIds = getCoveredSuggestionIds(suggestion, data)
    pushUndo([suggestion.id, ...coveredSuggestionIds])
    await updateSuggestionReviewForContext({
      suggestion_id: suggestion.id,
      status: 'accepted',
      rule_id: createdRule?.id || null,
      merchant_label: suggestion.merchant_label,
      target_category_name: data.category_id ? getCategoryName(data.category_id) : suggestion.target_category_name,
      target_category_id: data.category_id || null,
      keyword: data.keyword,
      owner_id: data.owner_id || null,
      account_id: data.account_id || null,
      amount_min: data.amount_min,
      amount_max: data.amount_max,
      clean_name_suggestion: data.clean_name || null,
    })
    // Auto-apply the rule's outputs to this suggestion's own source rows (no extra step). The broad
    // "apply to all matches" action below is opt-in and a superset; this scoped pass is the default.
    await applyRuleToSuggestionRows(createdRule?.id, suggestion)
    if (applyToExisting && createdRule?.id) await txnMutations.applyRule(createdRule.id)
    // A merge that actually changed the existing rule (filled a category/rename or added tags — i.e. not
    // a pure duplicate) is a candidate for re-categorizing the rows it already matches.
    if (createdRule?.status === 'merged' && createdRule.relation !== 'duplicate') {
      recordReconciledRule(createdRule.id, 'merged')
    }
    setEditingSuggestionId(null)
    await reloadSuggestions()
  }

  async function saveAcceptedSuggestion(suggestion, data) {
    setReconcileApplyNote(null)
    // applyToExisting is irrelevant for already-accepted suggestions (just edits/re-saves
    // the rule); destructure-and-discard so it isn't forwarded into the rule API payload.
    // eslint-disable-next-line no-unused-vars
    const { applyToExisting, ...ruleData } = data
    let ruleId = suggestion.rule_id || null
    let mergedRuleId = null
    const coveredSuggestionIds = getCoveredSuggestionIds(suggestion, data)
    pushUndo([suggestion.id, ...coveredSuggestionIds])

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
    }

    await updateSuggestionReviewForContext({
      suggestion_id: suggestion.id,
      status: 'accepted',
      rule_id: ruleId,
      merchant_label: suggestion.merchant_label,
      target_category_name: data.category_id ? getCategoryName(data.category_id) : null,
      target_category_id: data.category_id || null,
      keyword: data.keyword,
      owner_id: data.owner_id || null,
      account_id: data.account_id || null,
      amount_min: data.amount_min,
      amount_max: data.amount_max,
      clean_name_suggestion: data.clean_name || null,
    })

    await applyRuleToSuggestionRows(ruleId, suggestion)
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
      applyToExisting: false,
    })
  }

  async function saveSuggestionsAsIsBulk(suggestions) {
    setEditingSuggestionId(null)
    setResolveSummary(null)
    setReconcileApplyNote(null)
    setRuleSuggestionState(prev => ({ ...prev, error: '' }))
    pushUndo(suggestions.map(s => s.id))
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
        }, { onExisting: 'merge' })
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
        lastResult = await updateSuggestionReviewForContext({
          suggestion_id: suggestion.id,
          status: 'accepted',
          rule_id: createdRule?.id || null,
          merchant_label: suggestion.merchant_label,
          target_category_name: suggestion.target_category_name,
          keyword: suggestion.keyword,
        })
        await applyRuleToSuggestionRows(createdRule?.id, suggestion)
        updatesById[suggestion.id] = {
          review_status: 'accepted',
          rule_id: createdRule?.id || null,
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
    } catch (err) {
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
    ? `${systemCleanBatches.length} imported file${systemCleanBatches.length === 1 ? '' : 's'} using categories from the data`
    : isProfileContext
    ? `${profileBatches.length} imported file${profileBatches.length === 1 ? '' : 's'}`
    : `Imported ${formatImportedAt(batch?.imported_at)}${formatImportSummary(batch) ? ` · ${formatImportSummary(batch)}` : ''}`
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

          <div data-browser-context-passthrough="true" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '4px 32px 32px' }}>
            <div style={{ width: '100%', maxWidth: 1120, display: 'grid', gap: 18 }}>
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
                      ? 'Only imported files that use categories present in the data contribute category and rule patterns to this system-wide review.'
                      : isProfileContext
                      ? 'This data source does not have imported transactions using categories from the data that can be used to infer rules.'
                      : 'This import does not contain transactions using categories from the data that can be used to infer rules.'}
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
                          ? `Generated ${ruleSuggestionState.generated_at.slice(0, 16).replace('T', ' ')}`
                          : 'Suggestions will be generated from this imported data.'}
                      </div>
                    </div>
                    <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.6 }}>
                      {isSystemContext
                        ? 'Generate categorization rules from imported transactions that used categories present in the data across every imported file.'
                        : isProfileContext
                        ? 'Generate categorization rules from imported transactions attached to this data source that used categories present in the data.'
                        : 'Generate categorization rules from imported transactions in this file that used categories present in the data.'}
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
                              resolveSummary.skipped ? `${resolveSummary.skipped} already existed (skipped)` : null,
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
                              ? `↻ ${reconcileApplyNote} transaction${reconcileApplyNote === 1 ? '' : 's'} re-categorized.`
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
