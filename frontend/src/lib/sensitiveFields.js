// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// Input props for fields the browser must not treat as ordinary form history.
//
// Its own module rather than a named export from the dialog that first needed it: several surfaces spread
// these onto their own inputs (the vault passphrase/confirm fields, the Connections tab's provider-secret
// fields, the backup tab's restore passphrase), so a component module is the wrong home for it twice over
// — it is not vault-specific, and a `.jsx` file exporting a non-component object breaks Vite's Fast
// Refresh for everything else in that file.
//
// **Password managers and form history are different mechanisms, and only the second is suppressed.** A
// manager fills from a store the user chose to save into and usually has to unlock, and offering a strong
// generated value for a secret being *chosen* is help. Form history is the browser replaying whatever was
// once typed into a field it considers the same one — that is the dropdown every set here turns off, and
// no set opts out of managers.
//
// **Four sets, because "turn autocomplete off" is four different asks.** Two of the distinctions were
// real bugs. A non-secret annotated as a password (the vault-reset confirmation) invites a manager to
// offer to generate a value for a field whose only correct content is a fixed phrase. And an *existing*
// secret annotated as a new one — all secrets once shared a single `new-password` set — had a Chromium
// browser's built-in manager fill a freshly generated password into the field asking for the passphrase a
// backup was made with. Pick by what the field holds:
//
//   NO_AUTOFILL_PROPS     — not a secret, but must not offer past values (a typed confirmation, a label, a
//                           single-use setup token, a recovery code — text fields, never type=password).
//   NEW_SECRET_PROPS      — a secret being chosen (set or change a passphrase, a password for a new user).
//   EXISTING_SECRET_PROPS — a secret that already exists (unlock, the current passphrase, the passphrase a
//                           backup or key file was made with, a secret a provider issued).
//   ONE_TIME_CODE_PROPS   — a short code typed once and never valid again (an authenticator code).

// The shared floor: keep the browser's text handling off a value it must not "help" with.
const NO_AUTOFILL_BASE = {
  autoCorrect: 'off',
  autoCapitalize: 'off',
  spellCheck: false,
}

// `suppressAutofillId` is the part that actually stops the dropdown, and it is a prop of the shared
// `Input`, not a DOM attribute: that component auto-assigns a `useId`, those values are reused across
// views, and the browser keys its saved form-field history on the id — so a text search box that rendered
// as the same `:rN:` leaks its suggestions onto this field no matter what `autoComplete` says. No id, no
// key, no suggestions. (The console warns about a field with neither id nor name; that warning is the
// intended trade and must not be "fixed" by giving it an id.) On a secret field it matters most once
// `PasswordInput` reveals the value, since the field is then an ordinary text field.
//
// Carried by every set except `ONE_TIME_CODE_PROPS` — those fields are raw `<input>` elements, where an
// unrecognized prop reaches the DOM and React warns about it.
const SHARED_INPUT_ONLY = { suppressAutofillId: true }

// `autoComplete: 'off'` is honored for ordinary text fields — it is only on *password* fields that
// browsers ignore it, which is why the secret sets name the kind of secret instead.
export const NO_AUTOFILL_PROPS = {
  ...NO_AUTOFILL_BASE,
  ...SHARED_INPUT_ONLY,
  autoComplete: 'off',
}

// The value is meant to live in a password manager — the app says so, and the vault floor is ≥20 chars —
// so copy/paste stays fully enabled (`Input` adds no onPaste blocker) and a manager may offer to generate
// and then save it.
export const NEW_SECRET_PROPS = {
  ...NO_AUTOFILL_BASE,
  ...SHARED_INPUT_ONLY,
  autoComplete: 'new-password',
}

// A manager may fill a saved value; it must never offer to generate one, since nothing generated today
// can be the secret that already exists.
export const EXISTING_SECRET_PROPS = {
  ...NO_AUTOFILL_BASE,
  ...SHARED_INPUT_ONLY,
  autoComplete: 'current-password',
}

// Managers file a saved secret by site and username. A surface with no username field of its own — the
// vault dialogs — renders `PasswordManagerUsername` with this, so a saved vault passphrase is its own
// entry rather than one a manager could take for the sign-in password of the same site.
export const VAULT_PASSWORD_MANAGER_USERNAME = 'Vault passphrase'

// The same, for a backup key file's passphrase: saved when the key is generated, filled when a backup is
// restored with it. One name for every key rather than one per key, because the restore side knows only
// the file chosen, not the name the key was given.
export const BACKUP_KEY_PASSWORD_MANAGER_USERNAME = 'Backup key passphrase'

// Authenticator codes. Deliberately **not** a secret set: `one-time-code` is the standard annotation for
// exactly this field, and it does both halves of the job at once — the browser does not file the value in
// form history (a six-digit code that will never be valid again is pure noise in a dropdown, and mild
// leakage), while a manager holding the TOTP seed can still offer the *current* code.
//
// These fields keep their `id`/`name`: the annotation is what stops the history, and stripping the
// handles would only make it harder for a manager to recognize the field it is meant to fill.
export const ONE_TIME_CODE_PROPS = {
  ...NO_AUTOFILL_BASE,
  autoComplete: 'one-time-code',
  inputMode: 'numeric',
}
