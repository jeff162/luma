// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// The connection sync log: one row per connection per sync call, and one per every other operation on a
// data connection — a connect (including one that failed before any connection existed), reconnect, account
// refresh, disconnect, and a credential reissue or vault-reset revoke. The name stayed; the scope grew,
// because a sync that fails is usually explained by one of those beside it (backend/services/connection_log.py).
//
// **It lives with the connections it describes, not in Settings.** It sat there because a read-only
// diagnostic looks administrative, and the cost was that seeing what a sync had just done meant leaving
// the page the sync was started from. The rule that moved it: what an action
// produces belongs where the action is taken. Settings keeps what genuinely describes the install; a log
// about one subsystem owes itself back to that subsystem's own surface.
//
// It answers the two questions a connection cannot answer about itself: "did this sync fetch everything?"
// (the status sequence — a full historical backfill against a stop at the provider's initial window) and
// "why did nothing arrive?" (the warnings and advisories, which for the second reason are recorded
// nowhere else).

import { useCallback, useEffect, useState } from 'react'
import { api } from '../../lib/api.js'
import { AppDialog, Button, RefreshButton } from '../ui.jsx'
import { OutcomeChip } from '../importExport/SourceAccountChip.jsx'
import {
  allowanceSummary, cardSummary, checkpointSummary, connectionEventSummary, finalStatusSummary,
  historyDepthSummary, requestPoolSummary, skippedBreakdown, syncLogDate, syncModeLabel, windowSummary,
} from '../../lib/syncLogSummary.js'
import { connectionProviderLabel } from '../../lib/connectionSummary.js'
import { parseTimestamp } from '../../lib/utils.js'

// A stable default, so an omitted prop does not read as a new selection on every render.
const EMPTY_IDS = []

// What a row is about: the institution, or — for a connect that failed before the provider named one —
// the provider itself.
function rowTitle(entry) {
  return entry.institution || connectionProviderLabel(entry.provider)
}

// A pill's name. Two kinds of pill have no live connection behind them, and each says so: a connection
// the log remembers only for its disconnect, and the provider's connect attempts that never became one.
function pillLabel(c) {
  if (!c.connection_id) return `${connectionProviderLabel(c.provider)} connect attempts`
  return c.disconnected ? `${c.institution} (disconnected)` : c.institution
}

const CHIP = { padding: '1px 7px', borderRadius: 999, background: 'var(--surface2)', color: 'var(--muted)' }
const ERROR_CHIP = {
  padding: '1px 7px', borderRadius: 999,
  background: 'color-mix(in srgb, var(--danger) 16%, var(--surface2))', color: 'var(--danger)',
}

// What the provider itself said about a failure (`detail.provider_error`), one field a line: the row's
// error is the readable version, and this is the original — the part a support request needs, above all
// the request id. A documentation link is a link.
function ProviderErrorDetail({ entry }) {
  const fields = entry.detail?.provider_error
  if (!fields || typeof fields !== 'object') return null
  return (
    <div style={{ display: 'grid', gap: 2, color: 'var(--muted)', fontSize: 11 }}>
      {Object.entries(fields).map(([key, value]) => (
        <div key={key} style={{ wordBreak: 'break-word' }}>
          {key}:{' '}
          {key === 'documentation_url' && /^https:\/\//.test(String(value))
            ? <a href={value} target="_blank" rel="noreferrer noopener" style={{ color: 'var(--accent2)' }}>{value}</a>
            : <span style={{ fontFamily: 'monospace', color: 'var(--text)' }}>{String(value)}</span>}
        </div>
      ))}
    </div>
  )
}

// The row's collapsed tier. Collapsed always, never opened by default — including for an error row: what an
// error row owes the reader is the error, which sits in the always-visible half.
function DetailsToggle({ children }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <div>
        <button
          onClick={() => setOpen(v => !v)}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', fontSize: 11, fontWeight: 600, padding: '2px 0', display: 'inline-flex', alignItems: 'center', gap: 6 }}
        >
          <span style={{ fontSize: 9 }}>{open ? '▾' : '▸'}</span>
          Details
        </button>
      </div>
      {open ? <div style={{ display: 'grid', gap: 6, paddingLeft: 15 }}>{children}</div> : null}
    </>
  )
}

// A row that is not a sync: the operation, what came of it, and its error. None of a sync's counts apply,
// and rendering them as zeros would say an operation that fetches nothing fetched nothing. Details only
// when there is something behind them — the provider's own account of a failure.
function EventRow({ entry, summary, when }) {
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '8px 10px', display: 'grid', gap: 6, fontSize: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 600, fontSize: 13 }}>{rowTitle(entry)}</span>
        <span style={CHIP}>{summary.label}</span>
        {entry.error ? <span style={ERROR_CHIP}>error</span> : null}
        <span style={{ marginLeft: 'auto', color: 'var(--muted)' }}>{when}</span>
      </div>
      {summary.text ? <div style={{ color: 'var(--text)' }}>{summary.text}</div> : null}
      {entry.error ? (
        <div style={{ color: 'var(--danger)', fontFamily: 'monospace', fontSize: 11, wordBreak: 'break-word' }}>{entry.error}</div>
      ) : null}
      {entry.detail?.provider_error ? (
        <DetailsToggle><ProviderErrorDetail entry={entry} /></DetailsToggle>
      ) : null}
    </div>
  )
}

function SyncLogRow({ entry }) {
  // Degrade gracefully if a timestamp can't be parsed (e.g. a pre-fix malformed value) — show the raw
  // string rather than "Invalid Date".
  const parsedWhen = entry.started_at ? parseTimestamp(entry.started_at) : null
  const when = parsedWhen && !isNaN(parsedWhen) ? parsedWhen.toLocaleString() : (entry.started_at || '—')
  const summary = connectionEventSummary(entry)
  if (summary) return <EventRow entry={entry} summary={summary} when={when} />
  return <SyncRow entry={entry} when={when} />
}

function SyncRow({ entry, when }) {
  const modeLabel = syncModeLabel(entry)
  // The provider's backfill-readiness signal — Plaid's `transactions_update_status`, or SimpleFIN's
  // budget-pause marker. Read from `final_status` rather than the per-page `status_sequence`: the sequence
  // is one entry per drained page, so a walking adapter fills it with one identical value per request, and
  // where a call *ended up* is the question a reader has. The raw sequence is still recorded and still
  // travels in the pasteable support text, where a mid-drain anomaly would be the finding.
  //
  // A provider with no such concept reports nothing, so an absent status renders nothing rather than a row
  // reading `status: null` — which says "something is broken" when it in fact means "this provider does not
  // report one". An unrecognized value falls back to the raw string, kept monospace to read as the
  // uninterpreted token it is.
  const statusPhrase = finalStatusSummary(entry.final_status)
  // How many requests the pull actually spent, which for a walking adapter is the number that answers
  // "why did this take so long" — `pages` is a cursor provider's notion and reads 1 for every walk, however
  // many requests it made. Kept as the fallback for the providers where it is the true figure.
  const requests = entry.requested_windows?.length || null
  const cards = cardSummary(entry.card_counts, entry.institution)
  const skipped = skippedBreakdown(entry)
  // What the call covered: the span it actually fetched, reconciled against the depth it set out for. Two
  // separate facts, joined on one line because either alone invites the wrong conclusion — a span with no
  // target reads as complete, and a target with no span reads as achieved.
  const coverage = [windowSummary(entry.requested_windows),
  historyDepthSummary(entry.days_requested, entry.requested_windows)].filter(Boolean).join(' · ')
  // The consumable this pull spent. Always visible rather than filed under Details, because for a metered
  // provider it is the reason the row looks the way it does — a pull that stopped early and a pull that had
  // nothing left to fetch are indistinguishable without it.
  const allowance = allowanceSummary(entry.request_allowance)
  const pools = requestPoolSummary(entry.requested_windows)
  // How far back each account got on THIS call. `connection_account` holds only where each one stands now,
  // overwritten every sync, so this is the only place a past pull's reach survives — and on a walk that
  // pauses per account, "which ones actually moved" is the question the row exists to answer.
  // The provider prefix is dropped the same way the card summary drops the institution: it namespaces the
  // id and is already the row's own title, so it is the one part that identifies nothing here.
  const accountPrefix = entry.provider ? `${entry.provider}:` : null
  const reachRows = Object.entries(entry.account_counts || {})
    .filter(([, c]) => c?.reached)
    .map(([account, c]) => {
      const name = accountPrefix && account.startsWith(accountPrefix)
        ? account.slice(accountPrefix.length) : account
      return `${name} → ${syncLogDate(c.reached)}${c.history_complete ? ' (end of history)' : ''}`
    })
  // The raw fingerprints stay as the fallback: a provider whose checkpoint this cannot interpret must still
  // show *something*, since whether the token advanced is the first question a stalled sync raises.
  const checkpoint = checkpointSummary(entry.cursor_before, entry.cursor_after)
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '8px 10px', display: 'grid', gap: 6, fontSize: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 600, fontSize: 13 }}>{rowTitle(entry)}</span>
        {modeLabel ? <span style={CHIP}>{modeLabel}</span> : null}
        {entry.became_complete ? (
          <span style={{ padding: '1px 7px', borderRadius: 999, background: 'color-mix(in srgb, var(--success, #16a34a) 16%, var(--surface2))', color: 'var(--success, #16a34a)' }}>backfill complete</span>
        ) : null}
        {entry.error ? <span style={ERROR_CHIP}>error</span> : null}
        <span style={{ marginLeft: 'auto', color: 'var(--muted)' }}>{when}</span>
      </div>
      {/* What the sync did, in the effect vocabulary the connection card uses. First because it is the one
          line that answers "what happened", which every other line on the row only elaborates on. */}
      {statusPhrase ? (
        <div style={{ color: 'var(--text)' }}>{statusPhrase}</div>
      ) : entry.final_status ? (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={{ color: 'var(--muted)' }}>status:</span>
          <span style={{ fontFamily: 'monospace', fontSize: 11, padding: '1px 6px', borderRadius: 4, background: 'var(--surface2)' }}>{entry.final_status}</span>
        </div>
      ) : null}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', color: 'var(--muted)' }}>
        <span>added <b style={{ color: 'var(--text)' }}>{entry.added}</b></span>
        <span>updated <b style={{ color: 'var(--text)' }}>{entry.updated}</b></span>
        <span>removed <b style={{ color: 'var(--text)' }}>{entry.removed}</b></span>
        <span>skipped <b style={{ color: 'var(--text)' }}>{entry.skipped}</b></span>
        {/* Label first, like every other count on this row. The old `21 requests` put the number first,
            which read as a different kind of fact than the four figures beside it. */}
        {requests
          ? <span>requests <b style={{ color: 'var(--text)' }}>{requests}</b></span>
          : <span>pages <b style={{ color: 'var(--text)' }}>{entry.pages}</b></span>}
      </div>
      {/* The skip total split into the three unrelated events it folds together, as the same `OutcomeChip`s
          the connection card uses for these facts — the card deep-links here, so the two must not drift in
          wording or in which of them reads as a problem. */}
      {skipped ? (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          {skipped.map(b => (
            <OutcomeChip key={b.key} label={b.label} count={b.count} tone={b.tone} title={b.title} />
          ))}
        </div>
      ) : null}
      {coverage ? (
        <div style={{ color: 'var(--muted)' }}>{coverage}</div>
      ) : null}
      {allowance ? (
        <div style={{ color: 'var(--muted)' }}>
          allowance: <span style={{ color: 'var(--text)' }}>{allowance}</span>
        </div>
      ) : null}
      {/* Where the rows went. A sync files each row under its own transaction month, so one pull lands on
          as many cards as it spans — and the Import page shows one card at a time, which makes an
          `added` total that matches no visible card read as rows having gone missing. */}
      {cards ? (
        <div style={{ color: 'var(--muted)' }}>
          rows filed on <span style={{ color: 'var(--text)' }}>{cards}</span>
        </div>
      ) : null}
      {entry.error ? (
        <div style={{ color: 'var(--danger)', fontFamily: 'monospace', fontSize: 11, wordBreak: 'break-word' }}>{entry.error}</div>
      ) : null}
      {/* Warnings are the bank-level ones the connection card also shows, so they stay in the always-visible
          half: they are the reader's to act on. Advisories are the ones nobody can act on (what the provider
          said about our request shape, and rows that had nowhere to be imported) — this log is still their
          only home, but that home is the tier below. */}
      {(entry.warnings || []).map((w, i) => (
        <div key={`w${i}`} style={{ color: 'var(--warning)', fontSize: 11, wordBreak: 'break-word' }}>⚠ {w}</div>
      ))}
      {/* The provider's own bookkeeping, behind a toggle. Everything above answers a question about the
          user's data; everything below answers one about the sync machinery, and mixing the two at one
          visual weight is what made a routine budget-paused walk read as a wall of alarming output. A row
          that springs open is a row that has decided the reader is debugging. */}
      <DetailsToggle>
        {/* What the provider said about a failure, first: it is the one thing here that explains the
              error line above. */}
        <ProviderErrorDetail entry={entry} />
        {/* Which bucket paid for each request. Below the fold because the headline figure is how many
              requests the pull spent; this answers the follow-up, which only a stuck connection asks. */}
        {pools ? <div style={{ color: 'var(--muted)', fontSize: 11 }}>requests: {pools}</div> : null}
        {reachRows.length ? (
          <div style={{ color: 'var(--muted)', fontSize: 11 }}>
            reached: {reachRows.join(' · ')}
          </div>
        ) : null}
        {checkpoint ? (
          <div style={{ color: 'var(--muted)', fontSize: 11 }}>{checkpoint}</div>
        ) : (
          <div style={{ color: 'var(--muted)', fontFamily: 'monospace', fontSize: 11 }}>
            cursor {entry.cursor_before || 'none'} → {entry.cursor_after || 'none'}
          </div>
        )}
        {/* `×N` is how many of the call's requests drew the same remark — on a windowed history walk,
              "every one of them" reads very differently from "one". */}
        {(entry.advisories || []).map((a, i) => (
          <div key={`a${i}`} style={{ color: 'var(--muted)', fontSize: 11, wordBreak: 'break-word' }}>
            {a.message}{a.count > 1 ? <b style={{ color: 'var(--text)' }}> ×{a.count}</b> : null}
            {/* The request that drew it. Kept out of the message so the same remark from every window of a
                  walk stays one counted entry; shown as "first:" alongside a count, since with several
                  occurrences this names one of them rather than all. */}
            {a.context ? (
              <span style={{ opacity: 0.75 }}> ({a.count > 1 ? 'first: ' : ''}{a.context})</span>
            ) : null}
          </div>
        ))}
      </DetailsToggle>
    </div>
  )
}

// Plain-text rendering of the visible log, for pasting into a bug report or a support thread. Everything
// here is already non-identifying at the source — cursors are stored as fingerprints (length + leading
// slice, never the token) and the table holds no transaction data — so this needs no redaction pass of its
// own. Keep it that way: anything added to a log row shows up here too.
// The provider's own error fields, raw — the request id among them is what a provider's support asks for.
function providerErrorLines(entry) {
  const fields = entry.detail?.provider_error
  if (!fields || typeof fields !== 'object') return []
  return Object.entries(fields).map(([k, v]) => `  provider ${k}: ${v}`)
}

function syncLogAsText(entries, scopeLabel) {
  const lines = [`Luma connection sync log${scopeLabel ? ` — ${scopeLabel}` : ''} (${entries.length} entries, newest first)`, '']
  for (const e of entries) {
    // Any other operation is its event and its raw facts, for the reason the sync lines below print raw
    // values: whoever reads this is debugging, and the facts are the starting point.
    if ((e.event || 'sync') !== 'sync') {
      lines.push(`${e.started_at || '?'}  ${e.institution || e.provider || 'connection'} [${e.provider || '?'}] ${e.event}`)
      const facts = Object.entries(e.detail || {}).filter(([k]) => k !== 'provider_error')
      if (facts.length) lines.push(`  ${facts.map(([k, v]) => `${k} ${v}`).join(' · ')}`)
      if (e.error) lines.push(`  ERROR: ${e.error}`)
      lines.push(...providerErrorLines(e))
      lines.push('')
      continue
    }
    lines.push(`${e.started_at || '?'}  ${e.institution || e.provider || 'connection'} [${e.provider || '?'}] ${e.mode || '?'}`)
    const requests = e.requested_windows?.length
    // Raw throughout, including the day count the rendered row states as a duration: this is the artifact
    // someone debugs from, and a derived figure is a worse starting point than the value it came from.
    // The skip buckets are printed under their own keys rather than the rendered labels, and every bucket
    // the row carries is printed — including ones this build does not know about, so a log pasted from a
    // newer version is not silently trimmed on its way into a bug report.
    const skips = Object.entries(e.skipped_breakdown || {}).map(([k, v]) => `${k} ${v}`).join(', ')
    lines.push(`  added ${e.added} · updated ${e.updated} · removed ${e.removed} · skipped ${e.skipped}`
      + (skips ? ` (${skips})` : '')
      + ` · ${requests ? `${requests} request(s)` : `pages ${e.pages}`} · asked for ${e.days_requested ?? '—'} days`)
    const cards = cardSummary(e.card_counts, e.institution)
    if (cards) lines.push(`  rows filed on ${cards}`)
    // The *full* per-page sequence, unlike the rendered row, which shows only where the call ended up. This
    // text exists to be read by someone debugging, and the one thing the sequence holds over `final_status`
    // is a mid-drain anomaly — a status regressing, or a value nobody expected — which is visible only with
    // every page's entry in order. Statuses the provider never reported are still dropped: a walking adapter
    // emits `null` on most pages, and rendering those would bury the transitions this line exists to show.
    // The completion marker shared this line, so it is kept on its own rather than lost along with them.
    const statuses = (e.status_sequence || []).filter(s => s != null)
    const state = [
      statuses.length ? `status ${statuses.join(' → ')}` : null,
      e.became_complete ? 'backfill complete' : null,
    ].filter(Boolean)
    if (state.length) lines.push(`  ${state.join(' · ')}`)
    const checkpoint = [windowSummary(e.requested_windows), checkpointSummary(e.cursor_before, e.cursor_after)]
      .filter(Boolean).join(' · ')
    if (checkpoint) lines.push(`  ${checkpoint}`)
    // Raw pool levels, not the interpreted line: whoever reads this is checking our accounting against the
    // provider's, and the fractional token counts are the thing being checked.
    if (e.request_allowance?.pools) {
      const pools = Object.entries(e.request_allowance.pools).map(([k, v]) => `${k}=${v}`).join(', ')
      lines.push(`  allowance: capacity ${e.request_allowance.capacity}`
        + ` · +${e.request_allowance.refill_per_hour}/hr · pools {${pools}}`)
    }
    for (const [account, c] of Object.entries(e.account_counts || {})) {
      if (!c?.reached) continue
      lines.push(`  reached ${account} → ${c.reached}${c.history_complete ? ' (complete)' : ''}`)
    }
    // The raw fingerprints stay in the pasteable copy even when the line above interpreted them: this text
    // exists to be read by someone debugging, for whom "the token did not advance" is the finding, and an
    // interpretation is a worse artifact than the value it was derived from.
    lines.push(`  cursor ${e.cursor_before || 'none'} → ${e.cursor_after || 'none'}`)
    if (e.error) lines.push(`  ERROR: ${e.error}`)
    lines.push(...providerErrorLines(e))
    for (const w of e.warnings || []) lines.push(`  WARNING: ${w}`)
    for (const a of e.advisories || []) {
      const times = a.count > 1 ? ` (×${a.count})` : ''
      const where = a.context ? ` [${a.count > 1 ? 'first: ' : ''}${a.context}]` : ''
      lines.push(`  note: ${a.message}${times}${where}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

// The dialog and its state in one component, so the refresh can sit on the dialog's title.
function ConnectionSyncLogBody({ initialConnectionIds = EMPTY_IDS, initialProviders = EMPTY_IDS, onClose }) {
  // Read-only viewer over connection_sync_log. It answers the two questions a connection can't answer
  // about itself: "did this sync fetch everything?" (the status sequence — a full historical backfill vs.
  // a stop at the ~30-day Initial Update) and "why did nothing arrive?" (the warnings and advisories,
  // which for the second reason are recorded nowhere else).
  const [entries, setEntries] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [clearing, setClearing] = useState(false)
  const [copied, setCopied] = useState(false)
  // What the list is scoped to — seeded by whatever opened it (one connection, or one provider's card),
  // then adjustable here with the pills below. Two kinds, and a row matching either is shown: `subjects`
  // are pill keys (a connection id, or `connect:<provider>` for connect attempts), and `providers` take in
  // every row of a provider, which is how a provider's card includes what it has no ids for. Filtered
  // server-side, because rows are not small (a deep walk records every request it made). Both empty means
  // no filter, which is what makes "no pill pressed" show everything.
  const [scope, setScope] = useState(() => ({
    subjects: initialConnectionIds.filter(Boolean), providers: initialProviders.filter(Boolean),
  }))
  // Rows per pill *in the log*, from the same response and deliberately unfiltered — these label and size
  // the pills, so they have to keep describing every subject while some are filtered out.
  const [counts, setCounts] = useState([])
  // How many rows matched, against how many were sent: past the payload bound the list is the newest of
  // them, and says so, rather than reading as the complete history.
  const [total, setTotal] = useState(0)
  const [retentionDays, setRetentionDays] = useState(null)
  const [savingRetention, setSavingRetention] = useState(false)

  // Re-seeded only when the *set* of starting values changes. A caller builds the arrays inline, so
  // depending on the arrays themselves would reset the user's own pill choices on every render of the page
  // behind the dialog.
  const initialKey = JSON.stringify([initialConnectionIds.filter(Boolean), initialProviders.filter(Boolean)])
  useEffect(() => {
    const [subjects, providers] = JSON.parse(initialKey)
    setScope({ subjects, providers })
  }, [initialKey])

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await api.getSyncDiagnostics({ subjects: scope.subjects, providers: scope.providers })
      setEntries(res.entries || [])
      setCounts(res.counts || [])
      setTotal(res.total ?? (res.entries || []).length)
      setRetentionDays(res.retention_days ?? null)
    } catch (e) {
      setError(e.message || 'Could not load the sync log.')
      setEntries([])
    } finally {
      setLoading(false)
    }
  }, [scope])

  useEffect(() => { load() }, [load])

  async function clearLog() {
    setClearing(true)
    setError('')
    try {
      await api.clearSyncDiagnostics()
      setEntries([])
    } catch (e) {
      setError(e.message || 'Could not clear the sync log.')
    } finally {
      setClearing(false)
    }
  }

  async function saveRetention(days) {
    setSavingRetention(true)
    setError('')
    try {
      await api.setSyncLogRetention(days)
      await load()
    } catch (e) {
      setError(e.message || 'That setting could not be saved.')
    } finally {
      setSavingRetention(false)
    }
  }

  const filtered = scope.subjects.length > 0 || scope.providers.length > 0
  const isOn = c => scope.subjects.includes(c.subject) || scope.providers.includes(c.provider)
  const scopeLabel = counts.filter(isOn).map(pillLabel).join(', ')

  function togglePill(c) {
    if (!isOn(c)) {
      setScope(prev => ({ ...prev, subjects: [...prev.subjects, c.subject] }))
    } else if (scope.providers.includes(c.provider)) {
      // Turning off one pill of a provider-wide scope keeps that provider's other pills on — now named
      // one by one, since "every row of this provider" no longer describes the selection.
      const siblings = counts.filter(o => o.provider === c.provider && o.subject !== c.subject).map(o => o.subject)
      setScope(prev => ({
        providers: prev.providers.filter(p => p !== c.provider),
        subjects: [...new Set([...prev.subjects.filter(x => x !== c.subject), ...siblings])],
      }))
    } else {
      setScope(prev => ({ ...prev, subjects: prev.subjects.filter(x => x !== c.subject) }))
    }
  }

  async function copyForSupport() {
    try {
      await navigator.clipboard.writeText(syncLogAsText(entries || [], scopeLabel))
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (e) {
      setError(e.message || 'Could not copy the log.')
    }
  }

  return (
    <AppDialog
      title="Connection sync log"
      description="Every sync, connect, reconnect and disconnect of a data connection — how much arrived, whether the full history was fetched or the pull stopped early, and anything the provider reported along the way."
      onClose={onClose}
      width="min(860px, 100%)"
      actions={<Button variant="ghost" onClick={onClose}>Close</Button>}
      // A filter pill reloads the list too, and that load reaches the icon only through `useBusyIndicator`
      // — a quick one leaves it still, where the old relabelling button twitched on every pill click.
      refresh={<RefreshButton onRefresh={load} loading={loading} />}
    >
      <div style={{ display: 'grid', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Button small variant="ghost" onClick={copyForSupport} disabled={!(entries && entries.length)}
              title="Copy this log as text, to paste into a bug report. Contains no transaction data and no credentials.">
              {copied ? 'Copied' : 'Copy to clipboard'}
            </Button>
            <Button small variant="ghost" onClick={clearLog} disabled={clearing || !(entries && entries.length)}>{clearing ? 'Clearing…' : 'Clear log'}</Button>
          </div>
        </div>
        {/* One pill per subject that has rows here, replacing the old "Showing only X" banner rather than
          sitting beside it — two controls for one filter can disagree, and the banner could only ever say
          what the deep link had chosen. Only subjects present in the log are offered: a pill that filters
          to nothing is a dead end. A disconnected connection keeps a pill for as long as its disconnect
          row is in the log, and a provider's failed connects share one. */}
        {/* A single subject needs no pill — it would filter to what is already on screen. But an active
          filter always renders the row, so a deep link to a connection with no rows yet still offers a
          way back to everything instead of stranding the user on an empty list. */}
        {counts.length > 1 || filtered ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            {counts.map(c => {
              const on = isOn(c)
              const label = pillLabel(c)
              return (
                <button
                  key={c.subject}
                  type="button"
                  aria-pressed={on}
                  onClick={() => togglePill(c)}
                  title={on
                    ? `Showing ${label}. Click to stop filtering by it.`
                    : `Show only ${label}${filtered ? ' as well' : ''}.`}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6,
                    padding: '3px 10px', borderRadius: 99, fontSize: 12, cursor: 'pointer',
                    border: `1px solid ${on ? 'var(--accent)' : 'var(--border)'}`,
                    background: on ? 'color-mix(in srgb, var(--accent) 14%, var(--surface2))' : 'var(--surface2)',
                    color: on ? 'var(--text)' : 'var(--muted)',
                    fontWeight: on ? 600 : 400,
                  }}
                >
                  {label}
                  {/* Rows this log is holding for the subject, not operations ever run: the log keeps only
                    its retention window, so this is a count of what clicking would show. */}
                  <span style={{ fontVariantNumeric: 'tabular-nums', opacity: 0.7 }}>{c.count}</span>
                </button>
              )
            })}
            {filtered ? (
              <button
                type="button"
                onClick={() => setScope({ subjects: [], providers: [] })}
                /* "Clear filters", not "Show all": with every pill selected the list is already showing
                   everything, so a control promising to change that would be describing nothing. What it
                   does in both states is empty the selection. */
                style={{ background: 'none', border: 'none', padding: '0 4px', color: 'var(--accent2)', cursor: 'pointer', fontSize: 12, textDecoration: 'underline' }}
              >
                Clear filters
              </button>
            ) : null}
          </div>
        ) : null}
        {error ? <div style={{ fontSize: 12, color: 'var(--danger)' }}>{error}</div> : null}
        {entries && entries.length === 0 && !loading ? (
          <div style={{ fontSize: 13, color: 'var(--muted)' }}>
            {filtered
              ? `Nothing recorded for ${scopeLabel || 'this connection'} yet.`
              : 'Nothing recorded yet. Sync or connect a data connection, then Refresh here.'}
          </div>
        ) : null}
        {entries && entries.length ? (
          <div style={{ display: 'grid', gap: 8, maxHeight: 480, overflowY: 'auto' }}>
            {entries.map(e => <SyncLogRow key={e.id} entry={e} />)}
          </div>
        ) : null}
        {entries && total > entries.length ? (
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>
            Showing the newest {entries.length} of {total}. Filter by a connection to see its older entries.
          </div>
        ) : null}
        {/* The log's one setting, at its foot, in the shape the reimbursements report gives its reminder:
          a sentence around a single number. Rendered once the value is known and keyed on it, because the
          field is uncontrolled and would otherwise keep whatever it first showed. */}
        {retentionDays != null ? (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap',
            fontSize: 12.5, color: 'var(--muted)', borderTop: '1px solid var(--border)', paddingTop: 10,
          }}>
            <label htmlFor="sync-log-retention-days">Keep entries for</label>
            <input
              key={retentionDays}
              id="sync-log-retention-days"
              type="number"
              min="1"
              max="365"
              defaultValue={retentionDays}
              disabled={savingRetention}
              // On blur rather than per keystroke: shortening the window deletes the older entries at once,
              // so a request per digit could delete what the finished number would have kept.
              onBlur={e => {
                const next = Number(e.target.value)
                if (Number.isInteger(next) && next !== retentionDays) saveRetention(next)
              }}
              style={{
                font: 'inherit', fontSize: 12.5, width: 64, padding: '3px 6px', borderRadius: 6,
                border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)',
              }}
            />
            <span>days</span>
          </div>
        ) : null}
      </div>
    </AppDialog>
  )
}


// Opened from a button rather than standing on a page, all on the Import page's Connections tab: the
// whole log from the top of the tab, a provider's from its card, and a connection's from its last-sync
// pill.
//
// It was a permanent section under the import history at first, which was wrong in the same way its old
// home in Settings was wrong, just in the other direction: a diagnostic nobody needs most of the time
// should not occupy a screenful of a page people visit to import files. It is read on the specific
// occasion that a sync brought in less than expected — so it is behind a button, and it opens as a
// report the way the app's other read-only reports do (`AppDialog`, per `ReimbursementsReportDialog`).
//
// **Not one of the detached, minimize-to-nav viewers.** Those exist for reports a user keeps open while
// working elsewhere — a duplicate review, a reconciliation. This one is opened, read, and dismissed;
// giving it a nav pill would put a permanent affordance in the chrome for something with no state worth
// preserving across a navigation.
export function ConnectionSyncLogDialog({ initialConnectionIds = EMPTY_IDS, initialProviders = EMPTY_IDS, onClose }) {
  return (
    <ConnectionSyncLogBody
      initialConnectionIds={initialConnectionIds}
      initialProviders={initialProviders}
      onClose={onClose}
    />
  )
}
