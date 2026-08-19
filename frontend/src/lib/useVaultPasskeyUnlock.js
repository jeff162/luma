// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useRef, useState } from 'react'
import { runVaultPasskeyUnlock } from './vaultPasskey.js'

// The "Unlock with a passkey" control, everywhere it appears.
//
// There are legitimately two places to unlock a vault — the standing `VaultStrip` banner on the
// Connections tab (proactive, nothing waiting on it) and `VaultPassphraseDialog` (raised *by* a gated
// action — connect, sync, disconnect, a credentials restore, the 423 re-prompt — with that action
// waiting behind it). Two places, one behaviour.
//
// What was shared before this was only the *ceremony* (`runVaultPasskeyUnlock`). The control around it
// was written twice in one commit, kept in agreement by a comment — "ordered and toned exactly as the
// Connections tab's vault strip does it" — which synced the two on appearance and left the state machine
// out of the bargain. The dialog had a busy flag from the start; the strip never did, so a second press
// there started a second WebAuthn ceremony and the browser's refusal ("a request is already in progress")
// arrived as an error dialog stacked on the prompt the user actually wanted. The wording was in step and
// the behaviour was not, which is the failure mode an agreement held in prose has.
//
// So the hook owns everything that can diverge: the busy flag, the sequencing, and the label. Each host
// still renders its own `<Button>`, because the *styling* genuinely differs — the dialog's sits in
// `DialogActions` playing off the submit button's variant, the strip's is a `marginLeft: auto` banner
// action — and that difference is intended rather than accidental.
//
// A hook rather than a component for a concrete reason: both hosts also disable their **passphrase**
// control while a ceremony runs, since opening the passphrase dialog over the browser's passkey prompt
// is the same "two stacked asks for one thing" confusion in a different costume. They need `busy` in
// hand, so a component owning it privately would have to report it straight back out.

export const VAULT_PASSKEY_LABEL = 'Unlock with a passkey'
export const VAULT_PASSKEY_WAITING_LABEL = 'Waiting for passkey…'

export function useVaultPasskeyUnlock({ onUnlocked, onRefused }) {
  const [busy, setBusy] = useState(false)
  // The in-flight test is a ref, not the state above. State does not change until a re-render, so two
  // presses landing in one tick would both read `false` and both start a ceremony — the very case this
  // exists for. A ref is set the instant the first press is handled. The state is what the *render*
  // needs (a label, a disabled attribute); this is what the *guard* needs, and they are not the same
  // question.
  const busyRef = useRef(false)
  // Mirrored so `unlock` can be a stable reference while still calling the current handlers — the same
  // pattern `useVaultGate` uses. Without it every render rebuilds `unlock`, which is harmless today and
  // a trap for the first caller who puts it in a dependency array or hands it to a memoized child.
  const handlersRef = useRef({ onUnlocked, onRefused })
  useEffect(() => { handlersRef.current = { onUnlocked, onRefused } }, [onUnlocked, onRefused])

  const unlock = useCallback(async () => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    try {
      const result = await runVaultPasskeyUnlock()
      if (!result.ok) {
        // A dismissed prompt reports nothing — the user closed it on purpose — and so does a duplicate
        // press, which `runVaultPasskeyUnlock` refuses with an empty message. Both are answered by
        // leaving the surface exactly as it was.
        if (result.message) handlersRef.current.onRefused?.(result.message)
        return
      }
      await handlersRef.current.onUnlocked?.(result.user)
    } catch (e) {
      handlersRef.current.onRefused?.(e?.message || 'The vault opened, but this screen could not refresh.')
    } finally {
      // Cleared on every path, success included. The host normally responds by taking this surface away
      // — the strip re-renders unlocked, the dialog closes — so on the happy path this lands in the same
      // React 18 batch as that change and is never seen. What it buys is the path where the host does
      // *not* go away: a refresh that fails, or a vault that reports itself still locked. A control left
      // reading "Waiting for passkey…" over a ceremony that ended is unrecoverable without a reload,
      // which is a worse failure than a flicker that does not occur.
      busyRef.current = false
      setBusy(false)
    }
  }, [])

  return { busy, unlock, label: busy ? VAULT_PASSKEY_WAITING_LABEL : VAULT_PASSKEY_LABEL }
}
