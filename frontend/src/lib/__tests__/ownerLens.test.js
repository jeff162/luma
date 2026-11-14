import { describe, expect, it } from 'vitest'
import { UNASSIGNED_OWNER_ID, effectiveLens, lensOwnerIds, ownerLensAdmits } from '../ownerLens.js'

const owners = [{ id: 'alex' }, { id: 'robin' }]

describe('owner lens', () => {
  it('starts with Unassigned ticked and drops owners that no longer exist', () => {
    expect(lensOwnerIds({ on: false, ownerIds: null }, owners)).toEqual([UNASSIGNED_OWNER_ID])
    expect(lensOwnerIds({ on: true, ownerIds: ['alex', 'gone'] }, owners)).toEqual(['alex'])
  })

  it('narrows only when on with a real owner chosen', () => {
    expect(effectiveLens({ on: false, ownerIds: ['alex'] })).toBeNull()
    expect(effectiveLens({ on: true, ownerIds: [UNASSIGNED_OWNER_ID] })).toBeNull()
    expect(effectiveLens({ on: true, ownerIds: ['alex', UNASSIGNED_OWNER_ID] })).toEqual(['alex', UNASSIGNED_OWNER_ID])
  })

  it('shows what reaches a lens owner, and what reaches no one', () => {
    expect(ownerLensAdmits(['alex', 'robin'], ['robin'])).toBe(true)
    expect(ownerLensAdmits(['alex'], ['robin'])).toBe(false)
    expect(ownerLensAdmits([], ['robin'])).toBe(true)
    expect(ownerLensAdmits(['alex'], null)).toBe(true)
  })
})
