// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// The credential-vault passphrase dialog — the surface `useVaultGate` asks the host to render for its
// `mode` ('set' to mint the workspace vault, 'unlock' to open it for this session). Extracted from the
// Connections tab when the Backup tab became its second host: restoring a credentials backup re-keys
// secrets under the workspace DEK, so it needs the same gate and the same prompt.
//
// A third mode, 'change', rewraps the DEK under a new passphrase. It is not a gate mode — nothing awaits
// it — but it asks for the same fields against the same floor, and a separate dialog would be the same
// component with one extra input and its own opportunity to disagree about the rules.
//
// The strength meter travels with it (no other caller). `SENSITIVE_FIELD_PROPS` is exported rather than
// private: the Connections tab's provider-secret fields want the same autofill suppression, and one copy
// of that opt-out list is the point.

import { useEffect, useState } from 'react'
import { Button, Input, AppDialog, DialogActions } from './ui.jsx'
import { useAppSession } from '../lib/AppSessionContext.jsx'
import { passphraseLimits, passphraseShortfall } from '../lib/vaultPassphrase.js'
import { api } from '../lib/api.js'
import { formatDate } from '../lib/utils.js'

// Advisory only — a rough entropy estimate, shown alongside the hard floor rather than in place of it.
// The floor decides whether the passphrase is *allowed* (see `vaultPassphrase.js`); this says how good
// it is beyond that, which is the part worth nudging. Bits ≈ length × log2(effective alphabet), heavily
// penalized when very few distinct characters are used (a repeated char clears length but not entropy).
const STRENGTH_LABELS = ['Very weak', 'Weak', 'Fair', 'Good', 'Strong']
const STRENGTH_COLORS = ['#dc2626', '#dc2626', '#eab308', '#16a34a', '#16a34a']

function estimatePassphraseStrength(p) {
  if (!p) return { score: 0, label: '', bits: 0 }
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/]
  const sizes = [26, 26, 10, 32]
  const alphabet = classes.reduce((sum, re, i) => sum + (re.test(p) ? sizes[i] : 0), 0) || 1
  let bits = p.length * Math.log2(alphabet)
  const distinct = new Set(p).size
  if (distinct <= 4) bits = Math.min(bits, 24)  // near-repetition has almost no real entropy
  let score = 0
  if (bits >= 45) score = 1
  if (bits >= 65) score = 2
  if (bits >= 85) score = 3
  if (bits >= 110) score = 4
  return { score, label: STRENGTH_LABELS[score], bits }
}

function PassphraseStrengthMeter({ passphrase }) {
  // Always rendered — even with no passphrase yet — so this row reserves its space up front and the
  // confirm field below doesn't jump the moment the user starts typing. The empty state shows neutral grey
  // bars and a muted "Passphrase strength" caption rather than an alarming "Very weak".
  const has = !!passphrase
  const { score, label } = has ? estimatePassphraseStrength(passphrase) : { score: 0, label: '' }
  const color = STRENGTH_COLORS[score]
  return (
    <div style={{ display: 'grid', gap: 5 }}>
      <div style={{ display: 'flex', gap: 4 }}>
        {[0, 1, 2, 3].map(i => (
          <div key={i} style={{ height: 4, flex: 1, borderRadius: 2, background: has && i < score ? color : 'var(--border)' }} />
        ))}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--muted)', minHeight: 16 }}>
        <span style={{ color: has ? color : 'var(--muted)' }}>{has ? label : 'Passphrase strength'}</span>
        {has && score < 2 ? <span>Consider a longer, more varied passphrase.</span> : null}
      </div>
    </div>
  )
}

// Secret fields (vault passphrase/confirm, provider secret): the value is meant to live in a password
// manager — we tell the user so, and the Production vault floor is ≥20 chars — so suppress the browser's
// own autofill/suggestion dropdown and any autocorrect/capitalize/spellcheck that would mangle a pasted
// secret. `autoComplete="new-password"` is the reliable cross-browser suppressor even on the unlock field
// (`"off"` is widely ignored for password inputs). Copy/paste stays fully enabled — Input adds no onPaste
// blocker — since typing a 20+ char manager-generated secret isn't realistic.
export const SENSITIVE_FIELD_PROPS = {
  autoComplete: 'new-password',
  autoCorrect: 'off',
  autoCapitalize: 'off',
  spellCheck: false,
  // Password-manager extensions (1Password/LastPass/Bitwarden/Dashlane) inject a "choose a saved login"
  // overlay on any type=password field and ignore autoComplete — these per-vendor opt-out attributes tell
  // them to leave this one alone. The vault passphrase is a one-off secret to paste, not a site login to
  // fill or capture. (`autoComplete="new-password"` already suppresses the *browser's own* saved-password
  // dropdown; the dialog is not a <form> and never submits one, so the native save-password prompt — which
  // fires on form submission — doesn't trigger either.)
  'data-1p-ignore': 'true',
  'data-lpignore': 'true',
  'data-bwignore': 'true',
  'data-form-type': 'other',
  // Render with NO id/name so the browser has no handle to key its form-field history on. The shared
  // Input auto-assigns a `useId` id, but those ids are reused across views, so a text search box that
  // rendered as the same `:rN:` leaks its saved suggestions onto this password field even with
  // autoComplete="new-password" set. Being an "unnamed field" (the console warns about it — intended
  // here) is what actually stops the suggestion dropdown. See Input's `suppressAutofillId`.
  suppressAutofillId: true,
}

// Credentials backups the vault's current wrapping would strand. Fetched when the change dialog opens,
// because it is only ever true of *this* moment: a change rewraps the DEK, and every file exported before
// it stays restorable with the old passphrase alone. A failure to fetch leaves the list empty, which is
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

export function VaultPassphraseDialog({ mode, onSubmit, onClose }) {
  // mode: 'set' (mint/replace the workspace vault) | 'unlock' (open it for this session)
  //     | 'change' (rewrap the DEK under a new passphrase)
  //     | 'request' (join a vault that already exists — same passphrase against the same floor, but it
  //       opens nothing until a member approves, and saying so up front is the whole difference)
  const [passphrase, setPassphrase] = useState('')
  const [confirm, setConfirm] = useState('')
  const [current, setCurrent] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const changing = mode === 'change'
  const requesting = mode === 'request'
  // Every one of these three chooses a NEW passphrase and is held to the floor.
  const setting = mode === 'set' || changing || requesting
  const session = useAppSession()
  const limits = passphraseLimits(session?.currentUser)
  const shortfall = setting ? passphraseShortfall(passphrase, limits) : null
  const stranded = useStrandedBackups(changing)
  // Disabled rather than refused on submit: the floor is a rule the user can satisfy before spending a
  // round trip, and letting the click through only to answer it with an error is what made the old
  // advisory meter feel like the passphrase had been accepted.
  const blocked = busy || (setting && (!passphrase || !!shortfall))

  async function submit() {
    if (setting && passphrase !== confirm) { setError('The passphrases do not match.'); return }
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
          : setting ? 'Set a vault passphrase' : 'Unlock the vault'}
      description={changing
        ? 'The new passphrase re-protects the same encrypted credentials. Nothing is re-encrypted and no data source needs re-linking.'
        : requesting
          ? 'This workspace already has a credential vault. Choose the passphrase that will open it for you — it starts working once a member who can already open the vault approves the request.'
          : setting
            ? 'The vault encrypts your data-source credentials at rest. You will enter this passphrase once per session to connect or sync.'
            : 'Enter your vault passphrase to connect and sync data sources this session.'}
      onClose={onClose}
      // Above the standard dialog layer: this is the one dialog that opens *on top of* another one —
      // a connect or a disconnect confirmation raises it and waits behind it — and at the shared
      // z-index the dialog underneath would paint over the passphrase field.
      zIndex={1400}
      width="min(460px, 100%)"
      actions={
        <DialogActions>
          <Button variant="ghost" small onClick={onClose}>Cancel</Button>
          <Button small onClick={submit} disabled={blocked}>
            {busy ? 'Working…'
              : changing ? 'Change passphrase'
                : requesting ? 'Request access'
                  : setting ? 'Set passphrase' : 'Unlock'}
          </Button>
        </DialogActions>
      }
    >
      <div style={{ display: 'grid', gap: 12 }}>
        {changing ? (
          <Input type="password" value={current} onChange={setCurrent}
            placeholder="Current passphrase" autoFocus {...SENSITIVE_FIELD_PROPS} />
        ) : null}
        <Input type="password" value={passphrase} onChange={setPassphrase}
          placeholder={changing ? 'New passphrase' : 'Vault passphrase'} autoFocus={!changing}
          {...SENSITIVE_FIELD_PROPS} />
        {setting ? <PassphraseStrengthMeter passphrase={passphrase} /> : null}
        {shortfall ? (
          <div style={{ fontSize: 12, color: '#dc2626', marginTop: -6 }}>{shortfall}</div>
        ) : null}
        {setting ? (
          <Input type="password" value={confirm} onChange={setConfirm}
            placeholder={changing ? 'Confirm new passphrase' : 'Confirm passphrase'} {...SENSITIVE_FIELD_PROPS} />
        ) : null}
        {/* The consequence a passphrase change has that nothing else on screen would reveal: the same DEK
            is rewrapped, so stored ciphertext is untouched, but any credentials backup already written
            carries the OLD wrap and stays restorable only with the old passphrase — permanently. Named
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
                <b>Keep your current passphrase.</b> {stranded.length === 1 ? 'A credentials backup' : 'Credentials backups'} taken
                {' '}{stranded.map(b => formatDate(String(b.exported_at).slice(0, 10))).join(', ')}
                {' '}can only be restored with it, even after this change.
              </>
            ) : (
              <>
                <b>Keep your current passphrase.</b> Any credentials backup taken before now can only be
                restored with it, even after this change.
              </>
            )}
          </div>
        ) : null}
        {setting && !changing ? (
          <p style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5, margin: 0 }}>
            {requesting
              ? 'Nobody else ever learns this passphrase — approval does not require it.'
              : 'There is no recovery if this is lost — you would simply re-link your data sources.'}
            {' '}Store it in a password manager; it must be at least {limits.minLength} characters using
            at least {limits.minDistinct} different ones.
          </p>
        ) : null}
        {error ? <div style={{ fontSize: 13, color: '#dc2626' }}>{error}</div> : null}
      </div>
    </AppDialog>
  )
}
