// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * This module is the contract boundary between page-level UI state and backend routes. Most callers hand it
 * app concepts like filters, batch actions, or the current identity and let this layer normalize headers, query
 * strings, and the handful of upload/download cases that cannot use the default JSON request helper.
 *
 * Identity is carried by the session cookie in both modes (perimeter on or off), so there is no per-request
 * identity header: selecting an identity (or signing in) establishes the session server-side.
 */

import { noteRequestFailure } from './backendLiveness'
import { discardSaveFile } from './filePicker.js'

const BASE = '/api'

// Every request in this module goes out through here, so that the one place that cares — the
// backend-liveness watch — learns when a call never reached a server at all. `fetch` rejects rather
// than resolving in exactly that case, and until now each of those rejections was handled (or not) by
// whichever call site happened to make it, so the news that the process had stopped was thrown away as
// many times as there were callers. Failures are re-thrown unchanged: this observes, it does not
// handle.
async function trackedFetch(input, init) {
  try {
    return await fetch(input, init)
  } catch (error) {
    noteRequestFailure(error)
    throw error
  }
}

// Single app-wide "something was persisted" signal. Every successful mutation pings it: all non-GET
// requests through `request()` below, plus the multipart upload helpers (import/run, restore) that
// can't use the JSON path. Derived views that show server-computed counts — the nav Tasks badge and
// the Tasks page — listen for `luma:data-mutated` and refetch.
//
// Trailing-debounced so a burst of writes (bulk categorize, an import inserting many rows, a bulk
// duplicate-resolve) coalesces into one refetch instead of N. The point is that *mutating is the
// invalidation*: no individual call site has to remember to refresh a derived view, so none can
// forget to (the failure mode that left the badge stale). It fires for mutations that can't affect
// those counts too (e.g. saving a UI preference); that refetch is cheap and idempotent, and paying
// it is the price of never maintaining a list of "which endpoints affect which view."
let dataMutatedTimer = null
function signalDataMutated() {
  if (typeof window === 'undefined') return
  if (dataMutatedTimer) clearTimeout(dataMutatedTimer)
  dataMutatedTimer = setTimeout(() => {
    dataMutatedTimer = null
    window.dispatchEvent(new CustomEvent('luma:data-mutated'))
  }, 250)
}

/*
 * Single app-wide "the session is gone" signal, on the same footing as the mutation signal above: the
 * *api layer* notices, so no call site has to.
 *
 * A 401 means the server no longer knows who is asking, which is never something the surface that
 * happened to make the request can resolve. Left to the callers it surfaced as whatever error text each
 * one renders — "Not authenticated" in red inside a report dialog, with nothing to act on — and every
 * screen in the app had its own version of that. The shell listens and re-runs its identity bootstrap,
 * which re-establishes a passwordless session or lands on the chooser / sign-in.
 *
 * **The auth endpoints are exempt.** A 401 from them is an *answer*, not a lapse — it is how the
 * bootstrap discovers that nobody is signed in — and signalling on it would ask the shell to restart
 * the very check that produced it.
 *
 * **Suppressed for a window after it fires.** A page holds several requests in flight, so one lapse
 * produces a burst of 401s; and the bootstrap the signal triggers makes its own calls, which may 401
 * again while it works. Without the window those would feed each other.
 *
 * **A surface that ended the session itself can hold the signal** (`holdSessionLost`). A restore that
 * replaces the sign-in accounts signs everyone out, the requesting tab included, and its own completion
 * panel is the way out: it says what happened and reloads. Answering the next 401 would tear that panel
 * down under the person reading it.
 */
export const SESSION_LOST_EVENT = 'luma:session-lost'

const SESSION_LOST_QUIET_MS = 5000
const AUTH_PATH_PREFIX = '/auth/'
let sessionLostAt = 0
let sessionLostHeld = false

export function holdSessionLost(held) {
  sessionLostHeld = held
}

function signalSessionLost(path) {
  if (typeof window === 'undefined') return
  if (sessionLostHeld) return
  if (path.startsWith(AUTH_PATH_PREFIX)) return
  const now = Date.now()
  if (now - sessionLostAt < SESSION_LOST_QUIET_MS) return
  sessionLostAt = now
  window.dispatchEvent(new CustomEvent(SESSION_LOST_EVENT))
}

// Build an Error from a non-OK response body. FastAPI `detail` may be a plain string or a structured
// object ({code, message, ...}); surface a readable message either way and keep the raw object on
// `error.detail` so callers can branch on `code` (e.g. the demo-data and restore-compatibility guards).
function buildResponseError(body, status) {
  const detail = body?.detail
  const message = typeof detail === 'string' ? detail : (detail?.message || detail?.code || 'Request failed')
  const error = new Error(message)
  error.status = status
  error.detail = detail
  return error
}

async function request(path, options = {}) {
  const { suppressMutationSignal = false, ...fetchOptions } = options
  const res = await trackedFetch(`${BASE}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...fetchOptions.headers,
    },
    ...fetchOptions,
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }))
    if (res.status === 401) signalSessionLost(path)
    throw buildResponseError(err, res.status)
  }
  const method = (fetchOptions.method || 'GET').toUpperCase()
  if (!suppressMutationSignal && method !== 'GET' && method !== 'HEAD') signalDataMutated()
  return res.json()
}

// Owner/tag/category-owner filters travel on the wire as a single comma-separated string, which the backend rebuilds
// by splitting on ',' (see backend/routers/transactions.py). Joining here states that contract explicitly instead of
// relying on URLSearchParams' implicit Array→String coercion, and folds an empty selection back to an omitted param.
// Returns a spreadable fragment so call sites read `...csvParam('tag_ids', ids)`.
function csvParam(key, ids) {
  const value = Array.isArray(ids) ? ids.join(',') : ids
  return value ? { [key]: value } : {}
}

// Forwards the Dashboard's extra summary filters (account_ids, category_ids, group_ids, payees) onto the
// totals/trend endpoints. Values are already joined by the caller (comma for ids, pipe for payees).
function summaryFilterParams(opts = {}) {
  const out = {}
  for (const [key, value] of Object.entries(opts)) {
    if (value != null && value !== '') out[key] = value
  }
  return out
}

function ruleSuggestionScopePath({ batchId, profileId } = {}) {
  if (batchId) return `/import-export/batches/${batchId}/rule-suggestions`
  if (profileId) return `/import-export/profiles/${profileId}/rule-suggestions`
  return '/import-export/rule-suggestions'
}

// One multipart document upload. Not through `request()`, which sends JSON; signals the mutation itself for
// the same reason the other multipart helpers do.
function uploadDocument(path, file) {
  const fd = new FormData()
  fd.append('file', file)
  return trackedFetch(path, { method: 'POST', body: fd }).then(async res => {
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }))
      throw buildResponseError(err, res.status)
    }
    signalDataMutated()
    return res.json()
  })
}

export const api = {
  getAuthStatus: () => request('/auth/status'),
  getUserPreferences: () => request('/auth/preferences'),
  saveUserPreference: (key, value) =>
    request('/auth/preferences', { method: 'POST', body: JSON.stringify({ key, value }) }),
  clearUserPreferences: () => request('/auth/preferences', { method: 'DELETE' }),
  // Perimeter-off identities: the unified `user_account` rows presented as the local chooser. Selecting
  // one establishes a passwordless session server-side (see /auth/select-identity).
  getIdentities: () => request('/auth/identities'),
  createIdentity: (name) =>
    request('/auth/identities', { method: 'POST', body: JSON.stringify({ name }) }),
  renameIdentity: (id, name) =>
    request(`/auth/identities/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) }),
  deleteIdentity: (id) =>
    request(`/auth/identities/${id}`, { method: 'DELETE' }),
  selectIdentity: (userId) =>
    request('/auth/select-identity', { method: 'POST', body: JSON.stringify({ user_id: userId }) }),
  loadDemoData: () => request('/auth/demo-data', { method: 'POST' }),
  getDemoDataStatus: () => request('/auth/demo-data'),
  clearDemoData: () => request('/auth/demo-data/clear', { method: 'POST' }),
  getEffectiveConfig: () => request('/auth/config'),
  resetConfigValue: (key) => request(`/auth/config/${encodeURIComponent(key)}/reset`, { method: 'POST' }),
  savePasswordPolicy: (policy) =>
    request('/auth/password-policy', { method: 'POST', body: JSON.stringify({ policy }) }),
  // Vault (data-source credential custody). Set/change require the current user; set mints the workspace
  // DEK for the first user. All return { user: <session payload with vault_* flags> }.
  setVaultPassphrase: (passphrase) =>
    request('/auth/vault/set-passphrase', { method: 'POST', body: JSON.stringify({ passphrase }) }),
  changeVaultPassphrase: (old_passphrase, new_passphrase) =>
    request('/auth/vault/change-passphrase', { method: 'POST', body: JSON.stringify({ old_passphrase, new_passphrase }) }),
  unlockVault: (passphrase) =>
    request('/auth/vault/unlock', { method: 'POST', body: JSON.stringify({ passphrase }) }),
  // Whether a passphrase being chosen clears the floor, and its strength score — asked while it is typed
  // (`usePassphraseStrength`), since the estimate's dictionaries live on the server.
  vaultPassphraseStrength: (passphrase) =>
    request('/auth/vault/passphrase-strength', { method: 'POST', body: JSON.stringify({ passphrase }) }),
  // Prove with a passkey and set a new passphrase in one request, the passkey sibling of `recoverVault`.
  // One call rather than prove-then-set, so no ceremony is ever spent with no passphrase written. Also
  // the only route by which a passkey-only member gets a first passphrase.
  setVaultPassphraseWithPasskey: (credential_id, prf_output, new_passphrase) =>
    request('/auth/vault/passkey/set-passphrase', {
      method: 'POST',
      body: JSON.stringify({ credential_id, prf_output, new_passphrase }),
    }),
  // "Let me back in": replaces an unopenable passphrase slot with a pending one for a member to approve.
  // Opens nothing on its own — the DEK cannot be reached from here, which is the whole situation.
  // Delete the recovery code without minting another. `issueVaultRecoveryCode` always *replaces*, so
  // invalidating one could only be done by replacing it and not recording the new one — which leaves
  // `vault_has_recovery_code` true and the recovery ladder offering a rung the user does not have.
  discardVaultRecoveryCode: () => request('/auth/vault/recovery-code', { method: 'DELETE' }),
  requestVaultReenrolment: (new_passphrase) =>
    request('/auth/vault/reenrol', { method: 'POST', body: JSON.stringify({ new_passphrase }) }),
  lockVault: () => request('/auth/vault/lock', { method: 'POST' }),
  markVaultPassphrasesUnchecked: () => request('/auth/vault/developer/mark-passphrases-unchecked', { method: 'POST' }),
  // Backups carrying the vault, taken against the wrapping currently in force — the ones a passphrase change is
  // about to strand. Only those: a backup from before an earlier change is already stranded, and saying
  // so again would bury the one that still matters.
  vaultCredentialsBackups: () => request('/auth/vault/credentials-backups'),
  // Vault access. Setting a passphrase as a user the vault does not know yet *enrols* them — the slot
  // exists but opens nothing until a member holding the key approves it, which is what these cover.
  vaultAccessRequests: () => request('/auth/vault/access-requests'),
  vaultMembers: () => request('/auth/vault/members'),
  approveVaultAccess: (slotId) =>
    request(`/auth/vault/access-requests/${slotId}/approve`, { method: 'POST' }),
  revokeVaultAccess: (userId) =>
    request(`/auth/vault/access/${userId}/revoke`, { method: 'POST' }),
  // Replace the workspace key and re-encrypt every stored credential under it. Revoke first, then
  // rotate: rotation re-seals for whoever still holds a slot.
  rotateVault: () => request('/auth/vault/rotate', { method: 'POST' }),
  // After a possible exposure: swap each connection's credential for a new one where its provider can,
  // and report what is left to do at each provider. Nothing needs re-linking.
  reissueVaultCredentials: () => request('/auth/vault/reissue-credentials', { method: 'POST' }),
  // Passkey unlock methods. `params` reports whether a ceremony can run here at all (WebAuthn needs a
  // secure context and a named host) and carries the ids/salts a ceremony needs.
  vaultPasskeyParams: () => request('/auth/vault/passkey/params'),
  registerVaultPasskey: (data) =>
    request('/auth/vault/passkey/register', { method: 'POST', body: JSON.stringify(data) }),
  unlockVaultWithPasskey: (credential_id, prf_output) =>
    request('/auth/vault/passkey/unlock', { method: 'POST', body: JSON.stringify({ credential_id, prf_output }) }),
  removeVaultPasskey: (slotId) => request(`/auth/vault/passkey/${slotId}`, { method: 'DELETE' }),
  // Passkeys for *sign-in*, which are a separate feature from the vault passkeys above and share no
  // storage, no endpoint and no ceremony with them. `params` is public: the sign-in screen has to decide
  // whether to offer the button before there is a session.
  signInPasskeyParams: () => request('/auth/passkey/params'),
  beginSignInPasskeyRegistration: () => request('/auth/passkey/register/begin', { method: 'POST' }),
  completeSignInPasskeyRegistration: (credential, label) =>
    request('/auth/passkey/register/complete', { method: 'POST', body: JSON.stringify({ credential, label }) }),
  beginPasskeySignIn: () => request('/auth/passkey/login/begin', { method: 'POST' }),
  completePasskeySignIn: (credential) =>
    request('/auth/passkey/login/complete', { method: 'POST', body: JSON.stringify({ credential }) }),
  removeSignInPasskey: (passkeyId) => request(`/auth/passkey/${passkeyId}`, { method: 'DELETE' }),
  // Recovery code — one per user, and the only rung between a forgotten passphrase and rebuilding every
  // connection on a single-user install. Issuing returns the code in the clear exactly once; nothing
  // else ever can, since only its KEK is stored.
  issueVaultRecoveryCode: () => request('/auth/vault/recovery-code', { method: 'POST' }),
  // Deliberately one call, not unlock-then-change: there must be no window where the code has been
  // consumed and no replacement passphrase exists yet. Returns a fresh code alongside the session.
  recoverVault: (code, new_passphrase) =>
    request('/auth/vault/recover', { method: 'POST', body: JSON.stringify({ code, new_passphrase }) }),
  // What the reset dialog must say before the user commits — the free alternatives first, then the cost.
  // Its credentials-backup list is unfiltered, unlike `vaultCredentialsBackups`: recovery restores a
  // backup with the passphrase *it* was made under, so an older one is the rescue rather than noise.
  vaultResetPreview: () => request('/auth/vault/reset-preview'),
  // Irreversible. `reason` is 'lost' or 'compromised' — only the latter can revoke at the provider, and
  // only the former is refused while another member can still open the vault.
  resetVault: (reason, confirm) =>
    request('/auth/vault/reset', { method: 'POST', body: JSON.stringify({ reason, confirm }) }),
  // Per-provider app-level credentials (the Configure card). Status never returns the secret.
  getProviders: () => request('/providers'),
  getProviderConfig: (provider) => request(`/providers/${provider}/config`),
  saveProviderConfig: (provider, data) =>
    request(`/providers/${provider}/config`, { method: 'POST', body: JSON.stringify(data) }),
  // The one read path for a stored app secret — a diagnostic for checking it against the provider's
  // dashboard, kept off the status payload so plaintext only ever appears when explicitly asked for.
  // 423 when the vault is locked; 409 when nothing is on file.
  getProviderSecret: (provider) => request(`/providers/${provider}/secret`),
  // Connect a data source whose authorization is not a Link widget — the payload shape is whatever that
  // provider's `connect_spec` asked the UI to collect (e.g. { setup_token }).
  // `adoptConnectionId` names the existing connection this authorization *replaces*, for a provider whose
  // handle is derived from its credential (`stable_external_id: false`) — the server re-points that row
  // instead of inserting a second one, so its coverage and cursor survive. Must be decided before the
  // call, never after: a setup token is single-use, so there is no second attempt to act on a later answer.
  connectProvider: (provider, payload, adoptConnectionId = null) =>
    request(`/providers/${provider}/connect`, {
      method: 'POST',
      body: JSON.stringify({ payload, adopt_connection_id: adoptConnectionId }),
    }),
  // Drop a linked connection. Where the provider supports it this also revokes the credential at the
  // provider; where it does not (SimpleFIN has no revocation call) only the local copy goes.
  // `removeWithoutRevoking` is the answer to a `revoke_failed` refusal: remove it here knowing the access
  // may still be live at the provider.
  disconnectProvider: (provider, external_id, { removeWithoutRevoking = false } = {}) =>
    request(`/providers/${provider}/disconnect`, {
      method: 'POST', body: JSON.stringify({ external_id, remove_without_revoking: removeWithoutRevoking }),
    }),
  // Rebuild a connection's local account rows from its still-valid credential (no re-link) — the recovery
  // when a restore rolled back the accounts but kept the connection. Caller then backfills history via sync.
  refreshConnectionAccounts: (provider, external_id) =>
    request(`/providers/${provider}/refresh-accounts`, { method: 'POST', body: JSON.stringify({ external_id }) }),
  getBootstrapStatus: () => request('/auth/bootstrap-status'),
  getCurrentUser: () => request('/auth/me'),
  // `options` (optional) turns on sign-in protection by claiming an existing identity as admin:
  // { claim_user_id, admin_password, initial_passwords: { userId: password }, password_policy }.
  enableAuth: (options = null) =>
    request('/auth/enable', { method: 'POST', body: JSON.stringify({ enabled: true, ...(options || {}) }) }),
  disableAuth: () => request('/auth/disable', { method: 'POST' }),
  login: (username, password) =>
    request('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  changePassword: (new_password) =>
    request('/auth/change-password', { method: 'POST', body: JSON.stringify({ new_password }) }),
  changeOwnPassword: (current_password, new_password) =>
    request('/auth/password', { method: 'POST', body: JSON.stringify({ current_password, new_password }) }),
  verifyTwoFactor: (code) =>
    request('/auth/2fa/verify', { method: 'POST', body: JSON.stringify({ code }) }),
  bootstrap: (username, password, display_name) =>
    request('/auth/bootstrap', { method: 'POST', body: JSON.stringify({ username, password, display_name }) }),
  logout: () => request('/auth/logout', { method: 'POST' }),
  // Stops the server process itself, not the session. Only present when the desktop launcher owns the
  // process; elsewhere the backend answers 404 and the UI never offers it.
  shutdownApp: () => request('/app/shutdown', { method: 'POST' }),
  // Checking for a new version (opt-in, install-wide). `autoCheckForUpdate` is the load-time call and is a
  // no-op server-side unless the check is switched on and due; `checkForUpdateNow` always asks.
  getUpdateCheck: () => request('/app/update-check'),
  setUpdateCheckEnabled: (enabled) =>
    request('/app/update-check/settings', { method: 'POST', body: JSON.stringify({ enabled }) }),
  checkForUpdateNow: () => request('/app/update-check/run', { method: 'POST' }),
  autoCheckForUpdate: () => request('/app/update-check/auto', { method: 'POST' }),
  // Administration -> Error log: the most recent errors in the server's log file, newest first. Admin-only.
  // The TLS proxy's root certificate, where a server installation has one: { available } and, when it
  // does, the fingerprint and whether it is the certificate on record. Public — a device needs it before
  // sign-in.
  getProxyCertificate: () => request('/app/proxy-certificate'),
  acceptProxyCertificate: () => request('/app/proxy-certificate/accept', { method: 'POST' }),
  getErrorLog: () => request('/diagnostics/log/errors'),
  // Marks the errors counted up to `through` as seen, for the whole install — which clears the Tasks reminder.
  acknowledgeErrorLog: (through) =>
    request('/diagnostics/log/errors/acknowledge', { method: 'POST', body: JSON.stringify({ through }) }),
  listUsers: () => request('/auth/users'),
  createUser: (data) => request('/auth/users', { method: 'POST', body: JSON.stringify(data) }),
  updateUser: (id, data) => request(`/auth/users/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteUser: (id) => request(`/auth/users/${id}`, { method: 'DELETE' }),
  startTwoFactorSetup: () => request('/auth/2fa/setup', { method: 'POST' }),
  confirmTwoFactorSetup: (secret, code) =>
    request('/auth/2fa/confirm', { method: 'POST', body: JSON.stringify({ secret, code }) }),
  disableTwoFactor: (code) =>
    request('/auth/2fa/disable', { method: 'POST', body: JSON.stringify({ code }) }),
  regenerateRecoveryCodes: (code) =>
    request('/auth/2fa/recovery-codes', { method: 'POST', body: JSON.stringify({ code }) }),

  getTransactions: (params = {}) => {
    const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null))
    const result = request(`/transactions?${q}`)
    // Dev guard against the silent-truncation footgun: a caller that omits `limit` gets the backend's
    // default page size, and if that page came back short of the true `total` the list is truncated —
    // almost always a missing pagination (usePagedTransactions) or an intended `limit: 0` (all). A caller
    // that passed an explicit limit made a conscious choice, so it's exempt. Dev-only; compiled out of
    // production. Observing the promise here doesn't consume it — callers still get `result`.
    if (import.meta.env?.DEV && params.limit == null) {
      result.then(resp => {
        if (resp && Array.isArray(resp.transactions) && typeof resp.total === 'number'
            && resp.transactions.length < resp.total) {
          console.warn(
            `[api.getTransactions] returned ${resp.transactions.length} of ${resp.total} matching rows on the default page — this list is truncated. Paginate (usePagedTransactions), pass an explicit limit, or limit: 0 for all.`,
            params,
          )
        }
      }).catch(() => {})
    }
    return result
  },
  getGroupTotals: (month, account_id, date_start, date_end, owner_ids, category_owner_ids, tag_ids, opts = {}) => {
    const p = {
      ...(month               ? { month }               : {}),
      ...(date_start          ? { date_start }          : {}),
      ...(date_end            ? { date_end }            : {}),
      ...(account_id          ? { account_id }          : {}),
      ...csvParam('owner_ids', owner_ids),
      ...csvParam('category_owner_ids', category_owner_ids),
      ...csvParam('tag_ids', tag_ids),
      ...summaryFilterParams(opts),
    }
    return request(`/transactions/summary/by-group?${new URLSearchParams(p)}`)
  },
  getCategoryTotalsInGroup: (month, group_id, account_id, date_start, date_end, owner_ids, tag_ids, opts = {}) => {
    const p = {
      group_id,
      ...(month      ? { month }      : {}),
      ...(date_start ? { date_start } : {}),
      ...(date_end   ? { date_end }   : {}),
      ...(account_id ? { account_id } : {}),
      ...csvParam('owner_ids', owner_ids),
      ...csvParam('tag_ids', tag_ids),
      ...summaryFilterParams(opts),
    }
    return request(`/transactions/summary/by-category-in-group?${new URLSearchParams(p)}`)
  },
  getCategoryTotals: (month, account_id, date_start, date_end, owner_ids, category_owner_ids, tag_ids, exclude_income, exclude_expense, opts = {}) => {
    const p = {
      ...(month        ? { month }        : {}),
      ...(date_start   ? { date_start }   : {}),
      ...(date_end     ? { date_end }     : {}),
      ...(account_id   ? { account_id }   : {}),
      ...csvParam('owner_ids', owner_ids),
      ...csvParam('category_owner_ids', category_owner_ids),
      ...csvParam('tag_ids', tag_ids),
      ...(exclude_income ? { exclude_income: 'true' } : {}),
      ...(exclude_expense ? { exclude_expense: 'true' } : {}),
      ...summaryFilterParams(opts),
    }
    return request(`/transactions/summary/by-category?${new URLSearchParams(p)}`)
  },
  // Tag-report pie: server-side per-tag-signature buckets. `selected_tag_ids` are the report's tags
  // (they define the slices); `filters`/opts narrow the rows exactly like the other summary calls.
  getTagSignatureTotals: (selected_tag_ids, { date_start, date_end, account_id, owner_ids, tag_ids, exclude_income, exclude_expense } = {}, opts = {}) => {
    const p = {
      selected_tag_ids: selected_tag_ids || '',
      ...(date_start ? { date_start } : {}),
      ...(date_end   ? { date_end }   : {}),
      ...(account_id ? { account_id } : {}),
      ...csvParam('owner_ids', owner_ids),
      ...csvParam('tag_ids', tag_ids),
      ...(exclude_income ? { exclude_income: 'true' } : {}),
      ...(exclude_expense ? { exclude_expense: 'true' } : {}),
      ...summaryFilterParams(opts),
    }
    return request(`/transactions/summary/by-tag-signature?${new URLSearchParams(p)}`)
  },
  getMonthlyByGroup: (months = 24, account_id, group_id, tag_ids, owner_ids, opts = {}) => {
    const q = new URLSearchParams({
      months,
      ...(account_id ? { account_id } : {}),
      ...(group_id   ? { group_id }   : {}),
      ...csvParam('tag_ids', tag_ids),
      ...csvParam('owner_ids', owner_ids),
      ...summaryFilterParams(opts),
    })
    return request(`/transactions/summary/monthly-by-group?${q}`)
  },
  getMonthlyCashFlow: (months = 24, account_id, tag_ids, owner_ids, opts = {}) => {
    const q = new URLSearchParams({
      months,
      ...(account_id ? { account_id } : {}),
      ...(opts.date_start ? { date_start: opts.date_start } : {}),
      ...(opts.date_end ? { date_end: opts.date_end } : {}),
      ...csvParam('tag_ids', tag_ids),
      ...csvParam('owner_ids', owner_ids),
      ...csvParam('source_account_ids', opts.source_account_ids),
      ...(opts.granularity ? { granularity: opts.granularity } : {}),
      ...summaryFilterParams(opts),
    })
    return request(`/transactions/summary/monthly-cash-flow?${q}`)
  },
  getPayeeTrend: (payee, date_start, date_end, tag_ids) => {
    const q = new URLSearchParams({ payee, ...(date_start ? { date_start } : {}), ...(date_end ? { date_end } : {}), ...csvParam('tag_ids', tag_ids) })
    return request(`/transactions/summary/monthly-trend?${q}`)
  },
  getMonthlyTrend: (months = 6, category_id, account_id, date_start, date_end, tag_ids, view, owner_ids, opts = {}) => {
    const q = new URLSearchParams({
      months,
      ...(category_id ? { category_id } : {}),
      ...(account_id ? { account_id } : {}),
      ...(date_start ? { date_start } : {}),
      ...(date_end ? { date_end } : {}),
      ...(opts.anchor ? { anchor: opts.anchor } : {}),
      ...csvParam('tag_ids', tag_ids),
      ...csvParam('source_account_ids', opts.source_account_ids),
      ...(view ? { view } : {}),
      ...csvParam('owner_ids', owner_ids),
      ...summaryFilterParams(opts),
    })
    return request(`/transactions/summary/monthly-trend?${q}`)
  },
  // `ranges` is [{ start, end }] of inclusive ISO days; one row comes back per range, in order.
  getRangeTrend: (ranges, account_id, tag_ids, view, owner_ids, opts = {}) => {
    const q = new URLSearchParams({
      ranges: ranges.map(r => `${r.start}:${r.end}`).join(','),
      ...(account_id ? { account_id } : {}),
      ...csvParam('tag_ids', tag_ids),
      ...(view ? { view } : {}),
      ...csvParam('owner_ids', owner_ids),
      ...summaryFilterParams(opts),
    })
    return request(`/transactions/summary/range-trend?${q}`)
  },
  overrideCategory: (txnId, category_id, notes) =>
    request(`/transactions/${txnId}/category`, {
      method: 'PATCH',
      body: JSON.stringify({ category_id, notes }),
    }),

  // Re-pin an imported transaction's category as a corrected *file* categorization (keeps it driving
  // rule suggestions), vs overrideCategory which marks it a manual exception.
  setImportedCategory: (txnId, category_id) =>
    request(`/transactions/${txnId}/imported-category`, {
      method: 'PATCH',
      body: JSON.stringify({ category_id }),
    }),

  getAccounts: (params = {}) => {
    const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null))
    const suffix = q.toString() ? `?${q}` : ''
    return request(`/accounts${suffix}`)
  },
  createAccount: (data) => request('/accounts', { method: 'POST', body: JSON.stringify(data) }),
  // `transactions` says what happens to the account's own rows — 'reassign' (with
  // `target_account_id`) or 'delete'. The backend refuses to guess once the account holds any.
  deleteAccount: (id, params = {}) => {
    const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== ''))
    const suffix = q.toString() ? `?${q}` : ''
    return request(`/accounts/${id}${suffix}`, { method: 'DELETE' })
  },
  attachAccount: (id, parent_account_id) =>
    request(`/accounts/${id}/attach`, { method: 'POST', body: JSON.stringify({ parent_account_id }) }),
  detachAccount: (id) => request(`/accounts/${id}/detach`, { method: 'POST' }),
  getDistinctAccountPairs: () => request('/accounts/distinct-pairs'),
  assertDistinctAccountPair: (accountIdA, accountIdB) =>
    request('/accounts/distinct-pairs', {
      method: 'POST',
      body: JSON.stringify({ account_id_a: accountIdA, account_id_b: accountIdB }),
    }),
  forgetDistinctAccountPair: (accountIdA, accountIdB) =>
    request(`/accounts/distinct-pairs/${accountIdA}/${accountIdB}`, { method: 'DELETE' }),

  getCategoryTree: () => request('/categories'),
  getCategories: () => request('/categories/flat'),
  getCategoryUsageSummary: () => request('/categories/usage-summary'),
  createCategory: (data) => request('/categories', { method: 'POST', body: JSON.stringify(data) }),
  getAccountTags: (id) => request(`/accounts/${id}/tags`),
  // Explains an account with little/no activity: how many of its imported rows were skipped/removed
  // as duplicates, and which accounts/source files the matched existing transactions live on.
  getAccountDuplicateSummary: (id) => request(`/accounts/${id}/duplicate-summary`),
  setAccountTags: (id, tag_ids) =>
    request(`/accounts/${id}/tags`, { method: 'PUT', body: JSON.stringify({ tag_ids }) }),
  getInactiveCategories: () => request('/categories/inactive'),
  getCategoryDeletePreview: (id) => request(`/categories/${id}/delete-preview`),
  deleteCategory: (id, data = {}) => request(`/categories/${id}`, { method: 'DELETE', body: JSON.stringify(data) }),
  reactivateCategory: (id) => request(`/categories/${id}/reactivate`, { method: 'POST' }),
  getStarterRules: () => request('/categories/starter-rules'),
  generateStarterSet: (data = {}) => request('/categories/generate-starter', { method: 'POST', body: JSON.stringify(data) }),
  hardDeleteCategory: (id) => request(`/categories/${id}/forever`, { method: 'DELETE' }),
  getEmptyCleanupPreview: () => request('/categories/empty-cleanup-preview'),
  runEmptyCleanup: () => request('/categories/empty-cleanup', { method: 'POST' }),
  setCategoryAside: (id) => request(`/categories/${id}/set-aside`, { method: 'POST' }),
  restoreCategoryToPool: (id) => request(`/categories/${id}/restore-to-pool`, { method: 'POST' }),
  // One transaction for the whole Group Imported Categories draft; returns the resulting flat category list.
  applyImportedCategoryWorkspace: (plan) => request('/categories/imported-workspace/apply', { method: 'POST', body: JSON.stringify(plan) }),
  updateCategory: (id, data) =>
    request(`/categories/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  getCategoryTags: (id) => request(`/categories/${id}/tags`),
  setCategoryTags: (id, tag_ids) =>
    request(`/categories/${id}/tags`, { method: 'PUT', body: JSON.stringify({ tag_ids }) }),

  // Passing a connection id asks for an **update-mode** token: Link re-authorizes the Item that
  // connection already holds instead of creating a new one. Without it, "reconnect" mints a second
  // connection and strands the first with its coverage, cursor and a badge that can never clear.
  getLinkToken: (connectionId = null) => request(
    connectionId ? `/plaid/link-token?connection_id=${encodeURIComponent(connectionId)}` : '/plaid/link-token',
  ),
  // Finishes an update-mode session. Deliberately not an exchange — update mode issues no new credential,
  // and Plaid's guidance is not to exchange the public token it returns. The server proves the Item is
  // live by fetching accounts before it clears the reconnect flag.
  repairPlaidConnection: (connection_id) =>
    request('/plaid/repair', { method: 'POST', body: JSON.stringify({ connection_id }) }),
  // A Link session that ended in an error, for the connection log — Link runs in the browser, so the
  // server hears nothing of a failure there unless it is told. `error` is Link's own onExit error object.
  reportPlaidLinkError: ({ connectionId = null, institutionName = null, requestId = null, error = {} } = {}) =>
    request('/plaid/link-error', {
      method: 'POST',
      suppressMutationSignal: true,
      body: JSON.stringify({
        connection_id: connectionId,
        institution_name: institutionName,
        request_id: requestId,
        error_type: error.error_type || null,
        error_code: error.error_code || null,
        error_message: error.error_message || null,
        display_message: error.display_message || null,
      }),
    }),
  exchangeToken: (public_token, institution_name) =>
    request('/plaid/exchange', {
      method: 'POST',
      body: JSON.stringify({ public_token, institution_name }),
    }),

  // Per-connection account mapping — the data-source analog of a CSV import's account step. Connecting
  // records what the bank offers; nothing lands in an account until a mapping is applied, which is also
  // what gives duplicate detection its cross-account alias.
  getConnectionAccounts: (connectionId) => request(`/connections/${connectionId}/accounts`),
  setConnectionCapturedFields: (connectionId, fields) =>
    request(`/connections/${connectionId}/captured-fields`, {
      method: 'POST',
      body: JSON.stringify({ fields }),
    }),
  setConnectionAccountMap: (connectionId, mappings) =>
    request(`/connections/${connectionId}/account-map`, {
      method: 'POST',
      body: JSON.stringify({ mappings }),
    }),
  // Removing a connection's synced transactions also resets its cursor + coverage, so a later sync
  // re-backfills them — the summary is the preflight the confirm dialog states its counts from, and
  // `force` skips the manually-edited-rows guard (409 without it), as a file's Undo does.
  getConnectionSyncedTransactions: (connectionId) =>
    request(`/connections/${connectionId}/synced-transactions`),
  removeConnectionSyncedTransactions: (connectionId, force = false) =>
    request(`/connections/${connectionId}/synced-transactions${force ? '?force=true' : ''}`, { method: 'DELETE' }),
  updateMerchant:      (id, name)   => request(`/transactions/${id}/merchant`, { method: 'PATCH', body: JSON.stringify({ merchant_name: name }) }),
  updateNotes:         (id, notes)  => request(`/transactions/${id}/notes`,    { method: 'PATCH', body: JSON.stringify({ notes }) }),
  // Correcting the amount of a hand-entered transaction — offered only on a row entered by hand that is
  // neither split nor part of a reimbursement (`lib/amountEdit.js` says why, and the backend refuses the
  // rest independently with a 400 whose detail is written for the user; show that rather than composing
  // your own). `amount` is signed in the ledger's convention like every other amount the API carries, so
  // the caller derives it from a direction the user picked. The answer carries the row back including its
  // category, which the rules may have moved — an amount is a rule condition.
  updateAmount:        (id, amount) => request(`/transactions/${id}/amount`,   { method: 'PATCH', body: JSON.stringify({ amount }) }),
  updateTransactionTag: (id, tag_id, present) =>
    request(`/transactions/${id}/tags`, { method: 'PATCH', body: JSON.stringify({ tag_id, present }) }),
  clearOverride:       (id)         => request(`/transactions/${id}/uncategorize`, { method: 'PATCH' }),
  // Splits: allocating one transaction's amount across several categories. `parts` is an ordered
  // [{ category_id, amount }]; the backend enforces the invariants (sum to the amount, share its sign,
  // one part per category) and answers a failure with a 400 whose detail is written for the user, so a
  // caller shows that message rather than composing its own. `getSplitSuggestion` proposes an
  // allocation from an imported order's captured per-item detail — `{ available: false }` when there is
  // nothing to propose.
  getSplit:            (id)         => request(`/transactions/${id}/split`),
  saveSplit:           (id, parts)  =>
    request(`/transactions/${id}/split`, { method: 'PUT', body: JSON.stringify({ parts }) }),
  deleteSplit:         (id)         => request(`/transactions/${id}/split`, { method: 'DELETE' }),
  getSplitSuggestion:  (id)         => request(`/transactions/${id}/split/suggestion`),
  // Recording a transaction by hand — cash, a cheque, an account nothing syncs. `amount` is signed in
  // the ledger's convention (positive is money out) like every other amount the API carries; the caller
  // derives it from a direction the user picked (`lib/manualTransaction.js`) rather than asking them
  // about a storage convention. Validation failures come back as a 400 whose detail names the box to
  // fix; show it rather than composing your own.
  createTransaction:   (body)       => request('/transactions', { method: 'POST', body: JSON.stringify(body) }),
  // Multi-payment purchases: several transactions that are one purchase (a deposit and a balance, an
  // instalment plan). Pure association — grouping payments never changes a category, an amount or a
  // total, so nothing here needs an undo beyond removing the link. `expected_total` is signed in the
  // ledger's convention like every other amount, so a caller takes the sign from the payments it is
  // linking. A broken invariant (a payment already in another purchase, a selection of one) comes back
  // as a 400 whose detail is written for the user; show it rather than composing your own.
  getTransactionPurchase: (txnId)   => request(`/transactions/${txnId}/purchase`),
  createPurchase:      (body)       => request('/purchases', { method: 'POST', body: JSON.stringify(body) }),
  updatePurchase:      (id, body)   => request(`/purchases/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  addPurchasePayments: (id, txnIds) =>
    request(`/purchases/${id}/payments`, { method: 'POST', body: JSON.stringify({ txn_ids: txnIds }) }),
  removePurchasePayment: (id, txnId) =>
    request(`/purchases/${id}/payments/${txnId}`, { method: 'DELETE' }),
  deletePurchase:      (id)         => request(`/purchases/${id}`, { method: 'DELETE' }),
  // Reimbursable expenses: money that left as an expense and comes back later. Unlike a purchase this
  // is *not* pure association — settling rewrites the target transaction's allocations — so the
  // complete/reopen pair is the undo, and unlinking a completed reimbursement is refused rather than
  // silently discarding the record that could reverse it. Completing a reimbursement that was repaid in
  // full moves nothing and needs no category — that is the ordinary ending, not an edge case. Which
  // transaction a residual settles against
  // is decided by its sign on the server; `target_txn_id` only picks *which* candidate, and only when
  // the role has more than one. Broken invariants come back as a 400 written for the user.
  //
  // A reimbursement covers a *share* of a transaction, so every write takes `claims` — `{txn_id,
  // amount?, label?}` — rather than bare ids. An omitted amount claims whatever of the row is still
  // unclaimed, which is the whole answer for a row that is only in one reimbursement; it is stated only
  // where a row is divided between several.
  getTransactionReimbursement: (txnId) => request(`/transactions/${txnId}/reimbursement`),
  getOutstandingReimbursements: () => request('/reimbursements/outstanding'),
  getReimbursement:    (id)         => request(`/reimbursements/${id}`),
  createReimbursement: (body)       => request('/reimbursements', { method: 'POST', body: JSON.stringify(body) }),
  updateReimbursement: (id, body)   => request(`/reimbursements/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  addReimbursementClaims: (id, claims) =>
    request(`/reimbursements/${id}/transactions`, { method: 'POST', body: JSON.stringify({ claims }) }),
  removeReimbursementTransaction: (id, txnId) =>
    request(`/reimbursements/${id}/transactions/${txnId}`, { method: 'DELETE' }),
  // Re-attach a portion another reimbursement is holding. The amount is not sent: what moves is the
  // claim as it stands, and restating it would be a second truth able to disagree with the record it is
  // taken from. The reply carries `moved_from`, since emptying the old record deletes it.
  moveReimbursementClaim: (id, txnId, fromLinkId) =>
    request(`/reimbursements/${id}/transactions/move`,
      { method: 'POST', body: JSON.stringify({ txn_id: txnId, from_link_id: fromLinkId }) }),
  completeReimbursement: (id, body) =>
    request(`/reimbursements/${id}/complete`, { method: 'POST', body: JSON.stringify(body) }),
  reopenReimbursement: (id)         => request(`/reimbursements/${id}/complete`, { method: 'DELETE' }),
  deleteReimbursement: (id)         => request(`/reimbursements/${id}`, { method: 'DELETE' }),
  // The household's default reminder gap, and the receivables that have gone past it. Ledger-level
  // rather than per-user: one ledger has one answer, and the reminders are shown to everyone whoever's
  // accounts they sit on. `/outstanding` carries `reminder_days` too, so a surface already holding the
  // report derives overdue-ness from that rather than fetching this a second time.
  getReimbursementSettings: () => request('/reimbursements/settings'),
  setReimbursementSettings: (days) =>
    request('/reimbursements/settings', { method: 'PUT', body: JSON.stringify({ reminder_days: days }) }),
  getDueReimbursements: () => request('/reimbursements/due'),
  // Trash (soft-delete) for transactions. Mirrors the account trash flow: trashed rows are
  // filtered out of every read until they're explicitly restored or the trash is emptied.
  trashTransaction:    (id)         => request(`/transactions/${id}`,           { method: 'DELETE' }),
  restoreTransaction:  (id)         => request(`/transactions/${id}/restore`,   { method: 'POST'   }),
  // Bulk edit: `selection` is { mode:'ids', ids } or { mode:'filter', filter, exclude_ids };
  // `actions` is an ordered list of { type, ...payload }. Returns { updated_count }.
  bulkUpdateTransactions: (selection, actions) =>
    request('/transactions/bulk', { method: 'POST', body: JSON.stringify({ selection, actions }) }),
  getTrashedTransactions: (scope = 'all') => request(`/transactions/trash?scope=${encodeURIComponent(scope)}`),
  // Trash counts, the import records' size and the database's, for the Settings section list.
  getStorageSummary: ()             => request('/app/storage-summary'),
  emptyTransactionTrash: (scope = 'all', olderThan = 'all') => request(`/transactions/trash/empty?scope=${encodeURIComponent(scope)}&older_than=${encodeURIComponent(olderThan)}`, { method: 'POST' }),
  // Soft-flag duplicate review. Flagging happens in the backend during import (new account,
  // soft match) and account merge; the per-batch unified report (UnifiedDuplicatesDialog)
  // calls these to let the user keep, reject, or undo a previous rejection on a flagged row.
  resolveSuspectDuplicate: (id, action) =>
    request(`/transactions/${id}/resolve-suspect`, { method: 'POST', body: JSON.stringify({ action }) }),
  restoreRejectedDuplicate: (id) =>
    request(`/transactions/${id}/restore-rejected`, { method: 'POST' }),

  getRules: (search) => {
    const q = search ? '?' + new URLSearchParams({ search }) : ''
    return request(`/rules${q}`)
  },
  getMatchingRuleForTransaction: (txnId) => request(`/rules/match/transaction/${txnId}`),
  // Existing transactions a rule's matcher currently matches: { count (true total), transactions (capped) }.
  // Drives the per-rule hover count + report on the Rules page.
  getRuleMatches: (id) => request(`/rules/${id}/matches`),
  // Stale-rule cleanup + trash.
  getRuleTrash: () => request('/rules/trash'),
  restoreRule: (id) => request(`/rules/${id}/restore`, { method: 'POST' }),
  purgeRule: (id) => request(`/rules/${id}/purge`, { method: 'DELETE' }),
  purgeAllTrashedRules: () => request('/rules/trash/purge-all', { method: 'POST' }),
  // Active, non-managed rules whose newest applied effect is older than `before` (YYYY-MM-DD) or never set.
  getRuleCleanupCandidates: (before) => request(`/rules/cleanup-candidates?before=${encodeURIComponent(before)}`),
  // Bulk-trash a reviewed set of stale rules. `reconcile` (default off) also reverts their categorizations.
  cleanupRules: (ruleIds, { reconcile = false } = {}) =>
    request('/rules/cleanup', { method: 'POST', body: JSON.stringify({ rule_ids: ruleIds, reconcile }) }),
  // Rule pairs competing for the same transactions: overlapping amount ranges (a warning — nothing
  // decides which rule claims the charge) and nested merchant matchers (information). Read-only, run
  // on demand from the Rules page: { count, counts, findings, rules: { id: ruleRow } }.
  getRuleOverlaps: ({ includeDismissed = false } = {}) =>
    request(`/rules/overlaps${includeDismissed ? '?include_dismissed=true' : ''}`),
  // Acknowledge a finding ("this pair is deliberate") so the check stops listing it, and the undo. The
  // key carries what made the finding actionable, so a later edit that changes the situation surfaces
  // again under a different key rather than staying hidden.
  dismissRuleOverlap: (key, kind) =>
    request('/rules/overlaps/dismiss', { method: 'POST', body: JSON.stringify({ key, kind }) }),
  restoreRuleOverlap: (key) =>
    request('/rules/overlaps/restore', { method: 'POST', body: JSON.stringify({ key }) }),
  // Recent charges an amount-gated rule nearly claimed: one that missed a bound (a warning — the row
  // lost the rule's category) and one sitting just inside a bound (information). Same payload shape as
  // the overlaps check, because one panel presents both.
  getRuleRangeDrift: ({ includeDismissed = false } = {}) =>
    request(`/rules/range-drift${includeDismissed ? '?include_dismissed=true' : ''}`),
  // Acknowledge one charge ("not this rule's"), and the undo. Keyed by rule and transaction, so it says
  // nothing about the next charge and never uses up the cap on how many of a rule's near-misses list.
  dismissRuleRangeDrift: (key, kind) =>
    request('/rules/range-drift/dismiss', { method: 'POST', body: JSON.stringify({ key, kind }) }),
  restoreRuleRangeDrift: (key) =>
    request('/rules/range-drift/restore', { method: 'POST', body: JSON.stringify({ key }) }),
  // How many rule pairs a categorization pass caught deciding a transaction arbitrarily that still do.
  getRuleConflictCount: () => request('/rules/conflicts'),
  previewRule: (data) => request('/rules/preview', { method: 'POST', body: JSON.stringify(data) }),
  // `onExisting`: how to reconcile a same-matcher collision. Default (omitted) classifies and reports
  // without writing (status: duplicate|mergeable|conflict); 'merge' folds a mergeable/duplicate save
  // into the existing rule. Response carries `status` ('created'|'merged'|'duplicate'|'mergeable'|'conflict').
  createRule: (data, { onExisting } = {}) =>
    request(`/rules${onExisting ? `?on_existing=${onExisting}` : ''}`, { method: 'POST', body: JSON.stringify(data) }),
  // `onExisting`: like createRule, but for an edit that makes this rule's matcher collide with another
  // rule. Default classifies without writing; 'merge' folds this rule's actions into the other and
  // deletes this one. Response `status`: 'updated'|'merged'|'duplicate'|'mergeable'|'conflict'.
  // `reconcile` (default off) re-evaluates the transactions this rule previously categorized so rows an
  // edit drops from scope revert instead of retaining their old category (the "this rule was wrong" path).
  updateRule: (id, data, { onExisting, reconcile } = {}) => {
    const params = new URLSearchParams()
    if (onExisting) params.set('on_existing', onExisting)
    if (reconcile) params.set('reconcile', 'true')
    const qs = params.toString()
    return request(`/rules/${id}${qs ? `?${qs}` : ''}`, { method: 'PATCH', body: JSON.stringify(data) })
  },
  // `preserveManual` re-categorizes the rule's matches but leaves manual per-transaction edits alone
  // (used after a merge/replace changes the governing rule); omitted = full force, overwriting all matches.
  applyRule: (id, { preserveManual } = {}) =>
    request(`/rules/${id}/apply${preserveManual ? '?preserve_manual=true' : ''}`, { method: 'POST' }),
  // The Rule checkup's *Widen to include*: moves one bound out to the charge (the server rounds it outwards
  // to the cent) and re-applies the rule in one transaction, so a failure cannot leave the bound moved and
  // the charge unclaimed.
  widenRuleRange: (id, bound, amount) =>
    request(`/rules/${id}/widen`, { method: 'POST', body: JSON.stringify({ bound, amount }) }),
  // `reconcile` (default off) re-evaluates the transactions this rule categorized so they revert instead
  // of retaining the deleted rule's category.
  deleteRule: (id, { reconcile } = {}) =>
    request(`/rules/${id}${reconcile ? '?reconcile=true' : ''}`, { method: 'DELETE' }),

  // days <= 0 means "all available history" (the connect/refresh backfill). connectionId scopes the sync
  // to one connection so a backfill doesn't re-pull every other bank; omit it to sync all connections.
  // `fullHistory` marks a request for everything available (the initial backfill, and Fetch more history)
  // as opposed to a routine top-up, which sends the same `days`. The two are not interchangeable: only a
  // full-history pull may widen a connection's coverage claim backward, and on a provider with no cursor
  // only it re-walks history rather than fetching a bounded recent window. `provider` scopes the sync to
  // one data source so syncing one card cannot spend another provider's request budget.
  runSync: (days = 30, connectionId = null, { provider = null, fullHistory = false } = {}) =>
    request(
      `/sync?days=${days}`
      + (connectionId ? `&connection_id=${encodeURIComponent(connectionId)}` : '')
      + (provider ? `&provider=${encodeURIComponent(provider)}` : '')
      + (fullHistory ? '&full_history=true' : ''),
      { method: 'POST' },
    ),
  recategorize: () => request('/sync/recategorize', { method: 'POST' }),
  getRecategorizePreview: () => request('/sync/recategorize-preview'),
  // The data-connection log (the Sync log): every sync, plus each connect, reconnect, account refresh,
  // disconnect and credential reissue/revoke. `subjects` are filter-pill keys — a connection id, or
  // `connect:<provider>` for connect attempts that never became a connection — and `providers` selects
  // every row of a provider; a row matching either is returned. Both repeat once per value, and both empty
  // means unfiltered, never "match nothing".
  getSyncDiagnostics: ({ limit = 200, subjects = [], providers = [] } = {}) => request(
    `/sync/diagnostics?limit=${limit}`
    + [].concat(subjects || []).filter(Boolean).map(id => `&subject=${encodeURIComponent(id)}`).join('')
    + [].concat(providers || []).filter(Boolean).map(p => `&provider=${encodeURIComponent(p)}`).join(''),
  ),
  clearSyncDiagnostics: () => request('/sync/diagnostics', { method: 'DELETE' }),
  setSyncLogRetention: (days) =>
    request('/sync/diagnostics/retention', {
      method: 'PUT', body: JSON.stringify({ days }), suppressMutationSignal: true,
    }),

  getTasks:    () => request('/tasks'),
  // Task dismissal is a ratcheting high-water mark on the task's count (see routers/tasks.py), so both
  // calls return the freshly recomputed task list rather than just an ack.
  dismissTask: (key) => request(`/tasks/dismiss/${encodeURIComponent(key)}`, { method: 'POST' }),
  restoreTask: (key) => request(`/tasks/dismiss/${encodeURIComponent(key)}`, { method: 'DELETE' }),

  // Recurring series: detection is an on-demand scan; the rest curate the recurring_series records.
  getRecurringSeries: (includeSuppressed = false) =>
    request(`/recurring${includeSuppressed ? '?include_suppressed=true' : ''}`),
  scanRecurring:      (windowMonths = 25) => request(`/recurring/scan?window_months=${windowMonths}`, { method: 'POST' }),
  // App-load catch-up: the backend scans only if one is due (never scanned / stale), so this is a cheap
  // no-op when a recent import or sync already refreshed detection. Safe to call once per session.
  autoScanRecurring:  () => request('/recurring/auto-scan', { method: 'POST' }),
  rescanDuplicates:   () => request('/accounts/duplicate-rescan', { method: 'POST' }),
  forgetDuplicatePair: (a, b) => request(`/accounts/duplicate-pairs/${a}/${b}`, { method: 'DELETE' }),
  getDismissedDuplicatePairs: () => request('/accounts/duplicate-pairs'),
  reopenDuplicatePairs: (pairs) => request('/accounts/duplicate-pairs/reopen',
    { method: 'POST', body: JSON.stringify({ pairs }) }),
  getTransferReview:  () => request('/recurring/transfer-review'),
  decideTransferPair: (payingTxnId, receivingTxnId) =>
    request('/recurring/transfer-review/pair', {
      method: 'POST',
      body: JSON.stringify({ paying_txn_id: payingTxnId, receiving_txn_id: receivingTxnId || null }),
    }),
  restoreTransferDecision: (decision) =>
    request('/recurring/transfer-review/restore', { method: 'POST', body: JSON.stringify(decision) }),
  confirmRecurring:   (id) => request(`/recurring/${id}/confirm`, { method: 'POST' }),
  unconfirmRecurring: (id) => request(`/recurring/${id}/unconfirm`, { method: 'POST' }),
  suppressRecurring:  (id) => request(`/recurring/${id}/suppress`, { method: 'POST' }),
  endRecurring:       (id) => request(`/recurring/${id}/end`, { method: 'POST' }),
  restoreRecurring:   (id) => request(`/recurring/${id}/restore`, { method: 'POST' }),
  updateRecurring:    (id, data) => request(`/recurring/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  createRecurring:    (data) => request('/recurring', { method: 'POST', body: JSON.stringify(data) }),
  deleteRecurring:    (id) => request(`/recurring/${id}`, { method: 'DELETE' }),
  // Pin/exclude/clear one transaction's membership in a series (a scan-durable override).
  setRecurringMembership: (id, transaction_id, state) =>
    request(`/recurring/${id}/membership`, { method: 'POST', body: JSON.stringify({ transaction_id, state }) }),
  // Anomaly/forecast signals. Derived on read from the series and the ledger — nothing is stored but the
  // user's dismissals, which are keyed by each signal's own fingerprint so they survive a rescan.
  getRecurringSignals: (horizonDays) =>
    request(`/recurring/signals${horizonDays ? `?horizon_days=${horizonDays}` : ''}`),
  getDismissedRecurringSignals: () => request('/recurring/signals/dismissed'),
  // `oneOff` (Amount changed only): fine this time, but the usual amount is still expected.
  dismissRecurringSignal: (key, kind, { oneOff = false } = {}) =>
    request('/recurring/signals/dismiss', { method: 'POST', body: JSON.stringify({ key, kind, one_off: oneOff }) }),
  restoreRecurringSignal: (key) =>
    request('/recurring/signals/restore', { method: 'POST', body: JSON.stringify({ key }) }),

  getOwners:   () => request('/owners'),
  createOwner: (data) => request('/owners', { method: 'POST', body: JSON.stringify(data) }),
  updateOwner: (id, data) => request(`/owners/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteOwner: (id) => request(`/owners/${id}`, { method: 'DELETE' }),
  // Attached documents (receipts/invoices), and stored ones waiting for their transaction. The file itself
  // is never carried through JSON — it is uploaded as multipart and fetched back from its own URL, which is
  // what `documentFileUrl` is for. An upload is named by the File it sends: a paste names its file before
  // it gets here, so no second name travels beside it.
  getTransactionDocuments: (txnId) => request(`/documents/transaction/${txnId}`),
  attachTransactionDocument: (txnId, file) => uploadDocument(`/api/documents/transaction/${txnId}`, file),
  getStoredDocuments: () => request('/documents/stored'),
  storeDocument: (file) => uploadDocument('/api/documents/stored', file),
  attachStoredDocument: (documentId, txnId) =>
    request(`/documents/${documentId}/attach`, { method: 'POST', body: JSON.stringify({ txn_id: txnId }) }),
  // Off the transaction and back among the stored documents — the undoable removal.
  detachDocument: (documentId) =>
    request(`/documents/${documentId}/detach`, { method: 'POST' }),
  deleteDocument: (documentId) =>
    request(`/documents/${documentId}`, { method: 'DELETE' }),
  renameDocument: (documentId, filename) =>
    request(`/documents/${documentId}`, { method: 'PATCH', body: JSON.stringify({ filename }) }),
  // Editing replaces the document, so the response carries a new id that callers must swap in.
  editDocumentText: (documentId, text) =>
    request(`/documents/${documentId}/text`, { method: 'PUT', body: JSON.stringify({ text }) }),
  // The one read of a document's bytes through JavaScript: a text document about to be edited, which is
  // small by nature and has to be in a textarea to be changed at all.
  getDocumentText: (documentId) =>
    trackedFetch(`${BASE}/documents/${documentId}/file`).then(async res => {
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: res.statusText }))
        throw buildResponseError(err, res.status)
      }
      return res.text()
    }),
  // A URL rather than a fetch: the viewer points an <img>/<iframe> straight at it, so the bytes never
  // pass through JavaScript. `download` swaps the disposition for a save.
  documentFileUrl: (documentId, { download = false } = {}) =>
    `${BASE}/documents/${documentId}/file${download ? '?download=true' : ''}`,

  getTags:     () => request('/tags'),
  // The filter-attribute vocabulary (keys, labels, descriptions). Served rather than hardcoded so the
  // FilterBar's Attributes tab and the ledger's quick filter cannot drift from the predicates.
  getFilterAttributes: () => request('/transactions/filter-attributes'),
  getPayeeNames: q => request(`/transactions/payee-names?${new URLSearchParams({ q })}`),
  createTag:   (data) => request('/tags', { method: 'POST', body: JSON.stringify(data) }),
  updateTag:   (id, data) => request(`/tags/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteTag:   (id) => request(`/tags/${id}`, { method: 'DELETE' }),
  // Shared (tenant-wide) dashboard tag-report catalog. Not a per-user preference — every user sees
  // the same saved reports; only the current selection (spendingViewBy) stays per-user.
  getDashboardTagReports:  ()        => request('/tags/dashboard-reports'),
  saveDashboardTagReports: (reports) => request('/tags/dashboard-reports', { method: 'PUT', body: JSON.stringify({ reports }) }),
  getOwnerSummary: (params = {}) => {
    const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null))
    return request(`/owners/summary?${q}`)
  },
  updateAccount: (id, data) => request(`/accounts/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),

  // The mapping table's amounts. Parsed server-side by the same code the import runs, so the preview
  // cannot disagree with what will be stored; `suppressMutationSignal` because this POST writes nothing.
  previewAmounts: (body) =>
    request('/import-export/preview/amounts', {
      method: 'POST',
      body: JSON.stringify(body),
      suppressMutationSignal: true,
    }),

  // Multipart uploads intentionally bypass request() so fetch can set the boundary instead of inheriting the JSON content-type.
  previewCsv: (file) => {
    const fd = new FormData()
    fd.append('file', file)
    return trackedFetch('/api/import-export/preview', { method: 'POST', body: fd }).then(async res => {
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: res.statusText }))
        const error = new Error(err.detail || 'Request failed')
        error.status = res.status
        throw error
      }
      return res.json()
    })
  },
  // `progressId` names the run so `getImportRunProgress` can follow it while this request is open.
  runImport: (file, config, { progressId } = {}) => {
    const fd = new FormData()
    fd.append('file', file)
    fd.append('config', JSON.stringify(config))
    if (progressId) fd.append('progress_id', progressId)
    return trackedFetch('/api/import-export/run', { method: 'POST', body: fd }).then(async res => {
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: res.statusText }))
        throw buildResponseError(err, res.status)
      }
      signalDataMutated()
      return res.json()
    })
  },
  getImportRunProgress: (progressId) =>
    request(`/import-export/run-progress/${encodeURIComponent(progressId)}`),
  // PayPal money-movement review, at the data-source (profile) level: the distinct captured Type values
  // across all of the source's imports (with money-movement + already-ruled flags), and the endpoint that
  // adds/removes account-scoped match_source_text rules → Money movement, recategorizing existing rows.
  getMoneyMovementTypes: (profileId) =>
    request(`/import-export/profiles/${profileId}/money-movement-types`),
  applyMoneyMovementRules: (profileId, { add = [], remove = [] }) =>
    request(`/import-export/profiles/${profileId}/money-movement-rules`, {
      method: 'POST', body: JSON.stringify({ add, remove }),
    }),
  // AZAD Amazon order/items export(s): one or both files, sniffed server-side by header (a dropped file
  // on the general importer is detected client-side via lib/amazonDetect and routed here).
  // Inspect dropped AZAD files before importing: which payment cards they use + each card's funding-map
  // state, so the user can map any unmapped card up front (the map feeds the import that follows).
  scanAmazonFiles: (files, accountId) => {
    const fd = new FormData()
    for (const f of files) fd.append('files', f)
    if (accountId) fd.append('account_id', accountId)
    return trackedFetch('/api/import-export/amazon/scan', { method: 'POST', body: fd }).then(async res => {
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: res.statusText }))
        throw buildResponseError(err, res.status)
      }
      return res.json()
    })
  },
  importAmazon: (files, accountId, applyCategorization = true, profileId = null) => {
    const fd = new FormData()
    for (const f of files) fd.append('files', f)
    fd.append('account_id', accountId)
    fd.append('apply_categorization', applyCategorization ? 'true' : 'false')
    if (profileId) fd.append('profile_id', profileId)
    return trackedFetch('/api/import-export/amazon/import', { method: 'POST', body: fd }).then(async res => {
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: res.statusText }))
        throw buildResponseError(err, res.status)
      }
      signalDataMutated()
      return res.json()
    })
  },
  // PayPal monthly statements (PDFs, or zips of them): what the dropped files hold and which account each
  // PayPal account's statements already go into, then the import itself — one card per statement under the
  // PayPal data source. `assignments` maps each statement's PayPal Account ID to the account it goes into.
  scanPaypalStatements: (files) => {
    const fd = new FormData()
    for (const f of files) fd.append('files', f)
    return trackedFetch('/api/import-export/paypal-statements/scan', { method: 'POST', body: fd }).then(async res => {
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: res.statusText }))
        throw buildResponseError(err, res.status)
      }
      return res.json()
    })
  },
  importPaypalStatements: (files, assignments) => {
    const fd = new FormData()
    for (const f of files) fd.append('files', f)
    fd.append('assignments', JSON.stringify(assignments))
    return trackedFetch('/api/import-export/paypal-statements/import', { method: 'POST', body: fd }).then(async res => {
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: res.statusText }))
        throw buildResponseError(err, res.status)
      }
      signalDataMutated()
      return res.json()
    })
  },
  // Amazon funding-source → account map: which system account each Amazon payment instrument (card
  // last-4 + network) charges, so the importer can match + exclude the card charge. Global by default,
  // with an optional per-Amazon-account override (see docs/data-model.md -> Transaction links and
  // Amazon order import).
  getAmazonReconciliation:    (batchId) => request(`/import-export/amazon/reconciliation/${batchId}`),
  getAmazonImportDetail:      (batchId) => request(`/import-export/amazon/import-detail/${batchId}`),
  linkAmazonCharge:           (body) => request('/import-export/amazon/link-charge', { method: 'POST', body: JSON.stringify(body) }),
  linkAmazonCharges:          (body) => request('/import-export/amazon/link-charges', { method: 'POST', body: JSON.stringify(body) }),
  dismissAmazonSplitSuggestion: (body) => request('/import-export/amazon/dismiss-split-suggestion', { method: 'POST', body: JSON.stringify(body) }),
  markAmazonOrdersReviewed:   (body) => request('/import-export/amazon/mark-no-charge-reviewed', { method: 'POST', body: JSON.stringify(body) }),
  markAmazonUnaccountedReviewed: (body) => request('/import-export/amazon/mark-unaccounted-reviewed', { method: 'POST', body: JSON.stringify(body) }),
  trashAmazonDuplicateCharge: (body) => request('/import-export/amazon/trash-duplicate-charge', { method: 'POST', body: JSON.stringify(body) }),
  mergeAmazonDuplicateCharges: (body) => request('/import-export/amazon/merge-duplicate-charges', { method: 'POST', body: JSON.stringify(body) }),
  mergeUnaccountedAmazonCharges: (body) => request('/import-export/amazon/merge-unaccounted-charges', { method: 'POST', body: JSON.stringify(body) }),
  markAmazonChargesNotDuplicates: (body) => request('/import-export/amazon/charges-not-duplicates', { method: 'POST', body: JSON.stringify(body) }),
  unlinkAmazonOrderCharges: (body) => request('/import-export/amazon/unlink-charges', { method: 'POST', body: JSON.stringify(body) }),
  // The PayPal reconciliation (docs/data-model.md → PayPal funding pairs): the whole ledger, or one import's rows.
  getPaypalFundingReport:     (batchId) => request(`/import-export/paypal-funding/report${batchId ? `?batch_id=${encodeURIComponent(batchId)}` : ''}`),
  getPaypalFundingCandidates: (paypalTxnId) => request(`/import-export/paypal-funding/candidates/${paypalTxnId}`),
  pairPaypalFunding:          (body) => request('/import-export/paypal-funding/pair', { method: 'POST', body: JSON.stringify(body) }),
  unpairPaypalFunding:        (body) => request('/import-export/paypal-funding/unpair', { method: 'POST', body: JSON.stringify(body) }),
  declinePaypalFunding:       (body) => request('/import-export/paypal-funding/decline', { method: 'POST', body: JSON.stringify(body) }),
  markPaypalFundingReviewed:  (body) => request('/import-export/paypal-funding/mark-reviewed', { method: 'POST', body: JSON.stringify(body) }),
  // The ledger's currency — tenant-wide, not a per-user preference: everyone is reading the same numbers.
  // `setLedgerCurrency` answers 409 when the ledger already holds transactions and `confirm` was not sent;
  // the caller shows what the 409 says and retries verbatim with confirm: true.
  getLedgerCurrency:          ()     => request('/currency'),
  setLedgerCurrency:          (code, confirm = false) => request('/currency', { method: 'PUT', body: JSON.stringify({ code, confirm }) }),
  getAmazonFundingCategory:   ()     => request('/import-export/amazon/funding-category'),
  setAmazonFundingCategory:   (categoryId) => request('/import-export/amazon/funding-category', { method: 'PUT', body: JSON.stringify({ category_id: categoryId }) }),
  getAmazonFundingSources:    ()     => request('/import-export/amazon/funding-sources'),
  saveAmazonFundingSource:    (body) => request('/import-export/amazon/funding-sources', { method: 'PUT', body: JSON.stringify(body) }),
  deleteAmazonFundingSource:  (id)   => request(`/import-export/amazon/funding-sources/${id}`, { method: 'DELETE' }),
  // Saved Amazon sources: which Amazon account a drop lands in, and optionally a folder to watch. Stored
  // as `csv_import_profile` rows marked `marketplace:amazon`, so the watched-folder settings go through
  // the shared `updateImportProfileWatch` below rather than through these.
  getAmazonProfiles:          ()     => request('/import-export/amazon/profiles'),
  createAmazonProfile:        (body) => request('/import-export/amazon/profiles', { method: 'POST', body: JSON.stringify(body) }),
  updateAmazonProfile:        (id, body) => request(`/import-export/amazon/profiles/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteAmazonProfile:        (id)   => request(`/import-export/amazon/profiles/${id}`, { method: 'DELETE' }),
  // Shared (tenant-wide) "Group Imported Categories" workspace draft. Not a per-user preference — it
  // stages the one shared category tree, so it lives in import_workflow_state, not ui_preference.
  getCategoryWorkspaceDraft:  ()      => request('/import-export/category-workspace-draft'),
  saveCategoryWorkspaceDraft: (draft, baseRevision = 0) => request('/import-export/category-workspace-draft', { method: 'PUT', body: JSON.stringify({ draft, base_revision: baseRevision }) }),
  listBatches:      ()      => request('/import-export/batches'),
  // The maintenance screen over what each import stored beyond its transactions. The preview states
  // what the confirmation promises and the clear reports what it did — both counted server-side, so
  // the sentence and the write cannot disagree.
  getBatchDetailStorage:      ()          => request('/import-export/batches/detail-storage'),
  previewBatchDetailClearing: (batchIds)  => request('/import-export/batches/clear-detail-preview', { method: 'POST', body: JSON.stringify({ batch_ids: batchIds }) }),
  clearBatchDetail:           (batchIds)  => request('/import-export/batches/clear-detail', { method: 'POST', body: JSON.stringify({ batch_ids: batchIds }) }),
  getBatchEdited:   (id)    => request(`/import-export/batches/${id}/edited`),
  getBatchDuplicatesUnified: (id) => request(`/import-export/batches/${id}/duplicates-unified`),
  getBatchRemovedDuplicates: (id) => request(`/import-export/batches/${id}/removed-duplicates`),
  getBatchNotImported: (id) => request(`/import-export/batches/${id}/not-imported`),
  getBatchCategoryMappings: (id) => request(`/import-export/batches/${id}/category-mappings`),
  getBatchRuleSuggestions: (id, ownerIds = []) => {
    const q = new URLSearchParams(csvParam('owner_ids', ownerIds))
    const suffix = q.toString() ? `?${q}` : ''
    return request(`/import-export/batches/${id}/rule-suggestions${suffix}`)
  },
  getSystemRuleSuggestions: (ownerIds = []) => {
    const q = new URLSearchParams(csvParam('owner_ids', ownerIds))
    const suffix = q.toString() ? `?${q}` : ''
    return request(`/import-export/rule-suggestions${suffix}`)
  },
  getProfileRuleSuggestions: (id, ownerIds = []) => {
    const q = new URLSearchParams(csvParam('owner_ids', ownerIds))
    const suffix = q.toString() ? `?${q}` : ''
    return request(`/import-export/profiles/${id}/rule-suggestions${suffix}`)
  },
  getBatchRuleSuggestionMatches: (id, payload) =>
    request(`/import-export/batches/${id}/rule-suggestions/matches`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  getSystemRuleSuggestionMatches: (payload) =>
    request('/import-export/rule-suggestions/matches', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  getProfileRuleSuggestionMatches: (id, payload) =>
    request(`/import-export/profiles/${id}/rule-suggestions/matches`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  clearBatchRuleSuggestions: (id, status, suggestionIds = null) =>
    request(`/import-export/batches/${id}/rule-suggestions/clear`, {
      method: 'POST',
      body: JSON.stringify({ status, suggestion_ids: suggestionIds }),
    }),
  restoreBatchRuleSuggestionTrashSet: (id, trashSetId) =>
    request(`/import-export/batches/${id}/rule-suggestions/trash/${trashSetId}/restore`, { method: 'POST' }),
  refineBatchRuleSuggestionMatch: (id, payload) =>
    request(`/import-export/batches/${id}/rule-suggestions/refine-match`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  clearSystemRuleSuggestions: (status, suggestionIds = null) =>
    request('/import-export/rule-suggestions/clear', {
      method: 'POST',
      body: JSON.stringify({ status, suggestion_ids: suggestionIds }),
    }),
  restoreSystemRuleSuggestionTrashSet: (trashSetId) =>
    request(`/import-export/rule-suggestions/trash/${trashSetId}/restore`, { method: 'POST' }),
  refineSystemRuleSuggestionMatch: (payload) =>
    request('/import-export/rule-suggestions/refine-match', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  clearProfileRuleSuggestions: (id, status, suggestionIds = null) =>
    request(`/import-export/profiles/${id}/rule-suggestions/clear`, {
      method: 'POST',
      body: JSON.stringify({ status, suggestion_ids: suggestionIds }),
    }),
  restoreProfileRuleSuggestionTrashSet: (id, trashSetId) =>
    request(`/import-export/profiles/${id}/rule-suggestions/trash/${trashSetId}/restore`, { method: 'POST' }),
  refineProfileRuleSuggestionMatch: (id, payload) =>
    request(`/import-export/profiles/${id}/rule-suggestions/refine-match`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  // The review's actions, each one transaction server-side that answers with an `undo` payload for
  // undoRuleSuggestionAction. `scope` names the review: `{ batchId }`, `{ profileId }`, or `{}` for system.
  acceptRuleSuggestions: (scope, items) =>
    request(`${ruleSuggestionScopePath(scope)}/accept`, {
      method: 'POST',
      body: JSON.stringify({ items }),
    }),
  setRuleSuggestionStatus: (scope, items, status, { clearCategories = false } = {}) =>
    request(`${ruleSuggestionScopePath(scope)}/status`, {
      method: 'POST',
      body: JSON.stringify({ items, status, clear_categories: clearCategories }),
    }),
  resolveRuleSuggestionConflictSet: (scope, members, winnerId) =>
    request(`${ruleSuggestionScopePath(scope)}/resolve-conflict-set`, {
      method: 'POST',
      body: JSON.stringify({ members, winner_id: winnerId }),
    }),
  applyRuleSuggestionRules: (scope, ruleIds) =>
    request(`${ruleSuggestionScopePath(scope)}/apply-rules`, {
      method: 'POST',
      body: JSON.stringify({ rule_ids: ruleIds }),
    }),
  undoRuleSuggestionAction: (scope, undo) =>
    request(`${ruleSuggestionScopePath(scope)}/undo`, {
      method: 'POST',
      body: JSON.stringify(undo),
    }),
  applyBatchCategoryMappings: (id, assignments) =>
    request(`/import-export/batches/${id}/category-mappings`, { method: 'POST', body: JSON.stringify({ assignments }) }),
  setBatchProfile: (id, profileId) =>
    request(`/import-export/batches/${id}/profile`, { method: 'PATCH', body: JSON.stringify({ profile_id: profileId }) }),
  createProfileFromBatch: (id, name, filenamePattern = null) =>
    request(`/import-export/batches/${id}/create-profile`, { method: 'POST', body: JSON.stringify({ name, filename_pattern: filenamePattern }) }),
  updateBatchImportedCategoryUsage: (id, payload) =>
    request(`/import-export/batches/${id}/imported-category-usage`, {
      method: 'PATCH',
      body: JSON.stringify(
        typeof payload === 'boolean'
          ? { use_imported_categories: payload }
          : payload
      ),
    }),
  getCompatibleImportBatches: (profileId) =>
    request(`/import-export/profiles/${profileId}/compatible-batches`),
  importBatchDuplicates: (id, payload) =>
    request(`/import-export/batches/${id}/duplicates/import`, { method: 'POST', body: JSON.stringify(payload) }),
  markBatchDuplicatesReviewed: (id, rowNumbers, reviewed = true) =>
    request(`/import-export/batches/${id}/duplicates/mark-reviewed`, { method: 'POST', body: JSON.stringify({ row_numbers: rowNumbers, reviewed }) }),
  // Enrich-on-duplicate: fold each row's incoming detail into the transaction it matched, or undo that.
  enrichBatchDuplicates: (id, rowNumbers) =>
    request(`/import-export/batches/${id}/duplicates/enrich`, { method: 'POST', body: JSON.stringify({ row_numbers: rowNumbers }) }),
  undoBatchDuplicateEnrichment: (id, rowNumbers) =>
    request(`/import-export/batches/${id}/duplicates/enrich/undo`, { method: 'POST', body: JSON.stringify({ row_numbers: rowNumbers }) }),
  // Clear needs_review on every still-flagged transaction in this file — the one-click "looked these
  // over (or don't need to)" for a whole import. Returns { updated }.
  markBatchReviewed: (id) =>
    request(`/import-export/batches/${id}/mark-reviewed`, { method: 'POST' }),
  undoBatch:        (id, force = false) =>
    request(`/import-export/batches/${id}${force ? '?force=true' : ''}`, { method: 'DELETE' }),
  getImportProfiles:    ()      => request('/import-export/profiles'),
  createImportProfile:  (data)  => request('/import-export/profiles', { method: 'POST', body: JSON.stringify(data) }),
  updateImportProfile:  (id, data) => request(`/import-export/profiles/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteImportProfile:  (id)    => request(`/import-export/profiles/${id}`, { method: 'DELETE' }),
  clearImportMemory:    ()      => request('/import-export/developer/import-memory', { method: 'DELETE' }),
  // Watched import folders. `watchStatus` reads persisted state only — the filesystem is touched by the
  // two scans, so nothing that renders on a schedule may call them.
  getWatchStatus:       ()      => request('/import-export/watch/status'),
  scanWatchedFolders:   (profileId) =>
    request(`/import-export/watch/scan${profileId ? `?profile_id=${encodeURIComponent(profileId)}` : ''}`, { method: 'POST' }),
  autoScanWatchedFolders: ()    => request('/import-export/watch/auto-scan', { method: 'POST' }),
  updateImportProfileWatch: (id, data) =>
    request(`/import-export/profiles/${id}/watch`, { method: 'PATCH', body: JSON.stringify(data) }),
  // The subdirectories of one folder on the *server*, for the folder picker. Read-only and admin-gated,
  // like naming the folder itself. No path = the starting roots only.
  browseServerDirectories: (path) =>
    request(`/import-export/watch/browse${path ? `?path=${encodeURIComponent(path)}` : ''}`),
  dismissWatchedFile:   (fileId) => request(`/import-export/watch/files/${fileId}`, { method: 'DELETE' }),
  // A parked file's own text, so the ordinary import flow can be opened with it in hand — the file is on
  // the server, and everything downstream of the drop zone works from a File.
  getWatchedFileText:   (fileId) =>
    trackedFetch(`${BASE}/import-export/watch/files/${fileId}/content`).then(async res => {
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: res.statusText }))
        throw buildResponseError(err, res.status)
      }
      return res.text()
    }),
  exportTransactionsCsv: (params = {}) => {
    const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null))
    // Export flows hand callers a download URL because these endpoints are usually navigated to, not consumed as JSON.
    return `/api/import-export/transactions.csv?${q}`
  },
  getBackupRecipients: () => request('/import-export/backup/recipients'),
  getRestoreTargetStatus: () => request('/import-export/restore/target-status'),
  createBackupRecipient: (data) => request('/import-export/backup/recipients', { method: 'POST', body: JSON.stringify(data) }),
  // Generates a keypair and stores NOTHING: the private key comes back once, in this response, and the
  // caller submits the public half through createBackupRecipient only after the user has saved it.
  generateBackupKeypair: (data) => request('/import-export/backup/keypair', { method: 'POST', body: JSON.stringify(data) }),
  updateBackupRecipient: (id, data) => request(`/import-export/backup/recipients/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteBackupRecipient: (id) => request(`/import-export/backup/recipients/${id}`, { method: 'DELETE' }),
  // What a backup taken now would leave out, unencrypted and encrypted, and why.
  getBackupStatus: () => request('/import-export/backup/status'),
  getBackupHistory: () => request('/import-export/backup/history'),
  setBackupHistoryRetention: (days) =>
    request('/import-export/backup/history/retention', {
      method: 'PUT', body: JSON.stringify({ days }), suppressMutationSignal: true,
    }),
  renameBackupHistoryEntry: (id, filename) =>
    request(`/import-export/backup/history/${encodeURIComponent(id)}`, {
      method: 'PATCH', body: JSON.stringify({ filename }), suppressMutationSignal: true,
    }),
  trashBackupHistoryEntry: (id) =>
    request(`/import-export/backup/history/${encodeURIComponent(id)}`, { method: 'DELETE', suppressMutationSignal: true }),
  getBackupHistoryTrash: () => request('/import-export/backup/history-trash'),
  restoreBackupHistoryEntry: (id) =>
    request(`/import-export/backup/history-trash/${encodeURIComponent(id)}/restore`, { method: 'POST', suppressMutationSignal: true }),
  emptyBackupHistoryTrash: () =>
    request('/import-export/backup/history-trash/empty', { method: 'POST', suppressMutationSignal: true }),
  // A backup is always the financial data and the accounts; what to put back is chosen at restore.
  // `recipientIds` narrows an encrypted backup to a chosen subset; omitted means every enabled recipient,
  // which is what a single-recipient install always wants.
  // `savedAs` is the name a save picker chose before the backup was asked for, which the history records.
  exportBackup: (encrypted = false, recipientIds = null, savedAs = null) => {
    const params = []
    if (encrypted) params.push('encrypted=true')
    if (encrypted && recipientIds?.length) params.push(`recipients=${encodeURIComponent(recipientIds.join(','))}`)
    if (savedAs) params.push(`saved_as=${encodeURIComponent(savedAs)}`)
    return `/api/import-export/backup${params.length ? `?${params.join('&')}` : ''}`
  },
  inspectBackupFile: async (file) => {
    const fd = new FormData()
    fd.append('file', file)
    const res = await trackedFetch('/api/import-export/restore-file/inspect', { method: 'POST', body: fd })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }))
      const error = new Error(err.detail || 'Request failed')
      error.status = res.status
      throw error
    }
    return res.json()
  },
  // `parts` chooses what to put back: `includeData` (the financial data) and `includeAccounts` (the
  // accounts part, which only a full backup holds). `adminUsername`/`adminPassword` are an administrator of
  // the backup, asked for when restoring its accounts turns sign-in on.
  restoreBackupFile: async (file, privateKeyFile = null, privateKeyPassphrase = '', force = false, parts = {}) => {
    const fd = new FormData()
    fd.append('file', file)
    if (privateKeyFile) fd.append('private_key_file', privateKeyFile)
    if (privateKeyPassphrase) fd.append('private_key_passphrase', privateKeyPassphrase)
    if (force) fd.append('force', 'true')
    fd.append('include_data', parts.includeData === false ? 'false' : 'true')
    if (parts.includeAccounts) fd.append('include_accounts', 'true')
    if (parts.includeCredentials === false) fd.append('include_credentials', 'false')
    if (parts.adminUsername) fd.append('admin_username', parts.adminUsername)
    if (parts.adminPassword) fd.append('admin_password', parts.adminPassword)
    const res = await trackedFetch('/api/import-export/restore-file', { method: 'POST', body: fd })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }))
      // The compatibility and demo-data guards return structured detail objects (409). buildResponseError
      // keeps `detail` intact so the caller can branch on `code` and retry with force.
      throw buildResponseError(err, res.status)
    }
    signalDataMutated()
    return res.json()
  },
  restoreCredentialsFile: async (file, secret = null) => {
    const fd = new FormData()
    fd.append('file', file)
    // One secret of the member who PRODUCED the backup — `{ passphrase }`, `{ recovery_code }`, or
    // `{ passkey_credential_id, passkey_prf_output }` — only needed when the file's ciphertext is not
    // already valid here and must be reopened before it can be re-keyed under this workspace.
    for (const [field, value] of Object.entries(secret || {})) {
      if (value) fd.append(field, value)
    }
    const res = await trackedFetch('/api/import-export/restore/credentials-file', { method: 'POST', body: fd })
    if (!res.ok) {
      // `buildResponseError` (not a bare Error) so callers can branch on `detail.code` — this endpoint
      // answers `backup_secret_required` / `incorrect_backup_secret` (both with `unlock_options`) /
      // `vault_locked`.
      throw buildResponseError(await res.json().catch(() => ({ detail: res.statusText })), res.status)
    }
    signalDataMutated()
    return res.json()
  },
}

// Download a file the API serves as an attachment, WITHOUT navigating.
//
// A plain `<a href>` or `location.assign` hands the URL to the browser, which then renders whatever
// comes back — so any non-200 replaces the app with a raw JSON error page and no error handling can
// run. Fetching keeps the response in the app's hands: failures raise the same `buildResponseError`
// shape as every other call, and the SPA is never left.
export async function downloadUrl(url) {
  const res = await trackedFetch(url)
  if (!res.ok) {
    throw buildResponseError(await res.json().catch(() => ({ detail: res.statusText })), res.status)
  }
  const blob = await res.blob()
  // Filename comes from Content-Disposition; the server already dates and names these.
  const disposition = res.headers.get('Content-Disposition') || ''
  const match = /filename="?([^"';]+)"?/i.exec(disposition)
  saveBlob(blob, match ? match[1] : 'download')
}

// `downloadUrl` for a file already chosen with the save picker (`lib/filePicker.js`): the response is
// written into it, and the promise resolves once the bytes are on disk, so the caller knows the save
// happened. A failed request or write discards the file the picker left. A
// failed write's error carries `headers` too, because by then the server has done what was asked.
export async function saveUrlToFile(url, handle) {
  const res = await trackedFetch(url)
  if (!res.ok) {
    await discardSaveFile(handle)
    throw buildResponseError(await res.json().catch(() => ({ detail: res.statusText })), res.status)
  }
  try {
    await res.body.pipeTo(await handle.createWritable())
  } catch (error) {
    await discardSaveFile(handle)
    error.headers = res.headers
    throw error
  }
}

// Hand a blob to the browser as a download. Shared rather than inlined because the revoke timing below
// is a real trap: revoking synchronously can beat the click through in some browsers and save a
// zero-byte file, which a second copy of this would very plausibly get wrong.
export function saveBlob(blob, filename) {
  const objectUrl = URL.createObjectURL(blob)
  try {
    const anchor = document.createElement('a')
    anchor.href = objectUrl
    anchor.download = filename
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
  } finally {
    setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000)
  }
}
