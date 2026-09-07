// @vitest-environment jsdom

// Contract for the ledger's attribute quick filter. What is worth pinning is the split-button
// behaviour, because it is the whole reason this replaced two plain toggles and none of it is visible
// in a diff: the body switches the filter on and off while *keeping* the choice (so the ledger can be
// flipped between filtered and unfiltered without re-picking), the caret changes the choice, and
// picking from the menu applies immediately rather than leaving a chosen-but-inert filter on screen.
//
// Single-select is the other half of the contract. This control exists to find something quickly, so a
// second pick replaces the first — combining conditions is the FilterBar's job.
//
// There is deliberately no "clear": switched off already shows everything, and an empty choice would
// leave the button with no name. The host seeds one instead.

import { afterEach, describe, it, expect, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import AttributeFilterControl from '../AttributeFilterControl.jsx'

afterEach(cleanup)

const ATTRIBUTES = [
  { key: 'needs-review', label: 'Needs review', description: 'Not yet looked over.', in_filter_bar: true },
  { key: 'attachment', label: 'Has attachment', description: 'A receipt is attached.', in_filter_bar: true },
]

function setup(props = {}) {
  const onChange = vi.fn()
  render(
    <AttributeFilterControl
      attributes={ATTRIBUTES}
      value={null}
      active={false}
      onChange={onChange}
      {...props}
    />,
  )
  return { onChange, user: userEvent.setup() }
}

describe('AttributeFilterControl', () => {
  it('opens the picker on click while nothing is chosen', async () => {
    // The page always seeds a choice, so this is the pre-load state only — but it must still do
    // something rather than toggling a selection that is not there yet.
    const { user } = setup()
    await user.click(screen.getByRole('button', { name: 'Only…' }))
    expect(screen.getByText('Has attachment')).toBeTruthy()
  })

  it('applies a pick immediately', async () => {
    const { onChange, user } = setup()
    await user.click(screen.getByRole('button', { name: 'Only…' }))
    await user.click(screen.getByText('Needs review'))
    expect(onChange).toHaveBeenCalledWith({ attribute: 'needs-review', active: true })
  })

  it('names the button for what it filters on, in both states', () => {
    const { unmount } = render(
      <AttributeFilterControl attributes={ATTRIBUTES} value="attachment" active={false} onChange={vi.fn()} />,
    )
    expect(screen.getByRole('button', { name: 'Has attachment' })).toBeTruthy()
    unmount()
    render(<AttributeFilterControl attributes={ATTRIBUTES} value="attachment" active onChange={vi.fn()} />)
    expect(screen.getByRole('button', { name: '✕ Has attachment' })).toBeTruthy()
  })

  it('toggles off without discarding the choice', async () => {
    // The property the two buttons this replaced had, and the reason the picker is behind its own
    // caret: turning the filter off must keep the attribute so it can be turned back on in one click.
    const { onChange, user } = setup({ value: 'attachment', active: true })
    await user.click(screen.getByRole('button', { name: '✕ Has attachment' }))
    expect(onChange).toHaveBeenCalledWith({ attribute: 'attachment', active: false })
  })

  it('toggles back on from the off state', async () => {
    const { onChange, user } = setup({ value: 'attachment', active: false })
    await user.click(screen.getByRole('button', { name: 'Has attachment' }))
    expect(onChange).toHaveBeenCalledWith({ attribute: 'attachment', active: true })
  })

  it('replaces the choice rather than adding to it', async () => {
    const { onChange, user } = setup({ value: 'attachment', active: true })
    await user.click(screen.getByRole('button', { name: 'Choose what to filter on' }))
    await user.click(screen.getByText('Needs review'))
    expect(onChange).toHaveBeenCalledWith({ attribute: 'needs-review', active: true })
  })

  it('renders before the vocabulary has loaded', () => {
    // The attribute list arrives from the API, so the first render always has none — the control must
    // not crash or claim a selection it cannot name.
    setup({ attributes: [], value: 'attachment', active: true })
    expect(screen.getByRole('button', { name: 'Only…' })).toBeTruthy()
  })
})
