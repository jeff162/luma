// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// Putting a connection sync-log row into words.
//
// Every function here reads what `run_sync` recorded and answers a question a reader actually arrives
// with, rather than printing the field that happens to hold the answer. The three questions are: where did
// the rows go, what did the pull ask the provider for, and how far is the connection caught up.
//
// The checkpoint half parses a **stringly-typed contract** — `_cursor_fingerprint` (backend/routers/sync.py)
// renders a provider's resume token as `key=value, key=value`, or as a length plus a leading slice for an
// opaque paging token that has no keys to show. That is why this lives in its own module with its own
// tests: the format is produced by one function on the other side of an HTTP boundary, so the only thing
// keeping the two in step is a test that states what the shape is. Every function returns null rather than
// a placeholder when it cannot make sense of its input, so the caller can fall back to showing the raw
// value — for a stalled sync, "the token did not advance" is the finding, and hiding it behind a friendly
// sentence would remove the evidence.

import { formatDate } from './utils.js'

// An ISO date as a readable one, via the shared formatter, leaving anything that is not a plain date
// exactly as it came — these strings originate in a provider's own checkpoint and are not guaranteed.
export function syncLogDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value || '') ? formatDate(value) : value
}

export function parseCheckpoint(text) {
  if (!text) return null
  const out = {}
  for (const part of String(text).split(',')) {
    const at = part.indexOf('=')
    if (at < 0) continue
    // Split on the FIRST `=` only: a value may contain one (an opaque token's leading slice is arbitrary
    // characters), and splitting on all of them would silently truncate it.
    out[part.slice(0, at).trim()] = part.slice(at + 1).trim()
  }
  return Object.keys(out).length ? out : null
}

// The checkpoint in words, or null when there is nothing recognizable in it to say.
//
// The raw keys name the adapter's bookkeeping rather than anything the reader owns: `budget_date` is which
// day a request counter belongs to, which is only ever interesting as the word "today", and `through` is a
// claim about data in hand rather than a request bound — so printing the pairs verbatim asks the reader to
// hold the adapter's model in their head to learn two simple facts. Both fingerprints are read, because
// what changed is the informative half: a `through` that did not move is a sync that fetched nothing new.
export function checkpointSummary(before, after) {
  const from = parseCheckpoint(before)
  const to = parseCheckpoint(after)
  if (!to) return null
  const parts = []
  if (to.through) {
    const moved = from?.through && from.through !== to.through
    parts.push(`caught up through ${syncLogDate(to.through)}`
      + (moved ? ` (was ${syncLogDate(from.through)})` : ''))
  }
  if (to.requests_used) {
    parts.push(`${to.requests_used} request${to.requests_used === '1' ? '' : 's'} used today`)
  }
  return parts.length ? parts.join(' · ') : null
}

// The span this call actually asked the provider for. A walking adapter makes many requests inside one
// call, so the useful summary is the outer span — the individual windows abut, and listing them all would
// say the same thing at twenty times the length.
//
// The request count is deliberately NOT repeated here. It is `requested_windows.length`, which is the same
// number the row's own counts already show, and printing it twice on one row ("21 requests … across 21
// requests") reads as two different figures that happen to agree.
export function windowSummary(windows) {
  const span = windowSpan(windows)
  return span ? `fetched ${syncLogDate(span.start)} – ${syncLogDate(span.end)}` : null
}

// The outer bounds of a set of windows, as raw ISO dates, or null when none are usable.
function windowSpan(windows) {
  if (!windows?.length) return null
  const starts = windows.map(w => w?.start).filter(Boolean).sort()
  const ends = windows.map(w => w?.end).filter(Boolean).sort()
  if (!starts.length || !ends.length) return null
  return { start: starts[0], end: ends[ends.length - 1] }
}

const DAYS_PER_YEAR = 365.25
const DAYS_PER_MONTH = 30.44

// A day count as a duration someone reads rather than counts. `days_requested` is stored as a raw number
// because that is what the adapter contract takes, but "3650 days" is a figure a reader has to do
// arithmetic on before it means anything, and the thing it means is "10 years".
function humanDuration(days) {
  if (!(days > 0)) return null
  if (days < 60) return `${Math.round(days)} days`
  const months = Math.round(days / DAYS_PER_MONTH)
  if (months < 24) return `${months} months`
  const years = Math.floor(days / DAYS_PER_YEAR)
  const rem = Math.round((days - years * DAYS_PER_YEAR) / DAYS_PER_MONTH)
  // Rounding at a year boundary can land on 12 (3650 days is 9 years and 11.9 months, i.e. 10 years).
  if (rem >= 12) return `${years + 1} years`
  return rem ? `${years} yr ${rem} mo` : `${years} years`
}

// How deep this call meant to go, and how deep it got. These are two different facts and the row used to
// show only the first, as a bare `asked for 3650 days` sitting next to a fetched span two and a half years
// wide — a contradiction a reader has to resolve unaided, when the resolution ("it ran out of allowance
// partway") is the single most useful thing the row knows.
//
// A walk's last window overshoots the target by up to its own width, so "reached what it asked for" is a
// near-match rather than an equality; inside that tolerance the shortfall clause is dropped, because
// naming a gap of a few days as a shortfall is its own kind of wrong. A cursor provider names no window at
// all, leaving just the readable depth — still an improvement on the raw day count, and honest about the
// fact that nothing here can say how far back that provider actually reached.
const DEPTH_SATISFIED_RATIO = 0.95

export function historyDepthSummary(daysRequested, windows) {
  const asked = humanDuration(daysRequested)
  if (!asked) return null
  const span = windowSpan(windows)
  const spanDays = span ? (Date.parse(span.end) - Date.parse(span.start)) / 86400000 : null
  if (!(spanDays > 0) || spanDays >= daysRequested * DEPTH_SATISFIED_RATIO) return `asked for ${asked}`
  const reached = humanDuration(spanDays)
  return reached ? `asked for ${asked}, reached ${reached}` : `asked for ${asked}`
}

// The metered allowance the pull left behind, in words: what is available now and, when that is nothing,
// how long until it is not.
//
// This is the line the log most needed and did not have. A row could say a sync "paused on the request
// limit" while the level of that limit lived only in a column the next sync overwrote — so the record named
// a cause the reader could not check, and "resumes on the next sync" was advice nobody could act on,
// because a bucket refilling at one token an hour does not care that a sync ran ten minutes later.
//
// The shared bucket and the per-account ones are reported apart because they fail differently: an empty
// shared bucket stops the whole connection, while one empty account bucket stops that account and leaves
// its siblings walking — which is exactly the state that fills a log with pause markers on a pull that was
// making progress throughout.
export function allowanceSummary(allowance) {
  const pools = allowance?.pools
  if (!pools || typeof pools !== 'object') return null
  const capacity = Number(allowance.capacity) || 0
  const refill = Number(allowance.refill_per_hour) || 0
  // An absent pool is a full one — the adapter drops a bucket once it refills completely, since a full
  // bucket and one that never existed grant exactly the same thing.
  const shared = pools.shared
  const accounts = Object.entries(pools).filter(([key]) => key !== 'shared')
  const parts = []
  if (shared != null) {
    parts.push(`${formatTokens(shared)} of ${capacity} shared requests left`)
  }
  const drained = accounts.filter(([, tokens]) => Number(tokens) < 1)
  if (drained.length) {
    parts.push(`${drained.length} account${drained.length === 1 ? '' : 's'} out of allowance`)
  } else if (accounts.length) {
    const lowest = Math.min(...accounts.map(([, t]) => Number(t)))
    parts.push(`${formatTokens(lowest)} left on the thinnest account`)
  }
  if (!parts.length) return null
  // Only worth saying when something is actually empty; while requests remain, when the next one arrives
  // is not a question anyone is asking.
  const emptiest = Math.min(...Object.values(pools).map(Number))
  if (emptiest < 1 && refill > 0) {
    parts.push(`next request in ~${formatHours((1 - emptiest) / refill)}`)
  }
  return parts.join(' · ')
}

function formatTokens(tokens) {
  const n = Math.max(0, Number(tokens) || 0)
  // Floored, never rounded up: this is a spendable count, and claiming a request that is not yet granted
  // is the error that costs a disabled token on a provider that meters strictly.
  return String(Math.floor(n))
}

function formatHours(hours) {
  if (!(hours > 0)) return 'moments'
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} min`
  return `${Math.round(hours)} hr`
}

// How the pull's requests were charged. A bare total cannot be reconciled against any single allowance,
// because a walk narrow enough to filter spends each account's own bucket while a wide one spends the
// shared bucket — and the two are the difference between one account being stuck and the connection being
// stuck. Null when the adapter recorded no attribution (rows predating it, and cursor providers).
export function requestPoolSummary(windows) {
  const attributed = (windows || []).filter(w => w?.pool)
  if (!attributed.length) return null
  const shared = attributed.filter(w => w.pool === 'shared').length
  const perAccount = attributed.length - shared
  const accounts = new Set(attributed.filter(w => w.pool !== 'shared').map(w => w.pool)).size
  const parts = []
  if (shared) parts.push(`${shared} shared`)
  if (perAccount) parts.push(`${perAccount} charged to ${accounts} account${accounts === 1 ? '' : 's'}`)
  return parts.length ? parts.join(', ') : null
}

// What a row's `mode` means to a reader, which is one distinction finer than what it stores.
//
// `mode` is derived server-side from `initial_sync_complete`, and that flag flips only when the backfill
// *finishes* — so a first pull that stops early (a metered provider pausing on its request allowance, a
// provider still preparing its data) leaves every later resume labelled `initial` too. Literally that is
// true of all of them: each ran while the backfill was unfinished. But it reads as several first syncs,
// and it hides the one thing separating them — whether this pull began the backfill or continued it.
//
// `cursor_before` answers that with no new state: it is empty on the pull that started from nothing and
// carries the previous resume point on every pull after it. A row that *finishes* the backfill still says
// "continuing" and picks up the row's own `backfill complete` badge, which reads correctly — it continued,
// and it finished.
export function syncModeLabel(entry) {
  const mode = (entry?.mode || '').trim()
  if (mode !== 'initial') return mode || null
  return String(entry?.cursor_before || '').trim() ? 'initial · continuing' : 'initial'
}

// `skipped` split into the unrelated events it folds together, because they carry opposite meanings: an
// account the user chose not to import is working as configured, an account with no mapping decision yet
// is waiting on the user, a row already held is the incremental overlap working exactly as designed, and a
// zero-amount row is a provider artifact. One number covering them either cries wolf on every routine sync
// or hides a real gap inside a routine-looking total.
//
// **Nothing here subtracts.** The server sums the buckets from `account_counts` — the only place they are
// stored — and sends them named, as `skipped_breakdown` (`_skipped_breakdown` in backend/routers/sync.py).
// The previous shape had two of the buckets stored as their own columns and recovered the third from the
// total's remainder, which quietly reassigned every newly-added bucket into whichever one was computed by
// subtraction. Reading named counts is what makes adding a bucket a safe, local change.
//
// A row predating the split reports its no-destination count under the legacy `skipped_no_account` key,
// which the server still emits for those rows; `null` (no breakdown recorded at all) stays distinct from
// every-bucket-zero, since a genuine all-zero-amount sync is the common shape for a provider that reports
// balance-only rows.
//
// Tone carries the whole editorial judgement, so it is worth stating: only two of these are ever a
// problem. An unmapped account is actionable, and already-held rows on a *first* import are a
// contradiction (nothing can already be held before the first import) — that one is what a
// transaction-id collision looks like from the outside, and it is the sole remaining reason a connection
// card turns orange. The rest are muted because they describe the system doing what it was told.
const SKIP_BUCKETS = [
  {
    key: 'skipped_by_choice', label: 'Not imported', tone: 'muted',
    title: 'From accounts set to skip. These were left out on purpose and need no action.',
  },
  {
    key: 'skipped_unknown_account', label: 'No destination', tone: 'warning',
    title: 'These transactions had no account to go into. Map the account to import them.',
  },
  {
    key: 'skipped_no_account', label: 'No destination', tone: 'warning',
    title: 'These transactions had no account to go into. Map the account to import them.',
  },
  {
    key: 'skipped_already_held', label: 'Already imported', tone: 'byMode',
    title: 'Already held from a previous sync — the incremental overlap re-asks for recent days on purpose.',
    conflictTitle: 'Already in the ledger from a different connection \u2014 the same transaction reported by two connections, which should not happen.',
  },
  {
    key: 'skipped_zero_amount', label: 'Zero amount', tone: 'muted',
    title: 'Rows the provider reported with no amount, which carry nothing to import.',
  },
]

export function skippedBreakdown(entry) {
  const counts = entry?.skipped_breakdown
  if (!counts || typeof counts !== 'object') return null
  // Already-held rows are only a contradiction when another connection brought them in, and the server is
  // what decides that (`unexplained_already_held`): overlap, a resumed backfill, a walk re-seeing its own
  // pages and a restore replaying the connection's own rows are all this connection re-seeing its own
  // work. Read rather than re-derived so this row, the connection card's chip, and the outcome pill cannot
  // reach different verdicts about one call. An entry without the figure falls back to the older reading.
  const unexplained = entry?.already_held_unexplained
  const conflict = unexplained === undefined || unexplained === null
    ? entry?.mode === 'initial' && !entry?.cursor_before
    : unexplained > 0
  return SKIP_BUCKETS
    .map(b => ({
      key: b.key,
      label: b.label,
      count: Number(counts[b.key] || 0),
      tone: b.tone === 'byMode' ? (conflict ? 'warning' : 'muted') : b.tone,
      title: b.tone === 'byMode' && conflict ? b.conflictTitle : b.title,
    }))
    .filter(b => b.count > 0)
}

// Where the call ended up, in words — the provider's own readiness signal for the last page it drained.
//
// This replaces a rendered `status_sequence`. That sequence held one entry per drained page, which for a
// walking adapter is one per request: a run of the same value twenty-odd chips long, whose only payload
// beyond `final_status` and `became_complete` was an anomalous mid-drain transition. That is a debugging
// concern rather than a reading one, so the full raw sequence stays in the pasteable support text while
// the row shows the single fact a reader arrives for.
//
// The vocabulary spans two providers, which is why the mapping lives here rather than with either of them:
// `BUDGET_PAUSED` is Luma's own marker for a metered walk that stopped on its request allowance (see
// backend/services/providers/simplefin.py), and the rest are Plaid's `transactions_update_status` values
// passed through unchanged. An unrecognized value returns null like everything else in this module, so a
// provider whose vocabulary this predates still shows its raw status rather than nothing.
const FINAL_STATUS_TEXT = {
  BUDGET_PAUSED: 'paused on the provider’s request allowance — resumes once it refills',
  RATE_LIMITED: 'the provider refused a request — its limit was reached before this app’s own count said so',
  NOT_READY: 'provider was still preparing this connection’s data',
  INITIAL_UPDATE_COMPLETE: 'recent transactions delivered, history still filling in',
  HISTORICAL_UPDATE_COMPLETE: 'all available history delivered',
  TRANSACTIONS_UPDATE_STATUS_UNKNOWN: 'provider could not report how far its update had reached',
}

export function finalStatusSummary(status) {
  if (!status) return null
  return FINAL_STATUS_TEXT[status] || null
}

// Which import cards this sync's rows landed on. The institution prefix is dropped because it is already
// the log row's own title, leaving the part that identifies the card on the Import/Export page.
export function cardSummary(cards, institution) {
  if (!cards?.length) return null
  const prefix = institution ? `${institution} · ` : null
  return cards
    .map(c => `${prefix && c.card?.startsWith(prefix) ? c.card.slice(prefix.length) : c.card} (${c.added})`)
    .join(', ')
}
