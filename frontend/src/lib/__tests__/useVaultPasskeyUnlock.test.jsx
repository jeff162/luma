// @vitest-environment jsdom

// The shared "Unlock with a passkey" control, used by the Connections tab's vault strip and by the
// unlock dialog. Two places to unlock a vault is intended; two implementations of the button was not —
// they were written in one commit and kept in agreement by a comment, which synced their appearance and
// left the state machine out of it. The strip had no busy flag, so a second press started a second
// WebAuthn ceremony and the browser's refusal arrived as an error dialog on top of the prompt.
//
// These pin the parts that diverged, plus the contract that makes the hook safe to share:
//   - busy toggles around the ceremony and the label follows it
//   - a second press while one is in flight does nothing at all — checked in the SAME tick, since that
//     is the case a state-based guard cannot catch
//   - busy clears on success too, so a host that fails to take the surface away cannot strand the button
//   - refusal routes to the host, which shows it differently on each surface (inline error vs notice)
//   - `unlock` keeps a stable identity across renders

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'

const runVaultPasskeyUnlock = vi.fn()
vi.mock('../vaultPasskey.js', () => ({
  runVaultPasskeyUnlock: (...a) => runVaultPasskeyUnlock(...a),
}))

const { useVaultPasskeyUnlock, VAULT_PASSKEY_LABEL, VAULT_PASSKEY_WAITING_LABEL } =
  await import('../useVaultPasskeyUnlock.js')

beforeEach(() => runVaultPasskeyUnlock.mockReset())

// A ceremony left pending until the test releases it — the browser prompt sitting open.
function pendingCeremony() {
  let release
  runVaultPasskeyUnlock.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
  return value => release(value)
}

describe('useVaultPasskeyUnlock', () => {
  it('reports busy and re-labels while the ceremony runs, then settles', async () => {
    const release = pendingCeremony()
    const onUnlocked = vi.fn()
    const { result } = renderHook(() => useVaultPasskeyUnlock({ onUnlocked, onRefused: vi.fn() }))

    expect(result.current.label).toBe(VAULT_PASSKEY_LABEL)
    act(() => { result.current.unlock() })
    await waitFor(() => expect(result.current.busy).toBe(true))
    expect(result.current.label).toBe(VAULT_PASSKEY_WAITING_LABEL)

    await act(async () => { release({ ok: true, user: { id: 'u1' } }) })
    expect(onUnlocked).toHaveBeenCalledWith({ id: 'u1' })
    // Cleared on success too: the host normally takes this surface away, but one that fails to would
    // otherwise leave the control reading "Waiting for passkey…" with no way back short of a reload.
    expect(result.current.busy).toBe(false)
    expect(result.current.label).toBe(VAULT_PASSKEY_LABEL)
  })

  it('ignores a second press in the same tick, before any re-render could disable the button', async () => {
    // The exact shape of the bug. A guard reading React state cannot catch this: state does not change
    // until a re-render, so both presses would see "not busy" and both would start a ceremony.
    const release = pendingCeremony()
    const { result } = renderHook(() => useVaultPasskeyUnlock({ onUnlocked: vi.fn(), onRefused: vi.fn() }))

    act(() => {
      result.current.unlock()
      result.current.unlock()
    })
    expect(runVaultPasskeyUnlock).toHaveBeenCalledTimes(1)
    await act(async () => { release({ ok: true, user: null }) })
  })

  it('hands a refusal to the host rather than deciding how to show it', async () => {
    // The one thing that legitimately differs between the two surfaces: the dialog shows it inline, the
    // strip raises a notice. So the hook reports and the host renders.
    runVaultPasskeyUnlock.mockResolvedValueOnce({ ok: false, reason: 'failed', message: 'no good' })
    const onRefused = vi.fn()
    const { result } = renderHook(() => useVaultPasskeyUnlock({ onUnlocked: vi.fn(), onRefused }))
    await act(async () => { await result.current.unlock() })
    expect(onRefused).toHaveBeenCalledWith('no good')
    expect(result.current.busy).toBe(false)
  })

  it('says nothing when the refusal carries no message', async () => {
    // A dismissed prompt and a swallowed duplicate press both report an empty message: the user closed
    // it on purpose, or the ceremony they wanted is already on screen. Neither is news.
    runVaultPasskeyUnlock.mockResolvedValueOnce({ ok: false, reason: 'in_progress', message: '' })
    const onRefused = vi.fn()
    const { result } = renderHook(() => useVaultPasskeyUnlock({ onUnlocked: vi.fn(), onRefused }))
    await act(async () => { await result.current.unlock() })
    expect(onRefused).not.toHaveBeenCalled()
  })

  it('recovers when the host throws while adopting the unlock', async () => {
    runVaultPasskeyUnlock.mockResolvedValueOnce({ ok: true, user: { id: 'u1' } })
    const onRefused = vi.fn()
    const onUnlocked = vi.fn(async () => { throw new Error('refresh failed') })
    const { result } = renderHook(() => useVaultPasskeyUnlock({ onUnlocked, onRefused }))
    await act(async () => { await result.current.unlock() })
    expect(onRefused).toHaveBeenCalledWith('refresh failed')
    expect(result.current.busy).toBe(false)
  })

  it('keeps a stable unlock across renders, and still calls the current handlers', async () => {
    // Identity stability is a contract of shared code: a caller may put this in a dependency array or
    // pass it to a memoized child. Re-created handlers must still be honoured.
    const first = vi.fn()
    const { result, rerender } = renderHook(
      ({ onUnlocked }) => useVaultPasskeyUnlock({ onUnlocked, onRefused: vi.fn() }),
      { initialProps: { onUnlocked: first } },
    )
    const unlock = result.current.unlock
    const second = vi.fn()
    rerender({ onUnlocked: second })
    expect(result.current.unlock).toBe(unlock)

    runVaultPasskeyUnlock.mockResolvedValueOnce({ ok: true, user: null })
    await act(async () => { await result.current.unlock() })
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalled()
  })
})
