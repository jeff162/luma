// @vitest-environment jsdom

// The dialog reached by pressing a mapping row's `+New` when the matcher found accounts the source
// could already be. It carries the whole candidate set, because "Keep separate" records an
// `account_pair_distinct` assertion against every account listed here — and an assertion may only
// cover what the user was actually shown. That is the reason this is a modal at all.
//
// What these pin, and why each one is a way the dialog could quietly go wrong:
//   - Keep separate reports NO account, so callers cannot mistake a lit radio for part of the answer.
//   - It is never disabled. A radio group cannot be cleared once set, so gating it on "nothing
//     selected" would trap anyone who selected a candidate to consider it and then decided against it.
//   - The two relationship actions report WHICH account, and are unusable until one is chosen.
//   - A single candidate arrives pre-selected, so the common case keeps the press count it has always
//     had and never shows a lone radio dressed up as a choice.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PossibleAccountMatchChooserDialog } from '../importConfirmDialogs.jsx'

afterEach(cleanup)

const TWO = {
  csvValue: 'Harborline Checking ···6120',
  candidates: [
    { id: 'acct-name', label: 'Harborline Checking ···6120', institution: 'Northgate Bank' },
    { id: 'acct-mask', label: 'Harborline Checking2 ···6120', institution: 'Rivercrest Bank' },
  ],
}
const ONE = {
  csvValue: 'Harborline Saving ···7204',
  candidates: [{ id: 'acct-only', label: 'Harborline Saving ···7204', institution: 'Northgate Bank' }],
}

const radioFor = label => screen.getByText(label).closest('label').querySelector('input[type="radio"]')

describe('PossibleAccountMatchChooserDialog', () => {
  it('lists every candidate with the institution holding it', () => {
    // The institution is load-bearing once candidates can come from a shared mask: the names may be
    // unrelated, and "why am I being shown this one?" otherwise has no answer on screen.
    render(<PossibleAccountMatchChooserDialog pending={TWO} onSelect={() => {}} onCancel={() => {}} />)
    expect(screen.getByText('Harborline Checking ···6120')).toBeTruthy()
    expect(screen.getByText('Harborline Checking2 ···6120')).toBeTruthy()
    expect(screen.getByText('Rivercrest Bank')).toBeTruthy()
  })

  it('leaves the relationship actions unusable until an account is chosen', async () => {
    const onSelect = vi.fn()
    render(<PossibleAccountMatchChooserDialog pending={TWO} onSelect={onSelect} onCancel={() => {}} />)
    await userEvent.click(screen.getByText('Map to existing account'))
    await userEvent.click(screen.getByText('Create new account and group with existing'))
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('reports which account a relationship answer is about', async () => {
    const onSelect = vi.fn()
    render(<PossibleAccountMatchChooserDialog pending={TWO} onSelect={onSelect} onCancel={() => {}} />)
    await userEvent.click(radioFor('Harborline Checking2 ···6120'))
    await userEvent.click(screen.getByText('Create new account and group with existing'))
    expect(onSelect).toHaveBeenCalledWith('group_with_existing', 'acct-mask')
  })

  it('keeps separate without naming an account, even with one selected', async () => {
    // The selection is a leftover from considering a candidate, not part of the answer: the user
    // declined all of them either way, so the caller must not read it as a relationship.
    const onSelect = vi.fn()
    render(<PossibleAccountMatchChooserDialog pending={TWO} onSelect={onSelect} onCancel={() => {}} />)
    await userEvent.click(radioFor('Harborline Checking ···6120'))
    await userEvent.click(screen.getByText('Keep separate from all of these'))
    expect(onSelect).toHaveBeenCalledWith('keep_separate')
  })

  it('never disables keep separate, so a selection is not a trap', async () => {
    // The escape hatch. A radio group has no "none" state, so someone who selects a candidate and then
    // changes their mind would otherwise have to cancel and reopen to get out.
    const onSelect = vi.fn()
    render(<PossibleAccountMatchChooserDialog pending={TWO} onSelect={onSelect} onCancel={() => {}} />)
    await userEvent.click(screen.getByText('Keep separate from all of these'))
    expect(onSelect).toHaveBeenCalledWith('keep_separate')
  })

  it('pre-selects a lone candidate so the common case keeps its press count', async () => {
    const onSelect = vi.fn()
    render(<PossibleAccountMatchChooserDialog pending={ONE} onSelect={onSelect} onCancel={() => {}} />)
    expect(radioFor('Harborline Saving ···7204').checked).toBe(true)
    await userEvent.click(screen.getByText('Map to existing account'))
    expect(onSelect).toHaveBeenCalledWith('map_existing', 'acct-only')
  })

  it('re-runs the pre-selection when reopened about a different row', () => {
    // The dialog is one mounted component reused across rows. A selection surviving from the previous
    // row would pre-arm an answer about an account this row was never asked about.
    const { rerender } = render(
      <PossibleAccountMatchChooserDialog pending={ONE} onSelect={() => {}} onCancel={() => {}} />)
    expect(radioFor('Harborline Saving ···7204').checked).toBe(true)
    rerender(<PossibleAccountMatchChooserDialog pending={TWO} onSelect={() => {}} onCancel={() => {}} />)
    expect(radioFor('Harborline Checking ···6120').checked).toBe(false)
    expect(radioFor('Harborline Checking2 ···6120').checked).toBe(false)
  })
})
