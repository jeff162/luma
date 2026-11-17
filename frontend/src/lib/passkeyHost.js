// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// A passkey answers only at the host name it was registered under (`host`), so one registered under
// another name — a second name this system answers to, or the system a copied database came from — can
// neither unlock the vault nor sign in from this page. One whose name was never recorded may answer
// anywhere. Shared by the vault's and sign-in's passkey lists, which say the same thing about the same fact.
export function passkeyAnswersHere(passkey) {
  return !passkey.host || passkey.host === window.location.hostname
}
