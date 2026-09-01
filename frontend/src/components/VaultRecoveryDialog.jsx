// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// "I can't get into my vault" — the surface reached from the *locked* vault strip, and the only place in
// the app where the recovery ladder is presented as a whole.
//
// The ordering is the feature, not the layout. There are up to three ways out of a forgotten passphrase
// and only the last one costs anything, so this dialog offers them strictly in order and puts the
// destructive one behind a disclosure. Presented as a flat list of options, the cheapest rung reads as
// one choice among equals and a user in a hurry picks the loudest.
//
//   0. This user's own other unlock methods — a passkey they had forgotten registering. Free, immediate,
//      and the rung most easily missed, because anyone who reaches this dialog is thinking about a
//      passphrase and a passkey lives behind a different button.
//   1. Another member can open the vault  → not a reset at all. They re-enrol this user, no credential
//      moves, nothing is re-linked. **Named**: "somebody else can open this vault" is not something
//      anyone can act on, and "frances can" is — the name is the whole content of the rung.
//   2. A recovery code                    → opens the vault and re-keys the passphrase against the SAME
//      workspace key, so again nothing is re-encrypted and no data source is reconnected.
//   3. A credentials backup               → complete recovery, but only after a reset, since re-keying
//      needs a local vault open and there is no opening the old one. Named here so the reset does not
//      read as pure loss when a rescue file exists.
//   4. Rebuild                            → destructive, irreversible, and the only rung that re-links.
//
// **Every rung above the last is a reason, never a bar.** An earlier design refused the rebuild outright
// while another member held a slot. That contradicted this dialog's own language — the disclosure reads
// *"none of these"*, and answering "yes, one of them does" overrules the one person who knows whether
// that member is actually reachable. A slot row proves someone *could* open the vault, not that they
// will. So the alternatives are led with and named, and if the user says none apply the rebuild proceeds
// and states whose access it also ends.
//
// **The reassurance leads.** Losing the passphrase costs the ability to keep *syncing*; it costs no
// ledger data at all, and the accounts on screen do not change. A dialog that opens with the destruction
// reads as "my data is gone", which is both wrong and the likelier reason someone abandons the app at
// this moment — so the "your transactions are kept" line sits above every warning here, not below them.

import { useCallback, useEffect, useRef, useState } from 'react'
import { AppDialog, Button, Input, InsetPanel, SectionEyebrow, Spinner } from './ui.jsx'
import { NO_AUTOFILL_PROPS, SENSITIVE_FIELD_PROPS } from '../lib/sensitiveFields.js'
import { passphraseLimits, passphraseShortfall } from '../lib/vaultPassphrase.js'
import { useAppSession } from '../lib/AppSessionContext.jsx'
import { advanceOnEnter, onEnter } from '../lib/formKeys.js'
import { api } from '../lib/api.js'
import { formatDate } from '../lib/utils.js'

const CONFIRM_FALLBACK = 'RESET VAULT'

// What each revocation outcome asks of the user. Only two of the four ask anything, which is why the
// result screen groups by this rather than listing every connection at the same weight.
const OUTCOME_NOTE = {
  manual: 'Revoke this one yourself at the provider — it stays live until you do.',
  failed: 'The provider refused the revocation. Revoke this one yourself.',
  unreadable: 'Its stored credential could not be read, so nothing could be sent. Revoke it yourself.',
}

// The shown-once panel. Shared by this dialog and Vault settings because both mint a code and both owe
// the user the same three things: the code itself, the fact that it will not be shown again, and a way
// to get it somewhere safe without retyping it.
export function RecoveryCodeReveal({ code, onDismiss }) {
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState('')

  async function copy() {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // The clipboard is refused outright in some contexts, and a silent no-op here would look like the
      // copy worked — the one failure that matters for a secret shown exactly once.
      setCopyError('Could not reach the clipboard — select the code above and copy it manually.')
    }
  }

  return (
    <div style={{
      padding: 14, borderRadius: 10, border: '1px solid var(--warning)',
      background: 'color-mix(in srgb, var(--warning) 10%, var(--surface))', display: 'grid', gap: 10,
    }}>
      <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.5 }}>
        Save this recovery code somewhere safe — a password manager, or printed and kept away from this
        machine. It is shown once and cannot be recovered afterwards. Using it replaces it with a new one.
      </div>
      <div style={{
        fontFamily: 'monospace', fontSize: 15, letterSpacing: '0.04em', padding: '10px 12px',
        background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8,
        wordBreak: 'break-all',
      }}>
        {code}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <Button small onClick={copy}>{copied ? 'Copied' : 'Copy code'}</Button>
        {onDismiss ? <Button small variant="ghost" onClick={onDismiss}>I have saved it</Button> : null}
      </div>
      {copyError ? <div style={{ fontSize: 12, color: 'var(--danger)' }}>{copyError}</div> : null}
    </div>
  )
}

function Rung({ title, children }) {
  return (
    <InsetPanel style={{ display: 'grid', gap: 8, padding: 12 }}>
      <SectionEyebrow>{title}</SectionEyebrow>
      {children}
    </InsetPanel>
  )
}

export function VaultRecoveryDialog({ onClose, onRecovered, onReset }) {
  const session = useAppSession()
  const [preview, setPreview] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')

  // Recovery form
  const [code, setCode] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [confirmPassphrase, setConfirmPassphrase] = useState('')
  const [issuedCode, setIssuedCode] = useState('')
  const recoveryPassphraseRef = useRef(null)
  const recoveryConfirmRef = useRef(null)

  // Re-enrolment form (rung 1). Its own passphrase state rather than sharing the recovery one: the two
  // rungs sit on screen together, and a value typed into one appearing in the other would read as the
  // dialog having decided which rung is being taken.
  const [reenrolPassphrase, setReenrolPassphrase] = useState('')
  const [reenrolConfirm, setReenrolConfirm] = useState('')
  const [reenrolled, setReenrolled] = useState(false)
  const reenrolConfirmRef = useRef(null)

  // Reset form — collapsed until asked for, so the irreversible option is never the first thing read.
  const [showReset, setShowReset] = useState(false)
  const [reason, setReason] = useState('lost')
  const [confirmPhrase, setConfirmPhrase] = useState('')
  const [outcome, setOutcome] = useState(null)

  const limits = passphraseLimits(session?.currentUser)
  const shortfall = passphraseShortfall(passphrase, limits)
  // Named once because two things now gate on it — the button and the Enter handler — and a second copy
  // is how Enter comes to accept something the button refuses.
  const recoverBlocked = busy === 'recover' || !code.trim() || !passphrase || !!shortfall

  const reenrolShortfall = passphraseShortfall(reenrolPassphrase, limits)
  const reenrolBlocked = busy === 'reenrol' || !reenrolPassphrase || !!reenrolShortfall

  const load = useCallback(async () => {
    try {
      setPreview(await api.vaultResetPreview())
    } catch (e) {
      setError(e?.message || 'Could not read the vault status.')
    }
  }, [])

  // No "fetch once" ref beside the cancel flag: under StrictMode the pair deadlocks — the teardown
  // cancels the first run and the ref turns the remount into a no-op, leaving this on its spinner
  // forever. A duplicate GET in development is the trade.
  useEffect(() => { load() }, [load])

  async function recover() {
    if (passphrase !== confirmPassphrase) { setError('The passphrases do not match.'); return }
    setBusy('recover'); setError('')
    try {
      const result = await api.recoverVault(code.trim(), passphrase)
      setIssuedCode(result.recovery_code)
      await onRecovered?.(result.user)
    } catch (e) {
      setError(e?.message || 'That did not work.')
    } finally {
      setBusy('')
    }
  }

  async function reenrol() {
    if (reenrolPassphrase !== reenrolConfirm) { setError('The passphrases do not match.'); return }
    setBusy('reenrol'); setError('')
    try {
      await api.requestVaultReenrolment(reenrolPassphrase)
      setReenrolled(true)
    } catch (e) {
      setError(e?.message || 'That request could not be made.')
    } finally {
      setBusy('')
    }
  }

  async function reset() {
    setBusy('reset'); setError('')
    try {
      const result = await api.resetVault(reason, confirmPhrase)
      setOutcome(result)
      await onReset?.(result)
    } catch (e) {
      setError(e?.message || 'The vault could not be reset.')
    } finally {
      setBusy('')
    }
  }

  const phrase = preview?.confirm_phrase || CONFIRM_FALLBACK
  const others = preview?.other_members_can_unlock || []
  const otherNames = others.map(m => m.display_name).filter(Boolean)
  const passkeys = preview?.own_passkeys || []
  const backups = preview?.credentials_backups || []

  // Plain-English joining, because these read as a sentence: "frances and robin can open this vault".
  const nameList = names => (
    names.length <= 1 ? (names[0] || '')
      : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
  )

  // --- After a successful recovery: nothing was lost, so say only that -----------------------------
  if (issuedCode) {
    return (
      <AppDialog
        title="Your vault is open again"
        description="The new passphrase protects the same key, so every data source keeps working — nothing was re-encrypted and nothing needs reconnecting."
        onClose={onClose}
        width="min(520px, 100%)"
        actions={<Button small onClick={onClose}>Done</Button>}
      >
        <div style={{ display: 'grid', gap: 14 }}>
          <p style={{ fontSize: 13, margin: 0, lineHeight: 1.5 }}>
            The recovery code just used has been retired. Here is its replacement:
          </p>
          <RecoveryCodeReveal code={issuedCode} />
        </div>
      </AppDialog>
    )
  }

  // --- After a reset: what is left for the user to do ---------------------------------------------
  if (outcome) {
    const todo = outcome.unfinished || []
    return (
      <AppDialog
        title="The vault was rebuilt"
        description="Set a new vault passphrase, then reconnect each data source."
        onClose={onClose}
        width="min(560px, 100%)"
        actions={<Button small onClick={onClose}>Done</Button>}
      >
        <div style={{ display: 'grid', gap: 14 }}>
          <p style={{ fontSize: 13, margin: 0, lineHeight: 1.5 }}>
            Your transactions, accounts and their settings are unchanged.{' '}
            {outcome.connections_needing_relink === 1
              ? 'One data source needs reconnecting.'
              : `${outcome.connections_needing_relink} data sources need reconnecting.`}
          </p>
          {outcome.also_locked_out?.length ? (
            <p style={{ fontSize: 13, margin: 0, lineHeight: 1.5 }}>
              {nameList(outcome.also_locked_out)} can no longer open the vault either. Once a new
              passphrase is set here, {outcome.also_locked_out.length === 1 ? 'they' : 'they'} can set
              their own and be approved from Vault settings.
            </p>
          ) : null}
          {backups.length > 0 ? (
            <p style={{ fontSize: 13, margin: 0, lineHeight: 1.5 }}>
              A credentials backup is on file. Set a new passphrase and restore it with the passphrase it
              was made under, and the connections will work again without reconnecting anything.
            </p>
          ) : null}
          {todo.length > 0 ? (
            <Rung title="Still to do at the provider">
              <p style={{ fontSize: 12, color: 'var(--muted)', margin: 0, lineHeight: 1.5 }}>
                These credentials were not revoked automatically. Until they are removed at the provider,
                the access they granted stays live.
              </p>
              {todo.map(t => (
                <div key={t.connection_id} style={{ fontSize: 13 }}>
                  <strong>{t.label}</strong>
                  <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                    {t.detail || OUTCOME_NOTE[t.outcome]}
                  </div>
                </div>
              ))}
            </Rung>
          ) : null}
        </div>
      </AppDialog>
    )
  }

  // --- The ladder ---------------------------------------------------------------------------------
  return (
    <AppDialog
      title="Can’t open your vault?"
      description="The vault protects your data-source credentials. Your transactions and accounts are not encrypted and are never affected by anything on this screen."
      onClose={onClose}
      width="min(560px, 100%)"
      actions={<Button variant="ghost" small onClick={onClose}>Close</Button>}
    >
      {preview === null && !error ? <Spinner /> : (
        <div style={{ display: 'grid', gap: 14 }}>

          {/* 0 — free and immediate, and the one a user in this dialog has most likely forgotten: they
              came here thinking about a passphrase, and a passkey opens the vault from a different
              button entirely. */}
          {passkeys.length > 0 ? (
            <Rung title="You have a passkey for this vault">
              <p style={{ fontSize: 13, margin: 0, lineHeight: 1.5 }}>
                {passkeys.length === 1 && passkeys[0].label
                  ? `“${passkeys[0].label}” also opens this vault.`
                  : 'A registered passkey also opens this vault.'}{' '}
                Close this and use <strong>Unlock with a passkey</strong> — the passphrase is only one of
                your ways in, and nothing here is needed if a passkey still works.
              </p>
            </Rung>
          ) : null}

          {/* 1 — free, and not a reset at all. Named: a count cannot be acted on. */}
          {others.length > 0 ? (
            <Rung title={otherNames.length === 1
              ? `${otherNames[0]} can open this vault`
              : 'Other members can open this vault'}>
              <p style={{ fontSize: 13, margin: 0, lineHeight: 1.5 }}>
                {otherNames.length
                  ? `${nameList(otherNames)} ${otherNames.length === 1 ? 'holds' : 'hold'} a working unlock method, so nothing has to be destroyed.`
                  : 'Another member holds a working unlock method, so nothing has to be destroyed.'}{' '}
                Choose a new passphrase here and ask
                {otherNames.length === 1 ? ` ${otherNames[0]}` : ' one of them'} to approve it in Vault
                settings. No credential changes and no data source is reconnected.
              </p>
              {/* The fields sit in the rung, exactly as the recovery code's do below it. They used to be
                  a sentence pointing at the Connections tab — which had no such control while the vault
                  was locked, and where the underlying call refused this user anyway because their slot
                  still holds the key they cannot reach. A rung that names a button that is not there is
                  worse than no rung. */}
              {reenrolled ? (
                <p style={{ fontSize: 13, margin: 0, lineHeight: 1.5, color: 'var(--accent2)' }}>
                  Asked. The new passphrase starts working as soon as
                  {otherNames.length === 1 ? ` ${otherNames[0]} approves` : ' one of them approves'} it —
                  they do not need to know it, and they do not need yours.
                </p>
              ) : (
                <>
                  <Input
                    value={reenrolPassphrase} onChange={setReenrolPassphrase} type="password"
                    placeholder="New passphrase"
                    onKeyDown={advanceOnEnter(reenrolConfirmRef)} {...SENSITIVE_FIELD_PROPS}
                  />
                  {reenrolShortfall ? (
                    <div style={{ fontSize: 12, color: '#dc2626' }}>{reenrolShortfall}</div>
                  ) : null}
                  <Input
                    ref={reenrolConfirmRef}
                    value={reenrolConfirm} onChange={setReenrolConfirm} type="password"
                    placeholder="Confirm new passphrase"
                    onKeyDown={onEnter(() => { if (!reenrolBlocked) reenrol() })}
                    {...SENSITIVE_FIELD_PROPS}
                  />
                  <div>
                    <Button small disabled={reenrolBlocked} onClick={reenrol}>
                      {busy === 'reenrol' ? 'Asking…' : 'Ask to be let back in'}
                    </Button>
                  </div>
                </>
              )}
            </Rung>
          ) : null}

          {/* 2 — free, and the one a single-user install can act on alone. */}
          {preview?.has_recovery_code ? (
            <Rung title="Use your recovery code">
              <p style={{ fontSize: 13, margin: 0, lineHeight: 1.5 }}>
                This opens the vault and sets a new passphrase in one step. The key behind your
                credentials does not change, so every data source keeps working.
              </p>
              {/* Enter walks the three fields and opens the vault from the last — recovery is one
                  operation, so it is one keyboard run rather than three fields and a reach for the
                  mouse. Guarded on the same condition as the button below it. */}
              <Input
                value={code} onChange={setCode} placeholder="Recovery code"
                style={{ fontFamily: 'monospace' }}
                onKeyDown={advanceOnEnter(recoveryPassphraseRef)} {...SENSITIVE_FIELD_PROPS}
              />
              <Input
                ref={recoveryPassphraseRef}
                value={passphrase} onChange={setPassphrase} type="password"
                placeholder="New vault passphrase"
                onKeyDown={advanceOnEnter(recoveryConfirmRef)} {...SENSITIVE_FIELD_PROPS}
              />
              <Input
                ref={recoveryConfirmRef}
                value={confirmPassphrase} onChange={setConfirmPassphrase} type="password"
                placeholder="Confirm new passphrase"
                onKeyDown={onEnter(() => { if (!recoverBlocked) recover() })}
                {...SENSITIVE_FIELD_PROPS}
              />
              {shortfall ? (
                <div style={{ fontSize: 12, color: 'var(--muted)' }}>{shortfall}</div>
              ) : null}
              <div>
                <Button small disabled={recoverBlocked} onClick={recover}>
                  {busy === 'recover' ? 'Opening…' : 'Open the vault'}
                </Button>
              </div>
            </Rung>
          ) : null}

          {/* 3 — free, but only reachable after a reset, so it is context for rung 4 rather than an
              action of its own. */}
          {backups.length > 0 ? (
            <Rung title="A credentials backup is on file">
              <p style={{ fontSize: 13, margin: 0, lineHeight: 1.5 }}>
                The most recent was taken {formatDate(String(backups[0].exported_at).slice(0, 10))}. A
                backup is restored with the passphrase it was made under, not your current one — so if you
                remember an older passphrase, rebuilding below and then restoring that file recovers
                everything without reconnecting anything.
              </p>
            </Rung>
          ) : null}

          {/* 4 — the only destructive rung, kept collapsed. */}
          {!showReset ? (
            <div>
              <Button variant="ghost" small onClick={() => setShowReset(true)}>
                None of these — rebuild the vault…
              </Button>
            </div>
          ) : (
            <Rung title="Last resort">
              <p style={{ fontSize: 13, margin: 0, lineHeight: 1.5 }}>
                <strong>Your transactions, accounts, categories and rules are kept.</strong> What is
                destroyed is the stored credential for each data source, so{' '}
                {preview?.connections === 1
                  ? 'one data source will need reconnecting'
                  : `${preview?.connections ?? 0} data sources will need reconnecting`}
                . Their accounts, mappings and history stay where they are. This cannot be undone.
              </p>
              {/* The consequence that replaces the old refusal. There is one key per workspace, so this
                  ends everyone's access, not just this user's — and that is the part they cannot see
                  from their own screen, which is exactly why it is stated rather than assumed. */}
              {otherNames.length > 0 ? (
                <p style={{ fontSize: 13, margin: 0, lineHeight: 1.5, color: 'var(--warning)' }}>
                  This also ends {nameList(otherNames)}’s access — the vault has one key, shared by
                  everyone who can open it. {otherNames.length === 1 ? 'They' : 'They'} will need to set a
                  new vault passphrase afterwards, and the data sources will need reconnecting once.
                  If {otherNames.length === 1 ? `${otherNames[0]} is` : 'any of them are'} reachable,
                  the option above costs nothing.
                </p>
              ) : null}

              {/* Asked rather than inferred: only the user knows, and the answer changes what the reset
                  can promise. A compromised passphrase still opens the vault, so each credential can be
                  revoked at its provider on the way out; a lost one cannot decrypt anything, so every
                  provider has to be dealt with by hand. */}
              <div style={{ display: 'grid', gap: 6 }}>
                <label style={{ fontSize: 13, display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                  <input type="radio" name="vault-reset-reason" checked={reason === 'lost'}
                    onChange={() => setReason('lost')} style={{ marginTop: 3 }} />
                  <span>
                    I forgot the passphrase.
                    <span style={{ display: 'block', fontSize: 12, color: 'var(--muted)' }}>
                      Nothing can be revoked automatically — the credentials cannot be decrypted. You will
                      be told which providers to visit.
                    </span>
                  </span>
                </label>
                <label style={{ fontSize: 13, display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                  <input type="radio" name="vault-reset-reason" checked={reason === 'compromised'}
                    onChange={() => setReason('compromised')} style={{ marginTop: 3 }} />
                  <span>
                    The passphrase or database may have been exposed.
                    <span style={{ display: 'block', fontSize: 12, color: 'var(--muted)' }}>
                      Unlock the vault first; each credential is then revoked at its provider where that is
                      supported, before being destroyed.
                    </span>
                  </span>
                </label>
              </div>

              <div style={{ display: 'grid', gap: 6 }}>
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                  Type <strong>{phrase}</strong> to confirm.
                </span>
                {/* Not a secret, so not the secret set — but it must not offer past values either:
                    without suppression it takes the shared Input's reused `useId`, and the browser
                    keys form history on that, so another field's suggestions surface here. */}
                {/* No Enter handler, deliberately. This is the one irreversible action in the app, and
                    the typed phrase exists to make it a considered act — a field that destroys every
                    stored credential on a keystroke gives back exactly what the confirmation was added
                    to take away. The button is the only way through. */}
                <Input value={confirmPhrase} onChange={setConfirmPhrase} placeholder={phrase}
                  {...NO_AUTOFILL_PROPS} />
              </div>

              <div style={{ display: 'flex', gap: 8 }}>
                {/* Danger, and on the confirm button rather than the disclosure above it: this is the
                    click that actually destroys something, and it is genuinely irreversible — which is
                    what the colour is reserved for. */}
                <Button
                  small variant="danger"
                  disabled={busy === 'reset' || confirmPhrase.trim().toUpperCase() !== phrase}
                  onClick={reset}
                >
                  {busy === 'reset' ? 'Rebuilding…' : 'Rebuild the vault'}
                </Button>
                <Button variant="ghost" small disabled={busy === 'reset'} onClick={() => setShowReset(false)}>
                  Cancel
                </Button>
              </div>
            </Rung>
          )}

          {error ? <div style={{ fontSize: 13, color: 'var(--danger)' }}>{error}</div> : null}
        </div>
      )}
    </AppDialog>
  )
}
