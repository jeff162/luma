// One passkey ceremony at a time.
//
// The bug: the vault strip's "Unlock with a passkey" button had no busy state, so a second press while
// the browser's prompt was up started a second ceremony. The browser refuses that, and its refusal
// surfaced as an error dialog ("a request is already in progress") stacked on top of the prompt the user
// actually wanted — leaving them to dismiss a failure that was purely an artifact of pressing twice.
//
// The button now disables, but that is the guard the *user* sees. This is the one that holds when a
// press lands before the disabled state reaches the DOM, and for any future caller that forgets — being
// a property of WebAuthn rather than of a particular button. It refuses **silently** (`message: ''`),
// because both callers raise a notice only when there is a message, and nothing has gone wrong for the
// user to read: the ceremony they asked for is already on screen.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const vaultPasskeyParams = vi.fn()
const unlockVaultWithPasskey = vi.fn()

vi.mock('../api.js', () => ({
  api: {
    vaultPasskeyParams: (...a) => vaultPasskeyParams(...a),
    unlockVaultWithPasskey: (...a) => unlockVaultWithPasskey(...a),
  },
}))

const { runVaultPasskeyUnlock } = await import('../vaultPasskey.js')

// A ceremony that stays pending until the test releases it, standing in for the browser prompt sitting
// open while the user clicks again.
function pendingParams() {
  let release
  vaultPasskeyParams.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
  return () => release({})
}

beforeEach(() => {
  vaultPasskeyParams.mockReset()
  unlockVaultWithPasskey.mockReset()
})

describe('runVaultPasskeyUnlock concurrency', () => {
  it('refuses a second call while one is in flight, and says nothing about it', async () => {
    const release = pendingParams()
    const first = runVaultPasskeyUnlock()
    const second = await runVaultPasskeyUnlock()

    expect(second.ok).toBe(false)
    expect(second.reason).toBe('in_progress')
    // The whole point: an empty message is what makes the duplicate press produce no dialog.
    expect(second.message).toBe('')
    // And it never reached the browser — one ceremony was started, not two.
    expect(vaultPasskeyParams).toHaveBeenCalledTimes(1)

    release()
    await first
  })

  it('accepts a new call once the previous one has settled', async () => {
    vaultPasskeyParams.mockRejectedValueOnce(new Error('nope'))
    const failed = await runVaultPasskeyUnlock()
    expect(failed.ok).toBe(false)
    expect(failed.reason).toBe('failed')

    // A ceremony that throws must not wedge the flag: recovering would otherwise mean reloading.
    vaultPasskeyParams.mockRejectedValueOnce(new Error('nope again'))
    const next = await runVaultPasskeyUnlock()
    expect(next.reason).toBe('failed')
    expect(vaultPasskeyParams).toHaveBeenCalledTimes(2)
  })
})
