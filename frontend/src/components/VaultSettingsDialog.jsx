// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// Managing the credential vault itself, as opposed to opening it.
//
// The Connections strip keeps only what someone reaches for constantly — unlock, lock — because those
// are the whole interaction on a single-user install. Everything here is occasional and consequential:
// adding an unlock method, letting another household member in, replacing the workspace key. Putting
// them on the strip would have made a row of five buttons where four are almost never the one wanted.
//
// Opens only while the vault is unlocked, and that is not a styling decision: approving someone and
// rotating the key both need the key in hand, and removing an unlock method should not be possible from
// a session that could not prove it holds one.

import { useCallback, useEffect, useState } from 'react'
import { AppConfirmDialog, AppDialog, Button, DialogActions, Input, SectionEyebrow, Spinner } from './ui.jsx'
import { NO_AUTOFILL_PROPS } from '../lib/sensitiveFields.js'
import { PASSKEY_UNAVAILABLE, passkeyAvailability, registerPasskey } from '../lib/vaultPasskey.js'
import { RecoveryCodeReveal } from './VaultRecoveryDialog.jsx'
import { VaultPassphraseDialog } from './VaultPassphraseDialog.jsx'
import { api } from '../lib/api.js'
import { useAppSession } from '../lib/AppSessionContext.jsx'
import { formatDate } from '../lib/utils.js'
import { connectionProviderLabel } from '../lib/connectionSummary.js'

function Section({ title, description, children, style }) {
  return (
    <div style={{ display: 'grid', gap: 8, ...style }}>
      <SectionEyebrow>{title}</SectionEyebrow>
      {description ? (
        <p style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5, margin: 0 }}>{description}</p>
      ) : null}
      {children}
    </div>
  )
}

// What each connection's outcome asks of the user. Only `manual` and `failed` leave something to do, and
// both end the same way: the copied credential is only dead once the provider has been told.
const REISSUE_NOTE = {
  reissued: 'Replaced. The copied credential no longer works.',
  manual: 'This provider cannot replace it from here. Revoke it at the provider, then reconnect.',
  failed: 'The provider refused. Revoke it at the provider, then reconnect.',
  unreadable: 'Nothing stored could be read, so nothing was sent. If the provider still lists this connection, revoke it there.',
}

function Row({ children, style }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
      border: '1px solid var(--border)', borderRadius: 8, padding: '8px 10px', fontSize: 13,
      ...style,
    }}>
      {children}
    </div>
  )
}

export function VaultSettingsDialog({ currentUserId, isAdmin, onChangePassphrase, onChanged, onClose }) {
  const [requests, setRequests] = useState(null)
  const [members, setMembers] = useState(null)
  const [passkeyParams, setPasskeyParams] = useState(null)
  // Owned here rather than read off a session prop, for the reason the passkey list is: this dialog is
  // what mints a recovery code, and a surface that mutates something has to be the surface that re-reads
  // it — otherwise a code created here can never show up as created.
  const [recoveryCode, setRecoveryCode] = useState(null)
  const [busy, setBusy] = useState('')          // which action is running, so only that control disables
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const [newPasskeyLabel, setNewPasskeyLabel] = useState('')
  const [issuedRecoveryCode, setIssuedRecoveryCode] = useState('')
  const [confirmingRotate, setConfirmingRotate] = useState(false)
  const [confirmingReissue, setConfirmingReissue] = useState(false)
  // What the exposure response did and what it left, kept on screen so the steps it lists can be worked
  // through from here — the passphrase change and key replacement it leads into are in this dialog.
  const [reissueResult, setReissueResult] = useState(null)
  const [confirmingRevoke, setConfirmingRevoke] = useState(null)
  // Confirmed, unlike removing a passkey. A passkey is usually one of several ways in; the recovery code
  // is frequently the *only* rung between a forgotten passphrase and rebuilding every connection, and
  // that asymmetry is worth one dialog.
  const [confirmingDiscard, setConfirmingDiscard] = useState(false)
  // The action waiting on a secret, and which question to ask for it: `{ action, mode }`. The two are not
  // the same ask. 'confirm' means the vault is open and only the *recency* of the proof has lapsed;
  // 'unlock' means it is genuinely shut. Wording them alike would tell a user with a locked vault that it
  // is already open, or send someone whose vault is open to unlock it again.
  const [proofPending, setProofPending] = useState(null)
  const session = useAppSession()

  // Registered passkeys come from this dialog's own fetch, not from a session prop. They were read off
  // `currentUser.vault_passkeys`, which the page that owns it never re-read — so a passkey added here
  // could never appear, however well the registration went. Data a surface mutates is data it should own.
  const passkeys = passkeyParams?.credentials || []

  const load = useCallback(async () => {
    const [reqs, mems, params, me] = await Promise.all([
      api.vaultAccessRequests().catch(() => ({ requests: [] })),
      api.vaultMembers().catch(() => ({ members: [] })),
      // A connection that cannot host a ceremony is a normal answer, not a failure — the payload says
      // which of the two reasons applies and the Add control explains itself from it.
      api.vaultPasskeyParams().catch(() => null),
      api.getCurrentUser().catch(() => null),
    ])
    setRequests(reqs.requests || [])
    setMembers(mems.members || [])
    setPasskeyParams(params)
    setRecoveryCode(me?.user
      ? { has: !!me.user.vault_has_recovery_code, issuedAt: me.user.vault_recovery_code_issued_at }
      : null)
  }, [])

  useEffect(() => { load() }, [load])

  // `rethrow` is for the proof gate alone: it has to see the server's refusal to know an ask is needed,
  // and a swallowed error would leave the user looking at "that did not work" with no way to answer it.
  // Every other caller keeps the swallowing behaviour, which is what makes an error land in one place.
  async function run(key, action, successMessage, { rethrow = false } = {}) {
    setBusy(key)
    setError('')
    setStatus('')
    try {
      await action()
      await load()
      await onChanged?.()
      if (successMessage) setStatus(successMessage)
    } catch (e) {
      if (rethrow) throw e
      setError(e?.message || 'That did not work.')
    } finally {
      setBusy('')
    }
  }

  const availability = passkeyAvailability(passkeyParams)

  // The tail of a successful proof, shared by both ways of giving one. The session is refreshed first so
  // the countdown this component reads is the one the proof just created — otherwise the held action
  // would consult a stale zero and ask all over again.
  async function finishProof(user) {
    if (user) session?.setCurrentUser?.(user)
    await onChanged?.()
    const pending = proofPending
    setProofPending(null)
    if (pending?.action) await pending.action()
  }

  // Adding a passkey and minting a recovery code each create a credential that keeps working after lock,
  // relock, and the owner changing their passphrase — so each needs a secret presented recently, not
  // merely a DEK sitting in the unlock cache. The window is the server's (five minutes); this reads the
  // remaining seconds it reports so the ask comes *before* the ceremony rather than after a refusal
  // halfway through one.
  //
  // The local reading is allowed to be wrong — a sleeping tab, a second session — which is why the
  // refusal is still handled below. Being wrong costs one extra prompt and can never admit anything.
  // Which secret this action still needs, if any: null when it can just run, otherwise the *question* to
  // ask. The two are different asks and must not be worded alike — 'unlock' for a vault that is shut,
  // 'confirm' for one that is open with only the proof's recency lapsed. Every gated action here needs
  // the key in hand as well as recent proof, and unlocking satisfies both at once, so a locked vault is
  // always answered by unlocking.
  function neededSecret() {
    if (!session?.currentUser?.vault_unlocked) return 'unlock'
    if (!(Number(session?.currentUser?.vault_proof_seconds_remaining || 0) > 0)) return 'confirm'
    return null
  }

  // `run`, with the proof gate around it. Two chances to notice the window has lapsed, because the
  // cheap one is not reliable: the session's countdown is asked first so the prompt arrives before a
  // WebAuthn ceremony rather than in the middle of one, and the server's refusal is caught behind it for
  // the cases a client copy cannot know about — a sleeping tab, a second session, a restarted backend.
  //
  // Both land in the same place: hold the action, ask, and run it once the secret is presented. Stored
  // through a setter callback because `useState` calls a bare function argument instead of storing it.
  // Every action that changes how this vault is opened goes through here. Two chances to notice a secret
  // is needed, because the cheap one is not reliable: the session is asked first so the prompt arrives
  // before a WebAuthn ceremony rather than in the middle of one, and the server's own refusals are caught
  // behind it for what a client copy cannot know — a sleeping tab, a second session, a restarted backend.
  //
  // Both refusals land here and both are questions rather than failures. `423` means the vault is shut;
  // `403 proof_required` means it is open but the proof has aged out. Either way: hold the action, ask,
  // and run it once the secret is given, so the click the user already made is honoured instead of
  // becoming an error string whose remedy they have to work out and repeat by hand.
  async function runWithProof(key, action, successMessage) {
    const attempt = () => run(key, action, successMessage, { rethrow: true })
    const needed = neededSecret()
    if (needed) { setProofPending({ action: attempt, mode: needed }); return }
    try {
      await attempt()
    } catch (e) {
      if (e?.detail?.code === 'proof_required') { setProofPending({ action: attempt, mode: 'confirm' }); return }
      if (e?.status === 423) { setProofPending({ action: attempt, mode: 'unlock' }); return }
      setError(e?.message || 'That did not work.')
    }
  }

  async function addPasskey() {
    const needed = neededSecret()
    if (needed) { setProofPending({ action: addPasskeyProved, mode: needed }); return }
    await addPasskeyProved()
  }

  // Registration runs its own sequence rather than `run`'s, because a refused ceremony is an ordinary
  // answer with its own wording. The server's proof refusal still has to be caught, for the window
  // lapsing between the check above and the ceremony finishing.
  async function addPasskeyProved() {
    setBusy('add-passkey')
    setError('')
    setStatus('')
    try {
      // Params are re-fetched rather than reused: the salt they carry is minted per registration, so a
      // dialog left open across two attempts must not enrol the second key against the first's salt.
      const params = await api.vaultPasskeyParams()
      const result = await registerPasskey(params, { label: newPasskeyLabel })
      if (!result.ok) {
        // Every non-success outcome is reported, cancellation included. Staying quiet on a dismissed
        // prompt looked defensible — declining is the user's own answer — but it is only their answer
        // when they know what they declined, and a ceremony can end without them meaning to end it. The
        // silent version left the dialog looking untouched, which reads as "press it again", not as
        // "nothing was added".
        setError(PASSKEY_UNAVAILABLE[result.reason] || 'That authenticator could not be registered.')
        return
      }
      try {
        await api.registerVaultPasskey(result)
      } catch (e) {
        if (e?.detail?.code === 'proof_required') { setProofPending({ action: addPasskeyProved, mode: 'confirm' }); return }
        throw e
      }
      // Cleared only here, on the far side of the save: the label is the user's typing, and wiping it on
      // a failed attempt would take their input away along with the thing it was for.
      setNewPasskeyLabel('')
      await load()
      await onChanged?.()
      setStatus('Passkey added.')
    } catch (e) {
      setError(e?.message || 'That authenticator could not be registered.')
    } finally {
      setBusy('')
    }
  }

  return (
    <AppDialog
      title="Vault settings"
      description="How this vault is opened, who else can open it, and the key protecting your data provider credentials."
      onClose={onClose}
      width="min(560px, 100%)"
      actions={<DialogActions><Button small onClick={onClose}>Done</Button></DialogActions>}
    >
      <div style={{ display: 'grid', gap: 20 }}>
        <Section
          title="Unlock methods"
          description="Any one of these opens the vault. The last one cannot be removed — if you lose them all, only a recovery code stands between you and rebuilding the vault."
        >
          {/* Changing a passphrase is ordinary maintenance most of the time, so it lives here rather
            than under a compromise heading. The one thing that is not obvious is what it does *not*
            cover: it re-wraps this slot and leaves the key that decrypts the credentials untouched.
            Somebody acting on an exposure needs both halves, and this is where they will start. */}
          <p style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5, margin: 0 }}>
            If an unlock method may have been exposed, changing it here is only half the fix — it retires
            the passphrase or passkey, not the key your credentials are encrypted with. Follow it with
            Replace the vault key below.
          </p>
          <Row>
            <span>Passphrase</span>
            <Button variant="ghost" small style={{ marginLeft: 'auto' }} onClick={onChangePassphrase}>
              Change
            </Button>
          </Row>

          {passkeys.map(pk => (
            <Row key={pk.slot_id}>
              <span>{pk.label || 'Passkey'}</span>
              {pk.pending ? (
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>awaiting approval</span>
              ) : null}
              <Button
                variant="ghost" small style={{ marginLeft: 'auto' }}
                disabled={busy === `remove-${pk.slot_id}`}
                onClick={() => runWithProof(`remove-${pk.slot_id}`,
                  () => api.removeVaultPasskey(pk.slot_id), 'Passkey removed.')}
              >
                Remove
              </Button>
            </Row>
          ))}

          {availability.available ? (
            <Row style={{ borderStyle: 'dashed' }}>
              <Input
                value={newPasskeyLabel} onChange={setNewPasskeyLabel}
                placeholder="Name this device (optional)"
                style={{ flex: 1, minWidth: 160 }}
                {...NO_AUTOFILL_PROPS}
              />
              <Button small disabled={busy === 'add-passkey'} onClick={addPasskey}>
                {busy === 'add-passkey' ? 'Waiting…' : 'Add a passkey'}
              </Button>
            </Row>
          ) : (
            <p style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5, margin: 0 }}>
              {PASSKEY_UNAVAILABLE[availability.reason] || PASSKEY_UNAVAILABLE.unsupported}
            </p>
          )}
        </Section>

        {/* Between the unlock methods and the people, because that is what it is: a way in that belongs
            to nobody but this user. It is the only rung a single-user install has between forgetting the
            passphrase and rebuilding every connection — on a shared workspace another member covers the
            same ground, which is why the description says which case it is really for. */}
        <Section
          title="Recovery code"
          description="A one-time code that opens the vault and sets a new passphrase, without changing the key your credentials are encrypted with — so nothing is re-encrypted and no connection is reconnected. Worth having if you are the only person who can open this vault: without one, a forgotten passphrase means rebuilding the vault and reconnecting every connection."
        >
          <Row>
            <span>
              {recoveryCode?.has
                ? `Issued ${formatDate(String(recoveryCode.issuedAt || '').slice(0, 10))}`
                : 'No recovery code'}
            </span>
            <Button
              variant="ghost" small style={{ marginLeft: 'auto' }}
              disabled={busy === 'recovery-code'}
              onClick={() => runWithProof('recovery-code', async () => {
                const result = await api.issueVaultRecoveryCode()
                setIssuedRecoveryCode(result.recovery_code)
              })}
            >
              {recoveryCode?.has ? 'Replace code' : 'Create a recovery code'}
            </Button>
            {/* Text, not a trash icon: each passkey row above already offers exactly this affordance, and
                the same action in two visual languages reads as two different actions. Only offered when
                there is one to remove — "Replace code" is the create control when there is not. */}
            {recoveryCode?.has ? (
              <Button
                variant="ghost" small disabled={busy === 'discard-recovery-code'}
                onClick={() => setConfirmingDiscard(true)}
              >
                Remove
              </Button>
            ) : null}
          </Row>
          {/* Generating a new one retires the old, which is the property someone regenerating after a
              scare is relying on — so it is stated where the button is, not only in the reveal. */}
          {recoveryCode?.has && !issuedRecoveryCode ? (
            <p style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5, margin: 0 }}>
              The code itself is not stored and cannot be shown again. Replacing it stops the old one working.
            </p>
          ) : null}
          {issuedRecoveryCode ? (
            <RecoveryCodeReveal code={issuedRecoveryCode} onDismiss={() => setIssuedRecoveryCode('')} />
          ) : null}
        </Section>

        {/* Lifted to the top of the dialog whenever somebody is waiting, using grid `order` rather than a
            second copy of the markup. The badge on the button that opens this dialog says "(1 waiting)",
            so a request is the reason it was opened — and finding it below three other sections, off the
            bottom of the screen, makes the user hunt for the thing they were just told about. It falls
            back to its usual place when the queue is empty, where it reads as reference rather than as
            something outstanding. */}
        <Section
          style={requests?.length ? { order: -1 } : undefined}
          title="Vault access"
          description="These people can open the vault. Anyone who sets a vault passphrase joins the list below it until someone who can already open the vault approves them. Approving shares the key that decrypts data provider credentials — it does not change what they can see in the ledger, which is shared already."
        >
          {members === null ? <Spinner /> : members.map(m => (
            <Row key={m.user_id}>
              <span>{m.display_name}</span>
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                {m.user_id === currentUserId ? 'you' : `${m.method_count} unlock method${m.method_count === 1 ? '' : 's'}`}
              </span>
              {/* Absent for yourself: removing your own last way in is the one action with no recovery
                  behind it, and it belongs with the unlock methods above where the guard lives — not
                  here, where it would read as an ordinary tidy-up of a list. */}
              {isAdmin && m.user_id !== currentUserId ? (
                <Button
                  variant="ghost" small style={{ marginLeft: 'auto' }}
                  disabled={busy === `revoke-${m.user_id}`}
                  onClick={() => setConfirmingRevoke(m)}
                >
                  Remove access
                </Button>
              ) : null}
            </Row>
          ))}

          {requests === null ? null : requests.length === 0 ? (
            <p style={{ fontSize: 13, color: 'var(--muted)', margin: 0 }}>Nobody is waiting for access.</p>
          ) : requests.map(r => (
            <Row key={r.slot_id}>
              <span>{r.display_name}</span>
              {/* A newcomer enrolling and a member who lost their passphrase arrive in this queue looking
                  identical, and they are not the same decision: the second hands back access that
                  already existed, to whoever wrote the request — which is what someone at that person's
                  keyboard would be counting on. The approver is the only one who can tell, so the row
                  has to say which it is. */}
              <span style={{ fontSize: 12, color: r.replaces_access ? 'var(--warning)' : 'var(--muted)' }}>
                {r.replaces_access ? 'lost their passphrase · ' : ''}
                asked {formatDate(String(r.requested_at).slice(0, 10))}
              </span>
              <Button
                small style={{ marginLeft: 'auto' }}
                disabled={busy === `approve-${r.slot_id}`}
                title={r.replaces_access
                  ? `${r.display_name} already had access and could not open it. Approving restores it `
                    + 'under a passphrase they chose — check with them that they asked.'
                  : undefined}
                onClick={() => runWithProof(`approve-${r.slot_id}`, () => api.approveVaultAccess(r.slot_id),
                  `${r.display_name} can now open the vault.`)}
              >
                Approve
              </Button>
            </Row>
          ))}
        </Section>

        <Section
          title="Replace the vault key"
          description="Generates a new key and re-encrypts every stored credential under it, so a copy of the old key stops working. Do this after removing someone's access above. If a passphrase or passkey was exposed, change it under Unlock methods as well — the two retire different things, and replacing the key alone leaves an exposed passphrase still able to open the vault. This also locks the vault in every other running session."
        >
          <div>
            <Button variant="ghost" small disabled={busy === 'rotate'} onClick={() => setConfirmingRotate(true)}>
              Replace vault key…
            </Button>
          </div>
        </Section>

        {/* The non-destructive answer to "a copy of the database may be out there", for a vault that can
            still be opened. Only the provider can retire a credential already in someone else's copy, and
            where it can hand out a replacement the connection keeps syncing — the vault reset would
            instead destroy every credential and cost a re-link the bank or plan may not grant. */}
        <Section
          title="Respond to an exposure"
          description="If the database or a backup may have been copied, replace each connection's credential at its provider so the copied ones stop working. Connections keep syncing where the provider supports this; the rest are listed with what to do at the provider."
        >
          <div>
            <Button variant="ghost" small disabled={busy === 'reissue'} onClick={() => setConfirmingReissue(true)}>
              Replace connection credentials…
            </Button>
          </div>
          {reissueResult ? (
            <>
              {reissueResult.outcomes.map(o => (
                <Row key={o.connection_id} style={{ display: 'grid', gap: 2 }}>
                  <strong>{o.label}</strong>
                  <span style={{ fontSize: 12, color: 'var(--muted)' }}>{o.detail || REISSUE_NOTE[o.outcome]}</span>
                </Row>
              ))}
              {/* Never retired by the step above: the app secret is not per-connection, and a rotated-away
                  secret can keep working until it is deleted at the provider. */}
              {reissueResult.app_secrets_to_rotate.map(a => (
                <Row key={`app-secret-${a.provider}`} style={{ display: 'grid', gap: 2 }}>
                  <strong>{connectionProviderLabel(a.provider)} app secret</strong>
                  <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                    Rotate it at the provider, enter the new one with Configure, then delete the old one
                    there — it keeps working until deleted.
                  </span>
                </Row>
              ))}
              {reissueResult.has_credentials_backups
                && reissueResult.outcomes.some(o => o.outcome === 'reissued') ? (
                  <p style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5, margin: 0 }}>
                    Credentials backups made before now restore the replaced credentials, which no longer
                    work. Make a new one.
                  </p>
                ) : null}
              <p style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5, margin: 0 }}>
                Then change the passphrase and replace the vault key, in that order — they protect what is
                encrypted from now on, including the credentials just issued.
              </p>
              <div style={{ display: 'flex', gap: 8 }}>
                <Button variant="ghost" small onClick={onChangePassphrase}>Change passphrase</Button>
                <Button variant="ghost" small disabled={busy === 'rotate'} onClick={() => setConfirmingRotate(true)}>
                  Replace vault key…
                </Button>
              </div>
            </>
          ) : null}
        </Section>

        {error ? <div style={{ fontSize: 13, color: '#dc2626' }}>{error}</div> : null}
        {status ? <div style={{ fontSize: 13, color: 'var(--muted)' }}>{status}</div> : null}
      </div>

      {confirmingReissue ? (
        <AppConfirmDialog
          title="Replace connection credentials?"
          // Confirmed because it reaches past this install: every other copy of the database — a restored
          // backup elsewhere, a second install — holds the credentials being retired and stops syncing.
          description="Each connection's credential is replaced at its provider where the provider supports it, and the old one stops working. Connections here keep syncing. Any other copy of this database stops syncing those connections."
          confirmLabel={busy === 'reissue' ? 'Replacing…' : 'Replace credentials'}
          confirmDisabled={busy === 'reissue'}
          cancelDisabled={busy === 'reissue'}
          onConfirm={async () => {
            await run('reissue', async () => setReissueResult(await api.reissueVaultCredentials()))
            setConfirmingReissue(false)
          }}
          onCancel={() => setConfirmingReissue(false)}
        />
      ) : null}

      {confirmingRevoke ? (
        <AppConfirmDialog
          title={`Remove ${confirmingRevoke.display_name}’s vault access?`}
          // Says the part that is *not* obvious: revoking stops them opening the vault from now on, but
          // the key they could already read has not changed. Someone acting on a real compromise has to
          // know the second step exists, or they will stop here believing it is finished.
          description={`${confirmingRevoke.display_name} will no longer be able to connect or sync data providers, and their unlock methods stop working. Their account, and everything in the ledger, is unaffected. If you are removing them because the key may have been exposed, follow this with Replace the vault key — revoking alone does not change the key they could already read.`}
          confirmLabel={busy === `revoke-${confirmingRevoke.user_id}` ? 'Removing…' : 'Remove access'}
          confirmDisabled={busy === `revoke-${confirmingRevoke.user_id}`}
          cancelDisabled={busy === `revoke-${confirmingRevoke.user_id}`}
          onConfirm={async () => {
            const target = confirmingRevoke
            await run(`revoke-${target.user_id}`, () => api.revokeVaultAccess(target.user_id),
              `${target.display_name} can no longer open the vault.`)
            setConfirmingRevoke(null)
          }}
          onCancel={() => setConfirmingRevoke(null)}
        />
      ) : null}

      {confirmingRotate ? (
        <AppConfirmDialog
          title="Replace the vault key?"
          // Not styled danger: nothing is lost and every current member keeps access, though other running
          // sessions are locked. What it *is* is slow to undo — the old key is gone — so it takes a confirmation rather than a single click.
          description="Every stored data provider credential is re-encrypted under a new key. Anyone whose access you removed can no longer decrypt them, even with a copy of the database. This also locks the vault in every other running session."
          confirmLabel={busy === 'rotate' ? 'Replacing…' : 'Replace key'}
          confirmDisabled={busy === 'rotate'}
          cancelDisabled={busy === 'rotate'}
          onConfirm={async () => {
            await run('rotate', () => api.rotateVault(), 'The vault key was replaced.')
            setConfirmingRotate(false)
          }}
          onCancel={() => setConfirmingRotate(false)}
        />
      ) : null}

      {/* One dialog for both asks, because both end in the same call: presenting the secret again *is* an
          unlock, and that is what the server records as proof. Only the wording differs, which is what
          `mode` carries — 'confirm' for a vault that is open with a lapsed proof, 'unlock' for one that is
          shut. On success the held action runs, so the user's click is honoured rather than needing a
          second press at a surface they have already answered for. */}
      {confirmingDiscard ? (
        <AppConfirmDialog
          title="Remove the recovery code?"
          description="The code on file stops working and no replacement is issued. If the vault passphrase is then forgotten, the ways back in are a passkey, another member re-enrolling you, or rebuilding the vault and reconnecting every connection. A new code can be created here at any time."
          confirmLabel={busy === 'discard-recovery-code' ? 'Removing…' : 'Remove code'}
          confirmDisabled={busy === 'discard-recovery-code'}
          cancelDisabled={busy === 'discard-recovery-code'}
          onConfirm={async () => {
            setConfirmingDiscard(false)
            await runWithProof('discard-recovery-code', () => api.discardVaultRecoveryCode(),
                               'Recovery code removed.')
          }}
          onCancel={() => setConfirmingDiscard(false)}
        />
      ) : null}

      {proofPending ? (
        <VaultPassphraseDialog
          mode={proofPending.mode}
          onSubmit={async (passphrase) => {
            const resp = await api.unlockVault(passphrase)
            await finishProof(resp?.user)
          }}
          onUnlockedByPasskey={finishProof}
          onClose={() => setProofPending(null)}
        />
      ) : null}
    </AppDialog>
  )
}
