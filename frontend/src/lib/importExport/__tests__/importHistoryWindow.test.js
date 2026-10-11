import { describe, it, expect } from 'vitest'
import {
  partitionImportHistory,
  summarizeBatchAttention,
  archivedCardCount,
  byCoverage,
  formatCoverageRange,
} from '../importHistoryWindow.js'

const NOW = Date.parse('2026-10-08T12:00:00Z')

const card = (id, importedAt, extra = {}) => ({ id, imported_at: importedAt, ...extra })

// Newest-first, as both card surfaces sort before handing the list over.
const monthly = (count, { fromYear = 2026, fromMonth = 10 } = {}) =>
  Array.from({ length: count }, (_, i) => {
    const month = fromMonth - i
    const year = fromYear + Math.floor((month - 1) / 12)
    const normalized = ((month - 1) % 12 + 12) % 12 + 1
    const day = `${year}-${String(normalized).padStart(2, '0')}`
    return card(`m${i}`, `${day}-05 09:00:00`, { covers_start: `${day}-01`, covers_end: `${day}-28` })
  })

describe('the per-source recency window', () => {
  it('keeps the newest few cards out of the archive even when every one of them is old', () => {
    const { recent, archive } = partitionImportHistory(monthly(12), { now: NOW })
    expect(recent.map(b => b.id)).toEqual(['m0', 'm1', 'm2', 'm3'])
    expect(archivedCardCount(archive)).toBe(8)
  })

  it('keeps every card inside the window, past the newest few', () => {
    const dense = [
      card('a', '2026-10-07 09:00:00', { covers_start: '2026-10-01', covers_end: '2026-10-07' }),
      card('b', '2026-10-05 09:00:00', { covers_start: '2026-10-01', covers_end: '2026-10-05' }),
      card('c', '2026-10-02 09:00:00', { covers_start: '2026-10-01', covers_end: '2026-10-02' }),
      card('d', '2026-09-28 09:00:00', { covers_start: '2026-09-20', covers_end: '2026-09-28' }),
      card('e', '2026-09-20 09:00:00', { covers_start: '2026-09-14', covers_end: '2026-09-20' }),
      card('f', '2026-09-15 09:00:00', { covers_start: '2026-09-10', covers_end: '2026-09-15' }),
      card('g', '2026-05-15 09:00:00', { covers_start: '2026-05-01', covers_end: '2026-05-15' }),
      card('h', '2026-04-15 09:00:00', { covers_start: '2026-04-01', covers_end: '2026-04-15' }),
      card('i', '2026-03-15 09:00:00', { covers_start: '2026-03-01', covers_end: '2026-03-15' }),
    ]
    const { recent, archive } = partitionImportHistory(dense, { now: NOW })
    expect(recent.map(b => b.id)).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
    expect(archivedCardCount(archive)).toBe(3)
  })

  it('leaves a short tail in the list rather than hiding one or two cards behind a disclosure', () => {
    const { recent, archive } = partitionImportHistory(monthly(6), { now: NOW })
    expect(recent).toHaveLength(6)
    expect(archive).toEqual([])
  })

  it('groups the archive by year, newest year first', () => {
    const { archive } = partitionImportHistory(monthly(20), { now: NOW })
    expect(archive.map(group => [group.label, group.batches.length])).toEqual([
      ['2026', 6],
      ['2025', 10],
    ])
  })

  it('treats both timestamp shapes as the same calendar day', () => {
    const mixed = [
      card('sync', '2026-09-20T09:00:00Z', { covers_start: '2026-09-20', covers_end: '2026-09-20' }),
      card('file', '2026-09-20 09:00:00', { covers_start: '2026-09-20', covers_end: '2026-09-20' }),
      ...monthly(4, { fromMonth: 4 }),
    ]
    const { recent } = partitionImportHistory(mixed, { now: NOW, recentCount: 1 })
    expect(recent.map(b => b.id)).toEqual(['sync', 'file'])
  })

  // The invariant the window exists to keep: the list is the *top* of the coverage order, never a
  // subset of it with holes. A card imported moments ago but covering an old period is archived with
  // the period it covers — lifting it out by import date put one year in two places at once, a card
  // in the recent list sitting below the years already filed away.
  it('is a contiguous prefix of the order, whatever the cards were imported', () => {
    const backfill = [
      ...monthly(8),
      card('old-but-new', '2026-10-08 08:00:00', { covers_start: '2019-01-04', covers_end: '2019-12-28' }),
    ]
    const { recent, archive } = partitionImportHistory(backfill, { now: NOW })
    const order = backfill.map(b => b.id)
    expect(recent.map(b => b.id)).toEqual(order.slice(0, recent.length))
    expect(archive.flatMap(group => group.batches).map(b => b.id)).toEqual(order.slice(recent.length))
    expect(recent.map(b => b.id)).not.toContain('old-but-new')
  })

  // The reported case, in miniature: statements imported yesterday covering months an activity export
  // already covered. All of them belong with that export, not above it.
  it('keeps cards covering one period together, however far apart they were imported', () => {
    const paypal = [
      card('nov-statement', '2026-10-07 00:43:00', { covers_start: '2025-11-01', covers_end: '2025-11-30' }),
      card('aug-statement', '2026-10-07 00:43:01', { covers_start: '2025-08-01', covers_end: '2025-08-31' }),
      card('jun-statement', '2026-10-07 00:43:02', { covers_start: '2025-06-01', covers_end: '2025-06-30' }),
      card('activity-2025', '2026-07-26 20:09:00', { covers_start: '2025-01-03', covers_end: '2025-11-05' }),
      card('jan-statement', '2026-10-07 00:43:03', { covers_start: '2025-01-01', covers_end: '2025-01-31' }),
      card('activity-2024', '2026-07-26 20:09:01', { covers_start: '2024-01-06', covers_end: '2024-12-23' }),
      card('activity-2023', '2026-07-26 20:09:02', { covers_start: '2023-03-09', covers_end: '2023-12-03' }),
    ]
    const { archive } = partitionImportHistory(paypal, { now: NOW, recentCount: 1 })
    expect(archive.map(group => [group.label, group.batches.map(b => b.id)])).toEqual([
      ['2025', ['aug-statement', 'jun-statement', 'activity-2025', 'jan-statement']],
      ['2024', ['activity-2024']],
      ['2023', ['activity-2023']],
    ])
  })
})

describe('card order', () => {
  // A connection's initial import spans every month its first pull reached; the monthly cards that
  // follow it are newer than where it starts, though not newer than where it ends.
  it('runs by where each span starts, so a long card sits beneath the months that came after it', () => {
    const cards = [
      card('initial', '2026-07-10 09:00:00', { covers_start: '2026-04-12', covers_end: '2026-07-10' }),
      card('july', '2026-08-01 09:00:00', { covers_start: '2026-07-11', covers_end: '2026-07-31' }),
      card('march', '2026-09-01 09:00:00', { covers_start: '2026-03-02', covers_end: '2026-03-30' }),
    ]
    expect([...cards].sort(byCoverage).map(b => b.id)).toEqual(['july', 'initial', 'march'])
  })

  it('runs by the period covered, breaking ties on the most recent import', () => {
    const cards = [
      card('older-period', '2026-10-07 09:00:00', { covers_start: '2019-01-01', covers_end: '2019-12-31' }),
      card('same-period-older-import', '2026-07-01 09:00:00', { covers_start: '2026-07-05', covers_end: '2026-07-24' }),
      card('same-period-newer-import', '2026-09-01 09:00:00', { covers_start: '2026-07-05', covers_end: '2026-07-24' }),
    ]
    expect([...cards].sort(byCoverage).map(b => b.id))
      .toEqual(['same-period-newer-import', 'same-period-older-import', 'older-period'])
  })

  it('falls back to a marketplace card\'s own date, then to import time, for a card with no span', () => {
    const cards = [
      card('no-span', '2020-01-01 09:00:00'),
      card('marketplace', '2019-01-01 09:00:00', { newest_txn_date: '2024-06-01' }),
    ]
    expect([...cards].sort(byCoverage).map(b => b.id)).toEqual(['marketplace', 'no-span'])
  })

  // Every row the card received was refused, so it has no span — but it is still that month's card.
  it('places a sync card with no span by its month, not by when it was created', () => {
    const cards = [
      card('september', '2026-09-01 03:28:14', { sync_period: '2026-09', covers_start: '2026-09-01', covers_end: '2026-09-28' }),
      card('july-all-refused', '2026-09-01 03:28:14', { sync_period: '2026-07' }),
      card('august', '2026-09-01 03:28:14', { sync_period: '2026-08', covers_start: '2026-08-25', covers_end: '2026-08-28' }),
    ]
    expect([...cards].sort(byCoverage).map(b => b.id)).toEqual(['september', 'august', 'july-all-refused'])
  })
})

describe('a card\'s span, written out', () => {
  it('collapses what does not vary', () => {
    expect(formatCoverageRange({ covers_start: '2025-05-04', covers_end: '2025-05-04' })).toBe('May 4, 2025')
    expect(formatCoverageRange({ covers_start: '2025-02-01', covers_end: '2025-02-28' })).toBe('Feb 1 – 28, 2025')
    expect(formatCoverageRange({ covers_start: '2025-01-03', covers_end: '2025-11-05' })).toBe('Jan 3 – Nov 5, 2025')
    expect(formatCoverageRange({ covers_start: '2019-07-05', covers_end: '2020-03-01' })).toBe('Jul 5, 2019 – Mar 1, 2020')
  })

  it('says nothing for a card with no recorded span', () => {
    expect(formatCoverageRange({ imported_at: '2026-10-07 09:00:00' })).toBeNull()
  })
})

describe('an archive grouped by the period its cards cover', () => {
  // A multi-year drop is imported in one sitting but covers years of purchases. Grouped by import time
  // the whole thing would file under the single year it was loaded.
  const drop = [2025, 2024, 2023, 2022, 2021, 2020, 2019, 2018].map((year, i) => ({
    id: String(year),
    imported_at: `2026-01-05 09:00:0${i}`,
    covers_start: `${year}-01-11`,
    covers_end: `${year}-11-02`,
  }))

  it('groups by the years covered, not the day it was all imported', () => {
    const { recent, archive } = partitionImportHistory(drop, { now: NOW })
    expect(recent.map(b => b.id)).toEqual(['2025', '2024', '2023', '2022'])
    expect(archive.map(group => group.label)).toEqual(['2021', '2020', '2019', '2018'])
  })

  // A card too old to have a recorded span still has to land somewhere; the year it was imported is
  // the only date it has, and is what the history showed for it before spans existed.
  it('files a card with no recorded span under the year it was imported', () => {
    const { archive } = partitionImportHistory([...drop, { id: 'no-span', imported_at: '2017-04-05 09:00:00' }], { now: NOW })
    expect(archive.map(group => group.label)).toEqual(['2021', '2020', '2019', '2018', '2017'])
  })
})

describe('what an archived set still wants done', () => {
  // Advisory rows sit with the suspects rather than in a kind of their own, matching the card's own
  // duplicates pill. Counting only the suspects is what left a PayPal source of amber cards silent.
  it('counts rejections still flagged amber alongside the suspects', () => {
    expect(summarizeBatchAttention([
      { suspect_duplicate_count: 1, advisory_review_count: 5, needs_review_count: 3, paypal_recon_attention_ids: ['p1', 'bank1'] },
      { advisory_review_count: 2, needs_review_count: 2, recon_attention_count: 4, paypal_recon_attention_ids: ['bank1'] },
    ])).toEqual({ unresolvedDuplicates: 8, needsReview: 5, reconAttention: 4, paypalAttention: 2 })
  })

  it('reports nothing for cards that are all settled', () => {
    expect(summarizeBatchAttention([{ needs_review_count: 0, deduped_count: 12 }, {}]))
      .toEqual({ unresolvedDuplicates: 0, needsReview: 0, reconAttention: 0, paypalAttention: 0 })
  })
})
