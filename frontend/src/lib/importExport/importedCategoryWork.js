// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: GPL-3.0-or-later

// Pending "Group Imported Categories" work, derived from the live category list + the workspace draft.
// The workspace only acts on still-pending imported labels — Unassigned leaves with import_pending = 1
// (user-created and recovered system categories under Unassigned are excluded). The draft can already
// place some of those into groups (or park them) without having applied yet, so `pending` discounts what
// the draft has handled while `total` counts every pending label. Shared so the Import-page button, the
// Categories-page button, and the App-level workspace provider all count identically rather than
// re-deriving and drifting.

import { UNASSIGNED_CATEGORY_SYSTEM_KEY } from './constants.js'
import {
  normalizeImportCategoryValue,
  sanitizeCategoryWorkspaceDraftToSourceValues,
  summarizeCategoryWorkspaceDraft,
} from './categoryWorkspaceDraft.js'

export function pendingImportedCategorySourceValues(categories) {
  const list = categories || []
  const unassignedGroup = list.find(c => !c.parent_id && c.system_key === UNASSIGNED_CATEGORY_SYSTEM_KEY)
  if (!unassignedGroup) return []
  return list
    .filter(c => c.parent_id === unassignedGroup.id && c.import_pending)
    .map(c => c.name)
    .filter(Boolean)
}

export function parkedImportedCategorySourceValues(categories) {
  const list = categories || []
  const unassignedGroup = list.find(c => !c.parent_id && c.system_key === UNASSIGNED_CATEGORY_SYSTEM_KEY)
  if (!unassignedGroup) return []
  return list
    .filter(c => c.parent_id === unassignedGroup.id && c.import_pending && c.set_aside)
    .map(c => c.name)
    .filter(Boolean)
}

export function getImportedCategoryWorkCounts(categories, draft) {
  const sourceValues = pendingImportedCategorySourceValues(categories)
  const parkedKeys = new Set(parkedImportedCategorySourceValues(categories).map(normalizeImportCategoryValue))
  const effectiveDraft = sanitizeCategoryWorkspaceDraftToSourceValues(draft, sourceValues)
  const summary = summarizeCategoryWorkspaceDraft(effectiveDraft)
  const trackedKeys = new Set((summary.sourceValues || []).map(normalizeImportCategoryValue))
  // A leaf the draft never placed is "untracked". One that is parked live (set_aside = 1) is already
  // handled — it sits in Set Aside — so only untracked values that are NOT live-parked still need
  // sorting. Without this, a workspace with no persisted draft (post-restore, or a different profile)
  // counts every set-aside category as outstanding work even though the durable DB flag says parked.
  const untrackedValues = sourceValues.filter(
    value => !trackedKeys.has(normalizeImportCategoryValue(value)),
  )
  const untrackedPending = untrackedValues.filter(
    value => !parkedKeys.has(normalizeImportCategoryValue(value)),
  ).length
  return {
    pending: (summary.remainingCount || 0) + untrackedPending,
    total: (summary.totalCount || 0) + untrackedValues.length,
  }
}
