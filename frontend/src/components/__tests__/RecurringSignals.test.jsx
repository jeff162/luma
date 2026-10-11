// @vitest-environment jsdom

// The two signal views. They hold no signal state of their own — everything is derived server-side — so
// what is worth pinning is what they *say* and which action they offer, since those are what turn a
// finding into something the user can act on.
//
// Two properties in particular break quietly. "Mark ended" is offered only once a series is actually
// presumed ended, because offering it on a single late charge invites ending a series that is merely
// waiting. And the **upcoming** view carries no dismissal and no warning treatment at all: nothing in it
// is wrong, so there is nothing there to resolve. Each is a destination the user navigates to, so both
// must say something when empty rather than rendering nothing.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RecurringSignalsView, RecurringUpcomingView } from '../RecurringSignals.jsx'

afterEach(cleanup)

const MISSED = {
  kind: 'missed', key: 'missed:streamly||:2026-07-15', severity: 'warning',
  series_id: 's1', series_name: 'Streamly', category_name: 'Streaming', account_name: 'Checking',
  cadence: 'monthly', expected_date: '2026-07-15', days_late: 40, periods_missed: 2,
  presumed_ended: true, expected_amount: 15.99,
}
const PRICE = {
  kind: 'price_change', key: 'price_change:t9', severity: 'warning',
  series_id: 's1', series_name: 'Streamly', category_name: 'Streaming',
  txn_id: 't9', txn_date: '2026-08-14', amount: 19.99, baseline_amount: 15.99,
  delta: 4, percent: 25, direction: 'increase', amount_kind: 'fixed',
}
const UPCOMING = {
  kind: 'upcoming', key: 'upcoming:streamly||:2026-09-14', severity: 'info',
  series_id: 's2', series_name: 'Northgate Fiber', cadence: 'monthly',
  due_date: '2026-09-14', days_until: 6, expected_amount: 64.5,
}

function renderSection(props = {}) {
  const handlers = {
    onKindChange: vi.fn(), onDismiss: vi.fn(), onSeriesAction: vi.fn(),
    onOpenSeries: vi.fn(), onShowDismissed: vi.fn(), onAcceptPrice: vi.fn(), onExcludeCharge: vi.fn(),
  }
  const signals = props.signals || []
  const counts = props.counts || signals.reduce((acc, s) => ({ ...acc, [s.kind]: (acc[s.kind] || 0) + 1 }), {})
  const { container } = render(
    <RecurringSignalsView
      signals={signals}
      counts={counts}
      dismissedCount={props.dismissedCount || 0}
      kind={props.kind || 'all'}
      {...handlers}
    />,
  )
  return { container, ...handlers }
}

function renderUpcoming(signals) {
  return render(<RecurringUpcomingView signals={signals} horizonDays={30} />)
}

describe('RecurringSignals', () => {
  it('says so when nothing is open, rather than rendering nothing', () => {
    // It is a destination now, not a banner: arriving at a blank screen reads as a broken page.
    renderSection()
    expect(screen.getByText(/Nothing needs attention/)).toBeTruthy()
  })

  it('keeps the way back reachable when everything open has been dismissed', async () => {
    const { onShowDismissed } = renderSection({ dismissedCount: 2 })
    await userEvent.click(screen.getByText('2 dismissed — review'))
    expect(onShowDismissed).toHaveBeenCalled()
  })

  it('offers Mark ended only once a series is presumed ended', () => {
    renderSection({ signals: [MISSED] })
    expect(screen.getByText('Mark ended')).toBeTruthy()
    cleanup()

    renderSection({ signals: [{ ...MISSED, presumed_ended: false, periods_missed: 1 }] })
    expect(screen.queryByText('Mark ended')).toBeNull()
    // The way in is the arrow on the headline, not an action button — see the reachability tests below.
    expect(screen.getByRole('button', { name: 'Open this series' })).toBeTruthy()
  })

  it('gives every finding a way to see what it is about', () => {
    // Some kinds could reach nothing before the arrow replaced the Open series button — *Newly detected*
    // asked for a Confirm with no way to look at what was detected.
    const cases = [
      MISSED,
      PRICE,
      { kind: 'new_series', key: 'n1', series_id: 's2', series_name: 'Streamly', first_seen: '2026-08-01',
        occurrence_count: 3, expected_amount: 9.99, cadence: 'monthly' },
    ]
    for (const signal of cases) {
      cleanup()
      renderSection({ signals: [signal] })
      expect(screen.getByRole('button', { name: 'Open this series' })).toBeTruthy()
    }
  })

  it('opens what the headline names, handing back the finding', async () => {
    const { onOpenSeries } = renderSection({ signals: [PRICE] })
    await userEvent.click(screen.getByRole('button', { name: 'Open this series' }))
    expect(onOpenSeries).toHaveBeenCalledWith(PRICE)
  })

  it('shows no arrow when the finding names nothing that can be opened', () => {
    // A finding with no series id has nothing to point at, and an arrow that did nothing would be worse.
    renderSection({ signals: [{ ...PRICE, series_id: undefined }] })
    expect(screen.queryByRole('button', { name: /^Open this/ })).toBeNull()
  })

  it('reports a price change against the prior amount rather than a stored band', () => {
    renderSection({ signals: [PRICE] })
    const row = screen.getByText('Streamly').closest('div').parentElement
    expect(within(row).getByText(/\$15\.99 → \$19\.99/)).toBeTruthy()
    expect(within(row).getByText(/up 25%/)).toBeTruthy()
  })

  it('offers to accept a new amount only where amount actually gates membership', async () => {
    // On a gated series the charge is not matching, so there is something to repair.
    const gated = { ...PRICE, amount_mode: 'fixed', band_min: 15.99, band_max: 15.99, band_pinned: true }
    const { onAcceptPrice } = renderSection({ signals: [gated] })
    await userEvent.click(screen.getByRole('button', { name: 'Accept new amount' }))
    expect(onAcceptPrice).toHaveBeenCalledWith(gated)
  })

  it('offers no such action on an ungated series, where the band is read by nothing', () => {
    // There, Dismiss is the accept: it records the amount as allowed, and a variable series' envelope
    // is learned from exactly those dismissals.
    renderSection({ signals: [{ ...PRICE, amount_mode: 'variable', band_min: 15.99, band_max: 15.99 }] })
    expect(screen.queryByRole('button', { name: 'Accept new amount' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeTruthy()
  })

  it('offers no such action when the charge is already inside the band', () => {
    renderSection({ signals: [{ ...PRICE, amount_mode: 'fixed', band_min: 12, band_max: 22 }] })
    expect(screen.queryByRole('button', { name: 'Accept new amount' })).toBeNull()
  })

  it('offers to exclude the charge an amount finding names, handing back the finding', async () => {
    // Offered whether or not amount gates membership: a charge that does not belong is a different answer
    // from "the price changed", and before this the only route to it was the series report's row menu.
    const { onExcludeCharge } = renderSection({ signals: [{ ...PRICE, amount_mode: 'variable' }] })
    await userEvent.click(screen.getByRole('button', { name: 'Exclude from series' }))
    expect(onExcludeCharge).toHaveBeenCalledWith({ ...PRICE, amount_mode: 'variable' })
  })

  it('offers exclusion only where the finding names a charge in a series', () => {
    // A missing charge has no transaction to exclude, and a finding without a series has nothing to exclude
    // it from.
    renderSection({ signals: [MISSED] })
    expect(screen.queryByRole('button', { name: 'Exclude from series' })).toBeNull()
    cleanup()

    renderSection({ signals: [{ ...PRICE, series_id: undefined }] })
    expect(screen.queryByRole('button', { name: 'Exclude from series' })).toBeNull()
  })

  it('offers a one-off dismissal only on an amount finding, handing back the finding', async () => {
    const { onDismiss } = renderSection({ signals: [PRICE, MISSED] })
    const buttons = screen.getAllByRole('button', { name: 'Dismiss as one-off' })
    expect(buttons).toHaveLength(1)
    await userEvent.click(buttons[0])
    expect(onDismiss).toHaveBeenCalledWith(PRICE, { oneOff: true })
  })

  it('never shows an upcoming charge among the findings', () => {
    // Upcoming is a peer view, not a kind of problem; it must not leak into the attention list or its
    // per-kind filter row.
    renderSection({ signals: [PRICE, UPCOMING] })
    expect(screen.queryByText('Northgate Fiber')).toBeNull()
    expect(screen.queryByText('Upcoming')).toBeNull()
  })

  it('gives the upcoming view no dismissal and no actions', () => {
    renderUpcoming([UPCOMING])
    expect(screen.getByText('Northgate Fiber')).toBeTruthy()
    expect(screen.getByText(/in 6 days/)).toBeTruthy()
    expect(screen.queryByText('Dismiss')).toBeNull()
    expect(screen.queryByText('Open series')).toBeNull()
  })

  it('totals what the next 30 days will take out', () => {
    renderUpcoming([UPCOMING, { ...UPCOMING, key: 'u2', series_name: 'Riverstone Gym', expected_amount: 35.5 }])
    expect(screen.getByText('Next 30 days')).toBeTruthy()
    expect(screen.getByText('$100.00')).toBeTruthy()
  })

  it('says when nothing is due rather than rendering an empty box', () => {
    renderUpcoming([])
    expect(screen.getByText(/Nothing is due in the next 30 days/)).toBeTruthy()
  })

  it('falls back to the full list when a link asks for a kind that has nothing open', () => {
    // A Tasks card links to ?signal=missed; by the time the page loads the user may have resolved it.
    renderSection({ signals: [PRICE], kind: 'missed' })
    expect(screen.getByText('Streamly')).toBeTruthy()
  })

  it('dismisses one finding at a time', async () => {
    const { onDismiss } = renderSection({ signals: [PRICE, MISSED] })
    const buttons = screen.getAllByText('Dismiss')
    expect(buttons).toHaveLength(2)
    await userEvent.click(buttons[0])
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })
})
