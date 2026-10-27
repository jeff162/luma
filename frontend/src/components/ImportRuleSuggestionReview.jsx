// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * **This list is deliberately not windowed, and adding `WindowedRows` here is not a drop-in.** The
 * transaction lists and reports render through it (see `ui-patterns.md` → *Tables and lists*), so the
 * absence is a decision rather than an oversight: this is a grouped, heterogeneous card list whose items range
 * from ~80px to 1500px+, it scrolls with the *page* rather than owning a bounded viewport, it reads
 * its own rows back out of the DOM for scroll restoration, and its cards change height in place as
 * their primary interaction. The structural blocker is the second one — windowing presupposes a real
 * scroll viewport, so giving this page one is a prerequisite decision about its scroll model, not a
 * detail. `docs/scale-and-limits.md` -> "Render windowing: the one list left unwindowed" lists the
 * four obstacles and what to try first if this list gets slow.
 *
 * The page's mechanisms live beside it in `importRuleSuggestions/`: bulk selection, the
 * matching-transactions report and unsaved suggestion edits are hooks, and a suggestion is a
 * `SuggestionCard`. What stays here was considered for extraction and left in place, because moving it
 * adds wiring without making anything simpler:
 * - the sticky header and bulk-actions bar, which are layout markup that reads fine where it is
 * - `renderMerchantGroup`, `renderConflictSetCard` and `renderSettledConflictTable`, which are thin wrappers
 * - the merchant filter control, which is small, already built on `FilterChip`, and has no shared equivalent
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { localIsoDate } from '../lib/utils.js'
import { Spinner, Button, FilterChip, IconButton, LinkButton, SegmentedToggle, Select, getFormControlStyle } from './ui.jsx'
import { ActionMenu } from './ActionMenu.jsx'
import OwnerChip from './OwnerChip.jsx'
import { useUserPreferences } from '../lib/UserPreferencesContext.jsx'
import {
  IMPORT_RULE_LOOKBACK_CHOICES,
  IMPORT_RULE_LOOKBACK_PREF_KEY,
  IMPORT_RULE_SORT_PREF_KEY,
  IMPORT_RULE_SORT_STORAGE_KEY,
  findNearestScrollParent,
  getInWindowPendingSuggestionGroups,
  getRuleSuggestionMerchantGroupLabel,
  isRefinedPendingSuggestion,
  normalizeImportRuleLookback,
  normalizeImportRuleSortOrder,
  suggestionSelectionChanged,
} from '../lib/importRuleSuggestions.js'
import { ProgressPill, SuggestionActionButton } from './importRuleSuggestions/suggestionPresentational.jsx'
import { SettledConflictSetTable } from './importRuleSuggestions/SettledConflictSetTable.jsx'
import { RuleEditorModal } from './importRuleSuggestions/RuleEditorModal.jsx'
import { ConflictSetModal } from './importRuleSuggestions/ConflictSetModal.jsx'
import { MatchingTransactionsModal, MatchingTransactionsReport } from './importRuleSuggestions/MatchingTransactionsModal.jsx'
import { ConflictSetCard } from './importRuleSuggestions/ConflictSetCard.jsx'
import { suggestionBulkStorageScope, useSuggestionBulkSelection } from './importRuleSuggestions/useSuggestionBulkSelection.js'
import { useSuggestionMatchViewer } from './importRuleSuggestions/useSuggestionMatchViewer.js'
import { useSuggestionDrafts } from './importRuleSuggestions/useSuggestionDrafts.js'
import { SuggestionCard } from './importRuleSuggestions/SuggestionCard.jsx'
import { useStableOrder } from '../lib/useStableOrder.js'
import TransactionDetail from './TransactionDetail.jsx'
import { localStore } from '../lib/browserStorage.js'
import ContextualExplainer from '../help/ContextualExplainer.jsx'

const SORT_OPTIONS = [{ value: 'row_count', label: '# rows' }, { value: 'alpha', label: 'A–Z' }]

// A right-click menu opens where the pointer is, so its `ActionMenu` anchor is that point.
function pointerAnchor(event) {
  return { x: event.clientX, y: event.clientY }
}

const merchantGroupKey = group => group.key

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
  onRefineConflictMatch,
  applyingConflict,
  editingSuggestionId,
  categories,
  owners,
  accounts,
  tags = [],
  onTagCreated,
  onReloadTags,
  onCategoriesChanged,
  onReloadSuggestions,
  onClearReviewedSuggestions,
  onRestoreTrashSet,
}) {
  const rootRef = useRef(null)
  const { getPreference, hasPreference, setPreference } = useUserPreferences()
  const suggestions = useMemo(() => ruleSuggestionState?.suggestions || [], [ruleSuggestionState?.suggestions])
  const trashSets = ruleSuggestionState?.trash_sets || []
  const summary = ruleSuggestionState?.review_summary || {}
  const drafts = useSuggestionDrafts({ suggestions, categories, owners, accounts, onReloadTags })
  const getResolvedSuggestion = drafts.resolve
  const listTopRef = useRef(null)
  const stickyPanelRef = useRef(null)
  const pendingBulkAnchorRef = useRef(null)
  const [openConflictGroupId, setOpenConflictGroupId] = useState(null)
  const [bulkMenu, setBulkMenu] = useState(null)
  const [suggestionMenu, setSuggestionMenu] = useState(null)
  const [editingMatchMembers, setEditingMatchMembers] = useState(null)
  const [stickyTopOffset, setStickyTopOffset] = useState(0)
  const [merchantFilterText, setMerchantFilterText] = useState('')
  // The single source row backing the suggestion currently open in the rule editor, fetched so the
  // editor's "From the source file" panel can show it. Null unless the suggestion has exactly one row.
  const [editorExampleTxn, setEditorExampleTxn] = useState(null)
  const matchViewer = useSuggestionMatchViewer({ loadMatches: onLoadSuggestionMatches, onRowsChanged: onReloadSuggestions })
  const matchViewerState = matchViewer.state

  const merchantFilterSnapshotRef = useRef('')
  const merchantFilterInputRef = useRef(null)
  const merchantFilterButtonRef = useRef(null)
  const ownerFilterButtonRef = useRef(null)
  const migratedSortPreferenceRef = useRef(false)
  // Migrate the pre-preferences sort choice forward once so existing users keep
  // their review ordering after the setting moved into user preferences.
  const legacySortOrderRef = useRef(
    normalizeImportRuleSortOrder(localStore.get(IMPORT_RULE_SORT_STORAGE_KEY)) || 'row_count',
  )
  const availableOwners = owners
  const showOwnerFilter = availableOwners.length > 1
  // Conflicts render as ConflictSetCards resolved as a unit, so bulk-select (per-suggestion) is off there.
  const bulkAvailable = reviewFilter !== 'total' && reviewFilter !== 'conflicts' && reviewFilter !== 'trash'
  const sortOrder = normalizeImportRuleSortOrder(getPreference(IMPORT_RULE_SORT_PREF_KEY, null))
    || legacySortOrderRef.current
    || 'row_count'
  const normalizedMerchantFilter = merchantFilterText.trim().toLowerCase()

  // Look-back lens: split pending suggestions by recency. The pending/conflicts views show merchant
  // groups with any pending activity inside the chosen window (0 = all time); the `older` view shows the
  // complement. View filter only — never changes generation or stored state, and the substance threshold
  // stays full-history. Grouping keeps refined remainders beside the active decision that created them.
  const lookbackYears = normalizeImportRuleLookback(getPreference(IMPORT_RULE_LOOKBACK_PREF_KEY, 2))
  const lookbackCutoff = useMemo(() => {
    if (!lookbackYears) return null
    const cutoff = new Date()
    cutoff.setFullYear(cutoff.getFullYear() - lookbackYears)
    return localIsoDate(cutoff)
  }, [lookbackYears])
  const hasLens = lookbackCutoff != null
  const lensRelevant = reviewFilter === 'pending' || reviewFilter === 'conflicts' || reviewFilter === 'older'
  const inWindowPendingSuggestionGroups = useMemo(
    () => getInWindowPendingSuggestionGroups(suggestions, lookbackCutoff),
    [suggestions, lookbackCutoff],
  )
  // Pure recency test (no review-status / view logic). Undatable rows count as in-window — we can't call
  // them stale. With no window, everything is in-window. Pending suggestions inherit the group result so
  // a newly split older remainder does not vanish from the active merchant cluster.
  const inLookbackWindow = useCallback(suggestion => {
    if (!hasLens) return true
    if (suggestion.review_status === 'pending') {
      return inWindowPendingSuggestionGroups.has(suggestion.review_group_id)
    }
    if (!suggestion.latest_txn_date) return true
    return suggestion.latest_txn_date >= lookbackCutoff
  }, [hasLens, lookbackCutoff, inWindowPendingSuggestionGroups])
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
    if (filterKey === 'trash') return false
    return suggestion.review_status === 'pending'
  }

  const sortSuggestionsForDisplay = useCallback(list => {
    const next = [...list]
    if (sortOrder === 'row_count') {
      // Group by displayed merchant identity so refinements that change the keyword (selection
      // criteria) stay beside the broader suggestion they came from.
      const grouped = new Map()
      for (const suggestion of next) {
        const groupKey = suggestion.review_group_id
        const entry = grouped.get(groupKey) || {
          suggestions: [],
          totalRows: 0,
          merchantLabel: getRuleSuggestionMerchantGroupLabel(suggestion),
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
  // Merchant groups of the visible suggestions, keyed by the backend's `review_group_id`.
  const merchantGroups = useMemo(() => {
    const groups = []
    const groupByMerchant = new Map()
    for (const suggestion of visibleSuggestions) {
      const key = suggestion.review_group_id
      let group = groupByMerchant.get(key)
      if (!group) {
        group = { key, members: [] }
        groupByMerchant.set(key, group)
        groups.push(group)
      }
      group.members.push(suggestion)
    }
    return groups
  }, [visibleSuggestions])
  const compareMerchantGroups = useCallback((a, b) => {
    if (sortOrder === 'row_count') {
      const aRows = a.members.reduce((sum, member) => sum + (member.txn_count || 0), 0)
      const bRows = b.members.reduce((sum, member) => sum + (member.txn_count || 0), 0)
      if (aRows !== bRows) return bRows - aRows
    }
    const aLabel = getRuleSuggestionMerchantGroupLabel(a.members[0])
    const bLabel = getRuleSuggestionMerchantGroupLabel(b.members[0])
    return String(aLabel).localeCompare(String(bLabel), undefined, { sensitivity: 'base' })
  }, [sortOrder])
  // Group order comes from the visible row counts, then holds while the same merchant set is on screen so
  // resolving one card doesn't shove its siblings away. A change to that set re-sorts.
  const orderedMerchantGroups = useStableOrder(merchantGroups, {
    getId: merchantGroupKey,
    compare: compareMerchantGroups,
    resetKey: [
      sortOrder,
      reviewFilter,
      normalizedMerchantFilter,
      selectedOwnerIds.map(String).slice().sort().join(','),
      lookbackYears,
      merchantGroups.map(merchantGroupKey).slice().sort().join('\n'),
    ].join('|'),
  })
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
  const bulk = useSuggestionBulkSelection({
    visibleSuggestions,
    conflictGroupMembers: visibleConflictGroupMembers,
    available: bulkAvailable,
    storageScope: suggestionBulkStorageScope(persistKey, selectedOwnerIds, reviewFilter),
  })
  const bulkMode = bulk.active
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
    trash: 'No cleared rule suggestion sets.',
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

  // Bulk-mode scroll anchoring:
  // - Grouped conflict cards and flat bulk cards share a suggestion id as their stable identity.
  // - Skip clipped cards and capture the first whole card visible below the sticky controls.
  // - After React rebuilds the list, put that same rule in the first slot below the resized controls.
  useLayoutEffect(() => {
    const anchorId = pendingBulkAnchorRef.current
    if (anchorId == null) return
    pendingBulkAnchorRef.current = null

    const root = rootRef.current
    const stickyPanel = stickyPanelRef.current
    if (!root || !stickyPanel) return
    const scrollParent = findNearestScrollParent(root)
    if (!scrollParent) return

    const anchor = Array.from(
      listTopRef.current?.querySelectorAll('[data-rule-suggestion-id]') || [],
    ).find(element => element.dataset.ruleSuggestionId === anchorId)
    if (!anchor) return

    const rootStyle = window.getComputedStyle(root)
    const rowGap = Number.parseFloat(rootStyle.rowGap || rootStyle.gap || '0') || 0
    const desiredTop = stickyPanel.getBoundingClientRect().bottom + rowGap
    const delta = anchor.getBoundingClientRect().top - desiredTop
    if (Math.abs(delta) > 0.5) scrollParent.scrollTop += delta
  }, [bulkMode])

  useEffect(() => {
    if (!bulkMode) setBulkMenu(null)
  }, [bulkMode])

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
    localStore.set(IMPORT_RULE_SORT_STORAGE_KEY, sortOrder)
  }, [sortOrder])

  function handleSortOrderChange(nextSortOrder) {
    const normalized = normalizeImportRuleSortOrder(nextSortOrder)
    if (!normalized) return
    setPreference(IMPORT_RULE_SORT_PREF_KEY, normalized).catch(() => { })
  }

  function handleLookbackChange(nextYears) {
    setPreference(IMPORT_RULE_LOOKBACK_PREF_KEY, normalizeImportRuleLookback(nextYears)).catch(() => { })
  }

  function lookbackLabel(years) {
    if (!years) return 'All time'
    return `${years} year${years === 1 ? '' : 's'}`
  }

  function getSuggestionKey(suggestionId) {
    return String(suggestionId)
  }

  function toggleBulkMode() {
    const root = rootRef.current
    const stickyPanel = stickyPanelRef.current
    const list = listTopRef.current
    const scrollParent = root ? findNearestScrollParent(root) : null
    if (stickyPanel && list && scrollParent && scrollParent.scrollTop > 1) {
      const visibleTop = Math.max(
        stickyPanel.getBoundingClientRect().bottom,
        scrollParent.getBoundingClientRect().top,
      )
      const visibleBottom = scrollParent.getBoundingClientRect().bottom
      const cards = Array.from(list.querySelectorAll('[data-rule-suggestion-card]'))
      const fullyVisibleAnchor = cards.find(element => {
        const rect = element.getBoundingClientRect()
        return rect.top >= visibleTop - 1 && rect.bottom <= visibleBottom + 1
      })
      const anchor = fullyVisibleAnchor || cards.find(element => {
        const rect = element.getBoundingClientRect()
        return rect.top >= visibleTop - 1 && rect.top < visibleBottom
      })
      pendingBulkAnchorRef.current = anchor?.dataset.ruleSuggestionId ?? null
    } else {
      pendingBulkAnchorRef.current = null
    }

    if (bulkMode) bulk.exit()
    else bulk.enter()
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
    .filter(suggestion => bulk.isSelected(suggestion.id))
    .map(getResolvedSuggestion)
  const selectedCount = selectedResolvedSuggestions.length

  async function runBulkAction(action) {
    if (!selectedResolvedSuggestions.length) return
    await action.run(selectedResolvedSuggestions)
    bulk.exit()
    setSuggestionMenu(null)
  }

  function enterBulkMode(initialSuggestion) {
    setSuggestionMenu(null)
    bulk.enter(initialSuggestion)
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

  // What a card's report covers: exactly the rows the card represents (a conflict card its whole group,
  // the union of its members' source rows; a single card its own), so the report agrees with the card's
  // row count instead of listing every same-keyword row, including rows other suggestions own.
  function matchTargetFor(suggestion) {
    const resolvedSuggestion = getResolvedSuggestion(suggestion)
    const referenceSuggestion = getConflictReferenceSuggestion(suggestion)
    const rowIds = suggestion.conflict_group_id
      ? [...new Set(
          (visibleConflictGroupMembers.get(suggestion.conflict_group_id) || [])
            .map(id => suggestions.find(item => item.id === id))
            .filter(Boolean)
            .flatMap(member => member.source_row_ids || [])
            .map(String),
        )]
      : (resolvedSuggestion.source_row_ids || []).map(String)
    return {
      merchantLabel: resolvedSuggestion.merchant_label,
      ownerName: resolvedSuggestion.owner_name,
      accountName: resolvedSuggestion.account_name,
      query: {
        keyword: resolvedSuggestion.keyword,
        reference_target_category_id: referenceSuggestion.target_category_id || null,
        owner_id: resolvedSuggestion.owner_id || null,
        account_id: resolvedSuggestion.account_id || null,
        amount_min: resolvedSuggestion.amount_min,
        amount_max: resolvedSuggestion.amount_max,
        match_source_text: !!resolvedSuggestion.match_source_text,
        row_ids: rowIds.length ? rowIds : undefined,
      },
    }
  }

  function openMatchingTransactionsViewer(suggestion) {
    matchViewer.open(matchTargetFor(suggestion))
  }

  function toggleMatchingTransactionsReference(suggestion) {
    if (matchViewerState.open && matchViewerState.referenceMode) matchViewer.closeReference()
    else matchViewer.open(matchTargetFor(suggestion), { referenceMode: true })
  }

  // The suggestion as the rule editor's form left it, which is what saving it sends.
  function suggestionFromEditor(suggestion, data) {
    return {
      ...suggestion,
      keyword: data.keyword,
      target_category_id: data.category_id || null,
      target_category_name: drafts.categoryById(data.category_id)?.name || null,
      amount_min: data.amount_min,
      amount_max: data.amount_max,
      clean_name_suggestion: data.clean_name || null,
      tag_ids: data.tag_ids || [],
      owner_id: data.owner_id || null,
      account_id: data.account_id || null,
    }
  }

  function buildMatchRefinePayload(members, data) {
    return {
      source_suggestions: members.map(member => ({
        id: member.id,
        merchant_label: member.merchant_label,
        target_category_id: member.target_category_id || null,
        target_category_name: member.target_category_name || null,
        target_category_group_name: member.target_category_group_name || null,
        owner_id: member.owner_id || null,
        owner_name: member.owner_name || null,
        account_id: member.account_id || null,
        account_name: member.account_name || null,
        clean_name_suggestion: member.clean_name_suggestion || null,
        imported_categories: member.imported_categories || [],
        source_row_ids: member.source_row_ids || [],
      })),
      keyword: data.keyword,
      owner_id: data.owner_id || null,
      account_id: data.account_id || null,
      amount_min: data.amount_min,
      amount_max: data.amount_max,
      match_source_text: !!data.match_source_text,
    }
  }

  const editingSuggestion = editingSuggestionId
    ? suggestions.find(suggestion => getSuggestionKey(suggestion.id) === getSuggestionKey(editingSuggestionId))
    : null
  const resolvedEditingSuggestion = editingSuggestion ? getResolvedSuggestion(editingSuggestion) : null
  const resolvedEditingMatchMembers = (editingMatchMembers || []).map(getResolvedSuggestion)
  const editingMatchReferenceSuggestion = resolvedEditingMatchMembers.length
    ? getConflictReferenceSuggestion(resolvedEditingMatchMembers[0])
    : null
  const editingMatchRowCount = resolvedEditingMatchMembers.length
    ? new Set(resolvedEditingMatchMembers.flatMap(member => member.source_row_ids || []).map(String)).size
    : 0
  const editorReferenceOpen = Boolean(resolvedEditingSuggestion || editingMatchReferenceSuggestion)

  const closeMatchReference = matchViewer.closeReference
  useEffect(() => {
    if (!editorReferenceOpen) closeMatchReference()
  }, [editorReferenceOpen, closeMatchReference])

  // When the rule editor opens for a suggestion backed by exactly one source row, fetch that row so the
  // editor's "From the source file" panel can show its captured text. Multi-row suggestions skip this —
  // their per-row source text is seen through the matching-transactions report's hover. Keyed on the
  // suggestion id (the example is fixed by source_row_ids, so unsaved field edits don't refetch).
  useEffect(() => {
    if (!resolvedEditingSuggestion) { setEditorExampleTxn(null); return undefined }
    const rowIds = (resolvedEditingSuggestion.source_row_ids || []).map(String)
    const singleRow = rowIds.length === 1 || resolvedEditingSuggestion.txn_count === 1
    if (!singleRow) { setEditorExampleTxn(null); return undefined }
    let cancelled = false
    setEditorExampleTxn(null)
    ;(async () => {
      try {
        const result = await onLoadSuggestionMatches({
          keyword: resolvedEditingSuggestion.keyword,
          owner_id: resolvedEditingSuggestion.owner_id || null,
          account_id: resolvedEditingSuggestion.account_id || null,
          amount_min: resolvedEditingSuggestion.amount_min,
          amount_max: resolvedEditingSuggestion.amount_max,
          match_source_text: !!resolvedEditingSuggestion.match_source_text,
          row_ids: rowIds.length ? rowIds : undefined,
        })
        if (!cancelled) setEditorExampleTxn((result?.transactions || [])[0] || null)
      } catch {
        if (!cancelled) setEditorExampleTxn(null)
      }
    })()
    return () => { cancelled = true }
    // Keyed on which suggestion is open, deliberately not on its contents: the example is what the
    // suggestion matched when the editor opened, and refetching it as the user edits the criteria would
    // replace the reference they are editing against.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingSuggestionId])

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
    // Named for the action that fills it (Clear discarded / accepted / deferred) rather than "trash",
    // which no button on this page says. The label carries the *unit* too: unlike every other pill —
    // which counts suggestions — this one counts whole cleared sets, so a bare number beside them read
    // as suggestions. The `trash` key stays: it's the persisted filter value.
    {
      key: 'trash',
      label: (trashSets.length || summary.trash_set_count || 0) === 1 ? 'cleared set' : 'cleared sets',
      value: trashSets.length || summary.trash_set_count || 0,
      tone: 'trash',
    },
  ]

  // A title + one-line description for whichever filter is active, so it's always clear what the list
  // below is showing. Shown on the controls row beneath the pills — and, since that only appears once a
  // filter is *already* active, also used as each pill's hover text so a pill explains itself before
  // you commit to clicking it. Each description says where the contents come from.
  const viewHeaders = {
    total: { title: 'All suggestions', description: 'Every proposed rule, in any state.' },
    pending: { title: 'Pending', description: 'Proposed rules awaiting a decision.' },
    conflicts: { title: 'Conflicts', description: 'One merchant filed under several categories — resolve each set.' },
    older: { title: 'Older', description: `Pending with no activity in the last ${lookbackLabel(lookbackYears).toLowerCase()} — settle in bulk or widen the window.` },
    accepted: { title: 'Accepted', description: 'Suggestions you turned into rules.' },
    deferred: { title: 'Deferred', description: 'Suggestions set aside for later.' },
    discarded: { title: 'Discarded', description: 'Suggestions you dismissed.' },
    trash: {
      title: 'Cleared sets',
      description: 'Settled suggestions you removed from the review with Clear — one set per Clear, restorable whole.',
    },
  }
  const activeViewHeader = viewHeaders[reviewFilter] || viewHeaders.pending

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
        onClick: () => drafts.tags.begin(suggestion),
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
    }

    actions.push({
      key: 'editor',
      label: isRefinedPendingSuggestion(resolvedSuggestion)
        ? 'Selection criteria'
        : 'Rule Editor',
      onClick: () => onEditSuggestion(suggestion.id),
    })

    actions.push(
      suggestion.review_status === 'skipped'
        ? { key: 'resume', label: 'Resume', onClick: () => onSetSuggestionStatus(suggestion, 'pending') }
        : { key: 'defer', label: 'Defer', onClick: () => onSetSuggestionStatus(suggestion, 'skipped') },
    )

    return actions
  }

  // Invariant: a card's own row buttons ALWAYS act on just that card, even while it is part of a bulk
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

  function handleSortChange(nextSortOrder) {
    handleSortOrderChange(nextSortOrder)
    requestAnimationFrame(() => {
      listTopRef.current?.scrollIntoView({ block: 'start', behavior: 'auto' })
    })
  }

  function renderSortControl() {
    if (reviewFilter === 'trash') return null
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--muted)' }}>
        Sort order
        <SegmentedToggle
          size="compact"
          ariaLabel="Sort order"
          value={sortOrder}
          onChange={handleSortChange}
          options={SORT_OPTIONS}
          disabled={bulkMode}
        />
      </span>
    )
  }

  // Only meaningful where the lens runs (pending / conflicts / older); hidden elsewhere so it doesn't
  // imply an effect it isn't having on the accepted/discarded/total views.
  function renderLookbackControl() {
    if (!lensRelevant) return null
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--muted)' }}>
        Look back
        <Select
          aria-label="Look back"
          value={String(lookbackYears)}
          onChange={value => handleLookbackChange(Number(value))}
          options={IMPORT_RULE_LOOKBACK_CHOICES.map(years => ({ value: String(years), label: lookbackLabel(years) }))}
          style={getFormControlStyle({ size: 'sm', clickable: true })}
        />
      </span>
    )
  }

  function getClearStatusForView() {
    if (reviewFilter === 'accepted') return 'accepted'
    if (reviewFilter === 'deferred') return 'skipped'
    if (reviewFilter === 'discarded') return 'discarded'
    return null
  }

  function getReviewStatusLabel(status) {
    if (status === 'accepted') return 'accepted'
    if (status === 'skipped') return 'deferred'
    if (status === 'discarded') return 'discarded'
    return 'reviewed'
  }

  function renderClearReviewedControl() {
    const status = getClearStatusForView()
    if (
      !status
      || bulkMode
      || visibleSuggestions.length === 0
      || !onClearReviewedSuggestions
    ) return null
    const label = getReviewStatusLabel(status)
    const visibleIds = visibleSuggestions.map(suggestion => suggestion.id)
    return (
      <Button size="compact" variant="quiet" onClick={() => onClearReviewedSuggestions(status, visibleIds)}>
        Clear {label}
      </Button>
    )
  }

  function renderTrashSets() {
    if (!trashSets.length) {
      return (
        <div ref={listTopRef} style={{ fontSize: 13, color: 'var(--muted)' }}>
          {emptyMessage}
        </div>
      )
    }
    return (
      <div ref={listTopRef} style={{ display: 'grid', gap: 12 }}>
        {trashSets.map(item => {
          const label = getReviewStatusLabel(item.status)
          const clearedAt = item.cleared_at
            ? item.cleared_at.slice(0, 16).replace('T', ' ')
            : 'unknown time'
          return (
            <div
              key={item.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 14,
                flexWrap: 'wrap',
                padding: '12px 14px',
                border: '1px solid var(--border)',
                borderRadius: 14,
                background: 'color-mix(in srgb, var(--surface2) 70%, var(--surface))',
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>
                  Cleared {item.count || 0} {label} suggestion{item.count === 1 ? '' : 's'}
                </div>
                <div style={{ marginTop: 3, fontSize: 12, color: 'var(--muted)' }}>
                  {clearedAt}
                </div>
              </div>
              <SuggestionActionButton
                onClick={() => onRestoreTrashSet?.(item.id)}
                disabled={!onRestoreTrashSet}
              >
                Restore
              </SuggestionActionButton>
            </div>
          )
        })}
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
            name="rule-suggestions-merchant-filter"
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
            aria-label="Filter rule suggestions by merchant name"
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
      <FilterChip
        variant="add"
        ref={merchantFilterButtonRef}
        onClick={() => {
          merchantFilterSnapshotRef.current = merchantFilterText
          onMerchantFilterOpenChange(true)
        }}
        disabled={bulkMode}
      >
        +Merchant filter
      </FilterChip>
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
            {availableOwners.map(owner => (
              <OwnerChip
                key={owner.id}
                owner={owner}
                selected={selectedOwnerIds.includes(owner.id)}
                disabled={bulkMode}
                onClick={() => {
                  onToggleOwner(owner.id)
                  onOwnerFilterOpenChange(false)
                  setTimeout(() => ownerFilterButtonRef.current?.focus(), 0)
                }}
              />
            ))}
          </div>
          <IconButton
            size="compact"
            aria-label="Close owner filter"
            disabled={bulkMode}
            onClick={() => {
              selectedOwnerIds.forEach(ownerId => onToggleOwner(ownerId))
              onOwnerFilterOpenChange(false)
              setTimeout(() => ownerFilterButtonRef.current?.focus(), 0)
            }}
            style={{ position: 'absolute', top: -6, right: -6 }}
          >
            ×
          </IconButton>
        </div>
      )
    }

    return (
      <FilterChip
        variant="add"
        ref={ownerFilterButtonRef}
        onClick={() => onOwnerFilterOpenChange(true)}
        disabled={bulkMode}
      >
        {selectedOwnerIds.length === 1
          ? (availableOwners.find(owner => owner.id === selectedOwnerIds[0])?.name || '+Owner filter')
          : '+Owner filter'}
      </FilterChip>
    )
  }

  function handleCardContextMenu(event, suggestion, resolvedSuggestion) {
    event.preventDefault()
    if (bulkMode && bulkAvailable) {
      event.stopPropagation()
      setSuggestionMenu(null)
      setBulkMenu({ anchorPoint: pointerAnchor(event), scopeIds: bulk.scopedIdsFor(suggestion) })
      return
    }
    setBulkMenu(null)
    setSuggestionMenu({ anchorPoint: pointerAnchor(event), suggestion, resolvedSuggestion })
  }

  const cardCatalog = { categories, tags, onCategoriesChanged, onTagCreated }
  const cardHandlers = {
    editingSuggestionId,
    onEditSuggestion,
    runRowStatusAction,
    runRowSaveAction,
    onRejectSuggestionDisposition,
    onOpenReport: openMatchingTransactionsViewer,
    onOpenConflictSet: setOpenConflictGroupId,
    onContextMenu: handleCardContextMenu,
  }

  // The conflict modal renders its sections through this too, passing each section's own view and
  // conflict context so its cards match the main list.
  function renderSuggestionCard(
    suggestion,
    {
      filterKey = reviewFilter,
      conflictFollowerIds: followerIds = conflictFollowerIds,
      conflictLeadIds: leadIds = conflictLeadIds,
      allowConflictOpen = true,
    } = {},
  ) {
    const isConflictLead = leadIds.has(suggestion.id)
    const conflictGroupSize = suggestion.conflict_group_id
      ? (visibleConflictGroupMembers.get(suggestion.conflict_group_id) || []).length
      : 0
    return (
      <SuggestionCard
        key={suggestion.id}
        suggestion={suggestion}
        view={{
          filterKey,
          isConflictFollower: filterKey === 'pending' && followerIds.has(suggestion.id),
          isConflictLead,
          leadHasVisibleChildren: bulkMode && filterKey === 'pending' && isConflictLead && conflictGroupSize > 1,
          allowConflictOpen,
          isOlder: suggestion.review_status === 'pending' && hasLens && !inLookbackWindow(suggestion),
        }}
        selection={bulk}
        drafts={drafts}
        catalog={cardCatalog}
        handlers={cardHandlers}
      />
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
        onEditMatch={membersToEdit => setEditingMatchMembers(membersToEdit)}
        onEditRule={memberId => onEditSuggestion(memberId)}
        categories={categories}
        onSetMemberCategory={drafts.setCategory}
        onCategoryCreated={async () => drafts.noteCategories(await onCategoriesChanged?.())}
      />
    )
  }

  // The settled-view (accepted / deferred / discarded / total) counterpart to renderConflictSetCard: a
  // conflict set whose members have all been dispositioned tabulates read-only instead of stacking N
  // full cards. Members are pulled from the whole visible set by conflict_group_id (same as the card
  // path) so the table is complete regardless of flat order.
  function renderSettledConflictTable(suggestion) {
    const members = (visibleConflictGroupMembers.get(suggestion.conflict_group_id) || [])
      .map(id => visibleSuggestions.find(item => item.id === id))
      .filter(Boolean)
    return (
      <SettledConflictSetTable
        key={`settled-conflict:${suggestion.conflict_group_id}`}
        members={members}
        showStatusColumn={reviewFilter === 'total'}
        bulkMode={bulkMode && bulkAvailable}
        selectedSuggestionIds={bulk.selectedIds}
        getSuggestionKey={getSuggestionKey}
        onToggleSelection={bulk.toggle}
        getResolvedSuggestion={getResolvedSuggestion}
        tags={tags}
        editingSuggestionId={editingSuggestionId}
        onOpenReport={() => openMatchingTransactionsViewer(suggestion)}
        onEditSuggestion={onEditSuggestion}
        runRowStatusAction={runRowStatusAction}
        runRowSaveAction={runRowSaveAction}
        onRejectSuggestionDisposition={onRejectSuggestionDisposition}
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
    // In the settled views, collapse a conflict set into one read-only table — but only when ≥2 of its
    // members are visible here; a lone settled member tabulates to nothing useful, so it stays a card.
    const settledConflictCounts = new Map()
    if (!useConflictCards) {
      for (const suggestion of group.members) {
        if (suggestion.conflict_group_id) {
          settledConflictCounts.set(suggestion.conflict_group_id, (settledConflictCounts.get(suggestion.conflict_group_id) || 0) + 1)
        }
      }
    }
    for (const suggestion of group.members) {
      if (useConflictCards && suggestion.conflict_group_id) {
        if (seenConflict.has(suggestion.conflict_group_id)) continue
        seenConflict.add(suggestion.conflict_group_id)
        items.push({ key: `conflict:${suggestion.conflict_group_id}`, node: renderConflictSetCard(suggestion) })
      } else if (!useConflictCards && suggestion.conflict_group_id && (settledConflictCounts.get(suggestion.conflict_group_id) || 0) >= 2) {
        if (seenConflict.has(suggestion.conflict_group_id)) continue
        seenConflict.add(suggestion.conflict_group_id)
        items.push({ key: `settled-conflict:${suggestion.conflict_group_id}`, node: renderSettledConflictTable(suggestion) })
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

  const matchingRowsReferencePanel = matchViewerState.open && matchViewerState.referenceMode ? (
    <MatchingTransactionsReport
      state={matchViewerState}
      categories={categories}
      onKeepCategory={matchViewer.keepRowCategory}
      onSetRowCategory={matchViewer.setRowCategory}
      onSetAllCategories={matchViewer.setAllCategories}
      onCategoriesChanged={onCategoriesChanged}
      applyingAll={matchViewerState.applyingAll}
      onOpenMerchantReport={matchViewer.openMerchantReport}
      onClose={matchViewer.closeReference}
      embedded
      readOnly
      allowPinnedOrigin
    />
  ) : null
  const editingSuggestionUsesSelectionEditor = Boolean(
    isRefinedPendingSuggestion(resolvedEditingSuggestion)
    && !resolvedEditingSuggestion.conflict_group_id
  )
  const shouldRefinePendingFullSuggestion = data => Boolean(
    resolvedEditingSuggestion?.review_status === 'pending'
    && !resolvedEditingSuggestion.conflict_group_id
    && !editingSuggestionUsesSelectionEditor
    && suggestionSelectionChanged(resolvedEditingSuggestion, data)
  )

  return (
    <div
      ref={rootRef}
      onContextMenu={event => {
        if (!bulkMode || !bulkAvailable) return
        event.preventDefault()
        setBulkMenu({ anchorPoint: pointerAnchor(event), scopeIds: null })
      }}
      style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 12, minWidth: 0 }}
    >
      <div
        ref={stickyPanelRef}
        onContextMenu={event => {
          if (!bulkMode || !bulkAvailable) return
          event.preventDefault()
          setBulkMenu({ anchorPoint: pointerAnchor(event), scopeIds: null })
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
          <div style={{ display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr) auto', alignItems: 'center', gap: 10, minHeight: 42, width: '100%', minWidth: 0 }}>
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
            <div style={{ justifySelf: 'end' }}>
              {renderClearReviewedControl()}
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
                title={viewHeaders[pill.key]?.description}
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
              setBulkMenu({ anchorPoint: pointerAnchor(event), scopeIds: null })
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
                  onClick={toggleBulkMode}
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
                <LinkButton onClick={() => bulk.selectAll()} style={{ fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap' }}>
                  Select all
                </LinkButton>
                <LinkButton onClick={() => bulk.clear()} disabled={selectedCount === 0} style={{ fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap' }}>
                  Clear
                </LinkButton>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                {bulkActions.map(action => (
                  <Button
                    key={action.key}
                    variant={action.tone === 'primary' ? 'primary' : 'secondary'}
                    onClick={() => runBulkAction(action)}
                    disabled={selectedCount === 0}
                  >
                    {action.label}
                  </Button>
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
      ) : reviewFilter === 'trash' ? (
        renderTrashSets()
      ) : visibleSuggestions.length === 0 ? (
        <div ref={listTopRef} style={{ fontSize: 13, color: 'var(--muted)' }}>
          {emptyMessage}
        </div>
      ) : (
        <div ref={listTopRef} style={{ display: 'grid', gap: 12 }}>
          {(() => {
            // Bulk-select mode stays flat: every suggestion is its own selectable card, no grouping.
            if (bulkMode) return visibleSuggestions.map(suggestion => renderSuggestionCard(suggestion))

            // Otherwise group same-merchant suggestions into one bordered container so the whole pattern
            // reads together. The group identity is the backend's `review_group_id` — the displayed
            // merchant, not the exact keyword: a refined selection such as "merchant contains X renewal"
            // is still part of merchant X's neighborhood. In pending/conflicts/older views, a conflict
            // subset still resolves as a unit (ConflictSetCard); other filters show individual status cards.
            const useConflictCards = reviewFilter === 'pending' || reviewFilter === 'conflicts' || reviewFilter === 'older'
            return orderedMerchantGroups.map(group => renderMerchantGroup(group, useConflictCards))
          })()}
        </div>
      )}

      <ConflictSetModal
        sections={conflictSetSections}
        onClose={() => setOpenConflictGroupId(null)}
        renderSuggestionCard={renderSuggestionCard}
      />

      {!matchViewerState.referenceMode ? (
        <MatchingTransactionsModal
          state={matchViewerState}
          categories={categories}
          onKeepCategory={matchViewer.keepRowCategory}
          onSetRowCategory={matchViewer.setRowCategory}
          onSetAllCategories={matchViewer.setAllCategories}
          onCategoriesChanged={onCategoriesChanged}
          applyingAll={matchViewerState.applyingAll}
          onOpenMerchantReport={matchViewer.openMerchantReport}
          onClose={matchViewer.close}
        />
      ) : null}

      {matchViewer.merchantReport ? (
        // Stack the merchant spending report above the match modal (z 905). Detail panels live in the
        // 401+ band, so a high-z wrapper lifts the whole panel subtree over the modal. Rendered
        // non-floating (a centered modal) so it doesn't do the floating-panel measure-then-snap on
        // open. Edits reflect back into the match rows via the viewer's reload.
        <div style={{ position: 'fixed', inset: 0, zIndex: 960 }}>
          <TransactionDetail
            txn={matchViewer.merchantReport}
            categories={categories}
            availableTags={tags}
            showPayeeActivity={false}
            onClose={matchViewer.closeMerchantReport}
            // Any edit invalidates the matcher preview; a trash also closes the panel.
            onReconcile={(txnId, patch) => { matchViewer.reload(); if (patch === null) matchViewer.closeMerchantReport() }}
          />
        </div>
      ) : null}

      {resolvedEditingSuggestion ? (
        <RuleEditorModal
          suggestion={resolvedEditingSuggestion}
          categories={categories}
          owners={owners}
          accounts={accounts}
          exampleTransaction={editorExampleTxn}
          onCategoriesChanged={onCategoriesChanged}
          onTagCreated={onTagCreated}
          matchCount={resolvedEditingSuggestion.txn_count || (resolvedEditingSuggestion.source_row_ids || []).length}
          matchingRowsOpen={Boolean(matchingRowsReferencePanel)}
          matchingRowsPanel={matchingRowsReferencePanel}
          onOpenMatchingTransactions={() => toggleMatchingTransactionsReference(resolvedEditingSuggestion)}
          onAccept={async data => {
            if (editingSuggestionUsesSelectionEditor || shouldRefinePendingFullSuggestion(data)) {
              await onRefineConflictMatch?.(buildMatchRefinePayload([resolvedEditingSuggestion], data))
              return
            }
            drafts.keepEditorDraft(resolvedEditingSuggestion, data)
            await onSaveSuggestion(suggestionFromEditor(resolvedEditingSuggestion, data), data)
          }}
          onSaveAccepted={async data => {
            if (editingSuggestionUsesSelectionEditor) {
              await onRefineConflictMatch?.(buildMatchRefinePayload([resolvedEditingSuggestion], data))
              return
            }
            drafts.keepEditorDraft(resolvedEditingSuggestion, data)
            await onSaveAcceptedSuggestion(suggestionFromEditor(resolvedEditingSuggestion, data), data)
          }}
          onCloseWithDraft={async data => {
            if (editingSuggestionUsesSelectionEditor) {
              onCancelEdit()
              return
            }
            if (shouldRefinePendingFullSuggestion(data)) {
              await onRefineConflictMatch?.(buildMatchRefinePayload([resolvedEditingSuggestion], data))
              return
            }
            drafts.keepEditorDraft(resolvedEditingSuggestion, data)
            onCancelEdit()
          }}
          onDiscard={onCancelEdit}
          // A conflict member is edited from the ConflictSetCard's "Edit rule"; the editor must only stash
          // the draft (which feeds the card's Apply), never accept and bypass the set's other dispositions.
          // The conflict card renders in both the pending and conflicts filters, so draft-only covers both.
          // A refined single suggestion is still a selection partition; saving it must regenerate the cards
          // instead of accepting a rule against a now-stale one-row slice.
          draftOnly={Boolean(resolvedEditingSuggestion?.conflict_group_id) && (reviewFilter === 'pending' || reviewFilter === 'conflicts')}
          mode={editingSuggestionUsesSelectionEditor ? 'match-only' : 'full'}
        />
      ) : null}

      {editingMatchReferenceSuggestion ? (
        <RuleEditorModal
          suggestion={{
            ...editingMatchReferenceSuggestion,
            review_status: 'pending',
            target_category_id: null,
            target_category_name: null,
            clean_name_suggestion: null,
            tag_ids: [],
          }}
          categories={categories}
          owners={owners}
          accounts={accounts}
          onCategoriesChanged={onCategoriesChanged}
          onTagCreated={onTagCreated}
          matchCount={editingMatchRowCount || editingMatchReferenceSuggestion.txn_count || (editingMatchReferenceSuggestion.source_row_ids || []).length}
          matchingRowsOpen={Boolean(matchingRowsReferencePanel)}
          matchingRowsPanel={matchingRowsReferencePanel}
          onOpenMatchingTransactions={() => toggleMatchingTransactionsReference(editingMatchReferenceSuggestion)}
          onAccept={async data => {
            await onRefineConflictMatch?.(buildMatchRefinePayload(resolvedEditingMatchMembers, data))
            setEditingMatchMembers(null)
          }}
          onSaveAccepted={async () => {}}
          onCloseWithDraft={() => setEditingMatchMembers(null)}
          onDiscard={() => setEditingMatchMembers(null)}
          mode="match-only"
        />
      ) : null}

      {bulkMenu ? (
        <ActionMenu
          anchorPoint={bulkMenu.anchorPoint}
          align="start"
          onClose={() => setBulkMenu(null)}
          items={[
            { label: 'Select All', onClick: () => bulk.selectAll(bulkMenu.scopeIds) },
            { label: 'Clear All', onClick: () => bulk.clear(bulkMenu.scopeIds) },
            ...bulkActions.map((action, index) => ({
              label: action.label,
              onClick: () => runBulkAction(action),
              disabled: selectedCount === 0,
              separatorBefore: index === 0,
            })),
          ]}
        />
      ) : null}

      {suggestionMenu ? (
        <ActionMenu
          anchorPoint={suggestionMenu.anchorPoint}
          align="start"
          onClose={() => setSuggestionMenu(null)}
          items={[
            ...getSuggestionMenuActions(suggestionMenu.suggestion, suggestionMenu.resolvedSuggestion)
              .map(action => ({ label: action.label, onClick: action.onClick })),
            bulkAvailable
              ? { label: 'Bulk Select', onClick: () => enterBulkMode(suggestionMenu.suggestion), separatorBefore: true }
              : null,
          ]}
        />
      ) : null}
    </div>
  )
}
