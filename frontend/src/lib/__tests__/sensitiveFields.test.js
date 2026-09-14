// The field kinds, and the distinctions between them that a wrong spread would erase silently.
//
// Worth pinning because every failure here is invisible in the running app until someone notices the
// browser offering the wrong thing: a confirmation field advertising itself as a password, a field asking
// for an existing secret offered a generated one, a one-time code field suppressing the manager that would
// fill it, or a raw <input> handed a prop that only the shared Input understands.

import { describe, expect, it } from 'vitest'
import {
  EXISTING_SECRET_PROPS, NEW_SECRET_PROPS, NO_AUTOFILL_PROPS, ONE_TIME_CODE_PROPS,
} from '../sensitiveFields.js'

const ALL_KINDS = [NO_AUTOFILL_PROPS, NEW_SECRET_PROPS, EXISTING_SECRET_PROPS, ONE_TIME_CODE_PROPS]

describe('field kinds', () => {
  it('all of them turn off the browser text handling that would mangle a value', () => {
    for (const props of ALL_KINDS) {
      expect(props.autoCorrect).toBe('off')
      expect(props.autoCapitalize).toBe('off')
      expect(props.spellCheck).toBe(false)
    }
  })

  it('uses the autoComplete value that is actually honored for each kind', () => {
    // 'off' is ignored on password fields, so a secret set names its kind instead — and the two secret
    // kinds must differ, because 'new-password' is what invites a manager to generate a value: on a field
    // asking for a secret that already exists, that fills in something that cannot be right.
    expect(NO_AUTOFILL_PROPS.autoComplete).toBe('off')
    expect(NEW_SECRET_PROPS.autoComplete).toBe('new-password')
    expect(EXISTING_SECRET_PROPS.autoComplete).toBe('current-password')
    expect(ONE_TIME_CODE_PROPS.autoComplete).toBe('one-time-code')
  })

  it('leaves password managers free to work on every kind', () => {
    // Form history is what these sets suppress. A manager fills from a store the user saved into on
    // purpose, and the per-vendor opt-outs the secret set once carried kept managers off the very fields
    // whose values the app tells people to keep in one.
    for (const props of ALL_KINDS) {
      expect(Object.keys(props).filter(key => key.startsWith('data-'))).toEqual([])
    }
  })

  it('carries the shared-Input-only prop only where the shared Input is used', () => {
    // `suppressAutofillId` is a prop of `Input`, not a DOM attribute. The one-time-code fields are raw
    // <input> elements, so inheriting it would push an unknown attribute onto the DOM and warn — and the
    // fields want their id/name anyway, since the annotation is what stops the history.
    expect(NO_AUTOFILL_PROPS.suppressAutofillId).toBe(true)
    expect(NEW_SECRET_PROPS.suppressAutofillId).toBe(true)
    expect(EXISTING_SECRET_PROPS.suppressAutofillId).toBe(true)
    expect(ONE_TIME_CODE_PROPS).not.toHaveProperty('suppressAutofillId')
  })
})
