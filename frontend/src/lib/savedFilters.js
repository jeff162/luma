// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * Saved filters: a name for one setting of the FilterBar (its date, chips and amount) that is applied by
 * clicking it. Applying replaces whatever filters are in force, and the applied filters are ordinary
 * filters from then on, so adjusting one does not touch the saved copy until "Replace with current
 * filters" writes it back.
 *
 * - **A preset date stays relative.** A saved "Year to date" is this year's range whenever it is applied,
 *   because the stored date keeps the preset's label and the range is worked out again (`datePresets.js`).
 *   A custom range is fixed.
 * - **A chip is rebuilt from what it names when applied**, so a renamed account or tag shows its current
 *   name. A chip whose account, category, owner, tag or attribute no longer exists is kept and marked
 *   `missing` rather than dropped, since dropping it would widen the filter without saying so.
 * - **The list is each user's own**, a preference like a column layout. Every FilterBar on screen (the
 *   page's and the export dialog's) reads the same preference, so a save from one shows in the other.
 */

import { useCallback } from 'react'
import { api } from './api.js'
import { useUserPreference } from './UserPreferencesContext.jsx'
import { datePresetFilter } from './datePresets.js'
import { normalizeAmountFilter } from './filterParams.js'
import {
  accountSelection, attributeSelection, categorySelection, groupSelection, ownerSelection, tagSelection,
} from './filterSelections.js'

const SAVED_FILTERS_PREF_KEY = 'ui.filterBar.savedFilters'

/**
 * The saved list and its one writer. `update(list => next)` shows the change at once and rejects when the
 * save fails, by which time the list shown is back to what it was.
 */
export function useSavedFilters() {
  const [stored, setStored] = useUserPreference(SAVED_FILTERS_PREF_KEY, [])
  const savedFilters = Array.isArray(stored) ? stored : []
  const update = useCallback(async updater => {
    const saved = await setStored(previous => updater(Array.isArray(previous) ? previous : []))
    if (!saved) throw new Error('The saved filter could not be saved.')
  }, [setStored])
  return { savedFilters, updateSavedFilters: update }
}

/** A saved filter's name as stored: trimmed, with runs of spaces closed up. */
export function tidySavedFilterName(name) {
  return name.trim().split(/\s+/).join(' ')
}

export function makeSavedFilterId() {
  return `sf_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

/** The part of the current filters a saved filter keeps. */
export function savedFilterContent(filters) {
  return {
    date: filters.date ? { ...filters.date } : null,
    selections: filters.selections.map(({ missing: _missing, ...sel }) => sel),
    amount: normalizeAmountFilter(filters.amount),
  }
}

/** The date a saved filter applies as of `now`: a preset's range worked out again, a custom range as is. */
export function savedFilterDate(date, now = new Date()) {
  if (!date) return null
  return (date.preset && datePresetFilter(date.preset, now)) || { ...date }
}

function sameDate(saved, current) {
  if (!saved || !current) return !saved && !current
  if (saved.preset || current.preset) return saved.preset === current.preset
  return saved.start === current.start && saved.end === current.end
}

const selectionKey = s => `${s.type}\u0000${s.id}\u0000${s.mode === 'exclude' ? 'exclude' : 'include'}`

function sameSelections(a = [], b = []) {
  if (a.length !== b.length) return false
  const keys = new Set(a.map(selectionKey))
  return b.every(s => keys.has(selectionKey(s)))
}

function sameAmount(a, b) {
  const x = normalizeAmountFilter(a)
  const y = normalizeAmountFilter(b)
  if (!x || !y) return !x && !y
  return x.side === y.side && x.low === y.low && x.high === y.high
    && (x.low == null || x.lowOp === y.lowOp) && (x.high == null || x.highOp === y.highOp)
}

/** Whether the filters in force are exactly what a saved filter applies. Chip order and labels don't count. */
export function savedFilterMatches(saved, filters) {
  return sameDate(saved.date, filters.date)
    && sameSelections(saved.selections, filters.selections)
    && sameAmount(saved.amount, filters.amount)
}

// The stored things a chip can name, by type. Ids beginning `__` are the picker's synthetic buckets
// (Uncategorized, Untagged), which always exist; payees and account types name no stored row.
const STORED_TYPES = new Set(['account', 'group', 'category', 'owner', 'tag', 'attribute'])
const namesStoredRow = sel => STORED_TYPES.has(sel.type) && !String(sel.id).startsWith('__')
const keyOf = sel => `${sel.type}:${sel.id}`

async function currentSelections(types) {
  const need = (...ts) => ts.some(t => types.has(t))
  const [accounts, categories, owners, tags, attributes] = await Promise.all([
    need('account') ? api.getAccounts() : null,
    need('group', 'category') ? api.getCategories() : null,
    need('owner') ? api.getOwners() : null,
    need('tag') ? api.getTags() : null,
    need('attribute') ? api.getFilterAttributes() : null,
  ])
  const byKey = new Map()
  const add = (rows, build) => (rows || []).forEach(row => {
    const sel = build(row)
    byKey.set(keyOf(sel), sel)
  })
  add(accounts, accountSelection)
  add(categories?.filter(c => !c.parent_id), groupSelection)
  add(categories?.filter(c => c.parent_id), categorySelection)
  add(owners, ownerSelection)
  add(tags, tagSelection)
  add(attributes, attributeSelection)
  return byKey
}

/**
 * A saved filter's chips as of now: each rebuilt from what it names, or marked `missing` when that is
 * gone. Should the lookup itself fail, the chips apply as saved.
 */
export async function reconcileSelections(selections) {
  const types = new Set(selections.filter(namesStoredRow).map(s => s.type))
  if (types.size === 0) return selections
  let current
  try {
    current = await currentSelections(types)
  } catch {
    return selections
  }
  return selections.map(sel => {
    if (!namesStoredRow(sel)) return sel
    const now = current.get(keyOf(sel))
    return now ? { ...now, mode: sel.mode } : { ...sel, missing: true }
  })
}
