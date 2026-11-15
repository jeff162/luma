// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// Shared constants for the Import page and its extracted helpers and
// sub-components. These are the cross-cutting display options, preference keys,
// and imported-category vocabulary that must read identically across the page
// body, the pure helpers in this folder, and the presentational components.

export const AMOUNT_CONVENTIONS = [
  { value: 'single_signed', label: 'Single column — negative = debit (most banks)' },
  { value: 'single_unsigned', label: 'Single column + a debit/credit type column' },
  { value: 'two_column', label: 'Two columns — separate debit and credit' },
]
// How a file writes a number. The import reads strictly in the chosen one and refuses a cell malformed in
// it, so picking wrong shows as unparseable amounts rather than wrong ones.
export const DECIMAL_SEPARATORS = [
  { value: 'point', label: 'Point  (e.g. 1,234.56)' },
  { value: 'comma', label: 'Comma  (e.g. 1.234,56)' },
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
export const AMAZON_IMPORT_ACCOUNT_PREF_KEY = 'import.amazonAccountId'
export const NOT_IMPORTED_ROWS_COLUMNS_PREF_KEY = 'ui.import.notImportedRows.columns'
// One key per MatchReport-hosted report: the three share a table shell but not a column set, so they
// each remember their own geometry.
export const DUPLICATE_REPORT_COLUMNS_PREF_KEY = 'ui.import.duplicateReport.columns'
export const AMAZON_RECONCILIATION_COLUMNS_PREF_KEY = 'ui.import.amazonReconciliation.columns'
export const WALLET_PAIR_COLUMNS_PREF_KEY = 'ui.import.walletPairs.columns'
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

// The File Sources list's row geometry, shared by the CSV data-source rows and the marketplace ones.
//
// **The action column is a fixed width, not `auto`.** Each row is its own grid, so with an `auto` end
// track the two metadata columns sat wherever that row's buttons left them — a row carrying one extra
// button (PayPal's transfer review) pushed its own Last used and Imported out of line with every other
// row's. Fixing the track makes the four columns agree by construction, and means a row gaining a
// button cannot knock the list crooked again. Any control too wide for it goes on a line of its own
// beneath, rather than widening the column for everybody.
export const SOURCE_ROW_ACTIONS_WIDTH = 184
export const SOURCE_ROW_GRID_COLUMNS = `minmax(0, 1fr) 170px 170px ${SOURCE_ROW_ACTIONS_WIDTH}px`
// Below this the four columns stop fitting, so the list keeps its width and its card scrolls sideways
// rather than re-flowing into something unreadable. iPad is the narrowest device aimed at, and this
// leaves the name column usable there.
export const SOURCE_LIST_MIN_WIDTH = 820

// A single-line cell that truncates rather than wraps. Long values (a source name, a watched path)
// carry the full text in a `title`, which is what keeps a narrow window legible instead of ragged.
export const TRUNCATED_CELL_STYLE = {
  minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
}

// Shown on every import control disabled while demo data is loaded (the backend refuses those imports).
export const DEMO_IMPORT_DISABLED_MESSAGE = 'Demo Data Loaded: Imports are disabled'

// How a card the Import History has landed on is marked, shared by both card surfaces. The scroll margin
// is where a landing comes to rest: the history sets `--pinned-height` to the height of the block pinned
// above its list when it scrolls a card into view.
export const LANDING_SCROLL_MARGIN = 'calc(var(--pinned-height, 0px) + 8px)'
export const FOCUSED_CARD_STYLE = {
  boxShadow: 'inset 3px 0 0 var(--accent)',
  background: 'color-mix(in srgb, var(--accent) 7%, transparent)',
  scrollMarginTop: LANDING_SCROLL_MARGIN,
}
