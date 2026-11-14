// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useLocation } from 'react-router-dom'
import { Card, PageHeader, Button, Spinner } from '../components/ui.jsx'
import { useRecategorize, RecategorizeButton, RecategorizeResultBanner } from '../components/RecategorizeControl.jsx'
import ImportRuleSuggestionReview from '../components/ImportRuleSuggestionReview.jsx'
import ImportedFilesPopover from '../components/importRuleSuggestions/ImportedFilesPopover.jsx'
import { useBatchDetailPanels } from '../components/importExport/useBatchDetailPanels.jsx'
import FeatureExplainer from '../help/FeatureExplainer.jsx'
import { api } from '../lib/api.js'
import { txnMutations } from '../lib/txnMutations.js'
import { useUserPreference } from '../lib/UserPreferencesContext.jsx'
import { formatTimestamp } from '../lib/utils.js'

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

export default function ImportRuleSuggestions() {
  const { batchId, profileId } = useParams()
  const navigate = useNavigate()
  // The back affordance follows where the user came from: the Rules page stamps {backTo, backLabel}
  // when it opens this surface, otherwise it falls back to Import (its canonical home).
  const location = useLocation()
  const backTo = location.state?.backTo || '/import-export'
  const backLabel = location.state?.backLabel || 'Import'
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
    trash_sets: [],
    generated_at: null,
  })
  // Recap of the last accept action's collision reconciliation (merged into / skipped as duplicate of
  // an existing rule, or conflicts left pending for the user). Kept outside ruleSuggestionState so a
  // reload doesn't wipe it. `conflicts` carries one entry per unresolved conflict so the banner can show
  // the colliding rule and offer Replace/Keep inline; `reconciledRuleIds` collects the existing rules a
  // merge/replace changed, so the banner can offer to re-categorize the transactions those rules already
  // match. Shape: { merged, skipped, replaced, conflicts: ConflictEntry[], reconciledRuleIds: string[] }
  // | null (see showResolveSummary).
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
  // Each entry is `{ scope, undo }`: the payload an action answered with and the review it came from, so an
  // undo always reaches the review that produced it. Session-local — lost on reload.
  const [undoStack, setUndoStack] = useState([])
  const undoInFlightRef = useRef(false)
  const [applyingConflict, setApplyingConflict] = useState(false)
  const MAX_UNDO = 10
  const {
    result: recategorizeResult,
    run: runRecategorize,
    dismissResult: dismissRecategorizeResult,
    pendingCount: recategorizePendingCount,
    reloadPreview: reloadRecategorizePreview,
  } = useRecategorize({ countPending: true })
  const reviewScope = useMemo(() => ({ batchId, profileId }), [batchId, profileId])
  const { openBatchDetail, panelsNode: batchDetailPanelsNode } = useBatchDetailPanels({
    categories,
    onAddCategory: category => setCategories(prev => prev.some(existing => existing.id === category.id) ? prev : [...prev, category]),
  })

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
  const refineSuggestionMatchForContext = payload => (
    isSystemContext
      ? api.refineSystemRuleSuggestionMatch(payload)
      : isProfileContext
        ? api.refineProfileRuleSuggestionMatch(profileId, payload)
        : api.refineBatchRuleSuggestionMatch(batchId, payload)
  )
  const clearRuleSuggestionsForContext = (status, suggestionIds = null) => (
    isSystemContext
      ? api.clearSystemRuleSuggestions(status, suggestionIds)
      : isProfileContext
        ? api.clearProfileRuleSuggestions(profileId, status, suggestionIds)
        : api.clearBatchRuleSuggestions(batchId, status, suggestionIds)
  )
  const restoreRuleSuggestionTrashSetForContext = trashSetId => (
    isSystemContext
      ? api.restoreSystemRuleSuggestionTrashSet(trashSetId)
      : isProfileContext
        ? api.restoreProfileRuleSuggestionTrashSet(profileId, trashSetId)
        : api.restoreBatchRuleSuggestionTrashSet(batchId, trashSetId)
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

  async function reloadTags() {
    const nextTags = await api.getTags()
    setTags(nextTags || [])
    return nextTags || []
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
          trash_sets: result.trash_sets || [],
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
          trash_sets: [],
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
      trash_sets: result.trash_sets || [],
      generated_at: result.generated_at || null,
    })
    // Accepting/replacing suggestions creates or repoints rules, so the retroactive-apply preview
    // count can change — refresh it alongside the suggestion reload.
    reloadRecategorizePreview()
  }

  // Every review action is one request that commits whole or not at all and answers with the payload that
  // reverses it (backend `rule_suggestion_actions`), so the page only sends the user's intent, keeps the
  // undo payload, and reloads. A save from the rule editor rethrows so the editor stays open showing the
  // error; a card or bulk action reports it on the page.
  async function runReviewAction(perform, { fallbackError, rethrow = false }) {
    setRuleSuggestionState(prev => ({ ...prev, error: '' }))
    try {
      const result = await perform()
      if (result?.undo) {
        setUndoStack(prev => [...prev.slice(-(MAX_UNDO - 1)), { scope: reviewScope, undo: result.undo }])
      }
      await reloadSuggestions()
      return result
    } catch (err) {
      if (rethrow) throw err
      setRuleSuggestionState(prev => ({ ...prev, loading: false, error: err.message || fallbackError }))
      return null
    }
  }

  async function performUndo() {
    const entry = undoStack[undoStack.length - 1]
    // A ref, not state: a second press in the same tick would otherwise post the same payload twice and pop
    // an entry that was never undone.
    if (!entry || undoInFlightRef.current) return
    undoInFlightRef.current = true
    setRuleSuggestionState(prev => ({ ...prev, error: '' }))
    try {
      await txnMutations.undoRuleSuggestionAction(entry.scope, entry.undo)
      setUndoStack(prev => prev.slice(0, -1))
      await reloadSuggestions()
    } catch (err) {
      setRuleSuggestionState(prev => ({ ...prev, loading: false, error: err.message || 'Unable to undo the last action.' }))
    } finally {
      undoInFlightRef.current = false
    }
  }

  function getCategoryName(categoryId) {
    return categories.find(category => String(category.id) === String(categoryId))?.name || null
  }

  function statusItem(suggestion) {
    return {
      suggestion_id: suggestion.id,
      source_row_ids: suggestion.source_row_ids || [],
      merchant_label: suggestion.merchant_label || null,
      target_category_name: suggestion.target_category_name || null,
      keyword: suggestion.keyword || null,
    }
  }

  function suggestionRule(suggestion) {
    return {
      keyword: suggestion.keyword,
      category_id: suggestion.target_category_id,
      amount_min: suggestion.amount_min,
      amount_max: suggestion.amount_max,
      clean_name: suggestion.clean_name_suggestion || null,
      owner_id: suggestion.owner_id || null,
      account_id: suggestion.account_id || null,
      tag_ids: suggestion.tag_ids || [],
      match_source_text: !!suggestion.match_source_text,
    }
  }

  function acceptItem(suggestion, rule, applyToExisting = false) {
    return {
      suggestion_id: suggestion.id,
      source_row_ids: suggestion.source_row_ids || [],
      merchant_label: suggestion.merchant_label || null,
      rule,
      apply_to_existing: applyToExisting,
    }
  }

  // The banner recaps how an action's rules met existing ones. A conflict keeps the request item it came
  // from, so Replace resends exactly what was asked, with `replace_existing`.
  function showResolveSummary(summary, items) {
    const itemsById = new Map(items.map(item => [item.suggestion_id, item]))
    const conflicts = (summary?.conflicts || []).map(conflict => ({ ...conflict, item: itemsById.get(conflict.suggestion_id) }))
    const reconciledRuleIds = summary?.reconciled_rule_ids || []
    const notable = summary && (summary.merged || summary.skipped || summary.replaced || conflicts.length || reconciledRuleIds.length)
    setReconcileApplyNote(null)
    setResolveSummary(notable
      ? { merged: summary.merged, skipped: summary.skipped, replaced: summary.replaced, conflicts, reconciledRuleIds }
      : null)
  }

  function settleConflictEntry(suggestionId, { replaced = 0, reconciledRuleIds = [] } = {}) {
    setResolveSummary(prev => {
      if (!prev) return prev
      const next = {
        ...prev,
        replaced: (prev.replaced || 0) + replaced,
        conflicts: prev.conflicts.filter(entry => entry.suggestion_id !== suggestionId),
        reconciledRuleIds: [...new Set([...(prev.reconciledRuleIds || []), ...reconciledRuleIds])],
      }
      const empty = !next.conflicts.length && !next.merged && !next.skipped && !next.replaced && !next.reconciledRuleIds.length
      return empty ? null : next
    })
  }

  // Saving covers a pending suggestion (create the rule and claim the suggestion's rows) and an accepted one
  // (edit its rule and redraw the rows it owns); the backend tells the two apart from the stored review.
  async function saveSuggestions(items, { rethrow = false } = {}) {
    setResolveSummary(null)
    setReconcileApplyNote(null)
    const result = await runReviewAction(
      () => txnMutations.acceptRuleSuggestions(reviewScope, items),
      { fallbackError: 'Unable to save the selected rules.', rethrow },
    )
    if (!result) return
    setEditingSuggestionId(null)
    showResolveSummary(result.summary, items)
  }

  async function saveSuggestion(suggestion, data) {
    const { applyToExisting, ...rule } = data
    await saveSuggestions([acceptItem(suggestion, rule, !!applyToExisting)], { rethrow: true })
  }

  async function saveSuggestionAsIs(suggestion) {
    await saveSuggestions([acceptItem(suggestion, suggestionRule(suggestion))])
  }

  async function saveSuggestionsAsIsBulk(suggestions) {
    await saveSuggestions(suggestions.map(suggestion => acceptItem(suggestion, suggestionRule(suggestion))))
  }

  // Returning an accepted suggestion to pending also restores its rows and trashes the rule it created;
  // discarding with 'clear' clears the rows' categories, while 'keep' leaves them as imported.
  async function setSuggestionStatusBulk(suggestions, status, options) {
    setEditingSuggestionId(null)
    await runReviewAction(
      () => txnMutations.setRuleSuggestionStatus(reviewScope, suggestions.map(statusItem), status, options),
      { fallbackError: 'Unable to update the selected suggestions.' },
    )
  }

  async function setSuggestionStatus(suggestion, status) {
    await setSuggestionStatusBulk([suggestion], status)
  }

  async function rejectSuggestionWithDisposition(suggestion, mode) {
    await setSuggestionStatusBulk([suggestion], 'discarded', { clearCategories: mode === 'clear' })
  }

  async function bulkRejectWithDisposition(suggestions, mode) {
    await setSuggestionStatusBulk(suggestions, 'discarded', { clearCategories: mode === 'clear' })
  }

  async function clearReviewedSuggestions(status, suggestionIds = null) {
    setEditingSuggestionId(null)
    setRuleSuggestionState(prev => ({ ...prev, error: '' }))
    try {
      await clearRuleSuggestionsForContext(status, suggestionIds)
      await reloadSuggestions()
      setReviewFilter('trash')
    } catch (err) {
      setRuleSuggestionState(prev => ({
        ...prev,
        loading: false,
        error: err.message || 'Unable to clear rule suggestions.',
      }))
    }
  }

  async function restoreRuleSuggestionTrashSet(trashSetId) {
    setEditingSuggestionId(null)
    setRuleSuggestionState(prev => ({ ...prev, error: '' }))
    try {
      await restoreRuleSuggestionTrashSetForContext(trashSetId)
      await reloadSuggestions()
    } catch (err) {
      setRuleSuggestionState(prev => ({
        ...prev,
        loading: false,
        error: err.message || 'Unable to restore rule suggestions.',
      }))
    }
  }

  function describeRuleAction(categoryId, cleanName) {
    const categoryName = getCategoryName(categoryId)
    if (categoryName) return categoryName
    if (cleanName) return `rename to "${cleanName}"`
    return 'no category'
  }

  // Banner action: re-apply each merged/replaced rule to the transactions it already matches. Uses the
  // preserve-manual mode (reclaims trusted-import and rule-owned rows, leaves manual edits alone), since a
  // merge/replace deliberately changes the governing rule but a manual per-transaction edit still wins.
  async function recategorizeReconciledMatches() {
    const ids = resolveSummary?.reconciledRuleIds || []
    if (!ids.length || recategorizingMatches) return
    setRecategorizingMatches(true)
    try {
      // A review action like every other control here, so the rows it recategorizes are captured and the
      // Undo button reverses them — and all the named rules move in one transaction rather than one
      // request each.
      const result = await runReviewAction(
        () => txnMutations.applyRuleSuggestionRules(reviewScope, ids),
        { fallbackError: 'Unable to re-categorize matching transactions.' },
      )
      if (!result) return
      setReconcileApplyNote(result.updated || 0)
      setResolveSummary(prev => (prev ? { ...prev, reconciledRuleIds: [] } : prev))
      reloadRecategorizePreview()
    } finally {
      setRecategorizingMatches(false)
    }
  }

  // Replace: overwrite the colliding rule's category and rename with the suggestion's, then accept the
  // suggestion into that rule — the same save that conflicted, sent again with `replace_existing`.
  async function replaceConflictingRule(entry) {
    if (!entry.existing_rule_id || !entry.item || resolvingConflictId) return
    setResolvingConflictId(entry.suggestion_id)
    try {
      const result = await runReviewAction(
        () => txnMutations.acceptRuleSuggestions(reviewScope, [{ ...entry.item, replace_existing: true }]),
        { fallbackError: 'Unable to replace the existing rule.' },
      )
      if (!result) return
      setReconcileApplyNote(null)
      settleConflictEntry(entry.suggestion_id, {
        replaced: result.summary?.replaced || 0,
        reconciledRuleIds: result.summary?.reconciled_rule_ids || [],
      })
    } finally {
      setResolvingConflictId(null)
    }
  }

  // Keep: leave the existing rule untouched and defer the suggestion so it drops out of the pending view.
  async function keepExistingRule(entry) {
    if (resolvingConflictId) return
    setResolvingConflictId(entry.suggestion_id)
    try {
      const suggestion = ruleSuggestionState.suggestions.find(item => item.id === entry.suggestion_id)
      const result = suggestion
        ? await runReviewAction(
          () => txnMutations.setRuleSuggestionStatus(reviewScope, [statusItem(suggestion)], 'skipped'),
          { fallbackError: 'Unable to defer the suggestion.' },
        )
        : {}
      if (result) settleConflictEntry(entry.suggestion_id)
    } finally {
      setResolvingConflictId(null)
    }
  }

  // Resolve a whole conflict set in one action, driven by each member's *target* category: `winnerId` null
  // settles every member to its target with no rule; a winner's target becomes the rule, and the backend
  // derives every other member's disposition by comparing its target to the winner's category.
  async function applyConflictSet(members, winnerId) {
    if (applyingConflict) return
    setApplyingConflict(true)
    setResolveSummary(null)
    setReconcileApplyNote(null)
    try {
      const payload = members.map(member => ({
        ...statusItem(member),
        target_category_id: member.target_category_id || null,
        owner_id: member.owner_id || null,
        account_id: member.account_id || null,
        amount_min: member.amount_min,
        amount_max: member.amount_max,
        clean_name_suggestion: member.clean_name_suggestion || null,
        tag_ids: member.tag_ids || [],
        match_source_text: !!member.match_source_text,
      }))
      const result = await runReviewAction(
        () => txnMutations.resolveRuleSuggestionConflictSet(reviewScope, payload, winnerId || null),
        { fallbackError: 'Unable to resolve this conflict set.' },
      )
      if (!result) return
      setEditingSuggestionId(null)
      const winner = members.find(member => member.id === winnerId)
      showResolveSummary(result.summary, winner ? [acceptItem(winner, suggestionRule(winner))] : [])
    } finally {
      setApplyingConflict(false)
    }
  }

  async function refineConflictMatch(payload) {
    setResolveSummary(null)
    setReconcileApplyNote(null)
    setRuleSuggestionState(prev => ({ ...prev, error: '' }))
    try {
      await refineSuggestionMatchForContext(payload)
      setEditingSuggestionId(null)
      await reloadSuggestions()
    } catch (err) {
      setRuleSuggestionState(prev => ({ ...prev, error: err.message || 'Unable to refine this match.' }))
      throw err
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
  const describeBatch = item => [formatTimestamp(item?.imported_at), formatImportSummary(item)].filter(Boolean).join(' · ')
  const contextFiles = isSystemContext ? systemCleanBatches : profileBatches
  const contextFilesLink = (
    <ImportedFilesPopover
      files={contextFiles}
      label={`${contextFiles.length} imported file${contextFiles.length === 1 ? '' : 's'}`}
      describeFile={describeBatch}
      onOpenFile={openBatchDetail}
    />
  )
  const contextSummary = isSystemContext
    ? <>Using {contextFilesLink}.</>
    : isProfileContext
      ? contextFilesLink
      : `Imported ${describeBatch(batch)}`
  const emptyStateTitle = isSystemContext ? 'No categorized imports yet' : (isProfileContext ? 'Data source not found' : 'Import not found')
  const emptyStateDescription = isSystemContext
    ? "Check “Import the transactions with their existing categories” on a file's card on the Import page to include it in rule suggestions."
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
                <Button variant="secondary" onClick={performUndo}>
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
                                    onClick={() => replaceConflictingRule(entry)}
                                    disabled={resolvingConflictId === entry.suggestion_id}
                                  >
                                    Replace existing
                                  </Button>
                                  <Button
                                    variant="secondary"
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
                              onClick={recategorizeReconciledMatches}
                              disabled={recategorizingMatches}
                              title="Re-categorizes matches set by import or a rule; leaves manual edits unchanged."
                            >
                              {recategorizingMatches ? 'Re-categorizing…' : '↻ Re-categorize matching transactions'}
                            </Button>
                          </div>
                        ) : null}
                      </div>
                      <Button variant="secondary" onClick={() => { setResolveSummary(null); setReconcileApplyNote(null) }}>Dismiss</Button>
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
                    onSaveAcceptedSuggestion={saveSuggestion}
                    onSaveSuggestionAsIs={saveSuggestionAsIs}
                    onSetSuggestionStatusBulk={setSuggestionStatusBulk}
                    onSaveSuggestionsAsIsBulk={saveSuggestionsAsIsBulk}
                    onSetSuggestionStatus={setSuggestionStatus}
                    onRejectSuggestionDisposition={rejectSuggestionWithDisposition}
                    onBulkRejectDisposition={bulkRejectWithDisposition}
                    onApplyConflictSet={applyConflictSet}
                    applyingConflict={applyingConflict}
                    editingSuggestionId={editingSuggestionId}
                    onRefineConflictMatch={refineConflictMatch}
                    categories={categories}
                    owners={owners}
                    accounts={accounts}
                    tags={tags}
                    onTagCreated={created => setTags(prev => (prev.some(tag => tag.id === created.id) ? prev : [...prev, created]))}
                    onReloadTags={reloadTags}
                    onCategoriesChanged={reloadCategories}
                    onClearReviewedSuggestions={clearReviewedSuggestions}
                    onRestoreTrashSet={restoreRuleSuggestionTrashSet}
                  />
                </>
              )}
            </div>
          </div>
        </>
      )}
      {batchDetailPanelsNode}
    </div>
  )
}
