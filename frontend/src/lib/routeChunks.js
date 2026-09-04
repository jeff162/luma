// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * Lazy chunk loaders for the route table, and the set the shell warms up when idle.
 *
 * Route chunks come from the same server as the data, and the browser's module loader is not something
 * `lib/api.js` can see — so without `routeChunk` a stopped backend breaks every not-yet-loaded page
 * with the liveness watch none the wiser. The failure is reported and re-thrown unchanged: `lazy()`
 * still needs the rejection, and the prefetcher still discards it.
 */

import { noteRequestFailure } from './backendLiveness.js'

function routeChunk(load) {
  return () => load().catch(error => {
    noteRequestFailure(error)
    throw error
  })
}

export const loadDashboardPage = routeChunk(() => import('../pages/Dashboard.jsx'))
export const loadTransactionsPage = routeChunk(() => import('../pages/Transactions.jsx'))
export const loadCategoriesPage = routeChunk(() => import('../pages/Categories.jsx'))
export const loadRulesPage = routeChunk(() => import('../pages/Rules.jsx'))
export const loadAccountsPage = routeChunk(() => import('../pages/Accounts.jsx'))
export const loadSettingsPage = routeChunk(() => import('../pages/Settings.jsx'))
export const loadImportExportPage = routeChunk(() => import('../pages/ImportExport.jsx'))
export const loadImportRuleSuggestionsPage = routeChunk(() => import('../pages/ImportRuleSuggestions.jsx'))
export const loadTasksPage = routeChunk(() => import('../pages/Tasks.jsx'))
export const loadRecurringPage = routeChunk(() => import('../pages/Recurring.jsx'))
export const loadHelpPage = routeChunk(() => import('../pages/Help.jsx'))

export const ROUTE_PREFETCHERS = [
  loadDashboardPage,
  loadTransactionsPage,
  loadCategoriesPage,
  loadRulesPage,
  loadAccountsPage,
  loadSettingsPage,
  loadImportExportPage,
  loadImportRuleSuggestionsPage,
  loadTasksPage,
  loadRecurringPage,
  loadHelpPage,
]
