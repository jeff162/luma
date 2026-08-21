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
import { SENSITIVE_FIELD_PROPS } from '../lib/sensitiveFields.js'
import { PASSKEY_UNAVAILABLE, passkeyAvailability, registerPasskey } from '../lib/vaultPasskey.js'
import { api } from '../lib/api.js'
import { formatDate } from '../lib/utils.js'

function Section({ title, description, children }) {
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <SectionEyebrow>{title}</SectionEyebrow>
      {description ? (
        <p style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5, margin: 0 }}>{description}</p>
      ) : null}
      {children}
    </div>
  )
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
  const [busy, setBusy] = useState('')          // which action is running, so only that control disables
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const [newPasskeyLabel, setNewPasskeyLabel] = useState('')
  const [confirmingRotate, setConfirmingRotate] = useState(false)
  const [confirmingRevoke, setConfirmingRevoke] = useState(null)

  // Registered passkeys come from this dialog's own fetch, not from a session prop. They were read off
  // `currentUser.vault_passkeys`, which the page that owns it never re-read — so a passkey added here
  // could never appear, however well the registration went. Data a surface mutates is data it should own.
  const passkeys = passkeyParams?.credentials || []

  const load = useCallback(async () => {
    const [reqs, mems, params] = await Promise.all([
      api.vaultAccessRequests().catch(() => ({ requests: [] })),
      api.vaultMembers().catch(() => ({ members: [] })),
      // A connection that cannot host a ceremony is a normal answer, not a failure — the payload says
      // which of the two reasons applies and the Add control explains itself from it.
      api.vaultPasskeyParams().catch(() => null),
    ])
    setRequests(reqs.requests || [])
    setMembers(mems.members || [])
    setPasskeyParams(params)
  }, [])

  useEffect(() => { load() }, [load])

  async function run(key, action, successMessage) {
    setBusy(key)
    setError('')
    setStatus('')
    try {
      await action()
      await load()
      await onChanged?.()
      if (successMessage) setStatus(successMessage)
    } catch (e) {
      setError(e?.message || 'That did not work.')
    } finally {
      setBusy('')
    }
  }

  const availability = passkeyAvailability(passkeyParams)

  async function addPasskey() {
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
      await api.registerVaultPasskey(result)
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
      description="How this vault is opened, who else can open it, and the key protecting your data-source credentials."
      onClose={onClose}
      width="min(560px, 100%)"
      actions={<DialogActions><Button small onClick={onClose}>Done</Button></DialogActions>}
    >
      <div style={{ display: 'grid', gap: 20 }}>
        <Section
          title="Unlock methods"
          description="Any one of these opens the vault. The last one cannot be removed — there is no recovery if you lose them all."
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
                onClick={() => run(`remove-${pk.slot_id}`, () => api.removeVaultPasskey(pk.slot_id), 'Passkey removed.')}
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
                {...SENSITIVE_FIELD_PROPS}
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

        <Section
          title="Vault access"
          description="These people can open the vault. Anyone who sets a vault passphrase joins the list below it until someone who can already open the vault approves them. Approving shares the key that decrypts data-source credentials — it does not change what they can see in the ledger, which is shared already."
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
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                asked {formatDate(String(r.requested_at).slice(0, 10))}
              </span>
              <Button
                small style={{ marginLeft: 'auto' }}
                disabled={busy === `approve-${r.slot_id}`}
                onClick={() => run(`approve-${r.slot_id}`, () => api.approveVaultAccess(r.slot_id),
                  `${r.display_name} can now open the vault.`)}
              >
                Approve
              </Button>
            </Row>
          ))}
        </Section>

        <Section
          title="Replace the vault key"
          description="Generates a new key and re-encrypts every stored credential under it, so a copy of the old key stops working. Do this after removing someone's access above. If a passphrase or passkey was exposed, change it under Unlock methods as well — the two retire different things, and replacing the key alone leaves an exposed passphrase still able to open the vault. Everyone who still has access keeps it, and no data source needs reconnecting."
        >
          <div>
            <Button variant="ghost" small disabled={busy === 'rotate'} onClick={() => setConfirmingRotate(true)}>
              Replace vault key…
            </Button>
          </div>
        </Section>

        {error ? <div style={{ fontSize: 13, color: '#dc2626' }}>{error}</div> : null}
        {status ? <div style={{ fontSize: 13, color: 'var(--muted)' }}>{status}</div> : null}
      </div>

      {confirmingRevoke ? (
        <AppConfirmDialog
          title={`Remove ${confirmingRevoke.display_name}’s vault access?`}
          // Says the part that is *not* obvious: revoking stops them opening the vault from now on, but
          // the key they could already read has not changed. Someone acting on a real compromise has to
          // know the second step exists, or they will stop here believing it is finished.
          description={`${confirmingRevoke.display_name} will no longer be able to connect or sync data sources, and their unlock methods stop working. Their account, and everything in the ledger, is unaffected. If you are removing them because the key may have been exposed, follow this with Replace the vault key — revoking alone does not change the key they could already read.`}
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
          // Not styled danger: nothing is lost and every current member keeps working. What it *is* is
          // slow to undo — the old key is gone — so it takes a confirmation rather than a single click.
          description="Every stored data-source credential is re-encrypted under a new key. Anyone whose access you removed can no longer decrypt them, even with a copy of the database. Everyone who still has access is unaffected and no data source needs reconnecting."
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
    </AppDialog>
  )
}
