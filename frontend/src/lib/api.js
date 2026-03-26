/**
 * api.js — All API calls to the FastAPI backend
 *
 * PATTERN:
 *   All calls go through request(path, options), which prepends '/api' and
 *   parses JSON. Errors are thrown so callers can catch them if needed,
 *   but most call sites are fire-and-forget (.then() only, no catch).
 *
 * PARAM BUILDING:
 *   For GET requests with optional filters, params are built as URLSearchParams
 *   and appended to the path. Undefined/null values are omitted by spreading
 *   with conditional keys:
 *     { ...(value ? { key: value } : {}) }
 *   This keeps query strings clean (no "key=undefined" noise).
 *
 * MULTI-VALUE PARAMS:
 *   Some endpoints accept multiple values for a single filter:
 *     account_ids  — comma-separated:  '123,456'
 *     group_ids    — comma-separated:  '789,012'
 *     payees       — pipe-separated:   'Starbucks|Peet Coffee'
 *   Pipe is used for payees because names can contain commas.
 *
 * OPTIMISTIC UI:
 *   Category and merchant edits call the API without awaiting in the parent
 *   component — the UI updates immediately via local state. If the server
 *   fails, the data will be stale until next page load. Acceptable for a
 *   local self-hosted app; add error handling + rollback if needed.
 *
 * ADDING NEW ENDPOINTS:
 *   Add a method here following the existing pattern. For list endpoints
 *   with optional filters, use the URLSearchParams pattern above.
 *   For mutations, use { method: 'POST'/'PATCH'/'DELETE', body: JSON.stringify(data) }.
 */

/**
 * api.js — All API calls to the FastAPI backend.
 *
 * DESIGN PRINCIPLES:
 * - All requests go through the request() helper which prepends /api and
 *   handles JSON parsing. Never call fetch() directly in components.
 * - Multi-value filter params (account_ids, group_ids, category_ids) are
 *   passed as comma-separated strings. Payees use pipe-separated (|) because
 *   payee names can contain commas.
 * - Summary endpoints accept either a `month` (YYYY-MM) or `date_start`/
 *   `date_end` pair. Pass null/undefined for month to get all-time data.
 * - When adding a new endpoint: add it here first, then add the backend route,
 *   then call it from the component. Keep the frontend and backend param names
 *   in sync to make debugging easier.
 */

const BASE = '/api'

async function request(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
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
  // Auth
  getAuthStatus: () => request('/auth/status'),
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
  startTwoFactorSetup: () => request('/auth/2fa/setup', { method: 'POST' }),
  confirmTwoFactorSetup: (secret, code) =>
    request('/auth/2fa/confirm', { method: 'POST', body: JSON.stringify({ secret, code }) }),
  disableTwoFactor: (code) =>
    request('/auth/2fa/disable', { method: 'POST', body: JSON.stringify({ code }) }),
  regenerateRecoveryCodes: (code) =>
    request('/auth/2fa/recovery-codes', { method: 'POST', body: JSON.stringify({ code }) }),
  setPrivacyMode: (privacy_mode) =>
    request('/auth/privacy-mode', { method: 'POST', body: JSON.stringify({ privacy_mode }) }),

  // Transactions
  getTransactions: (params = {}) => {
    const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null))
    return request(`/transactions?${q}`)
  },
  getGroupTotals: (month, account_id, date_start, date_end, owner_ids, category_owner_ids) => {
    const p = {
      ...(month               ? { month }               : {}),
      ...(date_start          ? { date_start }          : {}),
      ...(date_end            ? { date_end }            : {}),
      ...(account_id          ? { account_id }          : {}),
      ...(owner_ids           ? { owner_ids }           : {}),
      ...(category_owner_ids  ? { category_owner_ids }  : {}),
    }
    return request(`/transactions/summary/by-group?${new URLSearchParams(p)}`)
  },
  getCategoryTotalsInGroup: (month, group_id, account_id, date_start, date_end, owner_ids) => {
    const p = {
      group_id,
      ...(month      ? { month }      : {}),
      ...(date_start ? { date_start } : {}),
      ...(date_end   ? { date_end }   : {}),
      ...(account_id ? { account_id } : {}),
      ...(owner_ids  ? { owner_ids }  : {}),
    }
    return request(`/transactions/summary/by-category-in-group?${new URLSearchParams(p)}`)
  },
  getCategoryTotals: (month, account_id) => {
    const q = new URLSearchParams({ month, ...(account_id ? { account_id } : {}) })
    return request(`/transactions/summary/by-category?${q}`)
  },
  getMonthlyByGroup: (months = 24, account_id, group_id) => {
    const q = new URLSearchParams({
      months,
      ...(account_id ? { account_id } : {}),
      ...(group_id   ? { group_id }   : {}),
    })
    return request(`/transactions/summary/monthly-by-group?${q}`)
  },
  getPayeeTrend: (payee, date_start, date_end) => {
    const q = new URLSearchParams({ payee, ...(date_start ? { date_start } : {}), ...(date_end ? { date_end } : {}) })
    return request(`/transactions/summary/monthly-trend?${q}`)
  },
  getMonthlyTrend: (months = 6, category_id) => {
    const q = new URLSearchParams({ months, ...(category_id ? { category_id } : {}) })
    return request(`/transactions/summary/monthly-trend?${q}`)
  },
  overrideCategory: (txnId, category_id, notes) =>
    request(`/transactions/${txnId}/category`, {
      method: 'PATCH',
      body: JSON.stringify({ category_id, notes }),
    }),

  // Accounts
  getAccounts: () => request('/accounts'),
  deleteAccount: (id) => request(`/accounts/${id}`, { method: 'DELETE' }),

  // Categories
  getCategoryTree: () => request('/categories'),
  getCategories: () => request('/categories/flat'),
  createCategory: (data) => request('/categories', { method: 'POST', body: JSON.stringify(data) }),
  deleteCategory: (id) => request(`/categories/${id}`, { method: 'DELETE' }),
  updateCategory: (id, data) =>
    request(`/categories/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),

  deleteRule: (ruleId) => request(`/categories/rules/${ruleId}`, { method: 'DELETE' }),

  // Plaid
  getLinkToken: () => request('/plaid/link-token'),
  exchangeToken: (public_token, institution_name) =>
    request('/plaid/exchange', {
      method: 'POST',
      body: JSON.stringify({ public_token, institution_name }),
    }),

  updateMerchant:      (id, name)   => request(`/transactions/${id}/merchant`, { method: 'PATCH', body: JSON.stringify({ merchant_name: name }) }),
  updateNotes:         (id, notes)  => request(`/transactions/${id}/notes`,    { method: 'PATCH', body: JSON.stringify({ notes }) }),

  // Rules
  getRules: (search) => {
    const q = search ? '?' + new URLSearchParams({ search }) : ''
    return request(`/rules${q}`)
  },
  createRule: (data) => request('/rules', { method: 'POST', body: JSON.stringify(data) }),
  updateRule: (id, data) => request(`/rules/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteRule: (id) => request(`/rules/${id}`, { method: 'DELETE' }),

  // Sync
  runSync: (days = 30) => request(`/sync?days=${days}`, { method: 'POST' }),
  recategorize: () => request('/sync/recategorize', { method: 'POST' }),

  // Owners
  getTasks:    () => request('/tasks'),
  getOwners:   () => request('/owners'),
  createOwner: (data) => request('/owners', { method: 'POST', body: JSON.stringify(data) }),
  updateOwner: (id, data) => request(`/owners/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteOwner: (id) => request(`/owners/${id}`, { method: 'DELETE' }),
  getOwnerSummary: (params = {}) => {
    const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null))
    return request(`/owners/summary?${q}`)
  },
  updateAccount: (id, data) => request(`/accounts/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),

  // Import / Export
  previewCsv: (file) => {
    const fd = new FormData(); fd.append('file', file)
    return fetch('/api/import-export/preview', { method: 'POST', body: fd }).then(r => r.json())
  },
  runImport: (file, config) => {
    const fd = new FormData()
    fd.append('file', file)
    fd.append('config', JSON.stringify(config))
    return fetch('/api/import-export/run', { method: 'POST', body: fd }).then(r => r.json())
  },
  listBatches:      ()      => request('/import-export/batches'),
  getBatchEdited:   (id)    => request(`/import-export/batches/${id}/edited`),
  undoBatch:        (id, force = false) =>
    request(`/import-export/batches/${id}${force ? '?force=true' : ''}`, { method: 'DELETE' }),
  getImportProfiles:    ()      => request('/import-export/profiles'),
  createImportProfile:  (data)  => request('/import-export/profiles', { method: 'POST', body: JSON.stringify(data) }),
  updateImportProfile:  (id, data) => request(`/import-export/profiles/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteImportProfile:  (id)    => request(`/import-export/profiles/${id}`, { method: 'DELETE' }),
  exportTransactionsCsv: (params = {}) => {
    const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null))
    return `/api/import-export/transactions.csv?${q}`  // returns URL for direct download
  },
  exportBackup:      ()  => '/api/import-export/backup',
  exportCredentials: ()  => '/api/import-export/backup/credentials',
  restoreBackup:     (data, includeTransactions = true) =>
    request('/import-export/restore', { method: 'POST', body: JSON.stringify({ data, include_transactions: includeTransactions }) }),
  restoreCredentials: (data) =>
    request('/import-export/restore/credentials', { method: 'POST', body: JSON.stringify({ data }) }),
}
