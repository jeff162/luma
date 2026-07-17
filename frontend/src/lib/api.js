// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * This module is the contract boundary between page-level UI state and backend routes. Most callers hand it
 * app concepts like filters, profile context, or batch actions and let this layer normalize headers, query strings,
 * and the handful of upload/download cases that cannot use the default JSON request helper.
 */

const BASE = '/api'
let localPreferenceProfileId = ''

export function setLocalPreferenceProfileId(profileId) {
  localPreferenceProfileId = profileId || ''
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
  const res = await fetch(`${BASE}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      // Preference profile selection is app-wide context, so the header is injected here instead of threaded through every call site.
      ...(localPreferenceProfileId ? { 'X-Fintrack-Preference-Profile': localPreferenceProfileId } : {}),
      ...fetchOptions.headers,
    },
    ...fetchOptions,
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }))
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

export const api = {
  getAuthStatus: () => request('/auth/status'),
  getUserPreferences: () => request('/auth/preferences'),
  saveUserPreference: (key, value) =>
    request('/auth/preferences', { method: 'POST', body: JSON.stringify({ key, value }) }),
  clearUserPreferences: () => request('/auth/preferences', { method: 'DELETE' }),
  getLocalPreferenceProfiles: () => request('/auth/local-preference-profiles'),
  createLocalPreferenceProfile: (name) =>
    request('/auth/local-preference-profiles', { method: 'POST', body: JSON.stringify({ name }) }),
  clearLocalPreferenceProfiles: () => request('/auth/local-preference-profiles', { method: 'DELETE' }),
  updateLocalPreferenceProfile: (id, name) =>
    request(`/auth/local-preference-profiles/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) }),
  deleteLocalPreferenceProfile: (id) =>
    request(`/auth/local-preference-profiles/${id}`, { method: 'DELETE' }),
  loadDemoData: () => request('/auth/demo-data', { method: 'POST' }),
  getDemoDataStatus: () => request('/auth/demo-data'),
  clearDemoData: () => request('/auth/demo-data/clear', { method: 'POST' }),
  getRuntimeConfigDefaults: () => request('/auth/runtime-config/defaults'),
  saveRuntimeConfig: (data) =>
    request('/auth/runtime-config', { method: 'POST', body: JSON.stringify(data) }),
  getEnvironmentSettings: () => request('/auth/environment'),
  saveEnvironmentSettings: (data) =>
    request('/auth/environment', { method: 'POST', body: JSON.stringify(data) }),
  savePasswordPolicy: (policy) =>
    request('/auth/password-policy', { method: 'POST', body: JSON.stringify({ policy }) }),
  saveSecurityProfile: (profile) =>
    request('/auth/security-profile', { method: 'POST', body: JSON.stringify({ profile }) }),
  getBootstrapStatus: () => request('/auth/bootstrap-status'),
  getCurrentUser: () => request('/auth/me'),
  enableAuth: () => request('/auth/enable', { method: 'POST', body: JSON.stringify({ enabled: true }) }),
  login: (username, password) =>
    request('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  verifyTwoFactor: (code) =>
    request('/auth/2fa/verify', { method: 'POST', body: JSON.stringify({ code }) }),
  bootstrap: (username, password, display_name) =>
    request('/auth/bootstrap', { method: 'POST', body: JSON.stringify({ username, password, display_name }) }),
  logout: () => request('/auth/logout', { method: 'POST' }),
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
  setPrivacyMode: (privacy_mode) =>
    request('/auth/privacy-mode', { method: 'POST', body: JSON.stringify({ privacy_mode }) }),

  getTransactions: (params = {}) => {
    const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null))
    return request(`/transactions?${q}`)
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
  overrideCategory: (txnId, category_id, notes) =>
    request(`/transactions/${txnId}/category`, {
      method: 'PATCH',
      body: JSON.stringify({ category_id, notes }),
    }),

  // Settle the rows behind a rejected rule suggestion. mode 'keep' records a category as a manual
  // decision (the existing one, or `category_id` when given — the conflict screen's "keep as a
  // different category"); mode 'clear' discards it to the `cleared` source (rule-eligible, label kept,
  // not re-grabbed by a trust-flag re-toggle). Both clear the `import` source and spare manual edits.
  setRejectedSuggestionDisposition: (transaction_ids, mode, category_id = null) =>
    request('/transactions/rejected-suggestion-disposition', {
      method: 'POST',
      body: JSON.stringify({ transaction_ids, mode, category_id }),
    }),

  // Undo for the above: restore each row to a previously captured category snapshot (the `rows`
  // returned by setRejectedSuggestionDisposition).
  restoreCategorization: (rows) =>
    request('/transactions/restore-categorization', {
      method: 'POST',
      body: JSON.stringify({ rows }),
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
  deleteAccount: (id) => request(`/accounts/${id}`, { method: 'DELETE' }),
  attachAccount: (id, parent_account_id) =>
    request(`/accounts/${id}/attach`, { method: 'POST', body: JSON.stringify({ parent_account_id }) }),
  detachAccount: (id) => request(`/accounts/${id}/detach`, { method: 'POST' }),
  trashAccount: (id) => request(`/accounts/${id}/trash`, { method: 'POST' }),
  restoreAccount: (id) => request(`/accounts/${id}/restore`, { method: 'POST' }),
  getTrashedAccounts: () => request('/accounts/trash'),
  emptyAccountTrash: () => request('/accounts/trash/empty', { method: 'POST' }),
  getDistinctAccountPairs: () => request('/accounts/distinct-pairs'),
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
  updateCategory: (id, data) =>
    request(`/categories/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  getCategoryTags: (id) => request(`/categories/${id}/tags`),
  setCategoryTags: (id, tag_ids) =>
    request(`/categories/${id}/tags`, { method: 'PUT', body: JSON.stringify({ tag_ids }) }),

  getLinkToken: () => request('/plaid/link-token'),
  exchangeToken: (public_token, institution_name) =>
    request('/plaid/exchange', {
      method: 'POST',
      body: JSON.stringify({ public_token, institution_name }),
    }),

  updateMerchant:      (id, name)   => request(`/transactions/${id}/merchant`, { method: 'PATCH', body: JSON.stringify({ merchant_name: name }) }),
  updateNotes:         (id, notes)  => request(`/transactions/${id}/notes`,    { method: 'PATCH', body: JSON.stringify({ notes }) }),
  updateTransactionTag: (id, tag_id, present) =>
    request(`/transactions/${id}/tags`, { method: 'PATCH', body: JSON.stringify({ tag_id, present }) }),
  clearOverride:       (id)         => request(`/transactions/${id}/uncategorize`, { method: 'PATCH' }),
  // Trash (soft-delete) for transactions. Mirrors the account trash flow: trashed rows are
  // filtered out of every read until they're explicitly restored or the trash is emptied.
  trashTransaction:    (id)         => request(`/transactions/${id}`,           { method: 'DELETE' }),
  restoreTransaction:  (id)         => request(`/transactions/${id}/restore`,   { method: 'POST'   }),
  // Bulk edit: `selection` is { mode:'ids', ids } or { mode:'filter', filter, exclude_ids };
  // `actions` is an ordered list of { type, ...payload }. Returns { updated_count }.
  bulkUpdateTransactions: (selection, actions) =>
    request('/transactions/bulk', { method: 'POST', body: JSON.stringify({ selection, actions }) }),
  getTrashedTransactions: ()        => request('/transactions/trash'),
  emptyTransactionTrash: (scope = 'all') => request(`/transactions/trash/empty?scope=${encodeURIComponent(scope)}`, { method: 'POST' }),
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
  previewRule: (data) => request('/rules/preview', { method: 'POST', body: JSON.stringify(data) }),
  // `onExisting`: how to reconcile a same-matcher collision. Default (omitted) classifies and reports
  // without writing (status: duplicate|mergeable|conflict); 'merge' folds a mergeable/duplicate save
  // into the existing rule. Response carries `status` ('created'|'merged'|'duplicate'|'mergeable'|'conflict').
  createRule: (data, { onExisting } = {}) =>
    request(`/rules${onExisting ? `?on_existing=${onExisting}` : ''}`, { method: 'POST', body: JSON.stringify(data) }),
  // `onExisting`: like createRule, but for an edit that makes this rule's matcher collide with another
  // rule. Default classifies without writing; 'merge' folds this rule's actions into the other and
  // deletes this one. Response `status`: 'updated'|'merged'|'duplicate'|'mergeable'|'conflict'.
  updateRule: (id, data, { onExisting } = {}) =>
    request(`/rules/${id}${onExisting ? `?on_existing=${onExisting}` : ''}`, { method: 'PATCH', body: JSON.stringify(data) }),
  // `preserveManual` re-categorizes the rule's matches but leaves manual per-transaction edits alone
  // (used after a merge/replace changes the governing rule); omitted = full force, overwriting all matches.
  applyRule: (id, { preserveManual } = {}) =>
    request(`/rules/${id}/apply${preserveManual ? '?preserve_manual=true' : ''}`, { method: 'POST' }),
  // Apply a rule's outputs to a specific set of transactions (the rows that generated an accepted
  // import-rule suggestion), leaving conflicting rows and manual exceptions alone.
  applyRuleToTransactions: (id, transaction_ids) =>
    request(`/rules/${id}/apply-to-transactions`, { method: 'POST', body: JSON.stringify({ transaction_ids }) }),
  deleteRule: (id) => request(`/rules/${id}`, { method: 'DELETE' }),
  traceImportRuleSuggestionAction: data =>
    request('/import-export/rule-suggestions/debug-trace', {
      method: 'POST',
      body: JSON.stringify(data),
      suppressMutationSignal: true,
    }),

  runSync: (days = 30) => request(`/sync?days=${days}`, { method: 'POST' }),
  recategorize: () => request('/sync/recategorize', { method: 'POST' }),
  getRecategorizePreview: () => request('/sync/recategorize-preview'),

  getTasks:    () => request('/tasks'),

  // Recurring series: detection is an on-demand scan; the rest curate the recurring_series records.
  getRecurringSeries: (includeSuppressed = false) =>
    request(`/recurring${includeSuppressed ? '?include_suppressed=true' : ''}`),
  scanRecurring:      (windowMonths = 25) => request(`/recurring/scan?window_months=${windowMonths}`, { method: 'POST' }),
  // App-load catch-up: the backend scans only if one is due (never scanned / stale), so this is a cheap
  // no-op when a recent import or sync already refreshed detection. Safe to call once per session.
  autoScanRecurring:  () => request('/recurring/auto-scan', { method: 'POST' }),
  confirmRecurring:   (id) => request(`/recurring/${id}/confirm`, { method: 'POST' }),
  suppressRecurring:  (id) => request(`/recurring/${id}/suppress`, { method: 'POST' }),
  endRecurring:       (id) => request(`/recurring/${id}/end`, { method: 'POST' }),
  restoreRecurring:   (id) => request(`/recurring/${id}/restore`, { method: 'POST' }),
  updateRecurring:    (id, data) => request(`/recurring/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  createRecurring:    (data) => request('/recurring', { method: 'POST', body: JSON.stringify(data) }),
  deleteRecurring:    (id) => request(`/recurring/${id}`, { method: 'DELETE' }),
  // Pin/exclude/clear one transaction's membership in a series (a scan-durable override).
  setRecurringMembership: (id, transaction_id, state) =>
    request(`/recurring/${id}/membership`, { method: 'POST', body: JSON.stringify({ transaction_id, state }) }),

  getOwners:   () => request('/owners'),
  createOwner: (data) => request('/owners', { method: 'POST', body: JSON.stringify(data) }),
  updateOwner: (id, data) => request(`/owners/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteOwner: (id) => request(`/owners/${id}`, { method: 'DELETE' }),
  getTags:     () => request('/tags'),
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

  // Multipart uploads intentionally bypass request() so fetch can set the boundary instead of inheriting the JSON content-type.
  previewCsv: (file) => {
    const fd = new FormData()
    fd.append('file', file)
    return fetch('/api/import-export/preview', { method: 'POST', body: fd }).then(async res => {
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: res.statusText }))
        const error = new Error(err.detail || 'Request failed')
        error.status = res.status
        throw error
      }
      return res.json()
    })
  },
  runImport: (file, config) => {
    const fd = new FormData()
    fd.append('file', file)
    fd.append('config', JSON.stringify(config))
    return fetch('/api/import-export/run', { method: 'POST', body: fd }).then(async res => {
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: res.statusText }))
        throw buildResponseError(err, res.status)
      }
      signalDataMutated()
      return res.json()
    })
  },
  // AZAD Amazon order/items export(s): one or both files, sniffed server-side by header (a dropped file
  // on the general importer is detected client-side via lib/amazonDetect and routed here).
  // Inspect dropped AZAD files before importing: which payment cards they use + each card's funding-map
  // state, so the user can map any unmapped card up front (the map feeds the import that follows).
  scanAmazonFiles: (files, accountId) => {
    const fd = new FormData()
    for (const f of files) fd.append('files', f)
    if (accountId) fd.append('account_id', accountId)
    return fetch('/api/import-export/amazon/scan', { method: 'POST', body: fd }).then(async res => {
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: res.statusText }))
        throw buildResponseError(err, res.status)
      }
      return res.json()
    })
  },
  importAmazon: (files, accountId, applyCategorization = true) => {
    const fd = new FormData()
    for (const f of files) fd.append('files', f)
    fd.append('account_id', accountId)
    fd.append('apply_categorization', applyCategorization ? 'true' : 'false')
    return fetch('/api/import-export/amazon/import', { method: 'POST', body: fd }).then(async res => {
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
  // with an optional per-Amazon-account override (see docs/backlog/paypal-amazon-enrichment.md).
  getAmazonReconciliation:    (batchId) => request(`/import-export/amazon/reconciliation/${batchId}`),
  getAmazonImportDetail:      (batchId) => request(`/import-export/amazon/import-detail/${batchId}`),
  linkAmazonCharge:           (body) => request('/import-export/amazon/link-charge', { method: 'POST', body: JSON.stringify(body) }),
  linkAmazonCharges:          (body) => request('/import-export/amazon/link-charges', { method: 'POST', body: JSON.stringify(body) }),
  dismissAmazonSplitSuggestion: (body) => request('/import-export/amazon/dismiss-split-suggestion', { method: 'POST', body: JSON.stringify(body) }),
  trashAmazonDuplicateCharge: (body) => request('/import-export/amazon/trash-duplicate-charge', { method: 'POST', body: JSON.stringify(body) }),
  mergeAmazonDuplicateCharges: (body) => request('/import-export/amazon/merge-duplicate-charges', { method: 'POST', body: JSON.stringify(body) }),
  mergeUnaccountedAmazonCharges: (body) => request('/import-export/amazon/merge-unaccounted-charges', { method: 'POST', body: JSON.stringify(body) }),
  markAmazonChargesNotDuplicates: (body) => request('/import-export/amazon/charges-not-duplicates', { method: 'POST', body: JSON.stringify(body) }),
  getAmazonFundingCategory:   ()     => request('/import-export/amazon/funding-category'),
  setAmazonFundingCategory:   (categoryId) => request('/import-export/amazon/funding-category', { method: 'PUT', body: JSON.stringify({ category_id: categoryId }) }),
  getAmazonFundingSources:    ()     => request('/import-export/amazon/funding-sources'),
  saveAmazonFundingSource:    (body) => request('/import-export/amazon/funding-sources', { method: 'PUT', body: JSON.stringify(body) }),
  deleteAmazonFundingSource:  (id)   => request(`/import-export/amazon/funding-sources/${id}`, { method: 'DELETE' }),
  // Shared (tenant-wide) "Group Imported Categories" workspace draft. Not a per-user preference — it
  // stages the one shared category tree, so it lives in import_workflow_state, not ui_preference.
  getCategoryWorkspaceDraft:  ()      => request('/import-export/category-workspace-draft'),
  saveCategoryWorkspaceDraft: (draft) => request('/import-export/category-workspace-draft', { method: 'PUT', body: JSON.stringify({ draft }) }),
  listBatches:      ()      => request('/import-export/batches'),
  getBatchEdited:   (id)    => request(`/import-export/batches/${id}/edited`),
  getBatchDuplicates: (id)  => request(`/import-export/batches/${id}/duplicates`),
  getBatchDuplicatesUnified: (id) => request(`/import-export/batches/${id}/duplicates-unified`),
  getBatchDedupedRows: (id) => request(`/import-export/batches/${id}/deduped-rows`),
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
  updateBatchRuleSuggestionReview: (id, payload) =>
    request(`/import-export/batches/${id}/rule-suggestions/review`, {
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
  updateSystemRuleSuggestionReview: (payload) =>
    request('/import-export/rule-suggestions/review', {
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
  updateProfileRuleSuggestionReview: (id, payload) =>
    request(`/import-export/profiles/${id}/rule-suggestions/review`, {
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
  exportTransactionsCsv: (params = {}) => {
    const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null))
    // Export flows hand callers a download URL because these endpoints are usually navigated to, not consumed as JSON.
    return `/api/import-export/transactions.csv?${q}`
  },
  getBackupRecipients: () => request('/import-export/backup/recipients'),
  getCredentialsBackupStatus: () => request('/import-export/backup/credentials/status'),
  getRestoreTargetStatus: () => request('/import-export/restore/target-status'),
  createBackupRecipient: (data) => request('/import-export/backup/recipients', { method: 'POST', body: JSON.stringify(data) }),
  updateBackupRecipient: (id, data) => request(`/import-export/backup/recipients/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteBackupRecipient: (id) => request(`/import-export/backup/recipients/${id}`, { method: 'DELETE' }),
  exportBackup:      (encrypted = false)  => `/api/import-export/backup${encrypted ? '?encrypted=true' : ''}`,
  exportCredentials: (encrypted = false)  => `/api/import-export/backup/credentials${encrypted ? '?encrypted=true' : ''}`,
  inspectBackupFile: async (file) => {
    const fd = new FormData()
    fd.append('file', file)
    const res = await fetch('/api/import-export/restore-file/inspect', { method: 'POST', body: fd })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }))
      const error = new Error(err.detail || 'Request failed')
      error.status = res.status
      throw error
    }
    return res.json()
  },
  restoreBackupFile: async (file, privateKeyFile = null, privateKeyPassphrase = '', force = false) => {
    const fd = new FormData()
    fd.append('file', file)
    if (privateKeyFile) fd.append('private_key_file', privateKeyFile)
    if (privateKeyPassphrase) fd.append('private_key_passphrase', privateKeyPassphrase)
    if (force) fd.append('force', 'true')
    const res = await fetch('/api/import-export/restore-file', { method: 'POST', body: fd })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }))
      // The compatibility and demo-data guards return structured detail objects (409). buildResponseError
      // keeps `detail` intact so the caller can branch on `code` and retry with force.
      throw buildResponseError(err, res.status)
    }
    signalDataMutated()
    return res.json()
  },
  restoreCredentialsFile: async (file) => {
    const fd = new FormData()
    fd.append('file', file)
    const res = await fetch('/api/import-export/restore/credentials-file', { method: 'POST', body: fd })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }))
      const error = new Error(err.detail || 'Request failed')
      error.status = res.status
      throw error
    }
    signalDataMutated()
    return res.json()
  },
}
