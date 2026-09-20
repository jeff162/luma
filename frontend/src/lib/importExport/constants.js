// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// Shared constants for the Import / Export page and its extracted helpers and
// sub-components. These are the cross-cutting display options, preference keys,
// and imported-category vocabulary that must read identically across the page
// body, the pure helpers in this folder, and the presentational components.

export const AMOUNT_CONVENTIONS = [
  { value: 'single_signed', label: 'Single column — negative = debit (most banks)' },
  { value: 'single_unsigned', label: 'Single column + a debit/credit type column' },
  { value: 'two_column', label: 'Two columns — separate debit and credit' },
]
export const DATE_FORMATS = [
  { value: '%m/%d/%Y', label: 'MM/DD/YYYY  (e.g. 01/31/2024)' },
  { value: '%Y-%m-%d', label: 'YYYY-MM-DD  (e.g. 2024-01-31)' },
  { value: '%Y/%m/%d', label: 'YYYY/MM/DD  (e.g. 2024/01/31)' },
  { value: '%d/%m/%Y', label: 'DD/MM/YYYY  (e.g. 31/01/2024)' },
  { value: '%m-%d-%Y', label: 'MM-DD-YYYY  (e.g. 01-31-2024)' },
  { value: '%d-%m-%Y', label: 'DD-MM-YYYY  (e.g. 31-01-2024)' },
  { value: '%b %d, %Y', label: 'Mon DD, YYYY  (e.g. Jan 31, 2024)' },
  { value: '%b-%d-%Y', label: 'MMM-DD-YYYY  (e.g. Mar-23-2026)' },
]
export const EXPORT_COLUMNS = [
  { key: 'date', label: 'Date' },
  { key: 'merchant_name', label: 'Merchant' },
  { key: 'raw_name', label: 'Raw description' },
  { key: 'amount', label: 'Amount' },
  { key: 'account', label: 'Account' },
  { key: 'category', label: 'Category' },
  { key: 'group', label: 'Group' },
  { key: 'owner', label: 'Owner' },
  { key: 'notes', label: 'Notes' },
  { key: 'is_pending', label: 'Pending' },
  { key: 'overridden', label: 'Manually categorized' },
  { key: 'import_batch', label: 'Import batch ID' },
]
export const DEFAULT_EXPORT_COLS = ['date', 'merchant_name', 'amount', 'account', 'category']
export const IMPORT_CONFIG_MAX_WIDTH = 'min(900px, 100%)'
export const MANUAL_DATA_SOURCE_VALUE = '__skip_for_now__'
export const EXPANDED_IMPORT_SOURCE_ROWS_PREF_KEY = 'import.expandedDataSourceRows'
export const DATA_SOURCE_MANAGER_POS_PREF_KEY = 'import.dataSourceManagerPos'
export const AMAZON_IMPORT_ACCOUNT_PREF_KEY = 'import.amazonAccountId'
export const DUPLICATE_ROWS_COLUMNS_PREF_KEY = 'ui.import.duplicateRows.columns'
export const NOT_IMPORTED_ROWS_COLUMNS_PREF_KEY = 'ui.import.notImportedRows.columns'
// One key per MatchReport-hosted report: the three share a table shell but not a column set, so they
// each remember their own geometry.
export const DUPLICATE_REPORT_COLUMNS_PREF_KEY = 'ui.import.duplicateReport.columns'
export const AMAZON_RECONCILIATION_COLUMNS_PREF_KEY = 'ui.import.amazonReconciliation.columns'
export const PAYPAL_FUNDING_COLUMNS_PREF_KEY = 'ui.import.paypalFunding.columns'
export const AMAZON_IMPORT_DETAIL_COLUMNS_PREF_KEY = 'ui.import.amazonImportDetail.columns'
export const UNASSIGNED_CATEGORY_SYSTEM_KEY = 'unassigned'
export const IMPORTED_CATEGORY_SCOPE_ALL = 'all'
export const IMPORTED_CATEGORY_SCOPE_FILTERED = 'filtered'
export const IMPORTED_CATEGORY_SETTINGS_KEY = 'imported_category_settings'
export const FIXED_ACCOUNT_CATEGORY_SCOPE_TOKEN_PREFIX = 'account:'
export const NEW_ACCOUNT_CATEGORY_SCOPE_TOKEN_PREFIX = 'new-account:'
export const IMPORTED_CATEGORY_USAGE_SENTENCE = 'Import the transactions with their existing categories and use them to propose categorization rules.'
export const IMPORTED_CATEGORY_FILTER_PILL_LABEL = 'Filter by owner/account'
export const IMPORTED_CATEGORY_FILTER_DIALOG_TITLE = 'Which accounts have useful categories?'
export const IMPORTED_CATEGORY_FILTER_DIALOG_DESCRIPTION = "Only the checked accounts' categories are applied and used to propose rules — every transaction still imports either way."
export const IMPORTED_CATEGORY_SCOPE_ALL_LABEL = 'Include all categorized transactions from this data set'

// Shown on every import control disabled while demo data is loaded (the backend refuses those imports).
export const DEMO_IMPORT_DISABLED_MESSAGE = 'Demo Data Loaded: Imports are disabled'
