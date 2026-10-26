// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef, useState } from 'react'
import { sessionStore } from '../../lib/browserStorage.js'

/*
 * Bulk selection on the Generate Rules review: whether bulk mode is on, which suggestions are selected,
 * and the rules that keep that selection honest.
 *
 * - **Only what is visible can be selected.** Select all takes the visible suggestions, and a selection
 *   is pruned whenever the visible set changes, so a bulk action never reaches a card the user cannot
 *   see.
 * - **A conflict set's lead selects its set.** Toggling the lead toggles the other visible members with
 *   it, unless they were already picked individually to differ from it.
 * - **The selection survives leaving the review, within the session.** It is saved to sessionStorage,
 *   not the durable preference store: it should not outlive the session or reach a backup. One slot,
 *   keyed by `storageScope` (import source, owner filter and view), so a selection is restored only into
 *   the context it was built in.
 *
 * Ids are compared as strings throughout. Ids are given as suggestion ids; `conflictGroupMembers` maps a
 * conflict group id to its visible member ids in display order, lead first.
 */

const STORAGE_KEY = 'luma.import-rule-suggestions.bulk-selection'

function loadStored(scope) {
  const stored = sessionStore.getJson(STORAGE_KEY)
  if (!stored || stored.scopeId !== scope) return null
  return Array.isArray(stored.ids) ? stored.ids.map(String) : null
}

// Scope-aware: clearing one context's slot never wipes a selection saved for another.
function clearStored(scope) {
  const stored = sessionStore.getJson(STORAGE_KEY)
  if (scope && stored?.scopeId && stored.scopeId !== scope) return
  sessionStore.remove(STORAGE_KEY)
}

export function suggestionBulkStorageScope(persistKey, selectedOwnerIds, reviewFilter) {
  const owners = [...(selectedOwnerIds || [])].map(String).sort().join(',')
  return `${persistKey || 'system'}::${owners}::${reviewFilter || 'pending'}`
}

export function useSuggestionBulkSelection({ visibleSuggestions, conflictGroupMembers, available, storageScope }) {
  const [active, setActive] = useState(false)
  const [selectedIds, setSelectedIds] = useState([])
  const hydratedRef = useRef(false)

  const visibleIds = () => visibleSuggestions.map(suggestion => String(suggestion.id))
  const groupIds = suggestion => (conflictGroupMembers.get(suggestion.conflict_group_id) || []).map(String)

  useEffect(() => {
    if (available) return
    setActive(false)
    setSelectedIds([])
  }, [available])

  useEffect(() => {
    const visible = new Set(visibleSuggestions.map(suggestion => String(suggestion.id)))
    setSelectedIds(prev => {
      const next = prev.filter(id => visible.has(id))
      return next.length === prev.length ? prev : next
    })
  }, [visibleSuggestions])

  // Restore once per mount, when there is something to restore into. Ids that are no longer visible
  // (saved, disposed of or regenerated since) fall away rather than restoring a ghost selection.
  useEffect(() => {
    if (hydratedRef.current || !visibleSuggestions.length) return
    hydratedRef.current = true
    const stored = loadStored(storageScope)
    if (!stored?.length) return
    const visible = new Set(visibleSuggestions.map(suggestion => String(suggestion.id)))
    const restored = stored.filter(id => visible.has(id))
    if (!restored.length) return
    setSelectedIds(restored)
    setActive(true)
  }, [visibleSuggestions, storageScope])

  // Gated on hydration so the first, empty render cannot clear the slot before the restore has run.
  useEffect(() => {
    if (!hydratedRef.current) return
    if (active && selectedIds.length) sessionStore.setJson(STORAGE_KEY, { scopeId: storageScope, ids: selectedIds })
    else clearStored(storageScope)
  }, [active, selectedIds, storageScope])

  function toggle(suggestionId) {
    const id = String(suggestionId)
    setSelectedIds(prev => (prev.includes(id) ? prev.filter(item => item !== id) : [...prev, id]))
  }

  function toggleConflictLead(suggestion) {
    const leadId = String(suggestion.id)
    const childIds = groupIds(suggestion).filter(id => id !== leadId)
    setSelectedIds(prev => {
      const leadSelected = prev.includes(leadId)
      const childrenFollowLead = childIds.every(id => prev.includes(id) === leadSelected)
      const next = new Set(prev)
      for (const id of [leadId, ...(childrenFollowLead ? childIds : [])]) {
        if (leadSelected) next.delete(id)
        else next.add(id)
      }
      return [...next]
    })
  }

  // What a right-click on this card's "Select All" covers: the whole set from its lead, the other
  // members from a member, and everything visible from a card outside any set.
  function scopedIdsFor(suggestion) {
    const ids = suggestion?.conflict_group_id ? groupIds(suggestion) : []
    if (ids.length <= 1) return visibleIds()
    return String(suggestion.id) === ids[0] ? ids : ids.slice(1)
  }

  function selectAll(scopeIds = null) {
    const ids = scopeIds?.length ? scopeIds : visibleIds()
    setSelectedIds(prev => [...new Set([...prev, ...ids])])
  }

  function clear(scopeIds = null) {
    const ids = scopeIds?.length ? scopeIds : visibleIds()
    setSelectedIds(prev => prev.filter(id => !ids.includes(id)))
  }

  // Entering from a card's menu starts with that card selected, or its whole set when it is a lead.
  function enter(initialSuggestion = null) {
    setActive(true)
    if (!initialSuggestion) {
      setSelectedIds([])
      return
    }
    const ids = initialSuggestion.conflict_group_id ? groupIds(initialSuggestion) : []
    const id = String(initialSuggestion.id)
    setSelectedIds(ids.length > 1 && ids[0] === id ? ids : [id])
  }

  function exit() {
    setActive(false)
    setSelectedIds([])
  }

  return {
    active,
    selectedIds,
    isSelected: suggestionId => selectedIds.includes(String(suggestionId)),
    toggle,
    toggleConflictLead,
    scopedIdsFor,
    selectAll,
    clear,
    enter,
    exit,
  }
}
