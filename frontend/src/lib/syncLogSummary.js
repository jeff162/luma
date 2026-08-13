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
// call, so the useful summary is the outer span plus how many requests bought it — the individual windows
// abut, and listing them all would say the same thing at twenty times the length.
export function windowSummary(windows) {
  if (!windows?.length) return null
  const starts = windows.map(w => w?.start).filter(Boolean).sort()
  const ends = windows.map(w => w?.end).filter(Boolean).sort()
  if (!starts.length || !ends.length) return null
  const span = `${syncLogDate(starts[0])} – ${syncLogDate(ends[ends.length - 1])}`
  return windows.length === 1 ? `fetched ${span}` : `fetched ${span} across ${windows.length} requests`
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
