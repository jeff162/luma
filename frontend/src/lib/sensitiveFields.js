// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// Input props for a field holding a secret the user pastes rather than types.
//
// Its own module rather than a named export from the dialog that first needed it: several surfaces spread
// these onto their own inputs (the vault passphrase/confirm fields, the Connections tab's provider-secret
// fields, the backup tab's restore passphrase), so a component module is the wrong home for it twice over
// — it is not vault-specific, and a `.jsx` file exporting a non-component object breaks Vite's Fast
// Refresh for everything else in that file.

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
