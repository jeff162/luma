// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { amazonReconciliation } from './amazonReconciliation.jsx'
import { walletReconciliation } from './walletReconciliation.jsx'

// The presentation half of each reconciliation report, keyed like RECONCILIATION_REPORTS
// (lib/reconciliationReports.js). The contract a vendor fills is described on ReconciliationReportDialog.
export const RECONCILIATION_VENDORS = {
  amazon: amazonReconciliation,
  wallet: walletReconciliation,
}
