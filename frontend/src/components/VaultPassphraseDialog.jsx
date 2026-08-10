// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// The credential-vault passphrase dialog — the surface `useVaultGate` asks the host to render for its
// `mode` ('set' to mint the workspace vault, 'unlock' to open it for this session). Extracted from the
// Connections tab when the Backup tab became its second host: restoring a credentials backup re-keys
// secrets under the workspace DEK, so it needs the same gate and the same prompt.
//
// The strength meter travels with it (no other caller). `SENSITIVE_FIELD_PROPS` is exported rather than
// private: the Connections tab's provider-secret fields want the same autofill suppression, and one copy
// of that opt-out list is the point.

import { useState } from 'react'
import { Button, Input, AppDialog, DialogActions } from './ui.jsx'

// Advisory only — a rough entropy estimate to nudge toward a stronger passphrase; it never blocks
// (the hard Production floor lives in the backend). Bits ≈ length × log2(effective alphabet), heavily
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

export function VaultPassphraseDialog({ mode, onSubmit, onClose }) {
  // mode: 'set' (mint/replace the workspace vault) | 'unlock' (open it for this session)
  const [passphrase, setPassphrase] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const setting = mode === 'set'

  async function submit() {
    if (setting && passphrase !== confirm) { setError('The passphrases do not match.'); return }
    if (!passphrase) { setError('Enter a passphrase.'); return }
    setBusy(true)
    setError('')
    try {
      await onSubmit(passphrase)
    } catch (e) {
      setError(e.message || 'Could not update the vault')
      setBusy(false)
    }
  }

  return (
    <AppDialog
      title={setting ? 'Set a vault passphrase' : 'Unlock the vault'}
      description={setting
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
          <Button small onClick={submit} disabled={busy}>{busy ? 'Working…' : (setting ? 'Set passphrase' : 'Unlock')}</Button>
        </DialogActions>
      }
    >
      <div style={{ display: 'grid', gap: 12 }}>
        <Input type="password" value={passphrase} onChange={setPassphrase}
          placeholder="Vault passphrase" autoFocus {...SENSITIVE_FIELD_PROPS} />
        {setting ? <PassphraseStrengthMeter passphrase={passphrase} /> : null}
        {setting ? (
          <Input type="password" value={confirm} onChange={setConfirm}
            placeholder="Confirm passphrase" {...SENSITIVE_FIELD_PROPS} />
        ) : null}
        {setting ? (
          <p style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5, margin: 0 }}>
            There is no recovery if this is lost — you would simply re-link your data sources. Store it in a password manager; for Production it must be at least 20 characters.
          </p>
        ) : null}
        {error ? <div style={{ fontSize: 13, color: '#dc2626' }}>{error}</div> : null}
      </div>
    </AppDialog>
  )
}
