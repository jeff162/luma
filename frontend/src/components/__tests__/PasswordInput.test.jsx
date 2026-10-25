// @vitest-environment jsdom

// `PasswordInput` is the one secret field, so what its hosts rely on is pinned here rather than per dialog:
//
//   * The reveal changes what is shown and nothing else — the value survives both directions.
//   * A refused `onReveal` leaves the field masked, so a failed fetch never shows an empty box as the value.
//   * The forwarded ref reaches the real input, for the default field and for one given as `as`. The vault
//     dialogs move focus through that ref (their fields carry no id to query), and the sign-in screen
//     renders `TransientTextInput` through `as`.
//   * A field set arrives as attributes, with no id left for the browser to key form history on.
//   * A suggested passphrase lands in the field shown, and the host hears of it only once it has — the
//     vault dialogs empty and focus their confirm field then, which the user types the words back into.
//   * A sign-in password is offered with no host callback, and is the shorter suggestion.

import { createRef, useState } from 'react'
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PasswordInput } from '../ui.jsx'
import TransientTextInput from '../TransientTextInput.jsx'
import { EXISTING_SECRET_PROPS } from '../../lib/sensitiveFields.js'

function Controlled(props) {
  const [value, setValue] = useState('')
  return <PasswordInput value={value} onChange={setValue} placeholder="Secret" {...props} />
}

afterEach(cleanup)

describe('PasswordInput', () => {
  it('reveals and re-masks without touching the value', async () => {
    render(<Controlled />)
    const field = screen.getByPlaceholderText('Secret')
    await userEvent.type(field, 'correct horse')
    expect(field.type).toBe('password')

    await userEvent.click(screen.getByRole('button', { name: 'Show characters' }))
    expect(field.type).toBe('text')
    expect(field.value).toBe('correct horse')

    await userEvent.click(screen.getByRole('button', { name: 'Hide characters' }))
    expect(field.type).toBe('password')
    expect(field.value).toBe('correct horse')
  })

  it('stays masked when onReveal refuses', async () => {
    render(<Controlled onReveal={async () => { throw new Error('vault locked') }} />)
    await userEvent.click(screen.getByRole('button', { name: 'Show characters' }))
    expect(screen.getByPlaceholderText('Secret').type).toBe('password')
  })

  it('forwards its ref to the input', () => {
    const ref = createRef()
    render(<PasswordInput ref={ref} value="" onChange={() => {}} placeholder="Secret" />)
    expect(ref.current).toBe(screen.getByPlaceholderText('Secret'))
  })

  it('renders the field given as `as`, with the ref and the reveal intact', async () => {
    const ref = createRef()
    render(
      <PasswordInput as={TransientTextInput} ref={ref} value="abc" onChange={() => {}}
        placeholder="Password" autoComplete="current-password" restoreOnEscape onBlurCommit={false} />,
    )
    const field = screen.getByPlaceholderText('Password')
    expect(ref.current).toBe(field)
    expect(field.getAttribute('autocomplete')).toBe('current-password')

    await userEvent.click(screen.getByRole('button', { name: 'Show characters' }))
    expect(field.type).toBe('text')
  })

  it('applies a field set as attributes, leaving no id to key form history on', () => {
    render(<PasswordInput value="" onChange={() => {}} placeholder="Secret" {...EXISTING_SECRET_PROPS} />)
    const field = screen.getByPlaceholderText('Secret')
    expect(field.getAttribute('autocomplete')).toBe('current-password')
    expect(field.hasAttribute('id')).toBe(false)
    expect(field.hasAttribute('suppressautofillid')).toBe(false)
  })

  it('fills in a suggested passphrase, shows it, then tells the host', async () => {
    const suggested = []
    render(<Controlled onSuggest={value => suggested.push(value)} />)
    const field = screen.getByPlaceholderText('Secret')

    await userEvent.click(screen.getByRole('button', { name: 'Suggest a passphrase' }))
    await waitFor(() => expect(suggested).toHaveLength(1))
    expect(field.value).toBe(suggested[0])
    expect(field.value.split('-').length).toBeGreaterThanOrEqual(6)
    expect(field.type).toBe('text')
  })

  it('offers a shorter sign-in password, with or without a host to tell', async () => {
    render(<Controlled suggestion="password" />)
    const field = screen.getByPlaceholderText('Secret')

    await userEvent.click(screen.getByRole('button', { name: 'Suggest a password' }))
    await waitFor(() => expect(field.value).not.toBe(''))
    const words = field.value.split('-').length
    expect(words).toBeGreaterThanOrEqual(4)
    expect(words).toBeLessThan(6)
    expect(field.type).toBe('text')
  })
})
