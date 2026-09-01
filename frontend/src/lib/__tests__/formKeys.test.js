// Enter-key handling for explicit-submit forms. Small, but the failure mode is silent in both
// directions: a handler that fires on every key would submit half-typed input, and one that swallows
// Enter without acting leaves a field that looks interactive and does nothing.

import { describe, expect, it, vi } from 'vitest'
import { advanceOnEnter, onEnter } from '../formKeys.js'

const press = (key) => ({ key, preventDefault: vi.fn() })

describe('onEnter', () => {
  it('acts on Enter and stops the default', () => {
    const action = vi.fn()
    const event = press('Enter')
    onEnter(action)(event)
    expect(action).toHaveBeenCalledOnce()
    expect(event.preventDefault).toHaveBeenCalledOnce()
  })

  it('ignores every other key, and leaves their default alone', () => {
    const action = vi.fn()
    for (const key of ['a', 'Tab', 'Escape', 'ArrowDown', ' ']) {
      const event = press(key)
      onEnter(action)(event)
      expect(event.preventDefault).not.toHaveBeenCalled()
    }
    expect(action).not.toHaveBeenCalled()
  })
})

describe('advanceOnEnter', () => {
  it('moves focus to the next field', () => {
    const focus = vi.fn()
    advanceOnEnter({ current: { focus } })(press('Enter'))
    expect(focus).toHaveBeenCalledOnce()
  })

  it('does not throw when the target is not mounted', () => {
    // A conditionally-rendered field (the confirm input exists only in the set/change modes) leaves an
    // empty ref behind, and Enter must be a no-op there rather than an error in the console.
    expect(() => advanceOnEnter({ current: null })(press('Enter'))).not.toThrow()
  })
})
