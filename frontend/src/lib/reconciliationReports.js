// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { api } from './api.js'

// The reconciliation reports the app can open, keyed by vendor: what the app-level viewer needs before the
// report's own code has loaded — how to fetch it, what to call it (from what it loaded, when it has), and
// how many rows the minimized nav pill should flag. The presentation half (buckets, columns, actions) is loaded with the dialog; see
// components/importExport/reconciliation/reconciliationVendors.js.
export const RECONCILIATION_REPORTS = {
  amazon: {
    title: () => 'Amazon reconciliation',
    load: ({ batchId }) => api.getAmazonReconciliation(batchId),
    problemCount: data => (data?.duplicate?.length || 0) + (data?.amazon_unmatched?.length || 0),
  },
  // Opened for one wallet account (from its Tasks entry) it covers that account's whole history, since
  // matches are made after syncs as well as imports; opened for an import, that import's rows. Named for the
  // wallets it covers, which is one unless a sync brought in several.
  wallet: {
    title: data => (data?.wallet_names?.length ? `${data.wallet_names.join(', ')} reconciliation` : 'Reconciliation'),
    load: ({ batchId, walletId }) => api.getWalletPairReport({ batchId, walletId }),
    problemCount: data => (data?.choice?.length || 0)
      + (data?.unmatched || []).filter(r => !r.reviewed).length
      + (data?.unaccounted || []).filter(r => !r.reviewed).length,
  },
}
