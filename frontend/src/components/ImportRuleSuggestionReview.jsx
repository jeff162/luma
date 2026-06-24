// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: GPL-3.0-or-later

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { txnMutations } from '../lib/txnMutations.js'
import { api } from '../lib/api.js'
import { Spinner, Tooltip } from './ui.jsx'
import CategoryPicker from './CategoryPicker.jsx'
import TagPickerWithCreate from './TagPickerWithCreate.jsx'
import { TagBadge } from './TagUi.jsx'
import { useUserPreferences } from '../lib/UserPreferencesContext.jsx'
import {
  IMPORT_RULE_LOOKBACK_CHOICES,
  IMPORT_RULE_LOOKBACK_PREF_KEY,
  IMPORT_RULE_SORT_PREF_KEY,
  IMPORT_RULE_SORT_STORAGE_KEY,
  buildCategoryDisplayLabel,
  findNearestScrollParent,
  getSuggestionFilterPills,
  normalizeImportRuleLookback,
  normalizeImportRuleSortOrder,
} from '../lib/importRuleSuggestions.js'
import {
  CriteriaGroup,
  ProgressPill,
  ReportArrowButton,
  SuggestionActionButton,
  SuggestionPill,
  SuggestionStatusBadge,
} from './importRuleSuggestions/suggestionPresentational.jsx'
import { RuleEditorModal } from './importRuleSuggestions/RuleEditorModal.jsx'
import { ConflictSetModal } from './importRuleSuggestions/ConflictSetModal.jsx'
import { MatchingTransactionsModal } from './importRuleSuggestions/MatchingTransactionsModal.jsx'
import { ConflictSetCard } from './importRuleSuggestions/ConflictSetCard.jsx'
import TransactionDetail from './TransactionDetail.jsx'
import ContextualExplainer from '../help/ContextualExplainer.jsx'

// Bulk-selection persistence. Deliberately sessionStorage, NOT the durable ui_preference store: the
// in-progress selection is a within-session convenience that survives navigating away from the review
// and reopening Generate Rules, but it should not outlive the session or get swept into data backups.
// One slot, scoped by review context (import source + owner filter + view) so a saved selection is only
// restored into the exact context it was built in, never bled across contexts.
const BULK_SELECTION_STORAGE_KEY = 'luma.import-rule-suggestions.bulk-selection'

function bulkSelectionScopeId(persistKey, selectedOwnerIds, reviewFilter) {
  const owners = [...(selectedOwnerIds || [])].map(String).sort().join(',')
  return `${persistKey || 'system'}::${owners}::${reviewFilter || 'pending'}`
}

function loadStoredBulkSelection(scopeId) {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.sessionStorage.getItem(BULK_SELECTION_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed || parsed.scopeId !== scopeId) return null
    return Array.isArray(parsed.ids) ? parsed.ids.map(String) : null
  } catch {
    return null
  }
}

function saveStoredBulkSelection(scopeId, ids) {
  if (typeof window === 'undefined') return
  try {
    window.sessionStorage.setItem(BULK_SELECTION_STORAGE_KEY, JSON.stringify({ scopeId, ids }))
  } catch { }
}

// Scope-aware clear: only drops the slot when it belongs to this context, so entering bulk mode in one
// context never wipes a selection saved for another.
function clearStoredBulkSelection(scopeId) {
  if (typeof window === 'undefined') return
  try {
    const raw = window.sessionStorage.getItem(BULK_SELECTION_STORAGE_KEY)
    if (!raw) return
    const parsed = JSON.parse(raw)
    if (scopeId && parsed?.scopeId && parsed.scopeId !== scopeId) return
    window.sessionStorage.removeItem(BULK_SELECTION_STORAGE_KEY)
  } catch { }
}

// Small text-style buttons (Select all / Clear) used inside the bulk-actions bar.
function bulkLinkButtonStyle(disabled) {
  return {
    border: 'none',
    background: 'none',
    padding: 0,
    fontSize: 12,
    fontWeight: 600,
    color: disabled ? 'var(--muted)' : 'var(--accent2)',
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.6 : 1,
    whiteSpace: 'nowrap',
  }
}

export default function ImportRuleSuggestionReview({
  onLoadSuggestionMatches,
  ruleSuggestionState,
  persistKey,
  selectedOwnerIds,
  reviewFilter,
  onChangeReviewFilter,
  onToggleOwner,
  merchantFilterOpen,
  onMerchantFilterOpenChange,
  ownerFilterOpen,
  onOwnerFilterOpenChange,
  onEditSuggestion,
  onCancelEdit,
  onSaveSuggestion,
  onSaveAcceptedSuggestion,
  onSaveSuggestionAsIs,
  onSetSuggestionStatusBulk,
  onSaveSuggestionsAsIsBulk,
  onSetSuggestionStatus,
  onRejectSuggestionDisposition,
  onBulkRejectDisposition,
  onApplyConflictSet,
  applyingConflict,
  editingSuggestionId,
  categories,
  owners,
  accounts,
  tags = [],
  onTagCreated,
  onCategoriesChanged,
  onReloadSuggestions,
}) {
  const rootRef = useRef(null)
  const { getPreference, hasPreference, setPreference } = useUserPreferences()
  const suggestions = useMemo(() => ruleSuggestionState?.suggestions || [], [ruleSuggestionState?.suggestions])
  const summary = ruleSuggestionState?.review_summary || {}
  const [suggestionActionOverrides, setSuggestionActionOverrides] = useState({})
  const [editingActionPill, setEditingActionPill] = useState(null)
  const [editingActionDraft, setEditingActionDraft] = useState('')
  const [editingCategorySuggestionId, setEditingCategorySuggestionId] = useState(null)
  const [categoryPickerOpenToken, setCategoryPickerOpenToken] = useState(0)
  const [editingTagSuggestionId, setEditingTagSuggestionId] = useState(null)
  const categoryPickerHasOpenedRef = useRef(false)
  const latestCategoriesRef = useRef(categories)
  const sortControlRef = useRef(null)
  const lookbackControlRef = useRef(null)
  const listTopRef = useRef(null)
  const [editingKeywordSuggestionId, setEditingKeywordSuggestionId] = useState(null)
  const [editingKeywordDraft, setEditingKeywordDraft] = useState('')
  const [openConflictGroupId, setOpenConflictGroupId] = useState(null)
  const [bulkMode, setBulkMode] = useState(false)
  const [selectedSuggestionIds, setSelectedSuggestionIds] = useState([])
  const [hoveredRemoveTooltip, setHoveredRemoveTooltip] = useState(null)
  const [bulkMenu, setBulkMenu] = useState(null)
  const [suggestionMenu, setSuggestionMenu] = useState(null)
  const [sortMenu, setSortMenu] = useState(null)
  const [lookbackMenu, setLookbackMenu] = useState(null)
  const [stickyTopOffset, setStickyTopOffset] = useState(0)
  const [merchantFilterText, setMerchantFilterText] = useState('')
  const [matchViewerState, setMatchViewerState] = useState({
    open: false,
    loading: false,
    error: '',
    merchantLabel: '',
    keyword: '',
    referenceTargetCategoryId: null,
    ownerId: null,
    ownerName: '',
    accountId: null,
    accountName: '',
    amountMin: null,
    amountMax: null,
    count: 0,
    rows: [],
    applyingAll: false,
  })
  // The match viewer's merchant ↗ opens the standard merchant spending report (TransactionDetail) as a
  // floating panel above the modal; edits there are reflected back by reloading the match rows.
  const [payeeDetail, setPayeeDetail] = useState(null)
  async function openMerchantReport(row) {
    if (!row?.id) return
    // The match-row shape is lighter than a full transaction (no category name, source file, tags, or
    // import evidence), so fetch the canonical record first — otherwise the report paints with gaps.
    // Fall back to the match row if the fetch fails.
    try {
      const result = await api.getTransactions({ ids: row.id })
      setPayeeDetail(result?.transactions?.[0] || row)
    } catch {
      setPayeeDetail(row)
    }
  }

  useEffect(() => {
    latestCategoriesRef.current = categories
  }, [categories])
  const merchantFilterSnapshotRef = useRef('')
  const merchantFilterInputRef = useRef(null)
  const merchantFilterButtonRef = useRef(null)
  const ownerFilterButtonRef = useRef(null)
  const migratedSortPreferenceRef = useRef(false)
  // Migrate the pre-preferences sort choice forward once so existing users keep
  // their review ordering after the setting moved into user preferences.
  const legacySortOrderRef = useRef(
    typeof window === 'undefined'
      ? 'row_count'
      : (normalizeImportRuleSortOrder(window.localStorage.getItem(IMPORT_RULE_SORT_STORAGE_KEY)) || 'row_count'),
  )
  const availableOwners = owners
  const showOwnerFilter = availableOwners.length > 1
  // Conflicts render as ConflictSetCards resolved as a unit, so bulk-select (per-suggestion) is off there.
  const bulkAvailable = reviewFilter !== 'total' && reviewFilter !== 'conflicts'
  const sortOrder = normalizeImportRuleSortOrder(getPreference(IMPORT_RULE_SORT_PREF_KEY, null))
    || legacySortOrderRef.current
    || 'row_count'
  const normalizedMerchantFilter = merchantFilterText.trim().toLowerCase()

  // Look-back lens: split pending suggestions by recency. The pending/conflicts views show only rows with
  // activity inside the chosen window (0 = all time); the `older` view shows the complement (the stale
  // tail), so pending + older = all pending. View filter only — never changes generation or stored state,
  // and the substance threshold stays full-history. A conflict set is kept whole (any member in-window).
  const lookbackYears = normalizeImportRuleLookback(getPreference(IMPORT_RULE_LOOKBACK_PREF_KEY, 2))
  const lookbackCutoff = useMemo(() => {
    if (!lookbackYears) return null
    const cutoff = new Date()
    cutoff.setFullYear(cutoff.getFullYear() - lookbackYears)
    return cutoff.toISOString().slice(0, 10)
  }, [lookbackYears])
  const hasLens = lookbackCutoff != null
  const lensRelevant = reviewFilter === 'pending' || reviewFilter === 'conflicts' || reviewFilter === 'older'
  // A conflict set resolves as a unit, so it counts as in-window if ANY of its members is.
  const inWindowConflictGroups = useMemo(() => {
    const groups = new Set()
    if (!lookbackCutoff) return groups
    for (const suggestion of suggestions) {
      if (suggestion.conflict_group_id && (suggestion.latest_txn_date || '') >= lookbackCutoff) {
        groups.add(suggestion.conflict_group_id)
      }
    }
    return groups
  }, [suggestions, lookbackCutoff])
  // Pure recency test (no review-status / view logic). Undatable rows count as in-window — we can't call
  // them stale. With no window, everything is in-window.
  const inLookbackWindow = useCallback(suggestion => {
    if (!hasLens) return true
    if (!suggestion.latest_txn_date) return true
    if (suggestion.conflict_group_id) return inWindowConflictGroups.has(suggestion.conflict_group_id)
    return suggestion.latest_txn_date >= lookbackCutoff
  }, [hasLens, lookbackCutoff, inWindowConflictGroups])
  // Recency slice for the active view: pending/conflicts show in-window, `older` shows the stale
  // complement, every other view is unaffected.
  const passesLensForView = useCallback(suggestion => {
    if (reviewFilter === 'older') return hasLens && !inLookbackWindow(suggestion)
    if (reviewFilter === 'pending' || reviewFilter === 'conflicts') return inLookbackWindow(suggestion)
    return true
  }, [reviewFilter, hasLens, inLookbackWindow])
  // Pill counts (member counts, not merchant-filtered, so the pills describe the whole review). The lens
  // splits pending into the in-window `pending` pill and the stale `older` pill; they sum to all pending.
  const pendingInWindowCount = useMemo(
    () => suggestions.filter(s => s.review_status === 'pending' && inLookbackWindow(s)).length,
    [suggestions, inLookbackWindow],
  )
  const pendingOlderCount = useMemo(
    () => suggestions.filter(s => s.review_status === 'pending' && !inLookbackWindow(s)).length,
    [suggestions, inLookbackWindow],
  )
  // Conflicts pill counts in-window pending conflict GROUPS (one per card), matching the pending pill's lens.
  const conflictsPillCount = useMemo(() => {
    const groups = new Set()
    for (const suggestion of suggestions) {
      if (suggestion.review_status === 'pending' && suggestion.conflict_group_id && inLookbackWindow(suggestion)) {
        groups.add(suggestion.conflict_group_id)
      }
    }
    return groups.size
  }, [suggestions, inLookbackWindow])

  useEffect(() => {
    if (migratedSortPreferenceRef.current) return
    const legacySortOrder = legacySortOrderRef.current
    if (hasPreference(IMPORT_RULE_SORT_PREF_KEY) || legacySortOrder === 'row_count') return
    migratedSortPreferenceRef.current = true
    setPreference(IMPORT_RULE_SORT_PREF_KEY, legacySortOrder).catch(() => { })
  }, [hasPreference, setPreference])
  function matchesReviewFilter(suggestion, filterKey) {
    if (filterKey === 'total') return true
    if (filterKey === 'pending') return suggestion.review_status === 'pending'
    // Conflicts is the still-pending subset that belongs to a conflict set (a merchant filed under
    // several categories) — the slice the user resolves as units before the remaining plain pending rules.
    if (filterKey === 'conflicts') return suggestion.review_status === 'pending' && Boolean(suggestion.conflict_group_id)
    // `older` is the pending status too — the in/out-of-window split is applied by the lens layer
    // (passesLensForView), not here.
    if (filterKey === 'older') return suggestion.review_status === 'pending'
    if (filterKey === 'accepted') return suggestion.review_status === 'accepted'
    if (filterKey === 'deferred') return suggestion.review_status === 'skipped'
    if (filterKey === 'discarded') return suggestion.review_status === 'discarded'
    return suggestion.review_status === 'pending'
  }

  const sortSuggestionsForDisplay = useCallback(list => {
    const next = [...list]
    if (sortOrder === 'row_count') {
      // Group by merchant (keyword) so every suggestion for one merchant sorts together; the group's
      // combined row count across all members (scope variants + conflicts) drives its position, so a
      // small owner-scoped variant rides next to its high-volume sibling instead of sinking down the list.
      const grouped = new Map()
      for (const suggestion of next) {
        const groupKey = suggestion.keyword || `__id:${suggestion.id}`
        const entry = grouped.get(groupKey) || {
          suggestions: [],
          totalRows: 0,
          merchantLabel: String(suggestion.merchant_label || ''),
        }
        entry.suggestions.push(suggestion)
        entry.totalRows += (suggestion.txn_count || 0)
        grouped.set(groupKey, entry)
      }

      const orderedGroups = [...grouped.entries()].sort(([, a], [, b]) => {
        if (a.totalRows !== b.totalRows) return b.totalRows - a.totalRows
        return a.merchantLabel.localeCompare(b.merchantLabel, undefined, { sensitivity: 'base' })
      })

      // Within a merchant, biggest first then by category name. Conflict members reorder inside their own
      // card, so the flat order here only needs to be stable and readable.
      return orderedGroups.flatMap(([, group]) => (
        [...group.suggestions].sort((a, b) => {
          if ((a.txn_count || 0) !== (b.txn_count || 0)) return (b.txn_count || 0) - (a.txn_count || 0)
          return String(a.target_category_name || '').localeCompare(String(b.target_category_name || ''), undefined, { sensitivity: 'base' })
        })
      ))
    }

    next.sort((a, b) => String(a.merchant_label || '').localeCompare(String(b.merchant_label || ''), undefined, { sensitivity: 'base' }))
    return next
  }, [sortOrder])

  function getConflictContext(orderedSuggestions) {
    const byGroup = new Map()
    for (const suggestion of orderedSuggestions) {
      if (!suggestion.conflict_group_id) continue
      const group = byGroup.get(suggestion.conflict_group_id) || []
      group.push(suggestion.id)
      byGroup.set(suggestion.conflict_group_id, group)
    }

    const followerIds = new Set()
    const leadIds = new Set()
    for (const ids of byGroup.values()) {
      if (ids.length > 0) leadIds.add(ids[0])
      ids.slice(1).forEach(id => followerIds.add(id))
    }

    return { followerIds, leadIds }
  }

  // Stable display order. The list's order is frozen as a sorted id list that refreshes ONLY when the
  // sort order changes or the SET of suggestions changes (reload / generate / undo / accept-spawned
  // items) -- never when an individual suggestion's status or row count changes. Acting on one item
  // (e.g. saving a conflict lead, which drops the group's sort key to a follower's count) must not
  // reshuffle its siblings out from under the user, who needs to resolve the whole group together.
  const suggestionIdSetKey = useMemo(
    () => suggestions.map(suggestion => suggestion.id).slice().sort().join(','),
    [suggestions],
  )
  const displayOrderIds = useMemo(
    () => sortSuggestionsForDisplay(suggestions).map(suggestion => suggestion.id),
    // Intentionally keyed only on the id-set and sort order: re-sort on those, not on row content.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [suggestionIdSetKey, sortOrder],
  )

  const matchesMerchantAndReviewFilter = useCallback(suggestion => {
    const merchantMatches = !normalizedMerchantFilter
      || String(suggestion.merchant_label || '').toLowerCase().includes(normalizedMerchantFilter)
    return merchantMatches && matchesReviewFilter(suggestion, reviewFilter)
  }, [normalizedMerchantFilter, reviewFilter])
  const filteredSuggestions = suggestions.filter(
    suggestion => matchesMerchantAndReviewFilter(suggestion) && passesLensForView(suggestion),
  )
  const visibleSuggestions = useMemo(() => {
    // Order the currently-visible (filtered) suggestions by the frozen display order. Items missing
    // from the order (e.g. arrived just before it last refreshed) trail at the end so nothing vanishes.
    const byId = new Map(filteredSuggestions.map(suggestion => [suggestion.id, suggestion]))
    const ordered = []
    for (const id of displayOrderIds) {
      const suggestion = byId.get(id)
      if (suggestion) {
        ordered.push(suggestion)
        byId.delete(id)
      }
    }
    for (const suggestion of byId.values()) ordered.push(suggestion)
    return ordered
  }, [filteredSuggestions, displayOrderIds])
  const visibleConflictContext = useMemo(
    () => getConflictContext(visibleSuggestions),
    [visibleSuggestions],
  )
  const conflictFollowerIds = visibleConflictContext.followerIds
  const conflictLeadIds = visibleConflictContext.leadIds
  const visibleConflictGroupMembers = useMemo(() => {
    const groups = new Map()
    for (const suggestion of visibleSuggestions) {
      if (!suggestion.conflict_group_id) continue
      const group = groups.get(suggestion.conflict_group_id) || []
      group.push(suggestion.id)
      groups.set(suggestion.conflict_group_id, group)
    }
    return groups
  }, [visibleSuggestions])
  const conflictSetSuggestions = useMemo(
    () => (openConflictGroupId
      ? suggestions.filter(suggestion => suggestion.conflict_group_id === openConflictGroupId)
      : []),
    [openConflictGroupId, suggestions],
  )
  const conflictSetSections = useMemo(() => {
    if (!conflictSetSuggestions.length) return []
    const sectionDefs = [
      { key: 'pending', label: 'pending', tone: 'pending' },
      { key: 'accepted', label: 'accepted', tone: 'accepted' },
      { key: 'deferred', label: 'deferred', tone: 'skipped' },
      { key: 'discarded', label: 'discarded', tone: 'discarded' },
    ]
    return sectionDefs
      .map(section => {
        const sectionSuggestions = sortSuggestionsForDisplay(
          conflictSetSuggestions.filter(suggestion => matchesReviewFilter(suggestion, section.key)),
        )
        if (!sectionSuggestions.length) return null
        return {
          ...section,
          suggestions: sectionSuggestions,
          conflictContext: getConflictContext(sectionSuggestions),
        }
      })
      .filter(Boolean)
  }, [conflictSetSuggestions, sortSuggestionsForDisplay])

  const emptyMessages = {
    total: 'No rule suggestions are available for this import.',
    pending: summary.total_count > 0 ? 'No pending suggestions in this view.' : 'No missing rules were found from the categorized rows in this file.',
    conflicts: 'No conflicts left to resolve.',
    older: 'No older suggestions outside the look-back window.',
    accepted: 'No accepted suggestions in this view.',
    deferred: 'No deferred suggestions in this view.',
    discarded: 'No discarded suggestions in this view.',
  }
  const emptyMessage = emptyMessages[reviewFilter] || emptyMessages.pending
  const showFullScreenLoading = ruleSuggestionState?.loading && suggestions.length === 0
  const showInlineRefreshing = ruleSuggestionState?.loading && suggestions.length > 0

  useLayoutEffect(() => {
    if (typeof window === 'undefined') return undefined
    const root = rootRef.current
    if (!root) return undefined
    const scrollParent = findNearestScrollParent(root)
    if (!scrollParent) {
      setStickyTopOffset(0)
      return undefined
    }

    function updateStickyOffset() {
      const style = window.getComputedStyle(scrollParent)
      const paddingTop = Number.parseFloat(style.paddingTop || '0') || 0
      setStickyTopOffset(-paddingTop)
    }

    updateStickyOffset()
    const resizeObserver = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(updateStickyOffset)
      : null
    resizeObserver?.observe(scrollParent)
    window.addEventListener('resize', updateStickyOffset)
    return () => {
      resizeObserver?.disconnect()
      window.removeEventListener('resize', updateStickyOffset)
    }
  }, [])

  useEffect(() => {
    const visibleIds = new Set(suggestions.map(suggestion => String(suggestion.id)))
    setSuggestionActionOverrides(prev => {
      const next = {}
      let changed = false
      Object.entries(prev).forEach(([suggestionId, value]) => {
        if (visibleIds.has(suggestionId)) next[suggestionId] = value
        else changed = true
      })
      return changed ? next : prev
    })
  }, [suggestions])

  useEffect(() => {
    if (bulkAvailable) return
    setBulkMode(false)
    setSelectedSuggestionIds([])
    setBulkMenu(null)
  }, [bulkAvailable])

  // The conflicts and older filters only exist while their pill has a count (the pill is hidden
  // otherwise). Once that count hits zero, drop back to pending so the user isn't stranded on an empty
  // view with no active pill.
  useEffect(() => {
    if (reviewFilter === 'conflicts' && conflictsPillCount === 0) onChangeReviewFilter('pending')
    else if (reviewFilter === 'older' && pendingOlderCount === 0) onChangeReviewFilter('pending')
  }, [reviewFilter, conflictsPillCount, pendingOlderCount, onChangeReviewFilter])

  useEffect(() => {
    if (!openConflictGroupId) return
    const hasSuggestions = suggestions.some(suggestion => suggestion.conflict_group_id === openConflictGroupId)
    if (!hasSuggestions) setOpenConflictGroupId(null)
  }, [openConflictGroupId, suggestions])

  useEffect(() => {
    const visibleIds = new Set(visibleSuggestions.map(suggestion => getSuggestionKey(suggestion.id)))
    setSelectedSuggestionIds(prev => {
      const next = prev.filter(id => visibleIds.has(id))
      if (next.length === prev.length && next.every((id, index) => id === prev[index])) {
        return prev
      }
      return next
    })
  }, [visibleSuggestions])

  useEffect(() => {
    if (!hoveredRemoveTooltip) return
    const visibleIds = new Set(suggestions.map(suggestion => getSuggestionKey(suggestion.id)))
    if (!visibleIds.has(getSuggestionKey(hoveredRemoveTooltip.id))) {
      setHoveredRemoveTooltip(null)
    }
  }, [hoveredRemoveTooltip, suggestions])

  useEffect(() => {
    if (!hoveredRemoveTooltip) return undefined
    function dismiss() {
      setHoveredRemoveTooltip(null)
    }
    window.addEventListener('scroll', dismiss, true)
    window.addEventListener('resize', dismiss)
    window.addEventListener('blur', dismiss)
    return () => {
      window.removeEventListener('scroll', dismiss, true)
      window.removeEventListener('resize', dismiss)
      window.removeEventListener('blur', dismiss)
    }
  }, [hoveredRemoveTooltip])

  useEffect(() => {
    if (!bulkMenu && !suggestionMenu && !sortMenu && !lookbackMenu) return undefined
    function dismiss() {
      setBulkMenu(null)
      setSuggestionMenu(null)
      setSortMenu(null)
      setLookbackMenu(null)
    }
    window.addEventListener('mousedown', dismiss)
    window.addEventListener('scroll', dismiss, true)
    window.addEventListener('resize', dismiss)
    return () => {
      window.removeEventListener('mousedown', dismiss)
      window.removeEventListener('scroll', dismiss, true)
      window.removeEventListener('resize', dismiss)
    }
  }, [bulkMenu, suggestionMenu, sortMenu, lookbackMenu])

  useEffect(() => {
    if (!merchantFilterOpen || bulkMode) return
    merchantFilterInputRef.current?.focus()
    merchantFilterInputRef.current?.select()
  }, [merchantFilterOpen, bulkMode])

  useEffect(() => {
    if (selectedOwnerIds.length > 0) {
      onOwnerFilterOpenChange(current => (current ? current : true))
    }
  }, [selectedOwnerIds, onOwnerFilterOpenChange])

  useEffect(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(IMPORT_RULE_SORT_STORAGE_KEY, sortOrder)
  }, [sortOrder])

  function handleSortOrderChange(nextSortOrder) {
    const normalized = normalizeImportRuleSortOrder(nextSortOrder)
    if (!normalized) return
    setPreference(IMPORT_RULE_SORT_PREF_KEY, normalized).catch(() => { })
  }

  function handleLookbackChange(nextYears) {
    setLookbackMenu(null)
    setPreference(IMPORT_RULE_LOOKBACK_PREF_KEY, normalizeImportRuleLookback(nextYears)).catch(() => { })
  }

  function lookbackLabel(years) {
    if (!years) return 'All time'
    return `${years} year${years === 1 ? '' : 's'}`
  }

  function getSuggestionKey(suggestionId) {
    return String(suggestionId)
  }

  function getBulkActions() {
    if (reviewFilter === 'pending' || reviewFilter === 'older') {
      // Save = create the rules as-is (the primary bulk action, promoted from the per-card Save button).
      // Discard, keep = settle the suggestions but leave the rows imported (still claimable by a later
      // apply). Discard, clear = also clear the rows' categories. No bare "Remove" — keeping is the
      // honest default for "I reviewed these, don't build rules." Same set in the `older` (stale) view,
      // which is the prime place to bulk-settle the tail.
      return [
        { key: 'save', label: 'Save', tone: 'primary', run: suggestionsToActOn => onSaveSuggestionsAsIsBulk(suggestionsToActOn) },
        { key: 'defer', label: 'Defer', run: suggestionsToActOn => onSetSuggestionStatusBulk(suggestionsToActOn, 'skipped') },
        { key: 'discard-keep', label: 'Discard, keep categories', run: suggestionsToActOn => onBulkRejectDisposition(suggestionsToActOn, 'keep') },
        { key: 'discard-clear', label: 'Discard, clear categories', run: suggestionsToActOn => onBulkRejectDisposition(suggestionsToActOn, 'clear') },
      ]
    }
    if (reviewFilter === 'accepted') {
      return [
        { key: 'defer', label: 'Defer', run: suggestionsToActOn => onSetSuggestionStatusBulk(suggestionsToActOn, 'skipped') },
      ]
    }
    if (reviewFilter === 'deferred') {
      return [
        { key: 'resume', label: 'Resume', run: suggestionsToActOn => onSetSuggestionStatusBulk(suggestionsToActOn, 'pending') },
        { key: 'save', label: 'Save', run: suggestionsToActOn => onSaveSuggestionsAsIsBulk(suggestionsToActOn) },
      ]
    }
    if (reviewFilter === 'discarded') {
      return [
        { key: 'restore', label: 'Restore', run: suggestionsToActOn => onSetSuggestionStatusBulk(suggestionsToActOn, 'pending') },
      ]
    }
    return []
  }

  const bulkActions = getBulkActions()
  const selectedResolvedSuggestions = visibleSuggestions
    .filter(suggestion => selectedSuggestionIds.includes(getSuggestionKey(suggestion.id)))
    .map(getResolvedSuggestion)
  const selectedCount = selectedResolvedSuggestions.length

  const bulkSelectionScope = bulkSelectionScopeId(persistKey, selectedOwnerIds, reviewFilter)
  const bulkSelectionHydratedRef = useRef(false)

  // Restore a saved selection once suggestions are available, so leaving the review and reopening
  // Generate Rules in the same context comes back to the in-progress batch. Runs once per mount; stale
  // ids (suggestions saved/disposed/regenerated since) are dropped by intersecting with what's visible,
  // so a no-longer-present id silently falls away rather than restoring an empty/ghost selection.
  useEffect(() => {
    if (bulkSelectionHydratedRef.current) return
    if (!visibleSuggestions.length) return
    bulkSelectionHydratedRef.current = true
    const stored = loadStoredBulkSelection(bulkSelectionScope)
    if (!stored || !stored.length) return
    const visibleKeys = new Set(visibleSuggestions.map(item => getSuggestionKey(item.id)))
    const restored = stored.filter(id => visibleKeys.has(id))
    if (!restored.length) return
    setSelectedSuggestionIds(restored)
    setBulkMode(true)
  }, [visibleSuggestions, bulkSelectionScope])

  // Persist on every change (sessionStorage writes are cheap, so there's no need to defer). Gated on
  // hydration so the initial empty render can't clear the slot before the restore above has run.
  useEffect(() => {
    if (!bulkSelectionHydratedRef.current) return
    if (bulkMode && selectedSuggestionIds.length) {
      saveStoredBulkSelection(bulkSelectionScope, selectedSuggestionIds)
    } else {
      clearStoredBulkSelection(bulkSelectionScope)
    }
  }, [bulkMode, selectedSuggestionIds, bulkSelectionScope])

  function resetBulkMode() {
    setBulkMode(false)
    setSelectedSuggestionIds([])
    setHoveredRemoveTooltip(null)
    setBulkMenu(null)
    setSuggestionMenu(null)
    setSortMenu(null)
  }

  async function runBulkAction(action) {
    if (!selectedResolvedSuggestions.length) return
    setBulkMenu(null)
    await action.run(selectedResolvedSuggestions)
    resetBulkMode()
  }

  function toggleSuggestionSelection(suggestionId) {
    const suggestionKey = getSuggestionKey(suggestionId)
    setSelectedSuggestionIds(prev => (
      prev.includes(suggestionKey)
        ? prev.filter(id => id !== suggestionKey)
        : [...prev, suggestionKey]
    ))
  }

  function toggleConflictParentSelection(suggestion) {
    const suggestionKey = getSuggestionKey(suggestion.id)
    const memberIds = (visibleConflictGroupMembers.get(suggestion.conflict_group_id) || []).map(getSuggestionKey)
    const childIds = memberIds.filter(id => id !== suggestionKey)
    setSelectedSuggestionIds(prev => {
      const parentSelected = prev.includes(suggestionKey)
      const nextParentSelected = !parentSelected
      const allChildrenMatchParent = childIds.every(id => prev.includes(id) === parentSelected)
      const next = new Set(prev)

      if (nextParentSelected) next.add(suggestionKey)
      else next.delete(suggestionKey)

      if (allChildrenMatchParent) {
        childIds.forEach(id => {
          if (nextParentSelected) next.add(id)
          else next.delete(id)
        })
      }

      return [...next]
    })
  }

  function getScopedBulkIdsForSuggestion(suggestion) {
    if (!suggestion?.conflict_group_id) {
      return visibleSuggestions.map(item => getSuggestionKey(item.id))
    }
    const groupIds = (visibleConflictGroupMembers.get(suggestion.conflict_group_id) || []).map(getSuggestionKey)
    if (groupIds.length <= 1) {
      return visibleSuggestions.map(item => getSuggestionKey(item.id))
    }
    const leadId = groupIds[0]
    const suggestionKey = getSuggestionKey(suggestion.id)
    if (suggestionKey === leadId) return groupIds
    return groupIds.filter(id => id !== leadId)
  }

  function selectAllScoped(scopeIds = null) {
    const ids = scopeIds?.length ? scopeIds : visibleSuggestions.map(suggestion => getSuggestionKey(suggestion.id))
    setSelectedSuggestionIds(prev => [...new Set([...prev, ...ids])])
    setBulkMenu(null)
  }

  function clearScopedSelection(scopeIds = null) {
    const ids = scopeIds?.length ? scopeIds : visibleSuggestions.map(suggestion => getSuggestionKey(suggestion.id))
    setSelectedSuggestionIds(prev => prev.filter(id => !ids.includes(id)))
    setBulkMenu(null)
  }

  function enterBulkMode(initialSuggestion = null) {
    setSuggestionMenu(null)
    setBulkMenu(null)
    setBulkMode(true)
    if (!initialSuggestion) {
      setSelectedSuggestionIds([])
      return
    }
    const suggestionKey = getSuggestionKey(initialSuggestion.id)
    const conflictGroupIds = initialSuggestion.conflict_group_id
      ? (visibleConflictGroupMembers.get(initialSuggestion.conflict_group_id) || []).map(getSuggestionKey)
      : []
    if (conflictGroupIds.length > 1 && conflictGroupIds[0] === suggestionKey) {
      setSelectedSuggestionIds(conflictGroupIds)
      return
    }
    setSelectedSuggestionIds([suggestionKey])
  }

  function getResolvedSuggestion(suggestion) {
    const override = suggestionActionOverrides[getSuggestionKey(suggestion.id)] || {}
    const hasOwnerOverride = Object.prototype.hasOwnProperty.call(override, 'ownerId')
    const hasAccountOverride = Object.prototype.hasOwnProperty.call(override, 'accountId')
    const hasAmountMinOverride = Object.prototype.hasOwnProperty.call(override, 'amountMin')
    const hasAmountMaxOverride = Object.prototype.hasOwnProperty.call(override, 'amountMax')
    // Every preview, bulk action, and match lookup should see the same unsaved
    // edits, so we always merge transient UI overrides before using a suggestion.
    const ownerId = override.removeOwner ? null : (hasOwnerOverride ? override.ownerId : suggestion.owner_id)
    const accountId = override.removeAccount ? null : (hasAccountOverride ? override.accountId : suggestion.account_id)
    const amountMin = override.removeAmount ? null : (hasAmountMinOverride ? override.amountMin : suggestion.amount_min)
    const amountMax = override.removeAmount ? null : (hasAmountMaxOverride ? override.amountMax : suggestion.amount_max)
    return {
      ...suggestion,
      keyword: override.keyword ?? suggestion.keyword,
      target_category_id: override.removeCategory ? null : (override.targetCategoryId ?? suggestion.target_category_id),
      target_category_name: override.removeCategory ? null : (override.targetCategoryName ?? suggestion.target_category_name),
      amount_min: amountMin,
      amount_max: amountMax,
      owner_id: ownerId,
      owner_name: ownerId ? (owners.find(owner => String(owner.id) === String(ownerId))?.name || suggestion.owner_name) : null,
      account_id: accountId,
      account_name: accountId ? (accounts.find(account => String(account.id) === String(accountId))?.name || suggestion.account_name) : null,
      clean_name_suggestion: override.removeRename
        ? null
        : (override.cleanName ?? suggestion.clean_name_suggestion),
      tag_ids: override.tagIds ?? (suggestion.tag_ids || []),
    }
  }

  function getConflictReferenceSuggestion(suggestion) {
    if (!suggestion?.conflict_group_id) return getResolvedSuggestion(suggestion)
    const siblings = suggestions
      .filter(candidate => candidate.conflict_group_id === suggestion.conflict_group_id)
      .map(getResolvedSuggestion)
    if (!siblings.length) return getResolvedSuggestion(suggestion)

    const ranked = [...siblings].sort((left, right) => {
      if ((right.txn_count || 0) !== (left.txn_count || 0)) {
        return (right.txn_count || 0) - (left.txn_count || 0)
      }
      const leftFilterCount = Number(Boolean(left.owner_id)) + Number(Boolean(left.account_id)) + Number(left.amount_min != null || left.amount_max != null)
      const rightFilterCount = Number(Boolean(right.owner_id)) + Number(Boolean(right.account_id)) + Number(right.amount_min != null || right.amount_max != null)
      if (leftFilterCount !== rightFilterCount) {
        return leftFilterCount - rightFilterCount
      }
      return String(left.target_category_name || '').localeCompare(String(right.target_category_name || ''), undefined, { sensitivity: 'base' })
    })
    return ranked[0]
  }

  async function openMatchingTransactionsViewer(suggestion) {
    if (!onLoadSuggestionMatches) return
    const resolvedSuggestion = getResolvedSuggestion(suggestion)
    const referenceSuggestion = getConflictReferenceSuggestion(suggestion)
    // Limit the report to exactly the rows this card represents: a conflict card covers its whole group
    // (union of member source rows), a single card just its own. This keeps the report's rows matching the
    // card's "N rows" count instead of every same-keyword row — including ones owned by other suggestions.
    const scopedRowIds = suggestion.conflict_group_id
      ? [...new Set(
          (visibleConflictGroupMembers.get(suggestion.conflict_group_id) || [])
            .map(id => suggestions.find(item => item.id === id))
            .filter(Boolean)
            .flatMap(member => member.source_row_ids || [])
            .map(String),
        )]
      : (resolvedSuggestion.source_row_ids || []).map(String)
    setMatchViewerState({
      open: true,
      loading: true,
      error: '',
      merchantLabel: resolvedSuggestion.merchant_label,
      keyword: resolvedSuggestion.keyword,
      referenceTargetCategoryId: referenceSuggestion.target_category_id || null,
      ownerId: resolvedSuggestion.owner_id || null,
      ownerName: resolvedSuggestion.owner_name || '',
      accountId: resolvedSuggestion.account_id || null,
      accountName: resolvedSuggestion.account_name || '',
      amountMin: resolvedSuggestion.amount_min,
      amountMax: resolvedSuggestion.amount_max,
      rowIds: scopedRowIds,
      count: 0,
      rows: [],
    })
    try {
      const result = await onLoadSuggestionMatches({
        keyword: resolvedSuggestion.keyword,
        reference_target_category_id: referenceSuggestion.target_category_id || null,
        owner_id: resolvedSuggestion.owner_id || null,
        account_id: resolvedSuggestion.account_id || null,
        amount_min: resolvedSuggestion.amount_min,
        amount_max: resolvedSuggestion.amount_max,
        row_ids: scopedRowIds.length ? scopedRowIds : undefined,
      })
      setMatchViewerState(prev => ({
        ...prev,
        loading: false,
        count: result.count || 0,
        rows: result.transactions || [],
      }))
    } catch (err) {
      setMatchViewerState(prev => ({
        ...prev,
        loading: false,
        error: err.message || 'Unable to load matching imported rows.',
      }))
    }
  }

  async function reloadMatchViewer() {
    const result = await onLoadSuggestionMatches?.({
      keyword: matchViewerState.keyword,
      reference_target_category_id: matchViewerState.referenceTargetCategoryId,
      owner_id: matchViewerState.ownerId,
      account_id: matchViewerState.accountId,
      amount_min: matchViewerState.amountMin,
      amount_max: matchViewerState.amountMax,
      row_ids: matchViewerState.rowIds?.length ? matchViewerState.rowIds : undefined,
    })
    setMatchViewerState(prev => ({
      ...prev,
      loading: false,
      error: '',
      count: result?.count || 0,
      rows: result?.transactions || [],
    }))
  }

  // Reconcile a single imported row to a chosen category as a *corrected file categorization*: it stays
  // category_source='import' (so it keeps driving the suggestions — the suggestion re-targets to the new
  // category) and its recorded file label is rewritten to match. Contrast Preserve, which marks the row
  // a manual exception. Used by the per-row picker and the "Use majority" button.
  async function setMatchRowCategory(row, categoryId) {
    if (!row?.id || !categoryId) return
    setMatchViewerState(prev => ({
      ...prev,
      rows: prev.rows.map(current => (current.id === row.id ? { ...current, keeping: true } : current)),
    }))
    try {
      await txnMutations.setImportedCategory(row.id, categoryId)
      await onReloadSuggestions?.()
      await reloadMatchViewer()
    } catch (err) {
      setMatchViewerState(prev => ({
        ...prev,
        error: err.message || 'Unable to set this category.',
        rows: prev.rows.map(current => (current.id === row.id ? { ...current, keeping: false } : current)),
      }))
    }
  }

  // Preserve marks the row a manual exception: the rules never change it and it drops out of the
  // suggestions (a deliberate one-off, not part of any rule).
  async function keepMatchingTransactionCategory(row) {
    if (!row?.id || !row?.target_category_id) return
    setMatchViewerState(prev => ({
      ...prev,
      rows: prev.rows.map(current => (current.id === row.id ? { ...current, keeping: true } : current)),
    }))
    try {
      await txnMutations.setCategory(row.id, row.target_category_id)
      await onReloadSuggestions?.()
      await reloadMatchViewer()
    } catch (err) {
      setMatchViewerState(prev => ({
        ...prev,
        error: err.message || 'Unable to preserve this categorization.',
        rows: prev.rows.map(current => (current.id === row.id ? { ...current, keeping: false } : current)),
      }))
    }
  }

  // Bulk reconcile: re-pin every matching row that isn't already `categoryId` to it (as a corrected file
  // categorization, kept as import), collapsing the conflict onto a single suggestion.
  async function setAllMatchCategories(categoryId) {
    if (!categoryId || matchViewerState.applyingAll) return
    const targets = matchViewerState.rows.filter(row => String(row.target_category_id) !== String(categoryId))
    if (!targets.length) return
    setMatchViewerState(prev => ({ ...prev, applyingAll: true, error: '' }))
    try {
      for (const row of targets) {
        await txnMutations.setImportedCategory(row.id, categoryId)
      }
      await onReloadSuggestions?.()
      await reloadMatchViewer()
    } catch (err) {
      setMatchViewerState(prev => ({ ...prev, error: err.message || 'Unable to set the category for these rows.' }))
    } finally {
      setMatchViewerState(prev => ({ ...prev, applyingAll: false }))
    }
  }

  function persistSuggestionDraft(suggestion, data) {
    const suggestionKey = getSuggestionKey(suggestion.id)
    const nextCategory = data.category_id
      ? categories.find(category => String(category.id) === String(data.category_id))
      : null
    setSuggestionActionOverrides(prev => ({
      ...prev,
      [suggestionKey]: {
        ...(prev[suggestionKey] || {}),
        keyword: data.keyword || suggestion.keyword,
        targetCategoryId: data.category_id || null,
        targetCategoryName: nextCategory?.name || null,
        removeCategory: !data.category_id,
        amountMin: data.amount_min ?? null,
        amountMax: data.amount_max ?? null,
        removeAmount: Boolean(data.clear_amount_min) && Boolean(data.clear_amount_max),
        ownerId: data.owner_id || null,
        removeOwner: Boolean(data.clear_owner),
        accountId: data.account_id || null,
        removeAccount: Boolean(data.clear_account),
        cleanName: data.clean_name || '',
        removeRename: !data.clean_name,
      },
    }))
  }

  function removeSuggestionAction(suggestionId, actionKey) {
    const suggestionKey = getSuggestionKey(suggestionId)
    setSuggestionActionOverrides(prev => ({
      ...prev,
      [suggestionKey]: {
        ...(prev[suggestionKey] || {}),
        [actionKey]: true,
      },
    }))
    if (editingActionPill?.suggestionId === suggestionKey) {
      setEditingActionPill(null)
      setEditingActionDraft('')
    }
    if (editingCategorySuggestionId === suggestionKey) {
      setEditingCategorySuggestionId(null)
    }
  }

  function beginCategoryActionEdit(suggestion) {
    categoryPickerHasOpenedRef.current = false
    setEditingCategorySuggestionId(getSuggestionKey(suggestion.id))
    setCategoryPickerOpenToken(token => token + 1)
  }

  function commitCategoryActionEdit(suggestion, categoryId) {
    const suggestionKey = getSuggestionKey(suggestion.id)
    const nextCategory = latestCategoriesRef.current.find(category => String(category.id) === String(categoryId))
    setSuggestionActionOverrides(prev => ({
      ...prev,
      [suggestionKey]: {
        ...(prev[suggestionKey] || {}),
        targetCategoryId: categoryId || null,
        targetCategoryName: nextCategory?.name || null,
        removeCategory: !categoryId,
      },
    }))
    setEditingCategorySuggestionId(null)
    categoryPickerHasOpenedRef.current = false
  }

  function beginTagEdit(suggestion) {
    setSuggestionMenu(null)
    setEditingTagSuggestionId(getSuggestionKey(suggestion.id))
  }

  // Tags are held as a transient override (`tagIds`) like the other suggestion edits; they're applied to
  // the rule on save (createRule accepts tag_ids), not persisted to the review state.
  function setSuggestionTag(suggestion, tagId, present) {
    const suggestionKey = getSuggestionKey(suggestion.id)
    setSuggestionActionOverrides(prev => {
      const current = prev[suggestionKey] || {}
      const currentTags = current.tagIds ?? (suggestion.tag_ids || [])
      const nextTags = present
        ? (currentTags.includes(tagId) ? currentTags : [...currentTags, tagId])
        : currentTags.filter(id => id !== tagId)
      return { ...prev, [suggestionKey]: { ...current, tagIds: nextTags } }
    })
  }

  function beginRenameActionEdit(suggestion) {
    const suggestionKey = getSuggestionKey(suggestion.id)
    const resolvedSuggestion = getResolvedSuggestion(suggestion)
    setEditingActionPill({ suggestionId: suggestionKey, actionKey: 'rename' })
    setEditingActionDraft(resolvedSuggestion.clean_name_suggestion || '')
  }

  function commitRenameActionEdit(suggestion) {
    const suggestionKey = getSuggestionKey(suggestion.id)
    const nextValue = editingActionDraft.trim()
    setSuggestionActionOverrides(prev => ({
      ...prev,
      [suggestionKey]: nextValue
        ? {
          ...(prev[suggestionKey] || {}),
          cleanName: nextValue,
          removeRename: false,
        }
        : {
          ...(prev[suggestionKey] || {}),
          cleanName: '',
          removeRename: true,
        },
    }))
    setEditingActionPill(null)
    setEditingActionDraft('')
  }

  function cancelRenameActionEdit() {
    setEditingActionPill(null)
    setEditingActionDraft('')
  }

  function beginKeywordEdit(suggestion) {
    const resolvedSuggestion = getResolvedSuggestion(suggestion)
    setEditingKeywordSuggestionId(getSuggestionKey(suggestion.id))
    setEditingKeywordDraft(resolvedSuggestion.keyword || '')
  }

  function commitKeywordEdit(suggestion) {
    const suggestionKey = getSuggestionKey(suggestion.id)
    const nextValue = editingKeywordDraft.trim()
    setSuggestionActionOverrides(prev => ({
      ...prev,
      [suggestionKey]: {
        ...(prev[suggestionKey] || {}),
        keyword: nextValue || suggestion.keyword,
      },
    }))
    setEditingKeywordSuggestionId(null)
    setEditingKeywordDraft('')
  }

  function cancelKeywordEdit() {
    setEditingKeywordSuggestionId(null)
    setEditingKeywordDraft('')
  }

  const editingSuggestion = editingSuggestionId
    ? suggestions.find(suggestion => getSuggestionKey(suggestion.id) === getSuggestionKey(editingSuggestionId))
    : null
  const resolvedEditingSuggestion = editingSuggestion ? getResolvedSuggestion(editingSuggestion) : null
  const reviewFilterPills = [
    { key: 'total', label: 'total', value: summary.total_count || 0, tone: 'default' },
    // Pending is lensed to the in-window count so the pill matches its list; the stale remainder gets its
    // own `older` pill below, so pending + older = all pending and clicking each shows its own rows.
    { key: 'pending', label: 'pending', value: pendingInWindowCount, tone: 'pending' },
    // Only surfaced while there are (in-window) conflicts to resolve: a perpetual "0 conflicts" filter
    // would be a dead, empty view. It disappears once the last set is settled (and falls back to pending).
    ...(conflictsPillCount > 0
      ? [{ key: 'conflicts', label: conflictsPillCount === 1 ? 'conflict' : 'conflicts', value: conflictsPillCount, tone: 'conflict' }]
      : []),
    // The stale tail hidden by the look-back lens. Click to see exactly those rows (and bulk-settle them);
    // hidden when none are stale or the window is All time. Muted tone — it's set-aside-by-recency, not a status.
    ...(pendingOlderCount > 0
      ? [{ key: 'older', label: 'older', value: pendingOlderCount, tone: 'older' }]
      : []),
    { key: 'accepted', label: 'accepted', value: summary.accepted_count || 0, tone: 'accepted' },
    { key: 'deferred', label: 'deferred', value: summary.skipped_count || 0, tone: 'skipped' },
    { key: 'discarded', label: 'discarded', value: summary.discarded_count || 0, tone: 'discarded' },
  ]

  // A title + one-line description for whichever filter is active, so it's always clear what the list
  // below is showing. Shown on the controls row beneath the pills.
  const viewHeaders = {
    total: { title: 'All suggestions', description: 'Every proposed rule, in any state.' },
    pending: { title: 'Pending', description: 'Proposed rules awaiting a decision.' },
    conflicts: { title: 'Conflicts', description: 'One merchant filed under several categories — resolve each set.' },
    older: { title: 'Older', description: `Pending with no activity in the last ${lookbackLabel(lookbackYears).toLowerCase()} — settle in bulk or widen the window.` },
    accepted: { title: 'Accepted', description: 'Suggestions you turned into rules.' },
    deferred: { title: 'Deferred', description: 'Suggestions set aside for later.' },
    discarded: { title: 'Discarded', description: 'Suggestions you dismissed.' },
  }
  const activeViewHeader = viewHeaders[reviewFilter] || viewHeaders.pending

  function getSuggestionActions(suggestion) {
    const resolvedSuggestion = getResolvedSuggestion(suggestion)
    const suggestionKey = getSuggestionKey(suggestion.id)
    const categoryLabel = buildCategoryDisplayLabel(
      categories,
      resolvedSuggestion.target_category_id,
      resolvedSuggestion.target_category_name,
    )
    return [
      resolvedSuggestion.target_category_id
        ? {
          key: 'category',
          label: `category: ${categoryLabel}`,
          onRemove: () => removeSuggestionAction(suggestion.id, 'removeCategory'),
          onMouseDown: () => beginCategoryActionEdit(suggestion),
        }
        : null,
      resolvedSuggestion.clean_name_suggestion
        ? {
          key: 'rename',
          label: `rename to ${resolvedSuggestion.clean_name_suggestion}`,
          onRemove: () => removeSuggestionAction(suggestion.id, 'removeRename'),
          onClick: () => beginRenameActionEdit(suggestion),
          editing: editingActionPill?.suggestionId === suggestionKey && editingActionPill?.actionKey === 'rename',
          editValue: editingActionDraft,
          onEditValueChange: setEditingActionDraft,
          onEditCommit: () => commitRenameActionEdit(suggestion),
          onEditCancel: cancelRenameActionEdit,
        }
        : null,
    ].filter(Boolean)
  }

  function getSuggestionMenuActions(suggestion, resolvedSuggestion) {
    if (suggestion.review_status === 'discarded') {
      return [
        { key: 'restore', label: 'Restore', onClick: () => onSetSuggestionStatus(suggestion, 'pending') },
      ]
    }

    const actions = []

    if (suggestion.review_status !== 'accepted') {
      actions.push({
        key: 'save',
        label: 'Save',
        onClick: () => onSaveSuggestionAsIs(resolvedSuggestion),
      })
      actions.push({
        key: 'tag',
        label: 'Add tag…',
        onClick: () => beginTagEdit(suggestion),
      })
      // No rule: reject the suggestion and settle the rows it covered. 'keep' records the file's
      // category as a manual decision; 'clear' discards it (the `cleared` source). See the page's
      // rejectSuggestionWithDisposition.
      actions.push({
        key: 'reject-keep',
        label: 'Discard and keep categorization',
        onClick: () => onRejectSuggestionDisposition(suggestion, 'keep'),
      })
      actions.push({
        key: 'reject-clear',
        label: 'Discard and remove categorization',
        onClick: () => onRejectSuggestionDisposition(suggestion, 'clear'),
      })
    } else {
      actions.push({
        key: 'remove',
        label: 'Remove',
        onClick: () => onSetSuggestionStatus(suggestion, 'discarded'),
      })
    }

    actions.push({
      key: 'editor',
      label: 'Rule Editor',
      onClick: () => onEditSuggestion(suggestion.id),
    })

    actions.push(
      suggestion.review_status === 'skipped'
        ? { key: 'resume', label: 'Resume', onClick: () => onSetSuggestionStatus(suggestion, 'pending') }
        : { key: 'defer', label: 'Defer', onClick: () => onSetSuggestionStatus(suggestion, 'skipped') },
    )

    return actions
  }

  // Invariant (see docs/ui-patterns.md "Rule suggestion review — bulk select alongside per-card
  // actions"): a card's own row buttons ALWAYS act on just that card, even while it is part of a bulk
  // selection. Bulk dispositions live solely in the sticky bulk-actions bar; row buttons never operate
  // on the selection. This is what lets the user build a batch and pick off outliers individually at
  // the same time. Do not reintroduce a "selected scope" branch here that makes a selected card's
  // button act on the whole selection — that ambiguity (and the Ctrl escape hatch it needed) is the
  // odd behavior this design removed.
  async function runRowStatusAction(suggestion, resolvedSuggestion, status) {
    await onSetSuggestionStatus(resolvedSuggestion, status)
  }

  async function runRowSaveAction(suggestion, resolvedSuggestion) {
    await onSaveSuggestionAsIs(resolvedSuggestion)
  }

  function showRemoveTooltip(suggestionId, label, target) {
    if (typeof window === 'undefined' || !target?.getBoundingClientRect) {
      setHoveredRemoveTooltip({ id: suggestionId, align: 'left', offset: 0 })
      return
    }
    const rect = target.getBoundingClientRect()
    const parentRect = target.offsetParent?.getBoundingClientRect?.() || null
    const estimatedWidth = Math.max(132, label.length * 7.1 + 18)
    const fitsRight = rect.right + 12 + estimatedWidth <= window.innerWidth - 12
    const anchorCenter = rect.width / 2
    const offset = fitsRight
      ? Math.max(0, Math.round((rect.left - (parentRect?.left || 0)) + anchorCenter - 19))
      : Math.max(0, Math.round(((parentRect?.right || rect.right) - rect.right) + anchorCenter - 19))
    setHoveredRemoveTooltip({
      id: suggestionId,
      align: fitsRight ? 'left' : 'right',
      offset,
    })
  }

  function getRemoveTooltipStyle(align, offset = 0) {
    return {
      position: 'absolute',
      top: 12,
      ...(align === 'left'
        ? { left: offset, transformOrigin: '16px 100%' }
        : { right: offset, transformOrigin: 'calc(100% - 16px) 100%' }),
      transform: 'translateY(calc(-100% - 2px))',
      zIndex: 14,
      display: 'inline-flex',
      alignItems: 'center',
      minHeight: 26,
      padding: '5px 9px',
      borderRadius: 9,
      border: '1px solid rgba(214, 222, 238, 0.42)',
      background: 'linear-gradient(180deg, rgba(10, 12, 18, 0.995), rgba(4, 6, 11, 0.995))',
      color: 'color-mix(in srgb, white 94%, var(--text) 6%)',
      fontSize: 10.5,
      fontWeight: 600,
      letterSpacing: '0.01em',
      lineHeight: 1.2,
      whiteSpace: 'nowrap',
      boxShadow: '0 18px 36px rgba(2, 6, 23, 0.56), 0 6px 14px rgba(0, 0, 0, 0.28), 0 0 0 1px rgba(220, 228, 244, 0.06)',
      backdropFilter: 'blur(14px)',
      outline: '1px dashed rgba(188, 198, 220, 0.52)',
      outlineOffset: 2,
      pointerEvents: 'none',
    }
  }

  function getRemoveTooltipArrowStyle(align) {
    return {
      position: 'absolute',
      ...(align === 'left' ? { left: 16 } : { right: 16 }),
      bottom: -5,
      width: 10,
      height: 10,
      borderRight: '1px solid rgba(214, 222, 238, 0.42)',
      borderBottom: '1px solid rgba(214, 222, 238, 0.42)',
      background: 'rgba(4, 6, 11, 0.995)',
      boxShadow: '4px 4px 12px rgba(2, 6, 23, 0.2)',
      transform: 'rotate(45deg)',
    }
  }

  function getMenuPanelStyle(position) {
    return {
      position: 'fixed',
      left: position.x,
      top: position.y,
      zIndex: 950,
      minWidth: 146,
      background: 'color-mix(in srgb, var(--surface) 94%, rgba(15, 23, 42, 0.18))',
      border: '1px solid color-mix(in srgb, var(--border) 86%, white 6%)',
      borderRadius: 9,
      boxShadow: '0 12px 24px rgba(15, 23, 42, 0.2)',
      backdropFilter: 'blur(10px)',
      overflow: 'hidden',
    }
  }

  function getMenuButtonStyle(disabled = false) {
    return {
      width: '100%',
      textAlign: 'left',
      background: 'none',
      border: 'none',
      color: disabled ? 'var(--muted)' : 'var(--text)',
      padding: '6px 10px',
      fontSize: 12,
      lineHeight: 1.15,
      cursor: disabled ? 'not-allowed' : 'pointer',
    }
  }

  function getSortMenuItemStyle(active = false) {
    return {
      ...getMenuButtonStyle(false),
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 12,
      background: active ? 'color-mix(in srgb, var(--accent) 14%, transparent)' : 'transparent',
      color: active ? 'color-mix(in srgb, var(--accent) 70%, white 18%)' : 'var(--text)',
      fontWeight: active ? 600 : 500,
    }
  }

  function openSortMenu() {
    if (bulkMode) return
    const rect = sortControlRef.current?.getBoundingClientRect?.()
    if (!rect) return
    const menuWidth = 148
    const margin = 12
    const x = Math.max(
      margin,
      Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - margin),
    )
    const y = Math.min(rect.bottom + 8, window.innerHeight - 120)
    setBulkMenu(null)
    setSuggestionMenu(null)
    setSortMenu({ x, y })
  }

  function handleSortChange(nextSortOrder) {
    handleSortOrderChange(nextSortOrder)
    setSortMenu(null)
    requestAnimationFrame(() => {
      listTopRef.current?.scrollIntoView({ block: 'start', behavior: 'auto' })
    })
  }

  function renderSortControl() {
    const currentSortLabel = sortOrder === 'row_count' ? '# rows' : 'A-Z'
    return (
      <div style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: '3px 9px',
        borderRadius: 999,
        border: '1px solid color-mix(in srgb, var(--border) 72%, white 12%)',
        background: 'linear-gradient(180deg, color-mix(in srgb, var(--surface2) 96%, white 4%), color-mix(in srgb, var(--surface2) 84%, var(--surface)))',
        color: 'var(--text)',
        boxShadow: '0 4px 12px rgba(15, 23, 42, 0.10), inset 0 1px 0 rgba(255,255,255,0.04)',
        fontSize: 11.5,
        lineHeight: 1.2,
        opacity: bulkMode ? 0.5 : 1,
      }}>
        <span style={{ whiteSpace: 'nowrap' }}>Sort order</span>
        <button
          ref={sortControlRef}
          type="button"
          onMouseDown={event => event.stopPropagation()}
          onClick={event => {
            event.stopPropagation()
            if (bulkMode) return
            if (sortMenu) {
              setSortMenu(null)
              return
            }
            openSortMenu()
          }}
          disabled={bulkMode}
          style={{
            background: 'none',
            border: 'none',
            padding: '0 2px',
            margin: 0,
            font: 'inherit',
            position: 'relative',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            cursor: bulkMode ? 'not-allowed' : 'pointer',
            color: 'inherit',
          }}
        >
          <span style={{ fontSize: 12, lineHeight: 1.2, whiteSpace: 'nowrap' }}>
            {currentSortLabel}
          </span>
          <span style={{ fontSize: 10, lineHeight: 1, color: 'inherit' }}>▾</span>
        </button>
      </div>
    )
  }

  function openLookbackMenu() {
    const rect = lookbackControlRef.current?.getBoundingClientRect?.()
    if (!rect) return
    const menuWidth = 148
    const margin = 12
    const x = Math.max(margin, Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - margin))
    const y = Math.min(rect.bottom + 8, window.innerHeight - 180)
    setBulkMenu(null)
    setSuggestionMenu(null)
    setSortMenu(null)
    setLookbackMenu({ x, y })
  }

  // Only meaningful where the lens runs (pending / conflicts / older); hidden elsewhere so it doesn't
  // imply an effect it isn't having on the accepted/discarded/total views.
  function renderLookbackControl() {
    if (!lensRelevant) return null
    const longestLookbackLabel = IMPORT_RULE_LOOKBACK_CHOICES
      .map(lookbackLabel)
      .reduce((longest, label) => (label.length > longest.length ? label : longest), '')
    return (
      <div style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: '3px 9px',
        borderRadius: 999,
        border: '1px solid color-mix(in srgb, var(--border) 72%, white 12%)',
        background: 'linear-gradient(180deg, color-mix(in srgb, var(--surface2) 96%, white 4%), color-mix(in srgb, var(--surface2) 84%, var(--surface)))',
        color: 'var(--text)',
        boxShadow: '0 4px 12px rgba(15, 23, 42, 0.10), inset 0 1px 0 rgba(255,255,255,0.04)',
        fontSize: 11.5,
        lineHeight: 1.2,
      }}>
        <span style={{ whiteSpace: 'nowrap' }}>Look back</span>
        <button
          ref={lookbackControlRef}
          type="button"
          onMouseDown={event => event.stopPropagation()}
          onClick={event => {
            event.stopPropagation()
            if (lookbackMenu) {
              setLookbackMenu(null)
              return
            }
            openLookbackMenu()
          }}
          style={{
            background: 'none',
            border: 'none',
            padding: '0 2px',
            margin: 0,
            font: 'inherit',
            position: 'relative',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            cursor: 'pointer',
            color: 'inherit',
          }}
        >
          {/* An invisible sizer holds the width of the widest choice ("All time"), so the pill doesn't
              resize as you flip between "1 year" / "2 years" / "All time". */}
          <span style={{ display: 'inline-grid', fontSize: 12, lineHeight: 1.2 }}>
            <span aria-hidden="true" style={{ gridArea: '1 / 1', visibility: 'hidden', whiteSpace: 'nowrap' }}>
              {longestLookbackLabel}
            </span>
            <span style={{ gridArea: '1 / 1', whiteSpace: 'nowrap' }}>
              {lookbackLabel(lookbackYears)}
            </span>
          </span>
          <span style={{ fontSize: 10, lineHeight: 1, color: 'inherit' }}>▾</span>
        </button>
      </div>
    )
  }

  function renderMerchantFilterControl() {
    if (merchantFilterOpen) {
      return (
        <div style={{
          position: 'relative',
          display: 'inline-flex',
          alignItems: 'center',
          minWidth: 220,
          maxWidth: 260,
          margin: '0 10px 0 0',
          background: 'linear-gradient(180deg, color-mix(in srgb, var(--surface2) 96%, white 4%), color-mix(in srgb, var(--surface2) 84%, var(--surface)))',
          border: '1px solid color-mix(in srgb, var(--border) 72%, white 12%)',
          borderRadius: 999,
          boxShadow: '0 4px 12px rgba(15, 23, 42, 0.10), inset 0 1px 0 rgba(255,255,255,0.04)',
          opacity: bulkMode ? 0.5 : 1,
        }}>
          <input
            ref={merchantFilterInputRef}
            type="text"
            value={merchantFilterText}
            onChange={event => setMerchantFilterText(event.target.value)}
            onKeyDown={event => {
              if (event.key !== 'Escape') return
              event.stopPropagation()
              const snapshot = merchantFilterSnapshotRef.current
              setMerchantFilterText(snapshot)
              onMerchantFilterOpenChange(Boolean(snapshot))
              setTimeout(() => {
                if (snapshot) {
                  merchantFilterInputRef.current?.focus()
                  merchantFilterInputRef.current?.select()
                } else {
                  merchantFilterButtonRef.current?.focus()
                }
              }, 0)
            }}
            disabled={bulkMode}
            placeholder="merchant name"
            style={{
              width: '100%',
              background: 'none',
              border: 'none',
              color: 'var(--text)',
              padding: '6px 12px',
              fontSize: 12,
              lineHeight: 1.2,
              outline: 'none',
            }}
          />
          <button
            type="button"
            onClick={() => {
              setMerchantFilterText('')
              onMerchantFilterOpenChange(false)
            }}
            disabled={bulkMode}
            title="Close merchant filter"
            style={{
              position: 'absolute',
              top: -6,
              right: -6,
              width: 16,
              height: 16,
              padding: 0,
              borderRadius: 999,
              border: '1px solid color-mix(in srgb, var(--border) 78%, white 8%)',
              background: 'color-mix(in srgb, var(--surface) 82%, transparent)',
              color: 'var(--muted)',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: bulkMode ? 'not-allowed' : 'pointer',
              fontSize: 11,
              fontWeight: 700,
              lineHeight: 1,
              boxShadow: '0 3px 8px rgba(15, 23, 42, 0.12)',
            }}
          >
            ×
          </button>
        </div>
      )
    }

    return (
      <button
        ref={merchantFilterButtonRef}
        type="button"
        onClick={() => {
          merchantFilterSnapshotRef.current = merchantFilterText
          onMerchantFilterOpenChange(true)
        }}
        disabled={bulkMode}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: '6px 12px',
          borderRadius: 999,
          border: '1px dashed color-mix(in srgb, var(--border) 78%, white 10%)',
          background: 'transparent',
          color: 'var(--muted)',
          fontSize: 12,
          lineHeight: 1.2,
          cursor: bulkMode ? 'not-allowed' : 'pointer',
          opacity: bulkMode ? 0.5 : 1,
        }}
      >
        +Merchant filter
      </button>
    )
  }

  function renderOwnerFilterControl() {
    if (!showOwnerFilter) return null

    if (ownerFilterOpen) {
      return (
        <div style={{
          position: 'relative',
          display: 'inline-flex',
          alignItems: 'center',
          height: 30,
          maxWidth: 'min(520px, 56vw)',
          margin: '0 14px 0 0',
          padding: '3px 14px 3px 6px',
          boxSizing: 'border-box',
          borderRadius: 999,
          border: '1px dashed color-mix(in srgb, var(--border) 78%, white 10%)',
          background: 'transparent',
          opacity: bulkMode ? 0.5 : 1,
          flex: '0 0 auto',
        }}>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            flexWrap: 'nowrap',
            overflowX: 'auto',
            overflowY: 'hidden',
            minWidth: 0,
            height: '100%',
            scrollbarWidth: 'thin',
            justifyContent: 'center',
          }}>
            {availableOwners.map(owner => {
              const selected = selectedOwnerIds.includes(owner.id)
              return (
                <button
                  key={owner.id}
                  type="button"
                  onClick={() => {
                    if (bulkMode) return
                    onToggleOwner(owner.id)
                    onOwnerFilterOpenChange(false)
                    setTimeout(() => ownerFilterButtonRef.current?.focus(), 0)
                  }}
                  disabled={bulkMode}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 5,
                    borderRadius: 999,
                    border: `1px solid ${selected ? 'color-mix(in srgb, var(--accent) 52%, var(--border))' : 'var(--border)'}`,
                    background: selected
                      ? 'linear-gradient(180deg, color-mix(in srgb, var(--accent) 18%, var(--surface2)), color-mix(in srgb, var(--accent) 8%, var(--surface)))'
                      : 'color-mix(in srgb, var(--surface2) 92%, var(--surface))',
                    color: selected ? 'var(--text)' : 'var(--muted)',
                    padding: '4px 9px',
                    fontSize: 11.5,
                    cursor: bulkMode ? 'not-allowed' : 'pointer',
                    boxShadow: selected ? '0 6px 14px rgba(15, 23, 42, 0.14)' : 'none',
                    fontWeight: selected ? 600 : 500,
                    flex: '0 0 auto',
                  }}
                >
                  <span style={{ width: 7, height: 7, borderRadius: 999, background: owner.color || 'var(--accent)' }} />
                  {owner.name}
                </button>
              )
            })}
          </div>
          <button
            type="button"
            onClick={() => {
              if (bulkMode) return
              selectedOwnerIds.forEach(ownerId => onToggleOwner(ownerId))
              onOwnerFilterOpenChange(false)
              setTimeout(() => ownerFilterButtonRef.current?.focus(), 0)
            }}
            disabled={bulkMode}
            title="Close owner filter"
            style={{
              position: 'absolute',
              top: -6,
              right: -6,
              width: 16,
              height: 16,
              padding: 0,
              borderRadius: 999,
              border: '1px solid color-mix(in srgb, var(--border) 78%, white 8%)',
              background: 'color-mix(in srgb, var(--surface) 82%, transparent)',
              color: 'var(--muted)',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: bulkMode ? 'not-allowed' : 'pointer',
              fontSize: 11,
              fontWeight: 700,
              lineHeight: 1,
              boxShadow: '0 3px 8px rgba(15, 23, 42, 0.12)',
            }}
          >
            ×
          </button>
        </div>
      )
    }

    return (
      <button
        ref={ownerFilterButtonRef}
        type="button"
        onClick={() => onOwnerFilterOpenChange(true)}
        disabled={bulkMode}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: '6px 12px',
          borderRadius: 999,
          border: '1px dashed color-mix(in srgb, var(--border) 78%, white 10%)',
          background: 'transparent',
          color: 'var(--muted)',
          fontSize: 12,
          lineHeight: 1.2,
          cursor: bulkMode ? 'not-allowed' : 'pointer',
          opacity: bulkMode ? 0.5 : 1,
        }}
      >
        {selectedOwnerIds.length === 1
          ? (availableOwners.find(owner => owner.id === selectedOwnerIds[0])?.name || '+Owner filter')
          : '+Owner filter'}
      </button>
    )
  }

  function renderSuggestionCard(
    suggestion,
    {
      filterKey = reviewFilter,
      conflictFollowerIds: followerIds = conflictFollowerIds,
      conflictLeadIds: leadIds = conflictLeadIds,
      allowConflictOpen = true,
    } = {},
  ) {
    const resolvedSuggestion = getResolvedSuggestion(suggestion)
    const actionLabels = getSuggestionActions(suggestion)
    const filterPills = getSuggestionFilterPills(resolvedSuggestion)
    const isConflictFollower = filterKey === 'pending' && followerIds.has(suggestion.id)
    const isConflictLead = leadIds.has(suggestion.id)
    const conflictGroupIds = suggestion.conflict_group_id
      ? (visibleConflictGroupMembers.get(suggestion.conflict_group_id) || []).map(getSuggestionKey)
      : []
    const leadHasVisibleChildren = bulkMode && filterKey === 'pending' && isConflictLead && conflictGroupIds.length > 1
    const showConflictMarker = Boolean(suggestion.conflict_group_id) && filterKey !== 'pending'
    const statusBadge = suggestion.review_status === 'accepted'
      ? { label: 'Accepted', tone: 'accepted' }
      : suggestion.review_status === 'skipped'
        ? { label: 'Deferred', tone: 'skipped' }
        : suggestion.review_status === 'discarded'
          ? { label: 'Removed', tone: 'discarded' }
          : null
    const showStatusBadge = Boolean(
      statusBadge && (
        filterKey === 'total'
        || filterKey === 'accepted'
        || filterKey === 'deferred'
        || filterKey === 'discarded'
      )
    )
    // Row buttons always act on this one card (bulk dispositions live in the bulk-actions bar), so the
    // labels are unconditionally the single-card forms.
    const saveLabel = 'Save'
    const deferLabel = 'Defer'
    const resumeLabel = 'Resume'
    const restoreLabel = 'Restore'
    const returnsToPending = suggestion.review_status === 'accepted' || suggestion.review_status === 'skipped'
    const removeActionStatus = returnsToPending ? 'pending' : 'discarded'
    const removeTitle = returnsToPending ? 'Return suggestion to pending' : 'Discard suggestion'

    return (
      <div
        key={suggestion.id}
        onMouseLeave={() => setHoveredRemoveTooltip(current => (current?.id === suggestion.id ? null : current))}
        onContextMenu={event => {
          event.preventDefault()
          if (bulkMode && bulkAvailable) {
            event.stopPropagation()
            setSuggestionMenu(null)
            setSortMenu(null)
            setBulkMenu({
              x: event.clientX,
              y: event.clientY,
              scopeIds: getScopedBulkIdsForSuggestion(suggestion),
            })
            return
          }
          setBulkMenu(null)
          setSortMenu(null)
          setSuggestionMenu({
            x: event.clientX,
            y: event.clientY,
            suggestion,
            resolvedSuggestion,
          })
        }}
        style={{
          position: 'relative',
          marginLeft: isConflictFollower ? 30 : 0,
          // Each card is its own stacking context (position + z-index), so an inline popover (the tag
          // picker) can't paint over the *next* card unless this card outranks it while open.
          zIndex: editingTagSuggestionId === getSuggestionKey(suggestion.id)
            ? 30
            : (hoveredRemoveTooltip?.id === suggestion.id ? 8 : 0),
          border: '1px solid var(--border)',
          borderRadius: 14,
          overflow: 'visible',
          isolation: hoveredRemoveTooltip?.id === suggestion.id ? 'isolate' : 'auto',
          background: 'color-mix(in srgb, var(--surface2) 70%, var(--surface))',
        }}
      >
        {isConflictFollower ? (
          <span
            aria-hidden="true"
            style={{
              position: 'absolute',
              left: -12,
              top: -10,
              bottom: -10,
              width: 8,
              borderLeft: '2px solid color-mix(in srgb, var(--text) 28%, var(--border))',
              borderRight: '2px solid color-mix(in srgb, var(--text) 18%, var(--border))',
              borderRadius: 999,
              pointerEvents: 'none',
              opacity: 0.95,
            }}
          />
        ) : null}
        {bulkMode ? (
          <label aria-label="Select this suggestion" style={{
            position: 'absolute',
            top: 13,
            left: 14,
            zIndex: 2,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 20,
            height: 20,
            cursor: 'pointer',
          }}>
            <input
              type="checkbox"
              checked={selectedSuggestionIds.includes(getSuggestionKey(suggestion.id))}
              onChange={() => {
                if (leadHasVisibleChildren) {
                  toggleConflictParentSelection(suggestion)
                  return
                }
                toggleSuggestionSelection(suggestion.id)
              }}
              style={{ width: 16, height: 16, accentColor: 'var(--accent)', cursor: 'pointer' }}
            />
          </label>
        ) : null}
        {showStatusBadge && statusBadge ? (
          <SuggestionStatusBadge
            label={statusBadge.label}
            tone={statusBadge.tone}
            left={bulkMode ? 42 : 14}
          />
        ) : null}
        {suggestion.review_status === 'accepted' ? (
          <>
            {hoveredRemoveTooltip?.id === suggestion.id ? (
              <div style={getRemoveTooltipStyle(hoveredRemoveTooltip.align, hoveredRemoveTooltip.offset)}>
                {removeTitle}
                <span style={getRemoveTooltipArrowStyle(hoveredRemoveTooltip.align)} />
              </div>
            ) : null}
            <button
              type="button"
              aria-label={removeTitle}
              onMouseEnter={event => showRemoveTooltip(suggestion.id, removeTitle, event.currentTarget)}
              onMouseLeave={() => setHoveredRemoveTooltip(current => (current?.id === suggestion.id ? null : current))}
              onFocus={event => showRemoveTooltip(suggestion.id, removeTitle, event.currentTarget)}
              onBlur={() => setHoveredRemoveTooltip(current => (current?.id === suggestion.id ? null : current))}
              onClick={() => runRowStatusAction(suggestion, resolvedSuggestion, removeActionStatus)}
              style={{
                position: 'absolute',
                top: 10,
                right: 10,
                zIndex: 1,
                border: '1px solid color-mix(in srgb, var(--danger) 22%, var(--border))',
                background: 'color-mix(in srgb, var(--surface) 82%, transparent)',
                color: 'var(--danger)',
                borderRadius: 999,
                width: 24,
                height: 24,
                padding: 0,
                fontSize: 13,
                fontWeight: 700,
                lineHeight: 1,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
              }}
            >
              ×
            </button>
          </>
        ) : null}
        <div style={{
          padding: showStatusBadge
            ? (suggestion.review_status === 'discarded'
              ? `11px 16px 11px ${bulkMode ? 72 : 44}px`
              : `11px 52px 11px ${bulkMode ? 72 : 44}px`)
            : (suggestion.review_status === 'discarded'
              ? `11px 16px 11px ${bulkMode ? 44 : 16}px`
              : `11px 52px 11px ${bulkMode ? 44 : 16}px`),
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 14,
          flexWrap: 'wrap',
        }}>
          <div style={{ minWidth: 0, flex: '1 1 280px' }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap' }}>
              <CriteriaGroup
                merchantLabel={resolvedSuggestion.merchant_label}
                keyword={resolvedSuggestion.keyword}
                filterPills={filterPills}
                onRemoveFilter={actionKey => removeSuggestionAction(suggestion.id, actionKey)}
                editing={editingKeywordSuggestionId === getSuggestionKey(suggestion.id)}
                draftValue={editingKeywordDraft}
                onEditSuggestion={() => onEditSuggestion(suggestion.id)}
                onBeginKeywordEdit={() => beginKeywordEdit(suggestion)}
                onKeywordChange={setEditingKeywordDraft}
                onKeywordCommit={() => commitKeywordEdit(suggestion)}
                onKeywordCancel={cancelKeywordEdit}
              />
              {suggestion.txn_count ? (
                <span style={{ fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                  {suggestion.txn_count} matching row{suggestion.txn_count === 1 ? '' : 's'}
                  <ReportArrowButton onClick={() => openMatchingTransactionsViewer(suggestion)} />
                </span>
              ) : null}
              {showConflictMarker ? (
                <button
                  type="button"
                  onClick={() => {
                    if (!allowConflictOpen || !suggestion.conflict_group_id) return
                    setOpenConflictGroupId(suggestion.conflict_group_id)
                  }}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '3px 8px',
                    borderRadius: 999,
                    fontSize: 11,
                    fontWeight: 600,
                    color: 'color-mix(in srgb, var(--warning) 72%, var(--text))',
                    background: 'color-mix(in srgb, var(--warning) 10%, var(--surface2))',
                    border: '1px solid color-mix(in srgb, var(--warning) 28%, var(--border))',
                    whiteSpace: 'nowrap',
                    cursor: allowConflictOpen ? 'pointer' : 'default',
                  }}
                >
                  conflict set
                </button>
              ) : null}
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
              <span style={{ fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap' }}>actions:</span>
              {actionLabels.length > 0 ? actionLabels.map(action => (
                action.key === 'category' && editingCategorySuggestionId === getSuggestionKey(suggestion.id) ? (
                  <div key={action.key} style={{ minWidth: 240, maxWidth: 320, flex: '0 1 320px' }}>
                    <CategoryPicker
                      value={resolvedSuggestion.target_category_id}
                      categories={categories}
                      onChange={value => commitCategoryActionEdit(suggestion, value)}
                      onCategoryCreated={async () => {
                        const nextCategories = await onCategoriesChanged?.()
                        if (Array.isArray(nextCategories)) {
                          latestCategoriesRef.current = nextCategories
                        }
                      }}
                      compact
                      openToken={categoryPickerOpenToken}
                      onOpenChange={open => {
                        if (open) {
                          categoryPickerHasOpenedRef.current = true
                          return
                        }
                        // Some picker close events fire before the popover is ever
                        // visible; ignore those so category edit mode does not cancel instantly.
                        if (categoryPickerHasOpenedRef.current) {
                          setEditingCategorySuggestionId(current => (
                            current === getSuggestionKey(suggestion.id) ? null : current
                          ))
                          categoryPickerHasOpenedRef.current = false
                        }
                      }}
                    />
                  </div>
                ) : (
                  <SuggestionPill
                    key={action.key}
                    label={action.label}
                    onRemove={action.onRemove}
                    onClick={action.onClick}
                    onMouseDown={action.onMouseDown}
                    editing={action.editing}
                    editValue={action.editValue}
                    onEditValueChange={action.onEditValueChange}
                    onEditCommit={action.onEditCommit}
                    onEditCancel={action.onEditCancel}
                  />
                )
              )) : (
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>none</span>
              )}
            </div>

            {(resolvedSuggestion.tag_ids?.length || editingTagSuggestionId === getSuggestionKey(suggestion.id)) ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
                <span style={{ fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap' }}>tags:</span>
                {resolvedSuggestion.tag_ids.map(tagId => {
                  const tag = tags.find(item => String(item.id) === String(tagId))
                  if (!tag) return null
                  return (
                    <span key={tagId} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      <TagBadge tag={tag} />
                      <button
                        type="button"
                        onClick={() => setSuggestionTag(suggestion, tagId, false)}
                        title={`Remove ${tag.name}`}
                        style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 13, lineHeight: 1, padding: 0 }}
                      >
                        ×
                      </button>
                    </span>
                  )
                })}
                <span style={{ position: 'relative', display: 'inline-flex' }}>
                  <button
                    type="button"
                    // Open-only: while the picker is open its own outside-click dismissal closes it, so a
                    // toggling onClick would close-then-reopen on the same click.
                    onClick={editingTagSuggestionId === getSuggestionKey(suggestion.id)
                      ? undefined
                      : () => setEditingTagSuggestionId(getSuggestionKey(suggestion.id))}
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: 4,
                      padding: '3px 9px', borderRadius: 999, fontSize: 11.5, fontWeight: 600,
                      color: 'var(--muted)', background: 'transparent',
                      border: '1px dashed color-mix(in srgb, var(--border) 80%, var(--text) 12%)',
                      cursor: 'pointer', whiteSpace: 'nowrap',
                    }}
                  >
                    + tag
                  </button>
                  {editingTagSuggestionId === getSuggestionKey(suggestion.id) ? (
                    <TagPickerWithCreate
                      allTags={tags}
                      selectedTagIds={new Set(resolvedSuggestion.tag_ids)}
                      onToggleTag={(tag, present) => setSuggestionTag(suggestion, tag.id, present)}
                      onTagCreated={created => onTagCreated?.(created)}
                      onClose={() => setEditingTagSuggestionId(null)}
                      positioning="absolute"
                      align="left"
                    />
                  ) : null}
                </span>
              </div>
            ) : null}

            {suggestion.needs_resolution && filterKey === 'pending' && isConflictLead ? (
              <div style={{ marginTop: 6, fontSize: 12, color: 'color-mix(in srgb, var(--warning) 72%, var(--text))' }}>
                Conflicting category assignments for the same merchant. Pick one or add selection criteria to distinguish them.
              </div>
            ) : null}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flexShrink: 0, alignItems: 'flex-end' }}>
            {suggestion.review_status === 'discarded' ? (
              <SuggestionActionButton onClick={() => runRowStatusAction(suggestion, resolvedSuggestion, 'pending')}>
                {restoreLabel}
              </SuggestionActionButton>
            ) : (
              <>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                  <SuggestionActionButton onClick={() => onEditSuggestion(suggestion.id)} active={editingSuggestionId === suggestion.id}>
                    {editingSuggestionId === suggestion.id ? 'Rule Editor Open' : 'Open Rule Editor'}
                  </SuggestionActionButton>
                  {suggestion.review_status === 'skipped' ? (
                    <SuggestionActionButton onClick={() => runRowStatusAction(suggestion, resolvedSuggestion, 'pending')}>
                      {resumeLabel}
                    </SuggestionActionButton>
                  ) : (
                    <SuggestionActionButton onClick={() => runRowStatusAction(suggestion, resolvedSuggestion, 'skipped')}>
                      {deferLabel}
                    </SuggestionActionButton>
                  )}
                  {suggestion.review_status !== 'accepted' ? (
                    <SuggestionActionButton onClick={() => runRowSaveAction(suggestion, resolvedSuggestion)}>
                      {saveLabel}
                    </SuggestionActionButton>
                  ) : null}
                </div>
                {suggestion.review_status !== 'accepted' ? (
                  // Reject the suggestion and settle the rows it covered. The two buttons complete the
                  // "discard and …" label and are grouped in a bordered chip so it reads as one unit; the
                  // wording ("…categorization") makes clear it acts on the transactions, not the category.
                  // 'remove' -> cleared source; 'keep' -> file category becomes a manual decision.
                  <div style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6,
                    border: '1px solid var(--border)', borderRadius: 9, padding: '3px 4px 3px 8px',
                    background: 'color-mix(in srgb, var(--surface) 70%, transparent)',
                  }}>
                    <span style={{ fontSize: 11, color: 'var(--muted)', whiteSpace: 'nowrap' }}>discard and</span>
                    <Tooltip content="Discard this proposed rule and clear the transactions' categorization">
                      <SuggestionActionButton
                        onClick={() => onRejectSuggestionDisposition(suggestion, 'clear')}
                        style={{ fontSize: 11, padding: '3px 8px' }}
                      >
                        remove categorization
                      </SuggestionActionButton>
                    </Tooltip>
                    <Tooltip content="Discard this proposed rule but keep the transactions' current categorization">
                      <SuggestionActionButton
                        onClick={() => onRejectSuggestionDisposition(suggestion, 'keep')}
                        style={{ fontSize: 11, padding: '3px 8px' }}
                      >
                        keep categorization
                      </SuggestionActionButton>
                    </Tooltip>
                  </div>
                ) : null}
              </>
            )}
          </div>
        </div>
      </div>
    )
  }

  // A conflict subset (same merchant + scope, different categories) renders as one resolution card. The
  // members are collected from the whole visible set by conflict_group_id, so a card shows every member
  // regardless of where they fall in the flat order.
  function renderConflictSetCard(suggestion) {
    const members = (visibleConflictGroupMembers.get(suggestion.conflict_group_id) || [])
      .map(id => visibleSuggestions.find(item => item.id === id))
      .filter(Boolean)
      .map(raw => ({
        ...getResolvedSuggestion(raw),
        imported_category_id: raw.target_category_id,
        imported_category_name: raw.target_category_name,
      }))
    return (
      <ConflictSetCard
        key={`conflict:${suggestion.conflict_group_id}`}
        members={members}
        applying={applyingConflict}
        onApply={winnerId => onApplyConflictSet(members, winnerId)}
        onDefer={() => onSetSuggestionStatusBulk(members, 'skipped')}
        onOpenReport={() => openMatchingTransactionsViewer(suggestion)}
        onEditRule={memberId => onEditSuggestion(memberId)}
        categories={categories}
        onSetMemberCategory={(member, categoryId) => commitCategoryActionEdit(member, categoryId)}
        onCategoryCreated={async () => {
          const nextCategories = await onCategoriesChanged?.()
          if (Array.isArray(nextCategories)) latestCategoriesRef.current = nextCategories
        }}
      />
    )
  }

  // Same-merchant (same keyword) suggestions render together inside one bordered container so the user
  // can see the whole pattern — scope variants and conflicts — and decide as a unit. A group with a
  // single item (one plain card, or one conflict set with no variants) renders bare to avoid a redundant
  // outer border. The combined row count drives the group's sort position (see sortSuggestionsForDisplay).
  function renderMerchantGroup(group, useConflictCards) {
    const items = []
    const seenConflict = new Set()
    for (const suggestion of group.members) {
      if (useConflictCards && suggestion.conflict_group_id) {
        if (seenConflict.has(suggestion.conflict_group_id)) continue
        seenConflict.add(suggestion.conflict_group_id)
        items.push({ key: `conflict:${suggestion.conflict_group_id}`, node: renderConflictSetCard(suggestion) })
      } else {
        items.push({ key: `single:${suggestion.id}`, node: renderSuggestionCard(suggestion) })
      }
    }

    if (items.length <= 1) return items[0]?.node ?? null

    const lead = group.members[0]
    const totalRows = group.members.reduce((sum, member) => sum + (member.txn_count || 0), 0)
    const categoryCount = new Set(
      group.members.map(member => member.target_category_id || `name:${member.target_category_name || ''}`),
    ).size
    return (
      <div
        key={`merchant:${group.key}`}
        style={{
          border: '1px solid color-mix(in srgb, var(--border) 86%, var(--text) 8%)',
          borderRadius: 16,
          padding: 12,
          display: 'grid',
          gap: 12,
          background: 'color-mix(in srgb, var(--surface2) 30%, transparent)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', padding: '0 2px' }}>
          <span style={{ fontWeight: 700, fontSize: 13 }}>{lead.merchant_label}</span>
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>
            {categoryCount} categor{categoryCount === 1 ? 'y' : 'ies'} · {totalRows} row{totalRows === 1 ? '' : 's'}
          </span>
        </div>
        <div style={{ display: 'grid', gap: 12 }}>
          {items.map(item => <div key={item.key}>{item.node}</div>)}
        </div>
      </div>
    )
  }

  return (
    <div
      ref={rootRef}
      onContextMenu={event => {
        if (!bulkMode || !bulkAvailable) return
        event.preventDefault()
        setBulkMenu({ x: event.clientX, y: event.clientY, scopeIds: null })
      }}
      style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 12, minWidth: 0 }}
    >
      <div
        onContextMenu={event => {
          if (!bulkMode || !bulkAvailable) return
          event.preventDefault()
          setBulkMenu({ x: event.clientX, y: event.clientY, scopeIds: null })
        }}
        style={{
          position: 'sticky',
          top: stickyTopOffset,
          zIndex: 5,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          flexWrap: 'wrap',
          padding: '10px 12px',
          margin: '-2px -2px 4px',
          border: '1px solid color-mix(in srgb, var(--border) 82%, white 8%)',
          borderRadius: 14,
          background: 'color-mix(in srgb, var(--surface) 92%, rgba(15, 23, 42, 0.18))',
          backdropFilter: 'blur(10px)',
          boxShadow: '0 10px 22px rgba(15, 23, 42, 0.14)',
        }}
      >
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 12, width: '100%', minWidth: 0 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr)', alignItems: 'center', gap: 10, minHeight: 42, width: '100%', minWidth: 0 }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)', whiteSpace: 'nowrap' }}>
              Filters:
            </span>
            <div style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              flexWrap: 'nowrap',
              overflowX: 'auto',
              overflowY: 'hidden',
              minWidth: 0,
              minHeight: 46,
              padding: '6px 6px',
              borderRadius: 999,
              border: '1px solid color-mix(in srgb, var(--border) 72%, white 12%)',
              background: 'color-mix(in srgb, var(--surface) 76%, rgba(15, 23, 42, 0.08))',
              boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.03)',
              justifySelf: 'start',
              scrollbarWidth: 'thin',
            }}>
              {renderMerchantFilterControl()}
              {renderOwnerFilterControl()}
            </div>
          </div>
          {/* Pills get their own full-width row so the set is stable — clicking a filter no longer
              reflows them (the per-view controls below changed width before and shoved the pills around). */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minWidth: 0 }}>
            {reviewFilterPills.map(pill => (
              <ProgressPill
                key={pill.key}
                label={pill.label}
                value={pill.value}
                tone={pill.tone}
                active={reviewFilter === pill.key}
                onClick={bulkMode ? undefined : () => onChangeReviewFilter(pill.key)}
                disabled={bulkMode}
              />
            ))}
          </div>
          {/* Bottom line: the active view's header on the left, the controls (look back / sort / bulk)
              pinned to the right so they sit on one consistent line instead of floating mid-panel. */}
          <div
            onContextMenu={event => {
              if (!bulkMode) return
              event.preventDefault()
              setBulkMenu({ x: event.clientX, y: event.clientY, scopeIds: null })
            }}
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', minWidth: 0 }}
          >
            <div style={{ minWidth: 0, flex: '1 1 220px' }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>{activeViewHeader.title}</span>
              {activeViewHeader.description ? (
                <span style={{ fontSize: 12, color: 'var(--muted)', marginLeft: 8 }}>{activeViewHeader.description}</span>
              ) : null}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              {renderLookbackControl()}
              {renderSortControl()}
              <span
                title={showInlineRefreshing ? 'Updating' : ''}
                style={{
                  width: 16,
                  height: 16,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  visibility: showInlineRefreshing ? 'visible' : 'hidden',
                }}
              >
                <span style={{
                  width: 8,
                  height: 8,
                  borderRadius: 999,
                  background: 'color-mix(in srgb, var(--accent) 72%, white 12%)',
                  boxShadow: '0 0 0 4px color-mix(in srgb, var(--accent) 14%, transparent)',
                }} />
              </span>
              {bulkAvailable ? (
                <SuggestionActionButton
                  onClick={() => {
                    setBulkMode(prev => {
                      const next = !prev
                      if (!next) {
                        setSelectedSuggestionIds([])
                        setBulkMenu(null)
                      }
                      setSortMenu(null)
                      return next
                    })
                  }}
                  active={bulkMode}
                >
                  {bulkMode ? 'Cancel' : 'Bulk Select'}
                </SuggestionActionButton>
              ) : null}
            </div>
          </div>
          {/* Bulk-actions bar: appears only in bulk mode. All bulk dispositions live here as visible
              buttons (Save/Defer/Discard variants per view) rather than riding on the cards' own row
              buttons or hiding in a right-click menu. Labels omit "selected" — the bar's own header
              already scopes them to the selection. */}
          {bulkMode ? (
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
              flexWrap: 'wrap',
              minWidth: 0,
              padding: '8px 10px',
              borderRadius: 12,
              border: '1px solid color-mix(in srgb, var(--accent) 30%, var(--border))',
              background: 'color-mix(in srgb, var(--accent) 8%, var(--surface))',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', minWidth: 0 }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)', whiteSpace: 'nowrap' }}>
                  Bulk actions
                </span>
                <span style={{ fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap' }}>
                  {selectedCount} of {visibleSuggestions.length} selected
                </span>
                <button
                  type="button"
                  onClick={() => selectAllScoped()}
                  style={bulkLinkButtonStyle(false)}
                >
                  Select all
                </button>
                <button
                  type="button"
                  onClick={() => setSelectedSuggestionIds([])}
                  disabled={selectedCount === 0}
                  style={bulkLinkButtonStyle(selectedCount === 0)}
                >
                  Clear
                </button>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                {bulkActions.map(action => (
                  <SuggestionActionButton
                    key={action.key}
                    onClick={() => runBulkAction(action)}
                    disabled={selectedCount === 0}
                    active={action.tone === 'primary'}
                  >
                    {action.label}
                  </SuggestionActionButton>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <ContextualExplainer
        topic="generate-rules"
        tipKey="generate-rules-conflicts"
        active={suggestions.some(suggestion => suggestion.conflict_group_id)}
        // The page header already carries a `?` for this topic, so don't leave a second one behind
        // when the first-use tip is dismissed.
        persistentButton={false}
      />

      {showFullScreenLoading ? (
        <Spinner />
      ) : ruleSuggestionState?.error ? (
        <div style={{ fontSize: 13, color: 'var(--danger)' }}>{ruleSuggestionState.error}</div>
      ) : ruleSuggestionState?.requires_owner_resolution ? (
        <div style={{
          fontSize: 13,
          padding: '12px 14px',
          borderRadius: 12,
          background: 'color-mix(in srgb, var(--accent2) 8%, var(--surface2))',
          border: '1px solid color-mix(in srgb, var(--accent2) 26%, var(--border))',
          lineHeight: 1.55,
        }}>
          Owner filtering is blocked until these accounts have an owner: {ruleSuggestionState.unowned_accounts.join(', ')}. Assign owners in <Link to="/accounts" style={{ color: 'var(--accent2)', textDecoration: 'none' }}>Accounts</Link>, then return to filter this review.
        </div>
      ) : visibleSuggestions.length === 0 ? (
        <div ref={listTopRef} style={{ fontSize: 13, color: 'var(--muted)' }}>
          {emptyMessage}
        </div>
      ) : (
        <div ref={listTopRef} style={{ display: 'grid', gap: 12 }}>
          {(() => {
            // Bulk-select mode stays flat: every suggestion is its own selectable card, no grouping.
            if (bulkMode) return visibleSuggestions.map(suggestion => renderSuggestionCard(suggestion))

            // Otherwise group same-merchant (same keyword) suggestions into one bordered container so the
            // whole pattern reads together. In the pending/conflicts/older (all pending) views a conflict
            // subset still resolves as a unit (ConflictSetCard); other filters show individual status cards.
            // Groups keep first-seen order, which the keyword-aware sort already arranged by row count.
            const useConflictCards = reviewFilter === 'pending' || reviewFilter === 'conflicts' || reviewFilter === 'older'
            const groups = []
            const groupByKeyword = new Map()
            for (const suggestion of visibleSuggestions) {
              const key = suggestion.keyword || `__id:${suggestion.id}`
              let group = groupByKeyword.get(key)
              if (!group) {
                group = { key, members: [] }
                groupByKeyword.set(key, group)
                groups.push(group)
              }
              group.members.push(suggestion)
            }
            return groups.map(group => renderMerchantGroup(group, useConflictCards))
          })()}
        </div>
      )}

      <ConflictSetModal
        sections={conflictSetSections}
        onClose={() => setOpenConflictGroupId(null)}
        renderSuggestionCard={renderSuggestionCard}
      />

      <MatchingTransactionsModal
        state={matchViewerState}
        categories={categories}
        onKeepCategory={keepMatchingTransactionCategory}
        onSetRowCategory={setMatchRowCategory}
        onSetAllCategories={setAllMatchCategories}
        onCategoriesChanged={onCategoriesChanged}
        applyingAll={matchViewerState.applyingAll}
        onOpenMerchantReport={openMerchantReport}
        onClose={() => setMatchViewerState(prev => ({ ...prev, open: false }))}
      />

      {payeeDetail ? (
        // Stack the merchant spending report above the match modal (z 905). Detail panels live in the
        // 401+ band, so a high-z wrapper lifts the whole panel subtree over the modal. Rendered
        // non-floating (a centered modal) so it doesn't do the floating-panel measure-then-snap on
        // open. Edits reflect back into the match rows via reloadMatchViewer.
        <div style={{ position: 'fixed', inset: 0, zIndex: 960 }}>
          <TransactionDetail
            txn={payeeDetail}
            categories={categories}
            availableTags={tags}
            showPayeeActivity={false}
            onClose={() => setPayeeDetail(null)}
            onCategorized={() => reloadMatchViewer()}
            onTrashed={() => { reloadMatchViewer(); setPayeeDetail(null) }}
            onNotesSaved={() => reloadMatchViewer()}
            onTagsChanged={() => reloadMatchViewer()}
          />
        </div>
      ) : null}

      {resolvedEditingSuggestion ? (
        <RuleEditorModal
          suggestion={resolvedEditingSuggestion}
          categories={categories}
          owners={owners}
          accounts={accounts}
          onCategoriesChanged={onCategoriesChanged}
          onAccept={async data => {
            persistSuggestionDraft(resolvedEditingSuggestion, data)
            const nextCategory = data.category_id
              ? latestCategoriesRef.current.find(category => String(category.id) === String(data.category_id))
              : null
            await onSaveSuggestion({
              ...resolvedEditingSuggestion,
              keyword: data.keyword,
              target_category_id: data.category_id || null,
              target_category_name: nextCategory?.name || null,
              amount_min: data.amount_min,
              amount_max: data.amount_max,
              clean_name_suggestion: data.clean_name || null,
              owner_id: data.owner_id || null,
              account_id: data.account_id || null,
            }, data)
          }}
          onSaveAccepted={async data => {
            persistSuggestionDraft(resolvedEditingSuggestion, data)
            const nextCategory = data.category_id
              ? latestCategoriesRef.current.find(category => String(category.id) === String(data.category_id))
              : null
            await onSaveAcceptedSuggestion({
              ...resolvedEditingSuggestion,
              keyword: data.keyword,
              target_category_id: data.category_id || null,
              target_category_name: nextCategory?.name || null,
              amount_min: data.amount_min,
              amount_max: data.amount_max,
              clean_name_suggestion: data.clean_name || null,
              owner_id: data.owner_id || null,
              account_id: data.account_id || null,
            }, data)
          }}
          onCloseWithDraft={data => {
            persistSuggestionDraft(resolvedEditingSuggestion, data)
            onCancelEdit()
          }}
          onDiscard={onCancelEdit}
          // A conflict member is edited from the ConflictSetCard's "Edit rule"; the editor must only stash
          // the draft (which feeds the card's Apply), never accept and bypass the set's other dispositions.
          // The conflict card renders in both the pending and conflicts filters, so draft-only covers both.
          // Single suggestions (no conflict group) keep the normal accept-on-save editor.
          draftOnly={Boolean(resolvedEditingSuggestion?.conflict_group_id) && (reviewFilter === 'pending' || reviewFilter === 'conflicts')}
        />
      ) : null}

      {bulkMenu ? (
        <div
          onMouseDown={event => event.stopPropagation()}
          onClick={event => event.stopPropagation()}
          onContextMenu={event => event.preventDefault()}
          style={getMenuPanelStyle(bulkMenu)}
        >
          <button
            type="button"
            onClick={() => selectAllScoped(bulkMenu.scopeIds)}
            style={getMenuButtonStyle()}
          >
            Select All
          </button>
          <button
            type="button"
            onClick={() => clearScopedSelection(bulkMenu.scopeIds)}
            style={getMenuButtonStyle()}
          >
            Clear All
          </button>
          <div style={{ height: 1, background: 'var(--border)' }} />
          {bulkActions.map(action => (
            <button
              key={action.key}
              type="button"
              disabled={selectedSuggestionIds.length === 0}
              onClick={() => runBulkAction(action)}
              style={getMenuButtonStyle(selectedSuggestionIds.length === 0)}
            >
              {action.label}
            </button>
          ))}
        </div>
      ) : null}

      {sortMenu ? (
        <div
          onMouseDown={event => event.stopPropagation()}
          onClick={event => event.stopPropagation()}
          onContextMenu={event => event.preventDefault()}
          style={getMenuPanelStyle(sortMenu)}
        >
          <button
            type="button"
            onClick={() => handleSortChange('alpha')}
            style={getSortMenuItemStyle(sortOrder === 'alpha')}
          >
            <span>A-Z</span>
            {sortOrder === 'alpha' ? <span style={{ fontSize: 11 }}>✓</span> : null}
          </button>
          <button
            type="button"
            onClick={() => handleSortChange('row_count')}
            style={getSortMenuItemStyle(sortOrder === 'row_count')}
          >
            <span># rows</span>
            {sortOrder === 'row_count' ? <span style={{ fontSize: 11 }}>✓</span> : null}
          </button>
        </div>
      ) : null}

      {lookbackMenu ? (
        <div
          onMouseDown={event => event.stopPropagation()}
          onClick={event => event.stopPropagation()}
          onContextMenu={event => event.preventDefault()}
          style={getMenuPanelStyle(lookbackMenu)}
        >
          {IMPORT_RULE_LOOKBACK_CHOICES.map(years => (
            <button
              key={years}
              type="button"
              onClick={() => handleLookbackChange(years)}
              style={getSortMenuItemStyle(lookbackYears === years)}
            >
              <span>{lookbackLabel(years)}</span>
              {lookbackYears === years ? <span style={{ fontSize: 11 }}>✓</span> : null}
            </button>
          ))}
        </div>
      ) : null}

      {suggestionMenu ? (
        <div
          onMouseDown={event => event.stopPropagation()}
          onClick={event => event.stopPropagation()}
          onContextMenu={event => event.preventDefault()}
          style={getMenuPanelStyle(suggestionMenu)}
        >
          {getSuggestionMenuActions(suggestionMenu.suggestion, suggestionMenu.resolvedSuggestion).map(action => (
            <button
              key={action.key}
              type="button"
              onClick={() => {
                setSuggestionMenu(null)
                action.onClick()
              }}
              style={getMenuButtonStyle()}
            >
              {action.label}
            </button>
          ))}
          {bulkAvailable ? (
            <>
              <div style={{ height: 1, background: 'var(--border)' }} />
              <button
                type="button"
                onClick={() => enterBulkMode(suggestionMenu.suggestion)}
                style={getMenuButtonStyle()}
              >
                Bulk Select
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
