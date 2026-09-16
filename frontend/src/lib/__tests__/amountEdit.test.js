/*
 * Which transactions offer an in-place amount correction, and which explain why they cannot.
 *
 * The three-way answer is the whole point and is what these assert: an imported row says *nothing*
 * (no control, no hint — "this came from a file" is not a problem the user has to solve, and a hint on
 * every imported row in the ledger would be noise), while a hand-entered row that is blocked explains
 * itself, because the control is present on their other hand-entered rows and its absence here would
 * otherwise be a mystery.
 */

import { describe, it, expect } from 'vitest'
import { amountEditState } from '../amountEdit.js'

const HAND_ENTERED = {
  id: 't1',
  amount: 12.5,
  import_batch_id: null,
  external_transaction_id: null,
  is_split: false,
  reimbursements: [],
}

describe('amountEditState', () => {
  it('offers the edit on a hand-entered row that is neither split nor reimbursed', () => {
    expect(amountEditState(HAND_ENTERED)).toEqual({ offered: true, editable: true, reason: '' })
  })

  it('says nothing at all about a row that came from a file', () => {
    const state = amountEditState({ ...HAND_ENTERED, import_batch_id: 'b1' })
    expect(state.offered).toBe(false)
    expect(state.editable).toBe(false)
    // Not merely "no control": no explanation either, which is the half a truthy `reason` would break.
    expect(state.reason).toBe('')
  })

  it('says nothing at all about a row that came from a provider', () => {
    // A synced row carries an import batch too, but the provider id is the independent tell — asserted
    // on its own so the check cannot come to rest on the batch alone.
    const state = amountEditState({ ...HAND_ENTERED, external_transaction_id: 'ext-1' })
    expect(state.offered).toBe(false)
    expect(state.reason).toBe('')
  })

  it('explains, rather than going quiet, when a hand-entered row is split', () => {
    const state = amountEditState({ ...HAND_ENTERED, is_split: true })
    expect(state.offered).toBe(true)
    expect(state.editable).toBe(false)
    expect(state.reason).not.toBe('')
  })

  it('explains when a hand-entered row is part of a reimbursement', () => {
    const state = amountEditState({ ...HAND_ENTERED, reimbursements: [{ id: 'r1' }] })
    expect(state.offered).toBe(true)
    expect(state.editable).toBe(false)
    expect(state.reason).not.toBe('')
  })

  it('treats a missing row as nothing to offer rather than throwing', () => {
    expect(amountEditState(null).offered).toBe(false)
  })
})
