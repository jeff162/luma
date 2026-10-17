// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/* eslint-disable react-refresh/only-export-components -- provider + hook + renderer live together by design */

// The credential vault's gate, at App level.
//
// The gate itself is `lib/useVaultGate.js` — a gated action awaits `ensureVault()` and then carries on in
// its own call frame. What lives here is the *hosting* of it: the flags it reads, the passphrase dialog
// that settles it, and the notice a request for access raises. All three used to sit inside the
// Connections tab, which was fine while every gated action was on that tab and is not fine now
// that the navigation pane can start a sync. A gate whose dialog is mounted under one route cannot
// suspend an action taken anywhere else: the promise would resolve only if the user happened to be on
// that page, and the prompt would unmount underneath a pending action the moment they were not.
//
// **The flags are derived, not fetched.** `currentUser` already carries the whole vault state
// (`vault_configured`, `vault_unlocked`, and the rest), and the session owns it, so a second copy polled
// here could only disagree with it. Staleness is expected rather than polled against: the server drops
// the key on restart and on its idle timeout, so "unlocked" is always a cached answer — which is what the
// gate's `force` option and every call site's 423 retry are for. `adoptVaultState` is the one concession,
// and it adds no fetch of its own: a page that read auth status for its own reasons can hand the answer
// over, so a surface that *displays* the vault state self-corrects without a timer.
//
// The change-passphrase dialog lives here too, though it is not a gate — nothing awaits it, and it rewraps
// the key the session already holds rather than obtaining one. It is here because two pages open it:
// Vault settings on the Connections tab, and the Backup section, whose credentials wait on a passphrase
// that fails the strength rule.
//
// What deliberately stays with the Connections tab: the vault *strip* (a configuration surface) and the
// strip's own passkey button, whose refusal is reported as a page notice rather than inline in a dialog.

import { createContext, useCallback, useContext, useMemo, useState } from 'react'
import { api } from '../lib/api.js'
import { useAppSession } from '../lib/AppSessionContext.jsx'
import { useVaultGate } from '../lib/useVaultGate.js'
import { VaultPassphraseDialog } from '../components/VaultPassphraseDialog.jsx'
import { AppNoticeDialog } from '../components/ui.jsx'

const VaultGateContext = createContext(null)

export function useVaultGateContext() {
  const ctx = useContext(VaultGateContext)
  if (!ctx) throw new Error('useVaultGateContext must be used inside <VaultGateProvider>')
  return ctx
}

// The session's view of the vault, in the shape every consumer already reads. `hasPasskey` ignores a
// pending enrolment: a passkey awaiting approval cannot open anything yet, so offering it as a way in
// would be an affordance that always fails.
function vaultFlags(user) {
  const u = user || {}
  return {
    configured: !!u.vault_configured,
    hasPassphrase: !!u.vault_has_passphrase,
    unlocked: !!u.vault_unlocked,
    accessPending: !!u.vault_access_pending,
    hasPasskey: (u.vault_passkeys || []).some(pk => !pk.pending),
    // Judged at this member's last unlock against the current strength rule, and failed.
    passphraseNeedsChange: !!u.vault_passphrase_needs_change,
    // Not yet judged under the current rule, which only typing it can do.
    passphraseNeedsCheck: !!u.vault_passphrase_needs_check,
  }
}

export function VaultGateProvider({ children }) {
  const { currentUser, setCurrentUser } = useAppSession()
  const vault = useMemo(() => vaultFlags(currentUser), [currentUser])
  const { mode, ensureVault, openVault, closeVault } = useVaultGate(vault)
  const [notice, setNotice] = useState(null)
  // Held apart from the gate's own mode on purpose: the gate exists to make a blocked action resume once
  // the vault opens, and nothing is waiting on a passphrase change. Sharing its state would give the
  // change dialog a waiter to settle and let a change resolve some unrelated pending action as "unlocked".
  const [changingPassphrase, setChangingPassphrase] = useState(false)

  // Take a fresh `/auth/status` user a *page* happened to fetch, but only when it actually says something
  // new about the vault.
  //
  // The caller is the Connections tab, which reads auth status on every refresh for its transport check and
  // so holds the server's current answer in hand — worth adopting, because the server drops the key on its
  // idle timeout and a strip claiming the vault is open when it is not is wrong in the one place a user
  // looks to find out. The comparison is what makes it safe rather than merely nice: that page's refresh
  // depends on `currentUser`, so pushing a new object identity on every refresh would re-trigger the
  // refresh that produced it, forever. Comparing the projection means an unchanged vault is a no-op.
  const adoptVaultState = useCallback((user) => {
    if (!user) return
    const next = vaultFlags(user)
    setCurrentUser?.(prev => {
      const current = vaultFlags(prev)
      const same = Object.keys(next).every(k => current[k] === next[k])
      return same ? prev : user
    })
  }, [setCurrentUser])

  // Re-read the session's vault state from the server. Used after an operation whose result the response
  // does not carry (locking), rather than on a schedule: see the note above on why staleness is handled
  // at the point of failure instead of polled for.
  const refreshVault = useCallback(async () => {
    const status = await api.getAuthStatus().catch(() => null)
    if (status?.user) setCurrentUser?.(status.user)
    return status
  }, [setCurrentUser])

  // The dialog is dismissed only after the session's user has been replaced, so whatever action was
  // waiting on the gate resumes against the state the unlock actually produced.
  const submitVault = useCallback(async (passphrase) => {
    // 'set' and 'request' are the same call — which of the two it turns out to be is the server's to
    // decide, since only it knows whether this workspace already has a vault. The response says which
    // happened via `vault_access_pending`.
    const resp = mode === 'set' || mode === 'request'
      ? await api.setVaultPassphrase(passphrase)
      : await api.unlockVault(passphrase)
    if (resp?.user) setCurrentUser?.(resp.user)
    // A request grants nothing yet, so settling the gate as "unlocked" would let whatever action was
    // waiting run straight into a locked vault. It closes as declined, and the strip explains the wait.
    closeVault(!resp?.user?.vault_access_pending)
    if (resp?.user?.vault_access_pending) {
      setNotice({
        title: 'Vault access requested',
        description: 'Your passphrase is saved. It starts opening the vault as soon as someone who can '
          + 'already open it approves the request — they do not need your passphrase to do that.',
      })
    }
  }, [closeVault, mode, setCurrentUser])

  // A passkey proves the secret exactly as typing it does, so it settles the gate the same way and an
  // action waiting on `ensureVault` resumes either route.
  const adoptPasskeyUnlock = useCallback(async (user) => {
    if (user) setCurrentUser?.(user)
    closeVault(true)
  }, [closeVault, setCurrentUser])

  // The tail both routes of a passphrase change share. A passkey proves the current secret exactly as typing
  // it does, and the outcome is identical — same DEK, same stranded-backup consequence — so the same notice
  // is owed rather than a second one written for the other button.
  const completePassphraseChange = useCallback(async (user) => {
    if (user) setCurrentUser?.(user)
    setChangingPassphrase(false)
    setNotice({
      title: 'Vault passphrase changed',
      description: 'Your connections are unaffected. A backup taken before now puts the previous '
        + 'passphrase back when its accounts & secrets are restored.',
    })
  }, [setCurrentUser])

  const submitPassphraseChange = useCallback(async ({ current, next }) => {
    const resp = await api.changeVaultPassphrase(current, next)
    await completePassphraseChange(resp?.user)
  }, [completePassphraseChange])

  const lockVault = useCallback(async () => {
    await api.lockVault().catch(() => {})
    await refreshVault()
  }, [refreshVault])

  const value = useMemo(() => ({
    vault, mode, ensureVault, openVault, closeVault,
    submitVault, adoptPasskeyUnlock, adoptVaultState, lockVault, refreshVault,
    changingPassphrase, changePassphrase: () => setChangingPassphrase(true),
    submitPassphraseChange, completePassphraseChange, closePassphraseChange: () => setChangingPassphrase(false),
    notice, dismissNotice: () => setNotice(null),
  }), [vault, mode, ensureVault, openVault, closeVault,
    submitVault, adoptPasskeyUnlock, adoptVaultState, lockVault, refreshVault,
    changingPassphrase, submitPassphraseChange, completePassphraseChange, notice])

  return <VaultGateContext.Provider value={value}>{children}</VaultGateContext.Provider>
}

// Mounted once near the top of the App tree, so the prompt outlives the route that raised it — the whole
// reason the gate moved here. `VaultPassphraseDialog` carries its own raised z-index, which is what lets
// it sit above a confirmation dialog that is still open beneath it (Disconnect asks for the passphrase
// only after the user has committed, and backing out of the prompt returns to that decision).
export function VaultGateRenderer() {
  const {
    mode, submitVault, adoptPasskeyUnlock, closeVault, notice, dismissNotice,
    changingPassphrase, submitPassphraseChange, completePassphraseChange, closePassphraseChange,
  } = useVaultGateContext()
  return (
    <>
      {changingPassphrase ? (
        // The passkey route is offered here too, which is what makes the change usable by someone who has
        // forgotten the passphrase but still holds a way in. It proves the *current* secret; the new one
        // is typed in the dialog either way.
        <VaultPassphraseDialog mode="change" onSubmit={submitPassphraseChange}
          onUnlockedByPasskey={completePassphraseChange} onClose={closePassphraseChange} />
      ) : null}
      {mode ? (
        <VaultPassphraseDialog
          mode={mode}
          onSubmit={submitVault}
          onUnlockedByPasskey={adoptPasskeyUnlock}
          onClose={() => closeVault(false)}
        />
      ) : null}
      {notice ? (
        <AppNoticeDialog title={notice.title} description={notice.description} onClose={dismissNotice} />
      ) : null}
    </>
  )
}
