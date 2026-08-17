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
// So it reports what is known and true — how much has arrived, how many requests it took, and how far
// back each account has reached — and leaves the ending open.

import { AppDialog, Button } from './ui.jsx'

// A row-sized "still working" mark. The shared `Spinner` is a page-level block — 40px of padding around
// the word "Loading…" — so dropping it into a status line both dwarfed the line and said the wrong thing:
// nothing here is loading, a sync is running. The numbers beside it are the real progress signal; this
// only has to show that time is still passing.
const PULSE_KEYFRAMES = '@keyframes lumaSyncPulse { 0%, 100% { opacity: 0.25 } 50% { opacity: 1 } }'

function ProgressRow({ entry }) {
  const p = entry.progress || {}
  return (
    <div style={{
      display: 'flex', alignItems: 'baseline', gap: 10, padding: '8px 12px', borderRadius: 8,
      background: 'var(--surface2)', fontSize: 13,
    }}>
      <span aria-hidden style={{
        width: 7, height: 7, borderRadius: '50%', flexShrink: 0, alignSelf: 'center',
        background: 'var(--accent)', animation: 'lumaSyncPulse 1.4s ease-in-out infinite',
      }} />
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {entry.institution}
      </span>
      <span style={{ color: 'var(--muted)', flexShrink: 0 }}>
        {p.added ? `${p.added} imported` : 'starting…'}
        {p.requests ? ` · ${p.requests} request${p.requests === 1 ? '' : 's'}` : ''}
      </span>
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

export function SyncStatusPanel({ running = [], syncState = {}, runProviders = [],
                                  onClose, onMinimize }) {
  // Scoped to the run in progress, not to everything `syncState` has accumulated. That map is keyed by
  // provider and keeps each one's last result for the life of the page (the Accounts cards read it that
  // way), so filtering it here is what stops a provider synced earlier from being reported as part of
  // this run — the panel is about *this* sync, while the cards are about *that connection*.
  const finished = runProviders
    .map(p => [p, syncState[p]])
    .filter(([, s]) => s && !s.syncing && s.result)
  const active = running.length > 0
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
        {running.map(entry => <ProgressRow key={entry.connectionId} entry={entry} />)}
        {finished.map(([provider, state]) => (
          <FinishedRow key={provider} provider={provider} state={state} />
        ))}
        {!running.length && !finished.length ? (
          <div style={{ color: 'var(--muted)', fontSize: 13 }}>No sync is running.</div>
        ) : null}
      </div>
    </AppDialog>
  )
}
