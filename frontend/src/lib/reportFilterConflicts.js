// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * Detect when the active filter removes a slice the Dashboard spending report would otherwise break
 * down — a `≠ Groceries` chip on the category report, a `≠ Business` chip on a tag report built on
 * Business, or (drilled into a group) an excluded component category. The report still renders
 * correctly — the filter just scopes the fetched rows before aggregation — so this only powers a quiet
 * note that the breakdown is omitting something, so a missing wedge doesn't read as a bug.
 *
 * Pure + entirely client-side: the report axis (the selected report / drilled group) and the chips
 * both live in front-end state, so the overlap is a set intersection with no server round-trip. Only
 * like-for-like facets are compared — category chip ↔ category slice, group chip ↔ group slice, tag
 * chip ↔ report tag — so an *indirect* filter (an account or owner chip that happens to drop a
 * category) never raises a note; that's the deliberate boundary from the design discussion.
 *
 * Two ways a report tag can be left out, both flagged for tag reports (the asymmetry a bare
 * exclude-only pass would miss): a tag `≠`-**excluded** by the filter, OR — when a tag *include* filter
 * is active — a report tag **missing** from that include set. Including only tag A on a report built on
 * {A,B} drops every non-A row, so B's rows vanish exactly as if B were excluded. For group/category
 * reports the include case is deliberately NOT flagged (a category has one group, so an include chip is
 * ordinary focusing, not the same distortion) — see docs/ui-patterns.md → General principles ("Warn
 * when a filter leaves out what a report is showing").
 */

// Groups are the parent categories (parent_id === null) in the flat category list; leaves carry
// parent_id = their group's id. A group/leaf is only *shown* by the spending report when it counts
// toward totals (not exclude_from_totals) and matches the active income/expense view — so an exclude
// on an already-omitted row (a transfer/card-payment category, or the other view's groups) is a no-op
// for the report and must not raise a false note.
export function computeReportSpendingConflicts({
  reportKind,             // 'group' | 'category' | 'tag' | null/other
  view,                   // 'income' | 'expense'
  reportTagIds = [],      // the tag report's tag ids (tag reports only)
  selectedGroupId = null, // set when drilled into a group (the breakdown is that group's leaves)
  selections = [],
  categories = [],        // flat: [{ id, parent_id, category_type, exclude_from_totals, name }]
  tagsById = new Map(),
} = {}) {
  const selList = selections || []

  if (reportKind === 'tag') {
    // Only *real* tag selections participate in the tag co-occurrence check. The tags tab also carries
    // the synthetic `__untagged__` bucket, which is an orthogonal axis rather than a report tag — an
    // Untagged chip must not read as "filtering on tags" and flag every report tag as missing, and it
    // has no report wedge of its own. (Attributes are their own facet and never reach this branch.)
    const isRealTagId = id => typeof id === 'string' && !id.startsWith('__')
    const excludedTagIds = new Set(selList.filter(s => s?.type === 'tag' && s.mode === 'exclude' && isRealTagId(s.id)).map(s => s.id))
    const includedTagIds = new Set(selList.filter(s => s?.type === 'tag' && s.mode !== 'exclude' && isRealTagId(s.id)).map(s => s.id))
    // Only when a tag *include* filter is active are the report's other tags being narrowed away; with
    // no tag include chip, every report tag is present unless explicitly excluded.
    const filteringOnTags = includedTagIds.size > 0
    const out = []
    for (const tid of reportTagIds || []) {
      const label = tagsById.get(tid)?.name || tid
      if (excludedTagIds.has(tid)) out.push({ facet: 'tag', id: tid, label, reason: 'excluded' })
      else if (filteringOnTags && !includedTagIds.has(tid)) out.push({ facet: 'tag', id: tid, label, reason: 'missing' })
    }
    return out
  }

  if (reportKind !== 'group' && reportKind !== 'category') return []

  const excludes = selList.filter(s => s && s.mode === 'exclude')
  if (excludes.length === 0) return []

  const byId = new Map((categories || []).map(c => [c.id, c]))
  const groupType = g => g?.category_type || 'expense'
  const isShownGroup = g => !!g && g.parent_id == null && !g.exclude_from_totals && groupType(g) === view
  const isShownLeaf = leaf => {
    if (!leaf || leaf.parent_id == null || leaf.exclude_from_totals) return false
    return isShownGroup(byId.get(leaf.parent_id))
  }

  // Which groups / leaf categories the report currently breaks down.
  let shownGroupIds
  let shownLeafIds
  if (reportKind === 'group' && selectedGroupId) {
    // Drilled into one group: the visible breakdown is that group's own leaves.
    shownGroupIds = isShownGroup(byId.get(selectedGroupId)) ? new Set([selectedGroupId]) : new Set()
    shownLeafIds = new Set(
      (categories || []).filter(c => c.parent_id === selectedGroupId && isShownLeaf(c)).map(c => c.id),
    )
  } else {
    // Top level: every shown group / leaf of the active view.
    shownGroupIds = new Set((categories || []).filter(isShownGroup).map(c => c.id))
    shownLeafIds = new Set((categories || []).filter(isShownLeaf).map(c => c.id))
  }

  const conflicts = []
  for (const s of excludes) {
    if (s.type === 'group' && shownGroupIds.has(s.id)) {
      conflicts.push({ facet: 'group', id: s.id, label: byId.get(s.id)?.name || s.label || 'group' })
    } else if (s.type === 'category' && shownLeafIds.has(s.id)) {
      conflicts.push({ facet: 'category', id: s.id, label: byId.get(s.id)?.name || s.label || 'category' })
    }
  }
  return conflicts
}

// Compose the conflict list into one short sentence for the note. Names up to two slices, then
// summarizes the rest as "and N more" so the note stays one quiet line regardless of chip count.
export function describeReportConflicts(conflicts) {
  if (!conflicts || conflicts.length === 0) return null
  const labels = conflicts.map(c => c.label)
  let subject
  if (labels.length === 1) subject = labels[0]
  else if (labels.length === 2) subject = `${labels[0]} and ${labels[1]}`
  else subject = `${labels[0]}, ${labels[1]} and ${labels.length - 2} more`
  // A "missing" conflict is caused by an include filter narrowing the report, not an exclude chip, so
  // the framing has to cover both — "the current filter leaves out" reads true whichever it is.
  if (conflicts.some(c => c.reason === 'missing')) {
    return `The current filter omits ${subject} which is part of this report`
  }
  return `The current filter excludes ${subject} which is part of this report`
}

// The selection ids to remove to clear the detected conflicts (drives the note's action). Excluded
// slices resolve by dropping their own chip. A tag report's *missing* tags have no chip to drop — the
// narrowing is the tag *include* filter — so any tag-report conflict clears every tag chip (include and
// exclude), fully restoring the report's own tags. Group/category conflicts drop only the exclude chip.
export function resolveConflictSelectionIds(conflicts, selections = []) {
  const ids = new Set()
  for (const c of conflicts) {
    if (c.reason !== 'missing') ids.add(c.id)
  }
  if (conflicts.some(c => c.facet === 'tag')) {
    for (const s of selections || []) {
      if (s?.type === 'tag') ids.add(s.id)
    }
  }
  return [...ids]
}
