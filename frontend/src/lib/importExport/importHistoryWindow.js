// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// How the import history is organized: by the period each card *covers*, not by when someone pressed
// import. The two agree for anyone importing recent transactions, which is the ordinary case; they come
// apart exactly when historical data is loaded, which is the case the history was unreadable in — a
// year's worth of back-filled files all stamped with today, in whatever order they happened to be read.
// The backend records a card's span as `covers_start`/`covers_end` (see
// `services/import_batch_totals.refresh_batch_coverage`), falling back here to import time for a card
// too old to have one.
//
// A source fed monthly accumulates one card per file for years, so the list also keeps only its recent
// cards and files the rest into a by-year archive. The window is per *source*: a global one lets an
// actively-fed source crowd out a quiet neighbour's recent cards, which is what the old global fetch cap
// did (`docs/scale-and-limits.md` → *Import history: retention*).

import { endOfMonth, format, parseISO } from 'date-fns'

export const RECENT_CARD_COUNT = 4
export const RECENT_WINDOW_DAYS = 30
// A disclosure that hides one or two cards costs the reader more than the rows it saves.
export const MIN_ARCHIVED_CARDS = 3

// `imported_at` arrives in two shapes — `2026-09-12T13:23:40Z` from a sync and `2026-09-12 13:23:40`
// from an import, both UTC — and the first ten characters are the calendar day in either, so the
// separator needs no normalizing here (unlike a comparison that reaches into the time).
const dayOf = value => String(value || '').slice(0, 10)

// A sync card's month (`sync_period`, `YYYY-MM`), as its first and last day. It stands in for a span on a
// card holding no rows — one whose every row was refused still exists to report that, and without this it
// fell back to import time and sorted among months it had nothing to do with.
const periodStart = batch => (batch?.sync_period ? `${batch.sync_period}-01` : '')
const periodEnd = batch => {
  const start = periodStart(batch)
  return start ? format(endOfMonth(parseISO(start)), 'yyyy-MM-dd') : ''
}

// Newest date a card covers. `newest_txn_date` is the marketplace path's own older field, kept as a
// fallback so a card predating the stored span still sorts by its data; import time is the last resort.
export const coverageEnd = batch =>
  dayOf(batch?.covers_end || batch?.newest_txn_date || periodEnd(batch) || batch?.imported_at)
export const coverageStart = batch => dayOf(batch?.covers_start || periodStart(batch) || coverageEnd(batch))
export const importedAt = batch => String(batch?.imported_at || '')

// Cards run by where their span starts, newest first. A span's start is the date it was fetched back to,
// which is what places a multi-month card among the single-month ones: a connection's initial import sits
// beneath the months that came after it, rather than above every month its span happens to reach into.
// Ties break on the end of the span and then on import time, so two files covering the same period still
// order stably and the most recently imported of them leads.
export function byCoverage(a, b) {
  const starts = coverageStart(b).localeCompare(coverageStart(a))
  if (starts !== 0) return starts
  const ends = coverageEnd(b).localeCompare(coverageEnd(a))
  if (ends !== 0) return ends
  return importedAt(b).localeCompare(importedAt(a))
}

/**
 * Split one source's cards into the recent list and a by-year archive.
 *
 * `batches` must already be ordered by `byCoverage`, and the recent list is a **prefix** of that order:
 * membership asks only about coverage, never about import time. An earlier version also kept anything
 * *imported* recently, so that a backfill could not land straight in a collapsed archive — and that
 * clause is what broke the invariant. A card imported months ago but covering a period in the middle of
 * the kept ones was lifted out of the middle of the list, putting one year in two places at once on a
 * list that presents itself as ordered by period. The hedge also bought little: when transactions are
 * recent, which is the ordinary case, coverage already puts a fresh import at the top on its own. It
 * only fired during a historical backfill, and paid for that one case by distorting the list for good.
 *
 * The window is tested on the same date the order sorts on — where a span starts — which is what makes
 * it a prefix without having to enforce one. Testing the end instead let a long card running up to today
 * stay in the list beneath an older, shorter card that had been archived.
 */
export function partitionImportHistory(batches, {
  now = Date.now(),
  recentCount = RECENT_CARD_COUNT,
  windowDays = RECENT_WINDOW_DAYS,
  minArchived = MIN_ARCHIVED_CARDS,
} = {}) {
  const list = (Array.isArray(batches) ? batches : []).filter(Boolean)
  const cutoff = dayOf(new Date(now - windowDays * 86400000).toISOString())
  const recent = []
  const older = []
  list.forEach((batch, index) => {
    const inWindow = index < recentCount || coverageStart(batch) >= cutoff
    ;(inWindow ? recent : older).push(batch)
  })
  if (older.length < minArchived) return { recent: list, archive: [] }

  const byYear = new Map()
  for (const batch of older) {
    const year = coverageStart(batch).slice(0, 4)
    if (!byYear.has(year)) byYear.set(year, [])
    byYear.get(year).push(batch)
  }
  const archive = [...byYear.entries()]
    .map(([year, yearBatches]) => ({ year, label: year || 'Undated', batches: yearBatches }))
    // Newest year first; a card with no usable date ('') sorts last.
    .sort((a, b) => b.year.localeCompare(a.year))
  return { recent, archive }
}

export const archivedCardCount = archive =>
  (archive || []).reduce((total, group) => total + group.batches.length, 0)

// A card's span, collapsed to what actually varies: one day reads as a date, one month drops the
// repeated month, one year drops the repeated year. Returns null when there is nothing to show.
export function formatCoverageRange(batch) {
  const start = batch?.covers_start
  const end = batch?.covers_end
  if (!start || !end) return null
  try {
    const from = parseISO(start)
    const to = parseISO(end)
    if (start === end) return format(from, 'MMM d, yyyy')
    if (start.slice(0, 7) === end.slice(0, 7)) return `${format(from, 'MMM d')} – ${format(to, 'd, yyyy')}`
    if (start.slice(0, 4) === end.slice(0, 4)) return `${format(from, 'MMM d')} – ${format(to, 'MMM d, yyyy')}`
    return `${format(from, 'MMM d, yyyy')} – ${format(to, 'MMM d, yyyy')}`
  } catch {
    return null
  }
}

// What the span is an answer to, for the card's hover — a statement declares its period, everything
// else is read from the rows the file carried.
export const coverageSourceLabel = batch => (
  batch?.covers_source === 'statement' ? 'Statement period'
    : batch?.covers_source === 'items' ? 'Dates of the items waiting for their orders file'
      : 'Dates of the transactions in this file'
)

/**
 * What a set of cards still wants someone to do, in the kinds the collapsed source row reports. The
 * archive badges itself with this: a disclosure that silently swallowed a card needing review would
 * repeat the lossy cap's failure one level down, on a smaller scale.
 *
 * `advisory_review_count` belongs with the suspects rather than in a kind of its own, which is how the
 * card's own duplicates pill already counts it: both are entries in the duplicate report still waiting
 * for a verdict, and splitting them apart here would put a number on screen that no pill matches.
 */
export function summarizeBatchAttention(batches) {
  const list = (Array.isArray(batches) ? batches : []).filter(Boolean)
  const sum = key => list.reduce((total, batch) => total + Math.max(0, Number(batch?.[key] || 0)), 0)
  return {
    unresolvedDuplicates: sum('suspect_duplicate_count') + sum('advisory_review_count'),
    needsReview: sum('needs_review_count'),
    reconAttention: sum('recon_attention_count'),
    // Counted by row rather than summed: a bank charge with no PayPal record is listed by every card
    // whose dates cover it.
    paypalAttention: new Set(list.flatMap(batch => batch?.paypal_recon_attention_ids || [])).size,
  }
}

/**
 * How a data-source row names itself: the heading, and the qualifier that sits under it.
 *
 * Shared because the qualifier is the only thing telling two connections at one institution apart —
 * the row's own label is just the institution — so a second surface rendering the heading without it
 * shows two identical groups for two different sources.
 */
export function describeDataSourceRow(row, providerLabel) {
  if (row?.kind === 'connection') {
    return {
      name: row.label || 'Data connection',
      qualifier: row.disconnected
        ? 'Disconnected · import history kept'
        : row.provider ? `${providerLabel(row.provider)} connection` : 'Data connection',
    }
  }
  if (row?.kind === 'manual') return { name: 'Temporary draft', qualifier: null }
  if (row?.kind === 'unknown') return { name: 'Unknown data source', qualifier: null }
  if (row?.kind === 'marketplace') return { name: row.label || 'Marketplace', qualifier: null }
  return { name: row?.profile?.name || 'Data source', qualifier: null }
}
