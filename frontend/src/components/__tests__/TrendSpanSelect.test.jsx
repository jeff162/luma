// @vitest-environment jsdom

// The chooser emits span *values* (`lib/trendSpan.js`), so these select by value and assert what the
// host is handed.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import TrendSpanSelect from '../TrendSpanSelect.jsx'

afterEach(cleanup)

function show(value) {
  const onChange = vi.fn()
  render(<TrendSpanSelect value={value} onChange={onChange} />)
  return { onChange, select: screen.getByLabelText('History shown') }
}

describe('TrendSpanSelect', () => {
  it('emits the preset that was picked', async () => {
    const { onChange, select } = show('all')
    await userEvent.selectOptions(select, '5y')
    expect(onChange).toHaveBeenCalledWith('5y')
  })

  // A start month stored by an older build is read as all data, so the chooser has to say so rather
  // than show an entry that is not in force.
  it('shows all data for a value that is not a preset', () => {
    expect(show('since:2026-05').select.value).toBe('all')
  })
})
