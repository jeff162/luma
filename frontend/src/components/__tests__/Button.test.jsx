// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
//
// Whether a shared Button submits the form it sits in. It used to drop `type` altogether, so every Button
// inside a form was a submit button whatever the caller wrote. The case that hid it: the two-factor setup
// form's Cancel only avoided submitting because its click also *removed* the form. So the Cancel here
// deliberately leaves its form mounted — a test whose click unmounted the form would pass against the old
// Button too, and prove nothing.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Button } from '../ui.jsx'

afterEach(cleanup)

function FormWith(buttonProps) {
  const onSubmit = vi.fn(e => e.preventDefault())
  const onClick = vi.fn()
  render(
    <form onSubmit={onSubmit}>
      <input aria-label="Code" />
      <Button {...buttonProps} onClick={onClick}>Press</Button>
    </form>,
  )
  return { onSubmit, onClick }
}

describe('Button inside a form', () => {
  it('runs its own handler and does not submit, by default', async () => {
    const { onSubmit, onClick } = FormWith({})
    await userEvent.click(screen.getByRole('button', { name: 'Press' }))
    expect(onClick).toHaveBeenCalledTimes(1)
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('does not become the form\'s Enter-key submitter by default', async () => {
    // Implicit submission (Enter in a field) fires a click on the form's first submit button. A Cancel
    // that were picked up as that button would run its handler on Enter, which is the opposite of what
    // someone typing a code and pressing Enter meant.
    const { onClick } = FormWith({})
    await userEvent.type(screen.getByLabelText('Code'), '123{Enter}')
    expect(onClick).not.toHaveBeenCalled()
  })

  it('submits when it says it is a submit button', async () => {
    const { onSubmit } = FormWith({ type: 'submit' })
    await userEvent.click(screen.getByRole('button', { name: 'Press' }))
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it('does not submit when disabled, even as a submit button', async () => {
    const { onSubmit } = FormWith({ type: 'submit', disabled: true })
    await userEvent.click(screen.getByRole('button', { name: 'Press' }))
    expect(onSubmit).not.toHaveBeenCalled()
  })
})

describe('Button showing progress', () => {
  it('keeps its label as its name, reports busy, and still refuses presses while disabled', async () => {
    const onClick = vi.fn()
    render(<Button disabled progress={0.4} onClick={onClick}>Importing 4 / 10…</Button>)
    const button = screen.getByRole('button', { name: 'Importing 4 / 10…' })
    expect(button.getAttribute('aria-busy')).toBe('true')
    await userEvent.click(button)
    expect(onClick).not.toHaveBeenCalled()
  })
})
