// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * The review surface for recurring anomaly signals, and the forward view of what is due next.
 *
 * Signals are derived server-side on every read (services/recurring_signals.py), so this component
 * holds no state about them beyond what the user is looking at: there is nothing to reconcile in place
 * after an action, because the next fetch recomputes the truth. Every action a row offers is an
 * existing endpoint — confirm/suppress/end a series, accept a new amount, exclude a charge from its
 * series — plus the one action that belongs to the signal itself, dismissal.
 *
 * Dismissal is per signal, not per kind: each finding names a specific charge or a specific missed date,
 * so "seen it" is an answer about that one thing. It is keyed by the signal's fingerprint rather than any
 * row id, which is what lets it survive the nightly rebuild that gives every auto-detected series a new
 * identity.
 *
 * These are two *peer views* of the Recurring page, selected alongside the series list rather than
 * stacked above it. The first arrangement put them in the page's pinned header over the list, and a
 * busy ledger's findings then pushed the list and the drill-down panel off the viewport — opening a
 * series drew its report into a region with no height and read as a dead button. Sharing one viewport
 * between findings and the series they refer to was the mistake; capping the findings only rationed it.
 * Each view now owns the scrolling body.
 *
 * A finding's headline carries an arrow that **opens a transaction report for the series it names**. It
 * replaced an "Open series" button that only some kinds ever had, which left *Newly detected* asking the
 * user to Confirm a series with no way to look at it. The arrow is on the name because the name is what
 * it opens.
 *
 * Either target opens **in place**, docked under the findings. Switching to the series list was tried and
 * was worse both ways: it took the user out of the list of findings they were working through, and the
 * series list's own filter can exclude the series being opened, leaving the drill-down describing a card
 * that is nowhere on screen.
 *
 * Upcoming is a peer view rather than a tab inside the findings, and carries no dismissal or badge: it
 * is a budgeting view someone may want to consult, not a thing that is wrong. Filing it under "needs
 * attention" was the mislabelling that separating the views fixes.
 */

import { useState } from 'react'
import { AppDialog, Button, EmptyState, Spinner } from './ui.jsx'
import { formatCurrency, formatDate } from '../lib/utils.js'
import { getTransactionAmountColor } from '../lib/moneyDisplay.js'
import { priceChangeBand, signalTarget } from '../lib/recurringSignals.js'

// Per kind: the label its group carries, the tone of its accent, and whether it is an anomaly (and so
// belongs to the reviewable set) or the forward view.
const SIGNAL_KINDS = {
  missed: { label: 'Missing charge', tone: 'var(--warning)' },
  price_change: { label: 'Amount changed', tone: 'var(--warning)' },
  new_series: { label: 'Newly detected', tone: 'var(--accent2)' },
}
const ANOMALY_KIND_ORDER = ['missed', 'price_change', 'new_series']

function pluralPeriods(n) {
  return n === 1 ? 'period' : 'periods'
}

// One quiet action, sized to sit several-to-a-row without competing with the signal's own text.
function SignalAction({ children, onClick, variant = 'default', title }) {
  const edge = '1px solid color-mix(in srgb, var(--border) 80%, transparent)'
  const looks = {
    default: { background: 'var(--surface2)', color: 'var(--text)', border: edge },
    primary: { background: 'var(--accent)', color: '#fff', border: '1px solid var(--accent)' },
    quiet: { background: 'transparent', color: 'var(--muted)', border: edge },
  }
  return (
    <button
      onClick={onClick}
      title={title}
      style={{ fontSize: 11.5, fontWeight: 500, padding: '3px 9px', borderRadius: 6, cursor: 'pointer', lineHeight: 1.5, whiteSpace: 'nowrap', ...looks[variant] }}
    >
      {children}
    </button>
  )
}

// What each kind says about itself. Kept as one function rather than five components because the rows
// are structurally identical — a headline, a sentence, and a set of actions — and only the sentence and
// the verbs differ.
function describe(signal) {
  switch (signal.kind) {
    case 'missed': {
      const due = formatDate(signal.expected_date)
      const base = `Expected ${due} — ${signal.days_late} days ago.`
      return signal.presumed_ended
        ? `${base} Nothing has arrived for ${signal.periods_missed} ${pluralPeriods(signal.periods_missed)}, so this may have been canceled.`
        : `${base} A failed payment, or a bill not imported yet.`
    }
    case 'price_change': {
      const dir = signal.direction === 'increase' ? 'up' : 'down'
      // A fixed price is judged against its usual amount; a varying bill against the range of its last few
      // charges — not its whole history, which may well have gone higher.
      const usual = signal.amount_kind === 'fixed' ? 'its usual amount' : 'its recent charges'
      return `${formatCurrency(signal.baseline_amount)} → ${formatCurrency(Math.abs(signal.amount))} on ${formatDate(signal.txn_date)} — ${dir} ${signal.percent}% from ${usual}.`
    }
    case 'new_series':
      return `First detected ${formatDate(signal.first_seen)} · ${signal.occurrence_count} charges · ~${formatCurrency(signal.expected_amount)} ${String(signal.cadence || '')}.`
    default:
      return ''
  }
}

function headline(signal) {
  return signal.series_name
}

// The second line of identification: which category and account the series sits on.
function subject(signal) {
  return [signal.category_name, signal.account_name].filter(Boolean).join(' · ')
}

// What Dismiss means for each kind. On an amount finding it is more than hiding: the amount becomes the
// series' normal, which is what sets it apart from the one-off beside it.
const DISMISS_TITLES = {
  price_change: 'Treat this amount as normal for the series',
  missed: 'Hide this finding; a later missed charge is still reported',
  new_series: 'Hide this finding; the series stays in Suggested',
}

function SignalRow({ signal, active, onDismiss, onSeriesAction, onOpenSeries, onAcceptPrice, onExcludeCharge, renderSeries }) {
  const tone = SIGNAL_KINDS[signal.kind]?.tone || 'var(--accent2)'
  const [detailsOpen, setDetailsOpen] = useState(false)
  // The series' current state — its cadence, amount setting, range and dates — is what a finding is
  // judged against, so it is one click away rather than a trip to the Series view.
  const seriesCard = signal.series_id && renderSeries ? renderSeries(signal.series_id) : null
  const target = signalTarget(signal)
  const actions = []
  if (signal.kind === 'missed') {
    if (signal.presumed_ended) {
      actions.push(<SignalAction key="end" onClick={() => onSeriesAction('end', signal)} title="Keep the history, stop forecasting it">Mark ended</SignalAction>)
    }
  } else if (signal.kind === 'price_change') {
    // Offered only where amount actually gates membership. On an ungated series the band is read by
    // nothing, so a button that moved it would be theatre — there, Dismiss is the accept: it records
    // the amount as one the user has allowed, and a variable series' envelope is learned from exactly
    // those (see `_load_accepted_amounts`).
    if (signal.amount_mode === 'fixed' && priceChangeBand(signal)) {
      actions.push(
        <SignalAction
          key="accept"
          variant="primary"
          onClick={() => onAcceptPrice(signal)}
          title="Widen this series' matching range to take in the new amount"
        >
          Accept new amount
        </SignalAction>,
      )
    }
    // The one finding that names a charge, so the one place a finding can say the charge does not belong.
    // The same scan-durable exclusion as the row menu's "Remove from recurring series"; without it here,
    // saying so meant opening the series report and finding the row.
    if (signal.txn_id && signal.series_id) {
      actions.push(
        <SignalAction
          key="exclude"
          onClick={() => onExcludeCharge(signal)}
          title="This charge is not part of the series. It stays out after future scans."
        >
          Exclude from series
        </SignalAction>,
      )
    }
    // The answer between Dismiss and Exclude: the charge belongs, but the usual amount still stands — a
    // hike the merchant agreed to reverse. The charge stops counting toward what later ones are judged
    // against, so a repeat of it is reported rather than read as the price having settled.
    actions.push(
      <SignalAction
        key="one-off"
        variant="quiet"
        onClick={() => onDismiss(signal, { oneOff: true })}
        title="Hide this finding but keep expecting the usual amount. If this amount comes again, it is reported again."
      >
        Dismiss as one-off
      </SignalAction>,
    )
  } else if (signal.kind === 'new_series') {
    actions.push(<SignalAction key="confirm" variant="primary" onClick={() => onSeriesAction('confirm', signal)}>Confirm</SignalAction>)
    actions.push(<SignalAction key="suppress" onClick={() => onSeriesAction('suppress', signal)}>Not recurring</SignalAction>)
  }
  actions.push(
    <SignalAction key="dismiss" variant="quiet" onClick={() => onDismiss(signal)} title={DISMISS_TITLES[signal.kind] || 'Hide this finding; a new one still appears'}>
      Dismiss
    </SignalAction>,
  )

  return (
    <div data-signal-key={signal.key} style={{
      borderTop: '1px solid color-mix(in srgb, var(--border) 55%, transparent)',
      // Marked while its series' transactions are open below, the same way a series card marks itself —
      // with several findings about different series, the panel's title alone does not say which row
      // opened it.
      background: active ? 'color-mix(in srgb, var(--accent) 8%, transparent)' : undefined,
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '10px 12px' }}>
        <span style={{ width: 3, alignSelf: 'stretch', borderRadius: 3, background: `color-mix(in srgb, ${tone} 65%, transparent)`, flexShrink: 0 }} />
        <div style={{ flex: '1 1 260px', minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 620, marginBottom: 2 }}>
            {headline(signal)}
            {target ? (
              <button
                onClick={() => onOpenSeries(signal)}
                aria-label="Open this series"
                title="Show this series’ transactions"
                style={{
                  background: 'none', border: 'none', padding: '0 0 0 5px', cursor: 'pointer',
                  color: 'var(--accent2)', fontSize: 12.5, fontWeight: 700, lineHeight: 1,
                  textDecoration: active ? 'underline' : 'none',
                }}
              >
                ↗
              </button>
            ) : null}
          </div>
          <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.45 }}>{describe(signal)}</div>
          {subject(signal) ? (
            <div style={{ fontSize: 11.5, color: 'var(--muted)', opacity: 0.8, marginTop: 2 }}>{subject(signal)}</div>
          ) : null}
          {seriesCard ? (
            <button
              onClick={() => setDetailsOpen(v => !v)}
              aria-expanded={detailsOpen}
              style={{ background: 'none', border: 'none', padding: 0, marginTop: 4, cursor: 'pointer', color: 'var(--accent2)', fontSize: 11.5, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 4 }}
            >Series Details<span style={{ fontSize: 9 }}>{detailsOpen ? '▾' : '▸'}</span>
            </button>
          ) : null}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {actions}
        </div>
      </div>
      {detailsOpen && seriesCard ? (
        <div style={{ padding: '0 12px 12px 27px' }}>{seriesCard}</div>
      ) : null}
    </div>
  )
}

function TabButton({ label, count, on, onClick, tone }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 10px', borderRadius: 99,
        cursor: 'pointer', fontSize: 12, fontWeight: 600,
        border: `1px solid ${on ? 'color-mix(in srgb, var(--accent) 45%, var(--border))' : 'transparent'}`,
        background: on ? 'color-mix(in srgb, var(--accent) 12%, var(--surface))' : 'transparent',
        color: on ? 'var(--accent2)' : 'var(--muted)',
      }}
    >
      {label}
      {count != null ? (
        <span style={{
          fontSize: 10.5, fontWeight: 700, minWidth: 15, textAlign: 'center', padding: '0 4px', borderRadius: 99,
          background: tone ? `color-mix(in srgb, ${tone} 22%, var(--surface))` : 'var(--surface2)',
          color: tone || 'var(--muted)',
        }}>{count}</span>
      ) : null}
    </button>
  )
}

/*
 * The findings view. One of the Recurring page's three peer views (see the header comment), so it owns
 * the whole scrolling body rather than competing with the series list for it — which is also why it
 * caps nothing: the page's body scrolls, and a long list of findings is exactly what someone switched
 * here to read.
 *
 * The kind row narrows within the view; it is a filter, not navigation, which is why it stays a pill
 * row rather than becoming part of the page's view selector.
 *
 * `matches` is the page's search, which sits above the view selector and narrows whichever view is
 * showing. It narrows the rows only: the kind counts say what is open, as the selector's badge does, so a
 * search never makes a kind look resolved.
 */
export function RecurringSignalsView({
  signals, counts, dismissedCount, kind, onKindChange, activeSeriesId,
  onDismiss, onSeriesAction, onOpenSeries, onAcceptPrice, onExcludeCharge, onShowDismissed,
  matches = () => true,
  // seriesId → the series' own card (the page's SeriesCard), shown under a finding's Details toggle.
  // Supplied by the page so the card is the one the Series view renders, not a lookalike; null where
  // the series is not loaded.
  renderSeries = null,
}) {
  const anomalies = (signals || []).filter(s => s.kind !== 'upcoming')
  const activeKinds = ANOMALY_KIND_ORDER.filter(k => (counts?.[k] || 0) > 0)
  // The filter actually in force: a kind arriving from elsewhere (a Tasks link) that has nothing open
  // by the time the page loads falls back to everything, rather than an empty list with no explanation.
  const effectiveKind = kind && counts?.[kind] ? kind : 'all'
  const ofKind = effectiveKind === 'all' ? anomalies : anomalies.filter(s => s.kind === effectiveKind)
  const shown = ofKind.filter(matches)

  return (
    <div>
      {anomalies.length ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap', marginBottom: 10 }}>
          <TabButton label="All" count={anomalies.length} on={effectiveKind === 'all'} onClick={() => onKindChange('all')} />
          {activeKinds.map(k => (
            <TabButton
              key={k}
              label={SIGNAL_KINDS[k].label}
              count={counts[k]}
              tone={SIGNAL_KINDS[k].tone}
              on={effectiveKind === k}
              onClick={() => onKindChange(k)}
            />
          ))}
        </div>
      ) : null}

      {shown.length ? (
        <div style={{
          border: '1px solid color-mix(in srgb, var(--border) 80%, transparent)',
          borderRadius: 12, background: 'var(--surface)', overflow: 'hidden',
        }}>
          {shown.map(s => (
            <SignalRow
              key={s.key}
              signal={s}
              active={!!activeSeriesId && s.series_id === activeSeriesId}
              onDismiss={onDismiss}
              onSeriesAction={onSeriesAction}
              onOpenSeries={onOpenSeries}
              onAcceptPrice={onAcceptPrice}
              onExcludeCharge={onExcludeCharge}
              renderSeries={renderSeries}
            />
          ))}
        </div>
      ) : (
        <EmptyState message={!anomalies.length
          ? 'Nothing needs attention. Missing charges, amount changes and newly detected series show up here.'
          : ofKind.length
            ? 'No findings match your search.'
            : 'Nothing of that kind is open. Choose All to see the rest.'}
        />
      )}

      {dismissedCount ? (
        <div style={{ marginTop: 12 }}>
          <button
            onClick={onShowDismissed}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', fontSize: 12, fontWeight: 600, padding: 0 }}
          >
            {dismissedCount} dismissed — review
          </button>
        </div>
      ) : null}
    </div>
  )
}

/*
 * The forward view: what is due next and what it is expected to cost. A peer view rather than a tab
 * inside the findings, because nothing in it is wrong — filing it under "needs attention" was the
 * mislabelling that separating the views is meant to fix. It carries no actions and no dismissal.
 *
 * `matches` is the page's search. The header's count and total are of the rows the search leaves, since
 * the header describes the list beneath it — a total of charges that are not on screen could not be
 * checked against anything.
 */
export function RecurringUpcomingView({ signals, horizonDays, matches = () => true }) {
  const upcoming = (signals || []).filter(s => s.kind === 'upcoming')
  if (!upcoming.length) {
    return <EmptyState message={`Nothing is due in the next ${horizonDays} days.`} />
  }
  const shown = upcoming.filter(matches)
  if (!shown.length) {
    return <EmptyState message={`Nothing due in the next ${horizonDays} days matches your search.`} />
  }
  const total = shown.reduce((sum, s) => sum + (Number(s.expected_amount) || 0), 0)
  return (
    <div style={{
      border: '1px solid color-mix(in srgb, var(--border) 80%, transparent)',
      borderRadius: 12, background: 'var(--surface)', overflow: 'hidden',
    }}>
      <div style={{
        display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12,
        padding: '11px 14px', fontSize: 12.5, color: 'var(--muted)',
      }}>
        <span style={{ fontWeight: 600 }}>Next {horizonDays} days</span>
        <span>
          {shown.length} charge{shown.length === 1 ? '' : 's'} ·{' '}
          <span style={{ fontWeight: 700, color: getTransactionAmountColor(total) }}>{formatCurrency(total)}</span>
        </span>
      </div>
      {shown.map(s => (
        <div
          key={s.key}
          style={{
            display: 'flex', alignItems: 'baseline', gap: 12, padding: '9px 14px',
            borderTop: '1px solid color-mix(in srgb, var(--border) 55%, transparent)',
          }}
        >
          <span style={{ flex: '1 1 auto', minWidth: 0, fontSize: 13.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {s.series_name}
          </span>
          <span style={{ fontSize: 12, color: 'var(--muted)', flexShrink: 0 }}>
            {s.days_until === 0 ? 'today' : `in ${s.days_until} day${s.days_until === 1 ? '' : 's'}`} · {formatDate(s.due_date)}
          </span>
          <span style={{ fontSize: 13.5, fontWeight: 650, flexShrink: 0, color: getTransactionAmountColor(s.expected_amount) }}>
            ~{formatCurrency(s.expected_amount)}
          </span>
        </div>
      ))}
    </div>
  )
}

/*
 * What dismissal is currently hiding, and the way back from it. Only signals that still *compute* are
 * listed: a dismissal whose subject has since been trashed or resolved has nothing to restore, so
 * showing it would offer an action that does nothing.
 */
export function DismissedSignalsDialog({ signals, loading, onRestore, onClose }) {
  return (
    <AppDialog
      title="Dismissed signals"
      description="Findings you have marked as seen. Restoring one puts it back in the review list."
      onClose={onClose}
      actions={<Button variant="ghost" onClick={onClose}>Close</Button>}
    >
      {loading ? (
        <Spinner />
      ) : !signals.length ? (
        <EmptyState message="Nothing is currently dismissed." />
      ) : (
        signals.map(s => (
          <div
            key={s.key}
            style={{
              display: 'flex', alignItems: 'flex-start', gap: 12, padding: '9px 2px',
              borderBottom: '1px solid color-mix(in srgb, var(--border) 60%, transparent)',
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 620 }}>{headline(s)}</div>
              <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>
                {SIGNAL_KINDS[s.kind]?.label || s.kind}{s.one_off ? ' (one-off)' : ''} · {describe(s)}
              </div>
            </div>
            <SignalAction onClick={() => onRestore(s)}>Restore</SignalAction>
          </div>
        ))
      )}
    </AppDialog>
  )
}
