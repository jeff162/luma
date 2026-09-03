// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * What may be done to a category, as one table instead of one boolean.
 *
 * The Categories tree used to ask a single question — "is this a system category?" — and answer six
 * different ones with it: may it be renamed, deleted, dragged out, dropped into, tagged, and may its
 * exclusion be changed. That worked only while every protected row answered all six the same way, and
 * it stopped being true as soon as a third kind appeared. The reimbursable holding group may be renamed
 * and tagged and accepts dropped leaves, yet must never be deleted, moved, or counted toward totals —
 * so a single flag would have to be wrong in one direction or the other.
 *
 * Each row below is a *kind* of category and each column a capability, which makes the matrix readable
 * in one place: adding a fourth protected kind is filling in a row rather than finding six predicates
 * scattered through the JSX. The failure this prevents is the one that happened here — backend guards
 * landing with the UI still rendering live controls for them.
 *
 * **This governs rendering only.** The backend refuses the same operations independently, because that
 * is what holds across entry points; a capability here that disagreed would produce a control that
 * errors on click rather than an operation that succeeds when it should not.
 */

export const UNASSIGNED_CATEGORY_SYSTEM_KEY = 'unassigned'
export const REIMBURSABLE_SYSTEM_KEY = 'reimbursable'

/*
 * Whether a selection sits in the reimbursable holding group — the group itself, or a leaf under it.
 *
 * Keys on the group's `system_key` rather than on its name, because the group is the user's to rename
 * and the feature has to keep working when they do. `parent` is the selection's own parent group, which
 * the caller has already resolved; a leaf carries no key of its own.
 */
export function isReimbursableSelection(cat, parent) {
  if (!cat) return false
  return cat.system_key === REIMBURSABLE_SYSTEM_KEY
    || parent?.system_key === REIMBURSABLE_SYSTEM_KEY
}

// `synthetic` rows are not database records at all — the "Uncategorized" bucket and its income group
// are assembled for display — so nothing can be done to them for want of anything to act on. That is a
// different reason from `unassigned`, which is a real row deliberately held still, and keeping the two
// apart is what stopped them being conflated again here.
const CAPABILITIES = {
  synthetic:    { rename: false, delete: false, move: false, acceptDrop: false, editExclusion: false, tags: false, bulkSelect: false, systemMark: true },
  unassigned:   { rename: false, delete: false, move: false, acceptDrop: false, editExclusion: false, tags: false, bulkSelect: false, systemMark: true },
  reimbursable: { rename: true,  delete: false, move: false, acceptDrop: true,  editExclusion: false, tags: true,  bulkSelect: false, systemMark: true },
  ordinary:     { rename: true,  delete: true,  move: true,  acceptDrop: true,  editExclusion: true,  tags: true,  bulkSelect: true,  systemMark: false },
}

export function categoryKind(cat) {
  if (!cat) return 'ordinary'
  if (cat.synthetic_kind === 'uncategorized' || cat.synthetic_kind === 'uncategorized_income_group') {
    return 'synthetic'
  }
  if (cat.system_key === UNASSIGNED_CATEGORY_SYSTEM_KEY) return 'unassigned'
  // Keyed on the group itself, never on its leaves: the leaves inside it are ordinary categories the
  // user renames, removes and adds at will, and the group's `exclude_from_totals` covers them anyway.
  if (cat.system_key === REIMBURSABLE_SYSTEM_KEY) return 'reimbursable'
  return 'ordinary'
}

export function categoryCapabilities(cat) {
  return CAPABILITIES[categoryKind(cat)]
}

/**
 * Whether the detail panel's controls strip has anything to show. It holds the exclusion checkbox and
 * the tag attachment, so a row that can do neither renders no strip at all rather than an empty frame —
 * while the reimbursable group still gets one, with the checkbox present and disabled. Showing that
 * checkbox greyed rather than hiding it is deliberate: the group *is* excluded, and hiding the control
 * that says so would leave the reason for its behaviour nowhere on screen.
 */
export function showsCategoryControls(cat) {
  const capabilities = categoryCapabilities(cat)
  return capabilities.tags || capabilities.editExclusion
}
