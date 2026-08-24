// @vitest-environment jsdom

// Contract for the vault gate. What matters here is not that a dialog opens but that the *caller's*
// promise settles the right way in every exit: the bug this replaced was a gated action that opened the
// panel and then silently dropped itself, which no assertion about the dialog would have caught.

import { describe, it, expect } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useVaultGate } from '../useVaultGate.js'

function mountGate(flags = { configured: true, unlocked: false }) {
  return renderHook(props => useVaultGate(props), { initialProps: flags })
}

// Starts a gated action and hands back a probe for what its promise did, since the whole contract is
// "the action continues, or it doesn't" rather than anything the hook renders.
function startGatedAction(result, options) {
  const probe = { settled: false, value: null }
  act(() => {
    result.current.ensureVault(options).then(value => { probe.settled = true; probe.value = value })
  })
  return probe
}

describe('useVaultGate', () => {
  it('lets an action straight through when the vault is already open', async () => {
    const { result } = mountGate({ configured: true, unlocked: true })
    const action = startGatedAction(result)
    await act(async () => { })
    expect(action.value).toBe(true)
    expect(result.current.mode).toBe(null)
  })

  it('holds the action while the passphrase is entered, then resumes it', async () => {
    const { result } = mountGate({ configured: true, unlocked: false })
    const action = startGatedAction(result)
    expect(result.current.mode).toBe('unlock')
    expect(action.settled).toBe(false)   // the action is waiting, not dropped
    await act(async () => { result.current.closeVault(true) })
    expect(action.value).toBe(true)
    expect(result.current.mode).toBe(null)
  })

  it('stops the action when the prompt is declined', async () => {
    const { result } = mountGate({ configured: true, unlocked: false })
    const action = startGatedAction(result)
    await act(async () => { result.current.closeVault(false) })
    expect(action.value).toBe(false)
  })

  it('asks for a passphrase to be set when no vault exists yet', () => {
    const { result } = mountGate({ configured: false, unlocked: false })
    startGatedAction(result)
    expect(result.current.mode).toBe('set')
  })

  it('re-prompts under force even though the cached flags say unlocked', () => {
    // The 423 path: the server dropped the DEK under a page that still believes it is unlocked.
    const { result } = mountGate({ configured: true, unlocked: true })
    const action = startGatedAction(result, { force: true })
    expect(result.current.mode).toBe('unlock')
    expect(action.settled).toBe(false)
  })

  it('reads the current flags, not the ones it mounted with', async () => {
    const { result, rerender } = mountGate({ configured: true, unlocked: false })
    rerender({ configured: true, unlocked: true })
    const action = startGatedAction(result)
    await act(async () => { })
    expect(action.value).toBe(true)
    expect(result.current.mode).toBe(null)
  })

  it('counts the vault as open the moment the host says so, without waiting for a re-render', async () => {
    // The host re-reads the session flags before closing, so the props catch up a render later; a
    // resumed action re-entering the gate in between must not be asked for the passphrase again.
    const { result } = mountGate({ configured: true, unlocked: false })
    startGatedAction(result)
    await act(async () => { result.current.closeVault(true) })
    const next = startGatedAction(result)
    await act(async () => { })
    expect(next.value).toBe(true)
    expect(result.current.mode).toBe(null)
  })

  it('releases an earlier waiter when a second prompt supersedes it', async () => {
    const { result } = mountGate({ configured: true, unlocked: false })
    const first = startGatedAction(result)
    const second = startGatedAction(result)
    await act(async () => { })
    expect(first.value).toBe(false)      // declined, so it cannot resume behind the second unlock
    expect(second.settled).toBe(false)
    await act(async () => { result.current.closeVault(true) })
    expect(second.value).toBe(true)
  })

  it('releases the waiter when the host unmounts with a prompt open', async () => {
    const { result, unmount } = mountGate({ configured: true, unlocked: false })
    const action = startGatedAction(result)
    await act(async () => { unmount() })
    expect(action.value).toBe(false)
  })
})
