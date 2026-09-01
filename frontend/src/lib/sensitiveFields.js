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
// **Three sets, because "turn autocomplete off" is three different asks.** Bundling them was a real bug:
// the vault-reset confirmation is not a secret, and spreading the secret set onto it would have annotated
// a plain text field as `new-password` — which is not merely untidy, it invites a password manager to
// offer to *generate* a value for a field whose only correct content is a fixed phrase. Pick by what the
// field holds:
//
//   NO_AUTOFILL_PROPS    — not a secret, but must not offer past values (a typed confirmation, a label).
//   SENSITIVE_FIELD_PROPS — a secret pasted from a manager (passphrase, provider secret, recovery code).
//   ONE_TIME_CODE_PROPS  — a short code typed once and never valid again (an authenticator code).

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
// intended trade and must not be "fixed" by giving it an id.)
//
// Carried only by the two sets below, never by `ONE_TIME_CODE_PROPS` — those fields are raw `<input>`
// elements, where an unrecognized prop reaches the DOM and React warns about it.
const SHARED_INPUT_ONLY = { suppressAutofillId: true }

// `autoComplete: 'off'` is honored for ordinary text fields — it is only on *password* fields that
// browsers ignore it, which is why the secret set below overrides it.
export const NO_AUTOFILL_PROPS = {
  ...NO_AUTOFILL_BASE,
  ...SHARED_INPUT_ONLY,
  autoComplete: 'off',
}

// Secret fields (vault passphrase/confirm, provider secret, vault recovery code): the value is meant to
// live in a password manager — we tell the user so, and the vault floor is ≥20 chars — so suppress the
// browser's own autofill/suggestion dropdown and any autocorrect/capitalize/spellcheck that would mangle
// a pasted secret. Copy/paste stays fully enabled — `Input` adds no onPaste blocker — since typing a 20+
// char manager-generated secret isn't realistic.
export const SENSITIVE_FIELD_PROPS = {
  ...NO_AUTOFILL_BASE,
  ...SHARED_INPUT_ONLY,
  // The reliable cross-browser suppressor on a password field, where plain `off` is widely ignored.
  autoComplete: 'new-password',
  // Password-manager extensions (1Password/LastPass/Bitwarden/Dashlane) inject a "choose a saved login"
  // overlay on any type=password field and ignore autoComplete — these per-vendor opt-out attributes tell
  // them to leave this one alone. A vault passphrase is a one-off secret to paste, not a site login to
  // fill or capture. (The dialog is not a <form> and never submits one, so the native save-password
  // prompt — which fires on form submission — doesn't trigger either.)
  'data-1p-ignore': 'true',
  'data-lpignore': 'true',
  'data-bwignore': 'true',
  'data-form-type': 'other',
}

// Authenticator codes. Deliberately **not** the secret set: `one-time-code` is the standard annotation for
// exactly this field, and it does both halves of the job at once — the browser does not file the value in
// form history (a six-digit code that will never be valid again is pure noise in a dropdown, and mild
// leakage), while a manager holding the TOTP seed can still offer the *current* code. Spreading the
// secret set here would suppress that help to prevent a saved value there is no longer any way to save.
//
// These fields keep their `id`/`name`: the annotation is what stops the history, and stripping the
// handles would only make it harder for a manager to recognize the field it is meant to fill.
export const ONE_TIME_CODE_PROPS = {
  ...NO_AUTOFILL_BASE,
  autoComplete: 'one-time-code',
  inputMode: 'numeric',
}
