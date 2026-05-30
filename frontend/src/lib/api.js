// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: GPL-3.0-or-later

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

async function request(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      // Preference profile selection is app-wide context, so the header is injected here instead of threaded through every call site.
      ...(localPreferenceProfileId ? { 'X-Fintrack-Preference-Profile': localPreferenceProfileId } : {}),
      ...options.headers,
    },
    ...options,
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }))
    const error = new Error(err.detail || 'Request failed')
    error.status = res.status
    throw error
  }
  return res.json()
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
  getGroupTotals: (month, account_id, date_start, date_end, owner_ids, category_owner_ids, tag_ids) => {
    const p = {
      ...(month               ? { month }               : {}),
      ...(date_start          ? { date_start }          : {}),
      ...(date_end            ? { date_end }            : {}),
      ...(account_id          ? { account_id }          : {}),
      ...(owner_ids           ? { owner_ids }           : {}),
      ...(category_owner_ids  ? { category_owner_ids }  : {}),
      ...(tag_ids             ? { tag_ids }             : {}),
    }
    return request(`/transactions/summary/by-group?${new URLSearchParams(p)}`)
  },
  getCategoryTotalsInGroup: (month, group_id, account_id, date_start, date_end, owner_ids, tag_ids) => {
    const p = {
      group_id,
      ...(month      ? { month }      : {}),
      ...(date_start ? { date_start } : {}),
      ...(date_end   ? { date_end }   : {}),
      ...(account_id ? { account_id } : {}),
      ...(owner_ids  ? { owner_ids }  : {}),
      ...(tag_ids    ? { tag_ids }    : {}),
    }
    return request(`/transactions/summary/by-category-in-group?${new URLSearchParams(p)}`)
  },
  getCategoryTotals: (month, account_id, date_start, date_end, owner_ids, category_owner_ids, tag_ids, exclude_income, exclude_expense) => {
    const p = {
      ...(month        ? { month }        : {}),
      ...(date_start   ? { date_start }   : {}),
      ...(date_end     ? { date_end }     : {}),
      ...(account_id   ? { account_id }   : {}),
      ...(owner_ids    ? { owner_ids }    : {}),
      ...(category_owner_ids ? { category_owner_ids } : {}),
      ...(tag_ids      ? { tag_ids }      : {}),
      ...(exclude_income ? { exclude_income: 'true' } : {}),
      ...(exclude_expense ? { exclude_expense: 'true' } : {}),
    }
    return request(`/transactions/summary/by-category?${new URLSearchParams(p)}`)
  },
  getMonthlyByGroup: (months = 24, account_id, group_id, tag_ids) => {
    const q = new URLSearchParams({
      months,
      ...(account_id ? { account_id } : {}),
      ...(group_id   ? { group_id }   : {}),
      ...(tag_ids    ? { tag_ids }    : {}),
    })
    return request(`/transactions/summary/monthly-by-group?${q}`)
  },
  getPayeeTrend: (payee, date_start, date_end, tag_ids) => {
    const q = new URLSearchParams({ payee, ...(date_start ? { date_start } : {}), ...(date_end ? { date_end } : {}), ...(tag_ids ? { tag_ids } : {}) })
    return request(`/transactions/summary/monthly-trend?${q}`)
  },
  getMonthlyTrend: (months = 6, category_id, account_id, date_start, date_end, tag_ids, view) => {
    const q = new URLSearchParams({
      months,
      ...(category_id ? { category_id } : {}),
      ...(account_id ? { account_id } : {}),
      ...(date_start ? { date_start } : {}),
      ...(date_end ? { date_end } : {}),
      ...(tag_ids ? { tag_ids } : {}),
      ...(view ? { view } : {}),
    })
    return request(`/transactions/summary/monthly-trend?${q}`)
  },
  overrideCategory: (txnId, category_id, notes) =>
    request(`/transactions/${txnId}/category`, {
      method: 'PATCH',
      body: JSON.stringify({ category_id, notes }),
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
  getCategoryDeletePreview: (id) => request(`/categories/${id}/delete-preview`),
  deleteCategory: (id, data = {}) => request(`/categories/${id}`, { method: 'DELETE', body: JSON.stringify(data) }),
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
  getTrashedTransactions: ()        => request('/transactions/trash'),
  emptyTransactionTrash: ()         => request('/transactions/trash/empty',     { method: 'POST'   }),
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
  createRule: (data) => request('/rules', { method: 'POST', body: JSON.stringify(data) }),
  updateRule: (id, data) => request(`/rules/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  applyRule: (id) => request(`/rules/${id}/apply`, { method: 'POST' }),
  deleteRule: (id) => request(`/rules/${id}`, { method: 'DELETE' }),

  runSync: (days = 30) => request(`/sync?days=${days}`, { method: 'POST' }),
  recategorize: () => request('/sync/recategorize', { method: 'POST' }),
  getRecategorizePreview: () => request('/sync/recategorize-preview'),

  getTasks:    () => request('/tasks'),
  getOwners:   () => request('/owners'),
  createOwner: (data) => request('/owners', { method: 'POST', body: JSON.stringify(data) }),
  updateOwner: (id, data) => request(`/owners/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteOwner: (id) => request(`/owners/${id}`, { method: 'DELETE' }),
  getTags:     () => request('/tags'),
  createTag:   (data) => request('/tags', { method: 'POST', body: JSON.stringify(data) }),
  updateTag:   (id, data) => request(`/tags/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteTag:   (id) => request(`/tags/${id}`, { method: 'DELETE' }),
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
        const error = new Error(err.detail || 'Request failed')
        error.status = res.status
        throw error
      }
      return res.json()
    })
  },
  listBatches:      ()      => request('/import-export/batches'),
  getBatchEdited:   (id)    => request(`/import-export/batches/${id}/edited`),
  getBatchDuplicates: (id)  => request(`/import-export/batches/${id}/duplicates`),
  getBatchDuplicatesUnified: (id) => request(`/import-export/batches/${id}/duplicates-unified`),
  getBatchCategoryMappings: (id) => request(`/import-export/batches/${id}/category-mappings`),
  getBatchRuleSuggestions: (id, ownerIds = []) => {
    const q = new URLSearchParams()
    if (ownerIds?.length) q.set('owner_ids', ownerIds.join(','))
    const suffix = q.toString() ? `?${q}` : ''
    return request(`/import-export/batches/${id}/rule-suggestions${suffix}`)
  },
  getSystemRuleSuggestions: (ownerIds = []) => {
    const q = new URLSearchParams()
    if (ownerIds?.length) q.set('owner_ids', ownerIds.join(','))
    const suffix = q.toString() ? `?${q}` : ''
    return request(`/import-export/rule-suggestions${suffix}`)
  },
  getProfileRuleSuggestions: (id, ownerIds = []) => {
    const q = new URLSearchParams()
    if (ownerIds?.length) q.set('owner_ids', ownerIds.join(','))
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
  updateSystemRuleSuggestionReview: (payload) =>
    request('/import-export/rule-suggestions/review', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  updateProfileRuleSuggestionReview: (id, payload) =>
    request(`/import-export/profiles/${id}/rule-suggestions/review`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  applyBatchCategoryMappings: (id, assignments) =>
    request(`/import-export/batches/${id}/category-mappings`, { method: 'POST', body: JSON.stringify({ assignments }) }),
  saveBatchCategoryWorkspaceDraft: (id, draft) =>
    request(`/import-export/batches/${id}/category-workspace-draft`, { method: 'PATCH', body: JSON.stringify({ draft }) }),
  getBatchCategoryWorkspaceDraft: (id) =>
    request(`/import-export/batches/${id}/category-workspace-draft`),
  setBatchProfile: (id, profileId) =>
    request(`/import-export/batches/${id}/profile`, { method: 'PATCH', body: JSON.stringify({ profile_id: profileId }) }),
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
  restoreBackupFile: async (file, privateKeyFile = null, privateKeyPassphrase = '') => {
    const fd = new FormData()
    fd.append('file', file)
    if (privateKeyFile) fd.append('private_key_file', privateKeyFile)
    if (privateKeyPassphrase) fd.append('private_key_passphrase', privateKeyPassphrase)
    const res = await fetch('/api/import-export/restore-file', { method: 'POST', body: fd })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }))
      const error = new Error(err.detail || 'Request failed')
      error.status = res.status
      throw error
    }
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
    return res.json()
  },
}
