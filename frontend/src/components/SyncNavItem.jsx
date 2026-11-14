// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// The navigation pane's sync control.
//
// **One control with three states, not three controls.** The pane already carried a sync affordance — a
// pill that appeared only while a run was stashed — and adding a permanent "Sync now" beside it would
// have put two sync things in the nav, disagreeing about whether anything was happening. So the same row
// reads its own status: idle it offers to sync and says how current the data is, running it reports
// progress, and once a run ends it restores the summary. Nothing appears or disappears, because a control
// that comes and goes is one a user cannot learn to reach for.
//
// **Freshness is derived, never stored.** The tooltip's "everything current as of …" is the *oldest*
// `last_synced_at` across every connection (`syncFreshness`), which is the same rule a provider card
// already applies to its own connections and for the same reason: a control speaking for everything has
// to report the connection furthest behind, or one healthy connection makes a stale app look current.
// Storing a "last pressed" timestamp beside that would add a second answer that can disagree with the
// first — a sync that ran and failed would move it, though nothing arrived.
//
// **The label is relative and the tooltip is absolute.** A resizable pane has no room for
// "9/5/2026, 07:40 AM", and the question here is staleness rather than the exact moment. `useRelativeTimestamp`
// re-renders the label as it ages so it cannot drift, and the exact time is one hover away.
//
// **Collapsed, the icon carries the state** — turning while a run is live, a check once it has finished —
// in the same colours the open row's glyph uses, since the label is gone and a tablet has no hover.

import { useSyncStatus } from '../contexts/SyncStatusContext.jsx'
import { useConnectionOperations } from '../lib/useConnectionOperations.js'
import { connectionProviderLabel as providerLabel, syncFreshness, syncNavLabel } from '../lib/connectionSummary.js'
import { useRelativeTimestamp } from '../lib/useRelativeTimestamp.js'
import { rosterAdded } from '../lib/syncRoster.js'
import { formatTimestamp } from '../lib/utils.js'
import { VISUALLY_HIDDEN_STYLE } from './ui.jsx'
import { NavIcon } from './navIcons.jsx'
import { NavPaneHint } from './NavPaneHint.jsx'

// What the tooltip says about each provider under the headline, so a stale overall figure can be traced
// to the connection responsible for it without opening the Connections tab.
function providerLines(byProvider) {
  return byProvider.map(p => {
    const name = providerLabel(p.provider)
    if (p.lastSynced) {
      const never = p.neverSynced ? ` · ${p.neverSynced} never synced` : ''
      return `  ${name} — ${formatTimestamp(p.lastSynced)}${never}`
    }
    return `  ${name} — never synced`
  })
}

export function SyncNavItem({ style, activeStyle, collapsed = false }) {
  // Every value here is read, none fetched. `providers` is the listing `SyncStatusContext` already loads
  // at boot to spot a sync started elsewhere, and keeps current through a run — this component used to
  // request the same endpoint a second time on every app load purely because the context's flattened
  // projection dropped `last_synced_at`. One request, one owner.
  const { providers, viewer, syncState, runProviders, runConnections, watching, restore } = useSyncStatus()
  // The same Sync now the Connections tab and the Data Import card offer, with its confirmation and notices.
  const { syncAll, dialogsNode } = useConnectionOperations()

  // Between the driver's calls no connection reports as running, so `runConnections` alone would blink;
  // `syncState` is this tab's memory of a run it is driving and `watching` is the observer's judgement
  // about one it merely sees. Together they are the same "is a sync happening?" expression the panel and
  // the connection cards use, which is what keeps all three from disagreeing.
  const driving = runProviders.some(p => syncState[p]?.syncing) || watching

  const freshness = syncFreshness(providers || [])
  const { label: relativeLabel, absolute } = useRelativeTimestamp(freshness.lastSynced)

  // Nothing to sync means no control: an affordance whose only outcome is an error is worse than its
  // absence, and a CSV-only install has no data connections at all.
  if (!providers || !freshness.connectionCount) return null

  const added = runConnections.reduce((n, e) => n + rosterAdded(e), 0)
  const finished = !!viewer && !driving

  const onClick = () => {
    // While a run is live or its summary is waiting, this row is the way back to the panel rather than a
    // way to start a second pull.
    if (driving || finished) { restore(); return }
    syncAll()
  }

  const label = syncNavLabel({ driving, finished, added, relativeLabel })

  const title = driving
    ? `${runConnections.length} connection${runConnections.length === 1 ? '' : 's'} syncing — ${added} transaction${added === 1 ? '' : 's'} imported so far`
    : finished ? 'The sync has finished — open the summary'
      : [
        'Sync every data connection',
        freshness.neverSynced
          ? `${freshness.neverSynced} connection${freshness.neverSynced === 1 ? '' : 's'} ${freshness.neverSynced === 1 ? 'has' : 'have'} never synced`
          : null,
        absolute ? `Everything current as of ${absolute}` : null,
        ...providerLines(freshness.byProvider),
      ].filter(Boolean).join('\n')

  // Styled from the nav's own link styles rather than as a chip: unlike the transient report pills beside
  // it, this row is permanent, so it should read as part of the pane rather than as something stashed in
  // it. `activeStyle` marks it while a run is live — the same "you are here" weight an open page carries.
  const rowStyle = driving || finished ? activeStyle : style
  const glyphColor = driving ? 'var(--accent)' : finished ? 'var(--success)' : 'var(--muted)'
  return (
    <>
      <NavPaneHint collapsed={collapsed} content={title} row describeTrigger>
        <button type="button" onClick={onClick} title={collapsed ? undefined : title} style={{
          ...rowStyle,
          width: 'auto',
          background: driving || finished ? rowStyle.background : 'none',
          border: 'none',
          cursor: 'pointer',
          textAlign: 'left',
          font: 'inherit',
          fontSize: 14,
          minWidth: 0,
        }}>
          {collapsed ? (
            <span style={{ color: glyphColor }}>
              <NavIcon
                name={finished ? 'syncDone' : 'sync'}
                className={driving ? 'ui-refresh-icon is-spinning' : undefined}
              />
            </span>
          ) : (
            <span aria-hidden style={{ flexShrink: 0, marginRight: 8, color: glyphColor }}>
              {finished ? '✓' : '↻'}
            </span>
          )}
          <span style={collapsed ? VISUALLY_HIDDEN_STYLE : { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {label}
          </span>
        </button>
      </NavPaneHint>
      {dialogsNode}
    </>
  )
}
