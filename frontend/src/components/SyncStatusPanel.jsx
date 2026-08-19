// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// The floating readout for a running sync. Deliberately **not** modal: the backend stopped holding its
// write transaction across provider calls, so there is nothing to protect the user from while a sync runs
// and blocking the app would cost usability for no safety. `AppDialog`'s `draggable` mode gives exactly
// that — a panel with a click-through backdrop — rather than the heavier draggable/resizable
// `DetailPanelShell`, which is for reports the user works *inside* rather than glances at.
//
// What it shows is chosen for the question a waiting user actually has, which is not "what percent":
// there is no total to be a percent of, because a walk discovers where history ends by walking into it.
// So it reports what is known and true — how much has arrived and how many requests it took — and leaves
// the ending open.
//
// **The row set is the run's roster, fixed from the first frame, not whatever is running this instant.**
// A run is a sequence of HTTP calls with a wait between them and the sync marker cleared on each one's way
// out, so "running right now" is empty for several seconds of every cycle; rendering it directly made the
// panel grow and collapse on that rhythm, and collapse once more at the end as the connection rows gave
// way to a single provider total. Every connection the run covers is listed from the start, each row
// filling in as it goes and holding its final figures afterwards — so the same panel that answers "how is
// it going" answers "what happened" once it is over, without ever changing size. The roster and the
// arithmetic behind it live in `SyncStatusContext` and `lib/syncRoster.js`.

import { AppDialog, Button } from './ui.jsx'
import { providerLabel } from '../lib/importSourceFields.js'
import { rosterAdded, rosterRequests } from '../lib/syncRoster.js'

// A row-sized "still working" mark. The shared `Spinner` is a page-level block — 40px of padding around
// the word "Loading…" — so dropping it into a status line both dwarfed the line and said the wrong thing:
// nothing here is loading, a sync is running. The numbers beside it are the real progress signal; this
// only has to show that time is still passing.
const PULSE_KEYFRAMES = '@keyframes lumaSyncPulse { 0%, 100% { opacity: 0.25 } 50% { opacity: 1 } }'

// One connection, in whichever of its two states the run is in. The two are deliberately the same row —
// same width, same order, same wording for the count — so that a run ending changes a mark and a tense,
// not the shape of what the user was already reading.
function ConnectionRow({ institution, added = 0, requests = 0, running, error }) {
  const detail = running
    ? (added ? `${added} imported` : 'starting…')
    : (error ? 'could not sync' : added ? `${added} imported` : 'nothing new')
  return (
    <div style={{
      padding: '8px 12px', borderRadius: 8, background: 'var(--surface2)', fontSize: 13,
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        {running ? (
          <span aria-hidden style={{
            width: 7, height: 7, borderRadius: '50%', flexShrink: 0, alignSelf: 'center',
            background: 'var(--accent)', animation: 'lumaSyncPulse 1.4s ease-in-out infinite',
          }} />
        ) : (
          // Sized and positioned as the dot was, so a row settling does not shift its own text sideways.
          <span aria-hidden style={{
            width: 7, flexShrink: 0, alignSelf: 'center', lineHeight: 1, fontSize: 11,
            color: error ? 'var(--danger)' : 'var(--success)',
          }}>{error ? '!' : '✓'}</span>
        )}
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {institution}
        </span>
        <span style={{ color: 'var(--muted)', flexShrink: 0 }}>
          {detail}
          {requests ? ` · ${requests} request${requests === 1 ? '' : 's'}` : ''}
        </span>
      </div>
      {error ? (
        <div style={{ marginTop: 4, fontSize: 11, color: 'var(--muted)' }}>{error}</div>
      ) : null}
    </div>
  )
}

function FinishedRow({ provider, state }) {
  const r = state.result || {}
  const note = state.paused?.length
      ? 'Paused on the provider’s request limit — more history arrives on a later sync'
      : state.incomplete
        ? 'Still sending history — sync again in a minute to collect the rest'
        : 'Finished'
  return (
    <div style={{ padding: '8px 12px', borderRadius: 8, background: 'var(--surface2)', fontSize: 13 }}>
      <div style={{ display: 'flex', gap: 10 }}>
        <span style={{ flex: 1 }}>{provider}</span>
        <span style={{ color: 'var(--muted)' }}>
          {r.added || 0} added{r.updated ? `, ${r.updated} updated` : ''}{r.skipped ? `, ${r.skipped} skipped` : ''}
        </span>
      </div>
      <div style={{ marginTop: 4, fontSize: 11, color: 'var(--muted)' }}>{note}</div>
    </div>
  )
}

export function SyncStatusPanel({ connections = [], syncState = {}, runProviders = [], watching = false,
                                  onClose, onMinimize }) {
  // Scoped to the run in progress, not to everything `syncState` has accumulated. That map is keyed by
  // provider and keeps each one's last result for the life of the page (the Accounts cards read it that
  // way), so filtering it here is what stops a provider synced earlier from being reported as part of
  // this run — the panel is about *this* sync, while the cards are about *that connection*.
  const finished = runProviders
    .map(p => [p, syncState[p]])
    .filter(([, s]) => s && !s.syncing && s.result)
  // A connection's row is live for as long as its *provider* is, rather than for as long as the connection
  // itself is reporting progress. Those are different questions: between the driver's calls no connection
  // is reporting anything, and a row that answered the second one would settle and un-settle every few
  // seconds while the sync went on regardless. A run this tab is only watching has no local driver to
  // follow, so those rows read `watching` — the observer's own judgement about whether it is still going.
  const isRunning = entry => (
    runProviders.includes(entry.provider) ? !!syncState[entry.provider]?.syncing : watching
  )
  // A driving provider with no rows yet — the one round trip between pressing Sync and the roster arriving.
  // Covering it is what stops the panel opening on "Sync finished" over "No sync is running", which is the
  // opposite of what is happening; the row it draws is replaced in place by that provider's real ones.
  const rostered = new Set(connections.map(e => e.provider))
  const starting = runProviders.filter(p => syncState[p]?.syncing && !rostered.has(p))
  const active = connections.some(isRunning) || starting.length > 0
  return (
    <AppDialog
      draggable
      title={active ? 'Syncing data connections' : 'Sync finished'}
      description={active
        ? 'This runs in the background — carry on using the app, or stash this to the sidebar and check back.'
        : undefined}
      width="min(460px, 100%)"
      onClose={onClose}
      actions={(
        <>
          {/* Exactly one way out of each state, because the two are not interchangeable.
              While a sync runs, Minimize is it: closing would discard the panel outright — no pill, no
              handle, and nothing to restore short of a page reload — which is not what a button sitting
              beside a live progress readout should do. Once it has finished there is nothing left to
              watch, so Close is the only sensible action; stashing a final result would leave a pill in
              the sidebar that never changes again. */}
          {active ? (
            <Button onClick={onMinimize}
                    title="Stash to the sidebar — the panel keeps updating and can be restored from the pill">
              Minimize
            </Button>
          ) : (
            <Button onClick={onClose}>Close</Button>
          )}
        </>
      )}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <style>{PULSE_KEYFRAMES}</style>
        {connections.map(entry => (
          <ConnectionRow
            key={entry.connectionId}
            institution={entry.institution}
            added={rosterAdded(entry)}
            requests={rosterRequests(entry)}
            running={isRunning(entry)}
            error={entry.error}
          />
        ))}
        {/* Deliberately the same row the roster gets, rather than a sentence of its own: `ConnectionRow`
            already says "starting…" before a connection has counts, so the panel neither changes shape nor
            swaps vocabulary when the roster lands — the names and the numbers just fill in. */}
        {starting.map(p => (
          <ConnectionRow key={`starting-${p}`} institution={providerLabel(p)} running />
        ))}
        {finished.map(([provider, state]) => (
          <FinishedRow key={provider} provider={provider} state={state} />
        ))}
        {!connections.length && !starting.length && !finished.length ? (
          <div style={{ color: 'var(--muted)', fontSize: 13 }}>No sync is running.</div>
        ) : null}
      </div>
    </AppDialog>
  )
}
