// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// The pairings the detector refused to make, for the user to settle.
//
// A payment between two tracked accounts is recorded twice, once in each, and the detector pairs those
// rows and reads the rhythm off the pairs (`services/transfer_pairs.py`). One thing stops it: a tie,
// where two transactions match the paying row equally well. Nothing in the ledger separates them, so it
// asks rather than guessing — filing real money against the wrong payment is the failure worth avoiding.
//
// **Nothing else appears here.** An earlier version also proposed swapping a movement in for the payee
// series holding its rows, which put two unrelated totals side by side and made a destructive button
// look like a tidy trade. Movements now claim their rows outright, so there is no offer left to weigh.
//
// **The question gets an answer *and* a refusal.** A list that offers only "accept" is a nag: its count
// never falls for a user who looked and decided no. So `Accept` sits beside `Dismiss`, and an
// `N answered · show` list at the foot restores anything answered — the same escape hatch
// `DismissedSignalsDialog` offers on this page.
//
// **Body copy is `--text`, not `--muted`.** The muted token passes contrast on its own but it is for
// secondary labels; a screen whose paragraphs are all muted is both harder to read and has no hierarchy
// left. It survives here on the trailing notes under a card.
//
// It is a floating panel rather than a modal (`DetailPanelShell`, as the duplicate report uses) because
// it is a report worked through rather than a prompt answered: draggable, resizable from any edge,
// geometry remembered across opens, and parkable while the user goes and looks at a series.

import { useState } from 'react'
import { DetailPanelShell, useDetailPanelChrome, useRestorablePanelGeometry } from './detailShared.jsx'
import { Button, EmptyState, Spinner, Tooltip, LinkButton } from './ui.jsx'
import { formatCurrency, formatDate } from '../lib/utils.js'

const PANEL_PREF_KEY = 'ui.recurring.transferReviewPanel'

const CARD = {
  border: '1px solid color-mix(in srgb, var(--border) 70%, transparent)',
  borderRadius: 10, padding: '13px 15px', marginBottom: 10, background: 'var(--surface)',
}
const BODY = { fontSize: 13, lineHeight: 1.55, color: 'var(--text)' }
const NOTE = { ...BODY, color: 'var(--muted)' }

function Ambiguity({ item, busy, onPair, onDismiss }) {
  const [picked, setPicked] = useState(null)
  const row = item.row
  return (
    <div style={CARD}>
      <div style={BODY}>
        <strong>{formatCurrency(row.amount)}</strong> left {row.account_name} on {formatDate(row.date)}
        {row.name ? <> — {row.name}</> : null}
      </div>
      <div style={{ ...BODY, marginTop: 8 }}>
        {item.candidates.map(c => (
          <label
            key={c.id}
            style={{ display: 'flex', alignItems: 'baseline', gap: 8, cursor: 'pointer', padding: '2px 0' }}
          >
            <input
              type="radio"
              name={`pair-${row.id}`}
              checked={picked === c.id}
              onChange={() => setPicked(c.id)}
              disabled={busy}
            />
            <span>{c.account_name} · {formatDate(c.date)}{c.name ? ` · ${c.name}` : ''}</span>
          </label>
        ))}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 }}>
        {/* A disabled control has to say why it is disabled, on hover — the shared rule for every
            greyed-out control in the app. The Tooltip wrapper is what makes that reachable at all: a
            `title` on a disabled button renders nothing, because the element is inert to pointer
            events. */}
        <Tooltip content={picked ? 'Record this as the other half' : 'Choose the matching transaction first'}>
          <Button variant="primary" disabled={busy || !picked} onClick={() => onPair(item, picked)}>
            {busy ? 'Working…' : 'Accept'}
          </Button>
        </Tooltip>
        <Button variant="secondary" disabled={busy} onClick={() => onDismiss(item)}>Dismiss</Button>
      </div>
      <div style={{ ...NOTE, marginTop: 6 }}>
        Recording the pair lets it count towards a series. Dismissing leaves these matched by merchant
        name, as they are now.
      </div>
    </div>
  )
}

export function TransferReviewDialog({
  review, loading, busyKey, onPair, onDismiss, onRestore, onClose,
  stackIndex = 0, isTopmost = true,
}) {
  const [showHidden, setShowHidden] = useState(false)
  const { initialPosition, initialSize, onGestureEnd } = useRestorablePanelGeometry(
    PANEL_PREF_KEY, { fallbackWidth: 720, fallbackHeight: 640 })
  const { pos, size, panelRef, onDragStart, onResizeStart } = useDetailPanelChrome(onClose, {
    forceFloating: true, stackIndex, initialPosition, initialSize, onGestureEnd,
  })

  const ambiguous = review?.ambiguous || []
  const hidden = review?.hidden || []

  const header = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1 }}>
      <div style={{ fontWeight: 600, fontSize: 15 }}>Transfer &amp; payment review</div>
      <div style={{ fontSize: 12, color: 'var(--muted)' }}>
        A payment between two of your accounts is recorded twice, once in each. These could not be
        matched up.
      </div>
    </div>
  )

  return (
    <DetailPanelShell
      pos={pos}
      size={size}
      panelRef={panelRef}
      onDragStart={onDragStart}
      onResizeStart={onResizeStart}
      onClose={onClose}
      header={header}
      isTopmost={isTopmost}
    >
      {loading ? (
        <Spinner />
      ) : !ambiguous.length && !hidden.length ? (
        <EmptyState message="Nothing to review." />
      ) : (
        <>
          {ambiguous.length ? (
            <>
              <div style={{ ...BODY, margin: '4px 0 12px' }}>
                More than one transaction matches equally well, so none of them was chosen. Pick the
                other half of each payment below.
              </div>
              {ambiguous.map(item => (
                <Ambiguity
                  key={item.row.id}
                  item={item}
                  busy={busyKey === item.row.id}
                  onPair={onPair}
                  onDismiss={onDismiss}
                />
              ))}
            </>
          ) : null}

          {hidden.length ? (
            <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid color-mix(in srgb, var(--border) 60%, transparent)' }}>
              <LinkButton onClick={() => setShowHidden(v => !v)} style={{ fontSize: 12.5, fontWeight: 600 }}>
                {hidden.length} answered · {showHidden ? 'hide' : 'show'}
              </LinkButton>
              {showHidden ? (
                <div style={{ marginTop: 8 }}>
                  {hidden.map(h => (
                    <div
                      key={h.paying_txn_id}
                      style={{ ...BODY, display: 'flex', alignItems: 'baseline', gap: 8, padding: '3px 0' }}
                    >
                      <span style={{ flex: 1 }}>
                        {h.label}
                        <span style={{ color: 'var(--muted)' }}>
                          {' · '}{h.kind === 'paired' ? 'paired' : 'dismissed'}
                        </span>
                      </span>
                      <Button variant="secondary" onClick={() => onRestore(h)}>Undo</Button>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </DetailPanelShell>
  )
}
