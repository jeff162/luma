// The three field kinds, and the distinctions between them that a wrong spread would erase silently.
//
// Worth pinning because every failure here is invisible in the running app until someone notices the
// browser offering the wrong thing: a confirmation field advertising itself as a password, a one-time
// code field suppressing the manager that would fill it, or a raw <input> handed a prop that only the
// shared Input understands.

import { describe, expect, it } from 'vitest'
import { NO_AUTOFILL_PROPS, ONE_TIME_CODE_PROPS, SENSITIVE_FIELD_PROPS } from '../sensitiveFields.js'

describe('field kinds', () => {
  it('all three turn off the browser text handling that would mangle a value', () => {
    for (const props of [NO_AUTOFILL_PROPS, SENSITIVE_FIELD_PROPS, ONE_TIME_CODE_PROPS]) {
      expect(props.autoCorrect).toBe('off')
      expect(props.autoCapitalize).toBe('off')
      expect(props.spellCheck).toBe(false)
    }
  })

  it('uses the autoComplete value that is actually honored for each kind', () => {
    // 'off' is ignored on password fields, which is the only reason the secret set says 'new-password'
    // — and saying 'new-password' on a non-password field is what invites a manager to offer to
    // *generate* a value for it, which is the bug that split these apart.
    expect(NO_AUTOFILL_PROPS.autoComplete).toBe('off')
    expect(SENSITIVE_FIELD_PROPS.autoComplete).toBe('new-password')
    expect(ONE_TIME_CODE_PROPS.autoComplete).toBe('one-time-code')
  })

  it('opts out of password managers only for a real secret', () => {
    // A manager holding the TOTP seed should still offer the current code, and a typed confirmation
    // phrase is nothing a manager has any business filling.
    expect(SENSITIVE_FIELD_PROPS['data-1p-ignore']).toBe('true')
    expect(NO_AUTOFILL_PROPS['data-1p-ignore']).toBeUndefined()
    expect(ONE_TIME_CODE_PROPS['data-1p-ignore']).toBeUndefined()
  })

  it('carries the shared-Input-only prop only where the shared Input is used', () => {
    // `suppressAutofillId` is a prop of `Input`, not a DOM attribute. The one-time-code fields are raw
    // <input> elements, so inheriting it would push an unknown attribute onto the DOM and warn — and the
    // fields want their id/name anyway, since the annotation is what stops the history.
    expect(NO_AUTOFILL_PROPS.suppressAutofillId).toBe(true)
    expect(SENSITIVE_FIELD_PROPS.suppressAutofillId).toBe(true)
    expect(ONE_TIME_CODE_PROPS).not.toHaveProperty('suppressAutofillId')
  })
})
