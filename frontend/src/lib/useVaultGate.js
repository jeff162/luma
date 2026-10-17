// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * The vault gate: the one way an action says "this needs the credential vault open".
 *
 * A gated action awaits `ensureVault()` and then carries on in its own call frame, so a locked vault
 * costs the user one passphrase entry rather than a passphrase entry plus a repeat of the gesture that
 * triggered it. That awaiting shape is the whole point: the earlier model — open the dialog and return —
 * dropped the action, so every gated button took two presses, and the alternative (handing the dialog a
 * callback to re-dispatch) makes each call site re-enter itself against vault flags the unlock has since
 * made stale. Here the flags are read once, before the prompt, and never again.
 *
 * `force` exists because those flags are only a *cached* answer: the server drops the DEK on restart and
 * on its idle timeout, so a 423 from a call this gate already let through is the same gate arriving late
 * and has to re-prompt even though the cache still says unlocked.
 *
 * The host owns the dialog: it renders whatever `mode` asks for, calls `closeVault(true)` once the
 * passphrase has been accepted (and the session's vault flags re-read), and `closeVault(false)` when the
 * user backs out. One prompt with one waiter — a second opener supersedes the first, releasing it as
 * declined, so an action can never resume behind an unlock performed for something else.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

export function useVaultGate({ configured, unlocked }) {
  // null (closed) | 'set' | 'unlock' from `ensureVault`; a host may `openVault` any dialog mode that ends
  // in the passphrase being submitted ('request', 'check').
  const [mode, setMode] = useState(null)
  // False when the opener already turned the passkey down — the strip's "Unlock with a passphrase" sits
  // beside the passkey button, so offering the passkey again in the dialog would undo that choice.
  const [offerPasskey, setOfferPasskey] = useState(true)
  const flagsRef = useRef({ configured, unlocked })
  const waiterRef = useRef(null)

  useEffect(() => { flagsRef.current = { configured, unlocked } }, [configured, unlocked])

  const settle = useCallback((value) => {
    const waiter = waiterRef.current
    waiterRef.current = null
    waiter?.(value)
  }, [])

  const openVault = useCallback((nextMode, { offerPasskey: offer = true } = {}) => {
    settle(false)
    setMode(nextMode)
    setOfferPasskey(offer)
    return new Promise(resolve => { waiterRef.current = resolve })
  }, [settle])

  // Resolves true only once the vault is actually open, so `if (!(await ensureVault())) return` is the
  // whole gate at a call site. An unconfigured vault asks for a passphrase to be set rather than for one
  // to be entered — minting it leaves the vault unlocked, so the action continues either way.
  const ensureVault = useCallback(({ force = false } = {}) => {
    const flags = flagsRef.current
    if (!force && flags.configured && flags.unlocked) return Promise.resolve(true)
    return openVault(flags.configured ? 'unlock' : 'set')
  }, [openVault])

  const closeVault = useCallback((unlockedNow = false) => {
    // Take the host's word for the new state immediately instead of waiting for the re-rendered flags:
    // a resumed action can re-enter the gate in the same tick (the 423 retry does), and a cache that
    // still said "locked" would prompt a second time for the passphrase just accepted.
    if (unlockedNow) flagsRef.current = { configured: true, unlocked: true }
    setMode(null)
    settle(!!unlockedNow)
  }, [settle])

  // Unmounting with a prompt open releases the waiter as declined rather than leaving the action's
  // promise pending forever.
  useEffect(() => () => settle(false), [settle])

  return { mode, offerPasskey, ensureVault, openVault, closeVault }
}
