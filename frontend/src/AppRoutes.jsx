// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * The route table: which path renders which page.
 *
 * Every page is a lazy chunk (`lib/routeChunks.js` owns the loaders). Route-level splitting keeps the
 * shell responsive and avoids forcing every large screen into the initial bundle before the user ever
 * visits it, and the shell warms the same loaders when idle, so a page is usually resident by the time
 * it is clicked.
 *
 * Kept apart from the shell in `App.jsx` because the table is the app's navigation contract while the
 * shell is everything drawn around it. Separated, the contract can be mounted on its own — which is
 * what lets a test drive real navigation through the real routes without standing up the shell's
 * bootstrap, auth and preference state.
 */

import { lazy, Suspense } from 'react'
import { Routes, Route } from 'react-router-dom'

import {
  loadAccountsPage,
  loadCategoriesPage,
  loadDashboardPage,
  loadHelpPage,
  loadImportExportPage,
  loadImportRuleSuggestionsPage,
  loadRecurringPage,
  loadRulesPage,
  loadSettingsPage,
  loadTasksPage,
  loadTransactionsPage,
} from './lib/routeChunks.js'

const Dashboard = lazy(loadDashboardPage)
const Transactions = lazy(loadTransactionsPage)
const Categories = lazy(loadCategoriesPage)
const Rules = lazy(loadRulesPage)
const Accounts = lazy(loadAccountsPage)
const Settings = lazy(loadSettingsPage)
const ImportExport = lazy(loadImportExportPage)
const ImportRuleSuggestions = lazy(loadImportRuleSuggestionsPage)
const Tasks = lazy(loadTasksPage)
const Recurring = lazy(loadRecurringPage)
const Help = lazy(loadHelpPage)

export function RouteLoadingFallback() {
  return (
    <div style={{
      minHeight: '100%',
      display: 'grid',
      placeItems: 'center',
      padding: 24,
    }}>
      <div style={{ fontSize: 14, color: 'var(--muted)' }}>Loading page...</div>
    </div>
  )
}

export default function AppRoutes() {
  return (
    <Suspense fallback={<RouteLoadingFallback />}>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/transactions" element={<Transactions />} />
        <Route path="/categories" element={<Categories />} />
        <Route path="/rules" element={<Rules />} />
        <Route path="/accounts" element={<Accounts />} />
        <Route path="/import-export/rule-suggestions" element={<ImportRuleSuggestions />} />
        <Route path="/import-export/batches/:batchId/rule-suggestions" element={<ImportRuleSuggestions />} />
        <Route path="/import-export/profiles/:profileId/rule-suggestions" element={<ImportRuleSuggestions />} />
        <Route path="/import-export" element={<ImportExport />} />
        <Route path="/tasks" element={<Tasks />} />
        <Route path="/recurring" element={<Recurring />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/help" element={<Help />} />
        <Route path="/help/:topic" element={<Help />} />
      </Routes>
    </Suspense>
  )
}
