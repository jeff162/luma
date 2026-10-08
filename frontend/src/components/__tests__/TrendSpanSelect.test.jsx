// @vitest-environment jsdom

// The chooser emits span *values* (`lib/trendSpan.js`), so these select by value and assert what the
// host is handed. The one behaviour with anything to get wrong is `Since…`: it has no value of its own
// and has to seed a month from the span already in force, or picking it would move the chart before a
// month was chosen.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import TrendSpanSelect from '../TrendSpanSelect.jsx'

afterEach(cleanup)

const DATA = { dataFirstMonth: '2014-03', dataLastMonth: '2026-10' }

function show(value, props = {}) {
  const onChange = vi.fn()
  render(<TrendSpanSelect value={value} onChange={onChange} {...DATA} {...props} />)
  return { onChange, select: screen.getByLabelText('History shown') }
}

describe('TrendSpanSelect', () => {
  it('emits the preset that was picked', async () => {
    const { onChange, select } = show('all')
    await userEvent.selectOptions(select, '5y')
    expect(onChange).toHaveBeenCalledWith('5y')
  })

  it('seeds Since… from the floor the span is already at', async () => {
    const { onChange, select } = show('5y')
    await userEvent.selectOptions(select, '__since__')
    // Five years ending 2026-10 starts at 2021-11, so the chart does not move on the pick itself.
    expect(onChange).toHaveBeenCalledWith('since:2021-11')
  })

  // The seed follows the chart's own buckets, or picking Since… on a year chart would widen it by a
  // year: whole calendar years counted back from 2026 start in January 2022, not in November 2021.
  it('seeds from the floor the grain gives', async () => {
    const { onChange, select } = show('5y', { grain: 'year' })
    await userEvent.selectOptions(select, '__since__')
    expect(onChange).toHaveBeenCalledWith('since:2022-01')
  })

  it('seeds Since… from the start of the data when showing all of it', async () => {
    const { onChange, select } = show('all')
    await userEvent.selectOptions(select, '__since__')
    expect(onChange).toHaveBeenCalledWith('since:2014-03')
  })

  it('offers the month and year fields only for a since value', () => {
    show('5y')
    expect(screen.queryByLabelText('Earliest year shown')).toBeNull()
    expect(screen.queryByLabelText('Earliest month shown')).toBeNull()
    cleanup()

    show('since:2019-07')
    expect(screen.getByLabelText('Earliest year shown').value).toBe('2019')
    expect(screen.getByLabelText('Earliest month shown').value).toBe('07')
  })

  it('offers the years the ledger covers, newest first', () => {
    show('since:2019-07', { dataFirstMonth: '2017-05', dataLastMonth: '2020-02' })
    const years = [...screen.getByLabelText('Earliest year shown').options].map(option => option.value)
    expect(years).toEqual(['2020', '2019', '2018', '2017'])
  })

  // A stored value outside the data's range still has to appear in its own list, or the select would
  // show a year it does not offer.
  it('keeps the year in force even when the data does not reach it', () => {
    show('since:2012-03', { dataFirstMonth: '2017-05', dataLastMonth: '2018-02' })
    const years = [...screen.getByLabelText('Earliest year shown').options].map(option => option.value)
    expect(years).toEqual(['2018', '2017', '2012'])
  })

  it('changes one field without disturbing the other', async () => {
    const { onChange } = show('since:2019-07')
    await userEvent.selectOptions(screen.getByLabelText('Earliest year shown'), '2021')
    expect(onChange).toHaveBeenLastCalledWith('since:2021-07')
    await userEvent.selectOptions(screen.getByLabelText('Earliest month shown'), '11')
    expect(onChange).toHaveBeenLastCalledWith('since:2019-11')
  })

  // A whole-year chart discards the month (`trendSpanFloorYear`), so a month field there would be a
  // control with no effect — but the stored month survives, rather than being reset by the visit.
  it('hides the month on a year chart and leaves it untouched', async () => {
    const { onChange } = show('since:2019-07', { grain: 'year' })
    expect(screen.queryByLabelText('Earliest month shown')).toBeNull()
    await userEvent.selectOptions(screen.getByLabelText('Earliest year shown'), '2021')
    expect(onChange).toHaveBeenLastCalledWith('since:2021-07')
  })

  // The left select names the mode only: the date it used to repeat is on the fields beside it.
  it('does not restate the date it is showing', () => {
    const { select } = show('since:2019-07')
    expect(select.value).toBe('__since__')
    expect(screen.getByRole('option', { name: 'Since…' })).toBeTruthy()
  })

  it('cannot offer Since… with no data to seed a month from', () => {
    show('5y', { dataFirstMonth: null, dataLastMonth: null })
    expect(screen.getByRole('option', { name: 'Since…' }).disabled).toBe(true)
  })
})
