// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// What a data connection says about itself on the Import page's Connections tab: the outcome pill, the
// last-synced line, and the per-account chips, which are the same chips an import card's outcome row
// uses — so a user reading a connection's card and then the cards its sync wrote cannot be told two
// stories about one pull.
//
// Nothing here fetches or acts. These are pure renderers over what the providers listing already says.

import { OutcomeChip, SourceAccountChip } from '../importExport/SourceAccountChip.jsx'
import { allowanceSummary } from '../../lib/requestAllowance.js'
import { HOVER_OPEN_DELAY_MS, Tooltip } from '../ui.jsx'
import { useRelativeTimestamp } from '../../lib/useRelativeTimestamp.js'

// When a connection last succeeded, as an age to read at a glance with the exact moment on hover. The
// pairing is the rule, not a nicety: a relative label is computed at render and would otherwise drift on
// a page left open, so the absolute value has to stay one hover away (see `useRelativeTimestamp`).
//
// A metered provider's requests left (`request_allowance` on the connection) share the hover: they say
// whether the next sync can run, which is the question the last-synced age raises.
export function LastSyncedLine({ lastSyncedAt, requestAllowance, style }) {
  const { label, absolute } = useRelativeTimestamp(lastSyncedAt)
  const allowance = allowanceSummary(requestAllowance)
  const text = label ? `synced ${label}` : 'never synced'
  const lines = [absolute ? `Last synced ${absolute}` : null, allowance ? `Requests: ${allowance}` : null]
    .filter(Boolean)
  return (
    <HoverLines lines={lines}>
      <span style={{ fontSize: 12, color: 'var(--muted)', ...style }}
        aria-label={[text, ...lines].join('. ')}>
        {text}
      </span>
    </HoverLines>
  )
}

// Plain-text hover lines, one per row, on the shared `Tooltip` with a short dwell so a pointer passing
// over does not flash it. Renders the trigger alone when there is nothing to say.
export function HoverLines({ lines, children }) {
  return (
    <Tooltip openDelay={HOVER_OPEN_DELAY_MS}
      content={lines?.length ? lines.map(line => <div key={line}>{line}</div>) : null}>
      {children}
    </Tooltip>
  )
}

// A small pill for the connection cards' at-a-glance state. `tone` picks the colour role rather than a
// literal colour, so the same component covers "needs attention" and "something is wrong".
//
// `muted` is the fourth role and the quiet one: a state that is neither normal nor wrong, such as a
// watched folder deliberately switched off. It has no colour of its own precisely so it cannot be read
// as a problem — the pill's shape is what makes it a state rather than a word in a sentence.
//
// `small` is for a pill that sits in a list row rather than on a card: beside a 10px column label or a
// line of 11px metadata, the full-size pill is the largest thing in the row and reads as the point of
// it. It stays legible because it keeps its weight; only the type and the padding come down.
export function StatusPill({ tone = 'accent2', small = false, children, title, onClick }) {
  const color = tone === 'danger' ? 'var(--danger, #dc2626)'
    : tone === 'warning' ? 'var(--warning)'
      : tone === 'muted' ? 'var(--muted)'
        : 'var(--accent2)'
  const Tag = onClick ? 'button' : 'span'
  return (
    <Tag
      {...(onClick ? { type: 'button', onClick } : {})}
      title={title}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        padding: small ? '0 6px' : '1px 8px', borderRadius: 999,
        fontSize: small ? 10 : 11, fontWeight: 600,
        background: `color-mix(in srgb, ${color} 12%, var(--surface2))`,
        color,
        border: `1px solid color-mix(in srgb, ${color} 50%, var(--border))`,
        cursor: onClick ? 'pointer' : 'default',
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </Tag>
  )
}

// Wording for the last sync's outcome. The labels name the *result* rather than repeating the action:
// these render immediately after the words "Last sync", where "Synced" and "Sync failed" said the verb
// twice and left the reader looking for a time where a status actually was.
//
// Wording for the last sync's outcome. The outcome itself is decided in `services/providers/config.py`
// (`_sync_outcome`) and only rendered here, so the card and the sync log can never describe the same call
// differently. Each label names the effect on the user's data rather than the mechanism behind it: a walk
// that stopped on the provider's request budget is "more history to fetch", because "budget paused" means
// nothing to someone who does not know the provider meters requests.
const SYNC_OUTCOMES = {
  failed: {
    label: 'Failed', tone: 'danger',
    title: 'The last sync did not complete. Nothing new was imported.',
  },
  attention: {
    label: 'Success · check the log', tone: 'warning',
    title: 'The sync succeeded, but some transactions did not make it into the ledger. Open the sync log for the detail.',
  },
  incomplete: {
    label: 'Success · more history to fetch', tone: 'accent2',
    title: 'Everything the provider offered this time was imported, and older history is still outstanding — the next sync continues from where this one stopped.',
  },
  ok: { label: 'Success', tone: null, title: 'The last sync completed and imported everything it was offered.' },
}

// The outcome of the last sync, laid out like the Import history card's own outcome row and built
// from the same chips (`SourceAccountChip`) — a sync and a file import answer the same question, and a
// user reads the two surfaces minutes apart, so they should not look like different features.
//
// `onToggleDetail` makes the "Last sync" label a disclosure for the per-account chips, which the caller
// supplies as `providerAccounts` while `detailOpen`. Closed by default at the call site: one chip per
// account is most of a card's height for something most visits never look at.
export function LastSyncSummary({ lastSync, syncing, providerAccounts = [], onOpenLog, onOpenReport,
  detailOpen = false, onToggleDetail = null }) {
  if (syncing) {
    return (
      <div style={{ fontSize: 12, color: 'var(--muted)' }}>
        <span style={{ color: 'var(--accent2)', fontWeight: 600 }}>Syncing…</span>{' '}
        importing transactions from this connection.
      </div>
    )
  }
  if (!lastSync) return null
  const outcome = SYNC_OUTCOMES[lastSync.outcome] || SYNC_OUTCOMES.ok
  const n = (v) => Number(v || 0).toLocaleString()
  const rowTotal = (lastSync.added || 0) + (lastSync.updated || 0) + (lastSync.removed || 0)
  // Every account the connection offers, not only those that received something. An account that imported
  // nothing is exactly what this exists to surface, and it cannot appear in a tally built from what landed
  // — which is why the chips are driven from the offered list and the counts merely joined onto it.
  //
  // The count is rows *seen* for the account, not rows landed, which is what an import card's chip has
  // always meant (`import_batch_account.row_count`, whether or not the account was skipped). Feeding this
  // one `added` alone made the shared chip mean two different things on the two surfaces: a skipped
  // account showed a bare `✕` here and `✕ … 35` there, so the connection card could not say how much data
  // a skipped account was turning away. Only the two no-destination buckets are added in — they arise
  // solely for accounts with no local account, so a mapped account's `−` (offered rows, imported none)
  // cannot be flipped to a `✓` by the routine already-held and zero-amount skips.
  const chips = providerAccounts.map(pa => {
    const c = lastSync.accounts?.[pa.external_account_id]
    return {
      ...pa,
      added: (c?.added || 0) + (c?.skipped_by_choice || 0) + (c?.skipped_unknown_account || 0),
    }
  })
  // Already-held rows another connection brought in — decided server-side by `unexplained_already_held`
  // and stored on the summary, not re-derived here. Re-deriving it from `mode` is what made this chip
  // disagree with the outcome pill beside it and with the sync log behind it: `mode` stays `initial` for
  // every call of a backfill a metered provider spreads over days, a walking adapter's overlapping pages
  // re-offer rows the same call just imported, and a restore puts a connection's own rows back before its
  // next pull. All of it is routine, and all of it used to light this up.
  // A summary written before the server sent the figure has no key, which reads as nothing to report —
  // the next sync fills it in, and staying quiet is the right way to be wrong about a warning.
  //
  // This is the only remaining outcome chip: rows with no destination are carried by the `✕` chips beside
  // it, per account and with their counts, which is both more informative and unambiguous — a separate
  // total sat next to a row of `✕` chips and read as a count of them whenever the two happened to agree.
  const heldUnexplained = Number(lastSync.already_held_unexplained || 0)
  // The import cards this pull wrote to, and whether its rows are still individually identified. Both come
  // from the stored summary rather than being inferred here: `scoped_rows` is 0 both when a pull added
  // nothing and when it added more than the server keeps a row list for, and the card has no way to tell
  // those apart — nor any need to, since the answer is the same either way.
  const reportCards  = lastSync.cards || []
  const reportRows   = Number(lastSync.scoped_rows || 0)
  const reportScoped = reportRows > 0

  return (
    <div style={{ display: 'grid', gap: 6, fontSize: 12, color: 'var(--muted)' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        {onToggleDetail ? (
          <button type="button" onClick={onToggleDetail}
            title={detailOpen
              ? 'Hide what the last sync did for each account'
              : 'Show what the last sync did for each account'}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              background: 'none', border: 'none', padding: 0, cursor: 'pointer',
              font: 'inherit', color: 'var(--muted)',
            }}>
            <span aria-hidden style={{ fontSize: 10 }}>{detailOpen ? '▾' : '▸'}</span>
            <span>Last sync</span>
          </button>
        ) : <span style={{ color: 'var(--muted)' }}>Last sync</span>}
        {outcome.tone
          ? <StatusPill tone={outcome.tone} title={outcome.title} onClick={onOpenLog}>{outcome.label}</StatusPill>
          : <span title={outcome.title} style={{ color: 'var(--text)' }}>{outcome.label}</span>}
        <span style={{ fontVariantNumeric: 'tabular-nums' }}>
          {rowTotal ? `${n(rowTotal)} row${rowTotal === 1 ? '' : 's'}` : 'no new transactions'}
        </span>
        {/* The same `↗` launcher used elsewhere on this card, and it opens the ledger over this page
            rather than navigating: finding the right card on the Import history page was the
            entire friction this removes.
            The two modes are named rather than left to look identical, because they answer different
            questions — one shows what this pull delivered, the other the card it landed on, which by
            then usually holds earlier syncs' rows too. Both are useful; being told which one is open
            is what keeps the count in the drawer from reading as a contradiction of the count here. */}
        {onOpenReport && reportCards.length ? (
          <button
            type="button"
            onClick={onOpenReport}
            title={reportScoped
              ? `Review the ${n(reportRows)} transaction${reportRows === 1 ? '' : 's'} from this sync`
              : 'Open the import card this sync added to'}
            style={{
              background: 'none', border: 'none', padding: '0 2px', cursor: 'pointer',
              color: 'var(--accent2)', fontSize: 11, lineHeight: 1, opacity: 0.75,
            }}
          >↗</button>
        ) : null}
      </div>
      {chips.length ? (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          {chips.map(c => (
            <SourceAccountChip
              key={c.external_account_id}
              label={c.label}
              count={c.added}
              skipped={c.mapping_mode === 'skip'}
            />
          ))}
          {heldUnexplained ? (
            <OutcomeChip
              label="Already imported" count={heldUnexplained} tone="warning" onClick={onOpenLog}
              title="Already in the ledger from a different connection — the same transactions reported by two connections. Open the sync log."
            />
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
