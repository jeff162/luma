// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * The review surface for recurring anomaly signals, and the forward view of what is due next.
 *
 * Signals are derived server-side on every read (services/recurring_signals.py), so this component
 * holds no state about them beyond what the user is looking at: there is nothing to reconcile in place
 * after an action, because the next fetch recomputes the truth. Every action a row offers is an
 * existing endpoint — confirm/suppress/end a series, edit or widen a rule — plus the one action that
 * belongs to the signal itself, dismissal.
 *
 * Dismissal is per signal, not per kind: each finding names a specific charge, a specific missed date,
 * or a specific rule, so "seen it" is an answer about that one thing. It is keyed by the signal's
 * fingerprint rather than any row id, which is what lets it survive the nightly rebuild that gives
 * every auto-detected series a new identity.
 *
 * These are two *peer views* of the Recurring page, selected alongside the series list rather than
 * stacked above it. The first arrangement put them in the page's pinned header over the list, and a
 * busy ledger's findings then pushed the list and the drill-down panel off the viewport — opening a
 * series drew its report into a region with no height and read as a dead button. Sharing one viewport
 * between findings and the series they refer to was the mistake; capping the findings only rationed it.
 * Each view now owns the scrolling body.
 *
 * "Open series" opens the drill-down **in place**, docked under the findings. Switching to the series
 * list for it was tried and was worse both ways: it took the user out of the list of findings they were
 * working through, and the series list's own filter can exclude the series being opened, leaving the
 * drill-down describing a card that is nowhere on screen.
 *
 * Upcoming is a peer view rather than a tab inside the findings, and carries no dismissal or badge: it
 * is a budgeting view someone may want to consult, not a thing that is wrong. Filing it under "needs
 * attention" was the mislabelling that separating the views fixes.
 */

import { AppDialog, Button, EmptyState, Spinner } from './ui.jsx'
import { formatCurrency, formatDate } from '../lib/utils.js'
import { getTransactionAmountColor } from '../lib/moneyDisplay.js'

// Per kind: the label its group carries, the tone of its accent, and whether it is an anomaly (and so
// belongs to the reviewable set) or the forward view.
const SIGNAL_KINDS = {
  missed: { label: 'Missing charge', tone: 'var(--warning)' },
  price_change: { label: 'Amount changed', tone: 'var(--warning)' },
  rule_range: { label: 'Outside a rule’s range', tone: 'var(--warning)' },
  rule_range_edge: { label: 'Near a rule’s limit', tone: 'var(--accent2)' },
  new_series: { label: 'Newly detected', tone: 'var(--accent2)' },
}
const ANOMALY_KIND_ORDER = ['missed', 'price_change', 'rule_range', 'rule_range_edge', 'new_series']

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
      const usual = signal.amount_kind === 'fixed' ? 'its established amount' : 'anything it has charged before'
      return `${formatCurrency(signal.baseline_amount)} → ${formatCurrency(Math.abs(signal.amount))} on ${formatDate(signal.txn_date)} — ${dir} ${signal.percent}% from ${usual}.`
    }
    case 'new_series':
      return `First detected ${formatDate(signal.first_seen)} · ${signal.occurrence_count} charges · ~${formatCurrency(signal.expected_amount)} ${String(signal.cadence || '')}.`
    case 'rule_range': {
      const bound = signal.bound === 'max' ? 'maximum' : 'minimum'
      const limit = formatCurrency(signal.bound === 'max' ? signal.amount_max : signal.amount_min)
      const where = signal.bound === 'max' ? 'above' : 'below'
      const landed = signal.current_category_name
        ? `It is categorized as ${signal.current_category_name} instead.`
        : 'It is uncategorized as a result.'
      return `${formatCurrency(Math.abs(signal.amount))} on ${formatDate(signal.txn_date)} is ${signal.percent}% ${where} the ${bound} of ${limit}, so the rule did not claim it. ${landed}`
    }
    case 'rule_range_edge': {
      const bound = signal.bound === 'max' ? 'maximum' : 'minimum'
      const limit = formatCurrency(signal.bound === 'max' ? signal.amount_max : signal.amount_min)
      return `${formatCurrency(Math.abs(signal.amount))} on ${formatDate(signal.txn_date)} is within ${signal.percent}% of the rule's ${bound} of ${limit}. The next one may fall outside it.`
    }
    default:
      return ''
  }
}

function headline(signal) {
  if (signal.kind === 'rule_range' || signal.kind === 'rule_range_edge') {
    return signal.txn_name || signal.rule_keyword
  }
  return signal.series_name
}

function subject(signal) {
  // The second line of identification: which rule, or which category/account the series sits on.
  if (signal.kind === 'rule_range' || signal.kind === 'rule_range_edge') {
    const parts = [`rule "${signal.rule_keyword}"`]
    if (signal.rule_category_name) parts.push(signal.rule_category_name)
    if (signal.series_name) parts.push(`series ${signal.series_name}`)
    return parts.join(' · ')
  }
  return [signal.category_name, signal.account_name].filter(Boolean).join(' · ')
}

function SignalRow({ signal, active, onDismiss, onSeriesAction, onOpenSeries, onEditRule, onWidenRange }) {
  const tone = SIGNAL_KINDS[signal.kind]?.tone || 'var(--accent2)'
  const actions = []
  if (signal.kind === 'missed') {
    if (signal.presumed_ended) {
      actions.push(<SignalAction key="end" onClick={() => onSeriesAction('end', signal)} title="Keep the history, stop forecasting it">Mark ended</SignalAction>)
    }
    actions.push(<SignalAction key="open" onClick={() => onOpenSeries(signal)}>Open series</SignalAction>)
  } else if (signal.kind === 'price_change') {
    actions.push(<SignalAction key="open" onClick={() => onOpenSeries(signal)}>Open series</SignalAction>)
  } else if (signal.kind === 'new_series') {
    actions.push(<SignalAction key="confirm" variant="primary" onClick={() => onSeriesAction('confirm', signal)}>Confirm</SignalAction>)
    actions.push(<SignalAction key="suppress" onClick={() => onSeriesAction('suppress', signal)}>Not recurring</SignalAction>)
  } else if (signal.kind === 'rule_range') {
    actions.push(
      <SignalAction
        key="widen"
        variant="primary"
        onClick={() => onWidenRange(signal)}
        title="Move the rule's limit to include this charge, then re-apply the rule"
      >
        Widen to include
      </SignalAction>,
    )
    actions.push(<SignalAction key="rule" onClick={() => onEditRule(signal)}>Edit rule</SignalAction>)
  } else if (signal.kind === 'rule_range_edge') {
    actions.push(<SignalAction key="rule" onClick={() => onEditRule(signal)}>Edit rule</SignalAction>)
  }
  actions.push(
    <SignalAction key="dismiss" variant="quiet" onClick={() => onDismiss(signal)} title="Hide this one finding; a new one still appears">
      Dismiss
    </SignalAction>,
  )

  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 12, padding: '10px 12px',
      borderTop: '1px solid color-mix(in srgb, var(--border) 55%, transparent)',
      // Marked while its series' transactions are open below, the same way a series card marks itself —
      // with several findings about different series, the panel's title alone does not say which row
      // opened it.
      background: active ? 'color-mix(in srgb, var(--accent) 8%, transparent)' : undefined,
    }}>
      <span style={{ width: 3, alignSelf: 'stretch', borderRadius: 3, background: `color-mix(in srgb, ${tone} 65%, transparent)`, flexShrink: 0 }} />
      <div style={{ flex: '1 1 260px', minWidth: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 620, marginBottom: 2 }}>{headline(signal)}</div>
        <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.45 }}>{describe(signal)}</div>
        {subject(signal) ? (
          <div style={{ fontSize: 11.5, color: 'var(--muted)', opacity: 0.8, marginTop: 2 }}>{subject(signal)}</div>
        ) : null}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
        {actions}
      </div>
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
 */
export function RecurringSignalsView({
  signals, counts, dismissedCount, kind, onKindChange, activeSeriesId,
  onDismiss, onSeriesAction, onOpenSeries, onEditRule, onWidenRange, onShowDismissed,
}) {
  const anomalies = (signals || []).filter(s => s.kind !== 'upcoming')
  const activeKinds = ANOMALY_KIND_ORDER.filter(k => (counts?.[k] || 0) > 0)
  // The filter actually in force: a kind arriving from elsewhere (a Tasks link) that has nothing open
  // by the time the page loads falls back to everything, rather than an empty list with no explanation.
  const effectiveKind = kind && counts?.[kind] ? kind : 'all'
  const shown = effectiveKind === 'all' ? anomalies : anomalies.filter(s => s.kind === effectiveKind)

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
              onEditRule={onEditRule}
              onWidenRange={onWidenRange}
            />
          ))}
        </div>
      ) : (
        <EmptyState message={anomalies.length
          ? 'Nothing of that kind is open. Choose All to see the rest.'
          : 'Nothing needs attention. Missing charges, amount changes, newly detected series and drifted rule ranges show up here.'}
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
 */
export function RecurringUpcomingView({ signals, horizonDays }) {
  const upcoming = (signals || []).filter(s => s.kind === 'upcoming')
  if (!upcoming.length) {
    return <EmptyState message={`Nothing is due in the next ${horizonDays} days.`} />
  }
  const total = upcoming.reduce((sum, s) => sum + (Number(s.expected_amount) || 0), 0)
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
          {upcoming.length} charge{upcoming.length === 1 ? '' : 's'} ·{' '}
          <span style={{ fontWeight: 700, color: getTransactionAmountColor(total) }}>{formatCurrency(total)}</span>
        </span>
      </div>
      {upcoming.map(s => (
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
                {SIGNAL_KINDS[s.kind]?.label || s.kind} · {describe(s)}
              </div>
            </div>
            <SignalAction onClick={() => onRestore(s)}>Restore</SignalAction>
          </div>
        ))
      )}
    </AppDialog>
  )
}
