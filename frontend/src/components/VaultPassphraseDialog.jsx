// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// The credential-vault passphrase dialog — the surface `useVaultGate` asks the host to render for its
// `mode` ('set' to mint the workspace vault, 'unlock' to open it for this session). Extracted from the
// Connections tab when Backup / Restore became its second host: restoring an older standalone credentials
// backup re-keys secrets under the workspace DEK, so it needs the same gate and the same prompt.
//
// A third mode, 'change', rewraps the DEK under a new passphrase. It is not a gate mode — nothing awaits
// it — but it asks for the same fields against the same floor, and a separate dialog would be the same
// component with one extra input and its own opportunity to disagree about the rules.
//
// The strength meter travels with it (no other caller). The field sets do not: the Connections tab's
// provider-secret fields and Backup / Restore annotate their secrets the same way, and one copy of that is
// the point, so it lives in `lib/sensitiveFields.js` — a shared constant, and not a vault-specific one, so
// a component module was the wrong home for it in both directions.

import { useEffect, useRef, useState } from 'react'
import { Button, PasswordInput, PasswordManagerUsername, AppDialog, Tooltip } from './ui.jsx'
import { useAppSession } from '../lib/AppSessionContext.jsx'
import { passphraseLimits, passphraseMeetsFloor, usePassphraseStrength } from '../lib/vaultPassphrase.js'
import { EXISTING_SECRET_PROPS, NEW_SECRET_PROPS, VAULT_PASSWORD_MANAGER_USERNAME } from '../lib/sensitiveFields.js'
import { hasUsableVaultPasskey } from '../lib/vaultPasskey.js'
import { useVaultPasskeyUnlock } from '../lib/useVaultPasskeyUnlock.js'
import { advanceOnEnter, onEnter } from '../lib/formKeys.js'
import { api } from '../lib/api.js'
import { formatDate } from '../lib/utils.js'

// The server's estimate (0–4, from `usePassphraseStrength`), drawn as four bars. The same estimate decides
// whether the passphrase is allowed — only the top score is — so the meter and the gate cannot disagree:
// a full green meter is exactly a passphrase the vault will take.
const STRENGTH_LABELS = ['Very weak', 'Weak', 'Fair', 'Almost there', 'Strong']
const STRENGTH_COLORS = ['#dc2626', '#dc2626', '#eab308', '#eab308', '#16a34a']

function PassphraseStrengthMeter({ score }) {
  // Always rendered — even with no passphrase yet — so this row reserves its space up front and the
  // confirm field below doesn't jump the moment the user starts typing. The empty state shows neutral grey
  // bars and a muted "Passphrase strength" caption rather than an alarming "Very weak".
  const has = score !== null && score !== undefined
  const label = has ? STRENGTH_LABELS[score] : ''
  const color = has ? STRENGTH_COLORS[score] : 'var(--muted)'
  return (
    <div style={{ display: 'grid', gap: 5 }}>
      <div style={{ display: 'flex', gap: 4 }}>
        {[0, 1, 2, 3].map(i => (
          <div key={i} style={{ height: 4, flex: 1, borderRadius: 2, background: has && i < score ? color : 'var(--border)' }} />
        ))}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--muted)', minHeight: 16 }}>
        <span style={{ color }}>{has ? label : 'Passphrase strength'}</span>
      </div>
    </div>
  )
}

// Backups carrying the vault's current wrapping, which a change would strand. Fetched when the change
// dialog opens, because it is only ever true of *this* moment: a change rewraps the DEK, and every file
// exported before it puts the old wrap back when restored, so the vault then opens with the old passphrase
// alone. A failure to fetch leaves the list empty, which is
// the right degradation — the general caution below is unconditional and covers the same ground less
// specifically.
function useStrandedBackups(active) {
  const [backups, setBackups] = useState([])
  useEffect(() => {
    if (!active) return undefined
    let alive = true
    api.vaultCredentialsBackups()
      .then(r => { if (alive) setBackups(r.backups || []) })
      .catch(() => {})
    return () => { alive = false }
  }, [active])
  return backups
}

// Said in four places — the note under the confirm field, the hover on each control the mismatch
// disables, and the submit-time refusal that still has to catch the stretch the note stays quiet for.
// One string, so a user who reads it twice reads the same sentence twice.
const MISMATCH = 'The passphrases do not match.'

export function VaultPassphraseDialog({ mode, onSubmit, onClose, onUnlockedByPasskey }) {
  // mode: 'set' (mint/replace the workspace vault) | 'unlock' (open it for this session)
  //     | 'change' (rewrap the DEK under a new passphrase)
  //     | 'request' (join a vault that already exists — same passphrase against the same floor, but it
  //       opens nothing until a member approves, and saying so up front is the whole difference)
  const [passphrase, setPassphrase] = useState('')
  const [confirm, setConfirm] = useState('')
  const [current, setCurrent] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // Enter walks the fields and submits from the last one — the same rule the sign-in screen follows, and
  // the reason these need refs at all: a sensitive field renders with no id or name (see
  // `sensitiveFields.js`), so there is no selector that could find the next one.
  const passphraseRef = useRef(null)
  const confirmRef = useRef(null)
  const changing = mode === 'change'
  const requesting = mode === 'request'
  // 'confirm' re-presents a secret for a vault that is already open, so a change to the unlock methods
  // themselves can be authorized. Mechanically an unlock — that is what stamps the proof server-side —
  // but it must not *say* "unlock", which would describe an action the vault does not need.
  const confirming = mode === 'confirm'
  // Every one of these three chooses a NEW passphrase and is held to the floor.
  const setting = mode === 'set' || changing || requesting
  const session = useAppSession()
  const limits = passphraseLimits(session?.currentUser)
  const strength = usePassphraseStrength(passphrase, limits, { enabled: setting })
  const shortfall = setting ? strength.issue : null
  const stranded = useStrandedBackups(changing)
  // Disabled rather than refused on submit: the floor is a rule the user can satisfy before spending a
  // round trip, and letting the click through only to answer it with an error is what made the old
  // advisory meter feel like the passphrase had been accepted. Held while the verdict on what is typed
  // is still on its way, for the same reason.
  const blocked = busy || (setting && (!passphrase || !!shortfall || strength.pending))

  // What is still wrong with the new passphrase, in the words of the condition that is unmet. One
  // expression feeds all three places it is needed — the note under the confirm field and the hover on
  // each control it disables — so a control can never be greyed for a reason the screen does not give.
  const newPassphraseIssue = !passphrase ? 'Enter a new passphrase.'
    : shortfall ? shortfall
      : strength.pending ? 'Checking how easy the passphrase is to guess…'
        : !confirm ? 'Re-enter the new passphrase to confirm it.'
          : passphrase !== confirm ? MISMATCH : ''
  // Shown from the first character typed into the confirm field until the two agree — deliberately
  // including the stretch where what has been typed is still a correct prefix. Staying silent there
  // reads as "so far so good" and leaves someone who stopped a character short with a greyed button
  // and nothing to explain it, which is the whole complaint this answers.
  const mismatch = setting && !!confirm && passphrase !== confirm

  // Offered wherever a passkey can actually answer the question being asked, and only where a usable one
  // exists. That is three of the modes, for two different reasons:
  //
  //   'unlock'  — the passkey opens the vault, which is the whole request.
  //   'confirm' — the ceremony *is* the proof; unlocking again is how the server records it.
  //   'change'  — the passkey stands in for the CURRENT passphrase, not the new one. This was the gap:
  //               the button was gated on 'unlock' alone on the reasoning that "the other modes choose a
  //               NEW passphrase, which a passkey cannot stand in for" — true of the new passphrase, but
  //               it also blocked the passkey from proving the old one, so somebody who had forgotten
  //               their passphrase but held a passkey had no way to set a new one at all.
  //
  // This is the fix for a gap that made the feature nearly unreachable: the ceremony existed and worked,
  // but was wired only to the vault strip on the Connections tab. Every gated action — disconnect, sync,
  // a credentials restore, and the 423 re-prompt that fires when the server drops the key on its idle
  // timeout — raises THIS dialog instead, which offered the passphrase and nothing else. So a user who
  // had set up a passkey specifically to stop typing their passphrase was asked for it every time, and
  // the 423 path could not even be pre-empted by clicking the strip first, since it is invisible until
  // it fires.
  const canUsePasskey = (mode === 'unlock' || confirming || changing) && !!onUnlockedByPasskey
    && hasUsableVaultPasskey(session?.currentUser)

  // In 'change' the passkey submits the whole operation — proof and replacement together — so it has to
  // hold the new passphrase to the same floor and the same confirm-field check as the button beside it.
  // In the other two it carries nothing.
  const passkeyBlocked = changing && !!newPassphraseIssue

  // A refusal leaves the dialog open on the passphrase, which is the fallback the user still has.
  const { busy: passkeyBusy, unlock: unlockByPasskey, label: passkeyLabel } = useVaultPasskeyUnlock({
    onUnlocked: onUnlockedByPasskey,
    onRefused: setError,
    // 'change' runs a different ceremony: it ends by writing the new passphrase rather than by
    // unlocking, so the new one has to travel with it.
    ...(changing ? { getNewPassphrase: () => passphrase, label: 'Use a passkey' } : {}),
    ...(confirming ? { label: 'Confirm with a passkey' } : {}),
  })

  function onPasskey() {
    if (changing && passphrase !== confirm) { setError(MISMATCH); return }
    unlockByPasskey()
  }

  async function submit() {
    if (setting && passphrase !== confirm) { setError(MISMATCH); return }
    if (!passphrase) { setError('Enter a passphrase.'); return }
    if (changing && !current) { setError('Enter your current passphrase.'); return }
    setBusy(true)
    setError('')
    try {
      await onSubmit(changing ? { current, next: passphrase } : passphrase)
    } catch (e) {
      setError(e.message || 'Could not update the vault')
      setBusy(false)
    }
  }

  return (
    <AppDialog
      title={changing ? 'Change the vault passphrase'
        : requesting ? 'Request vault access'
          : confirming ? 'Confirm it’s you'
            : setting ? 'Set a vault passphrase' : 'Unlock the vault'}
      description={changing
        ? 'The new passphrase re-protects the same encrypted credentials. Nothing is re-encrypted and no connection needs re-linking. The current passphrase proves this is you — a passkey does the same, for anyone who has one.'
        : confirming
          ? 'Changing how this vault is opened needs the passphrase or a passkey, even though the vault is already open. Otherwise anyone who reached an unlocked screen could add their own way in.'
          : requesting
          ? 'This workspace already has a credential vault. Choose the passphrase that will open it for you — it starts working once a member who can already open the vault approves the request.'
          : setting
            ? 'The vault encrypts your data provider credentials at rest. You will enter this passphrase once per session to connect or sync.'
            : 'Enter your vault passphrase to connect and sync data providers this session.'}
      onClose={onClose}
      // Above the standard dialog layer: this is the one dialog that opens *on top of* another one —
      // a connect or a disconnect confirmation raises it and waits behind it — and at the shared
      // z-index the dialog underneath would paint over the passphrase field.
      zIndex={1400}
      width="min(460px, 100%)"
      actions={
        <>
          <Button variant="ghost" small onClick={onClose}>Cancel</Button>
          {/* Ordered and toned exactly as the Connections tab's vault strip does it, so the primary way
              in does not change depending on which surface asked. */}
          {canUsePasskey ? (
            <Tooltip content={passkeyBlocked ? newPassphraseIssue : ''} align="right">
              <Button small onClick={onPasskey} disabled={busy || passkeyBusy || passkeyBlocked}>
                {passkeyLabel}
              </Button>
            </Tooltip>
          ) : null}
          <Tooltip content={blocked && !busy ? newPassphraseIssue : ''} align="right">
            <Button small variant={canUsePasskey ? 'ghost' : 'primary'}
              onClick={submit} disabled={blocked || passkeyBusy}>
              {busy ? 'Working…'
                : changing ? 'Change passphrase'
                  : requesting ? 'Request access'
                    : confirming ? 'Confirm'
                      : setting ? 'Set passphrase' : 'Unlock'}
            </Button>
          </Tooltip>
        </>
      }
    >
      <div style={{ display: 'grid', gap: 12 }}>
        <PasswordManagerUsername value={VAULT_PASSWORD_MANAGER_USERNAME} />
        {changing ? (
          <PasswordInput value={current} onChange={setCurrent}
            placeholder={canUsePasskey ? 'Current passphrase (or use a passkey)' : 'Current passphrase'}
            autoFocus
            onKeyDown={advanceOnEnter(passphraseRef)} {...EXISTING_SECRET_PROPS} />
        ) : null}
        {/* Submits directly when unlocking, which is the single-field case and the whole interaction:
            type the passphrase, press Enter. Every other mode is choosing a *new* passphrase and has a
            confirm field, so Enter moves there instead — submitting from here would skip the check the
            second field exists to make. */}
        <PasswordInput ref={passphraseRef} value={passphrase} onChange={setPassphrase}
          placeholder={changing ? 'New passphrase' : 'Vault passphrase'} autoFocus={!changing}
          onKeyDown={setting ? advanceOnEnter(confirmRef) : onEnter(() => { if (!blocked) submit() })}
          {...(setting ? {
            onSuggest: () => { setConfirm(''); confirmRef.current?.focus() },
            suggestionFits: value => passphraseMeetsFloor(value, limits),
          } : {})}
          {...(setting ? NEW_SECRET_PROPS : EXISTING_SECRET_PROPS)} />
        {setting ? <PassphraseStrengthMeter score={passphrase ? strength.score : null} /> : null}
        {shortfall ? (
          <div style={{ fontSize: 12, color: '#dc2626', marginTop: -6 }}>{shortfall}</div>
        ) : null}
        {setting ? (
          <PasswordInput ref={confirmRef} value={confirm} onChange={setConfirm}
            placeholder={changing ? 'Confirm new passphrase' : 'Confirm passphrase'}
            // Guarded on the same `blocked` the button is, so Enter can never submit something the
            // button would refuse — a passphrase under the floor stays un-submittable either way.
            onKeyDown={onEnter(() => { if (!blocked) submit() })}
            {...NEW_SECRET_PROPS} />
        ) : null}
        {mismatch ? (
          <div style={{ fontSize: 12, color: '#dc2626', marginTop: -6 }}>{MISMATCH}</div>
        ) : null}
        {/* The consequence a passphrase change has that nothing else on screen would reveal: the same DEK
            is rewrapped, so stored ciphertext is untouched, but any backup already written carries the
            OLD wrap, and restoring it — here or on another system — puts the vault back as it was, so it
            then opens only with the old passphrase (or the recovery code it carries). Named
            by date where the record knows of one, since "you have a backup from this date" is actionable
            in a way that "if you hold any backup…" is not. The general line stays for files exported
            before that record existed. */}
        {changing ? (
          <div style={{
            fontSize: 12, lineHeight: 1.5, borderRadius: 6, padding: '8px 10px',
            background: 'color-mix(in srgb, var(--warning, #d97706) 12%, var(--surface2))',
            color: 'var(--text)',
          }}>
            {stranded.length ? (
              <>
                <b>Keep your current passphrase.</b> {stranded.length === 1 ? 'A backup' : 'Backups'} taken
                {' '}{stranded.map(b => formatDate(String(b.exported_at).slice(0, 10))).join(', ')}
                {' '}put the vault back as it was, so after restoring one the vault opens only with it, even
                after this change.
              </>
            ) : (
              <>
                <b>Keep your current passphrase.</b> Any backup taken before now puts the vault back as it
                was, so after restoring it the vault opens only with it, even after this change.
              </>
            )}
          </div>
        ) : null}
        {setting && !changing ? (
          <p style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5, margin: 0 }}>
            {requesting
              ? 'Nobody else ever learns this passphrase — approval does not require it.'
              : 'Nothing here can recover it for you — create a recovery code in Vault settings, or losing it means reconnecting every connection.'}
            {' '}Store it in a password manager; it must be at least {limits.minLength} characters and
            hard to guess — several unrelated words work well.
          </p>
        ) : null}
        {error ? <div style={{ fontSize: 13, color: '#dc2626' }}>{error}</div> : null}
      </div>
    </AppDialog>
  )
}
