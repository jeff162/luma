// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// Turns a transaction (or a list of them) into a dense, decoration-free representation for sharing —
// e.g. pasting into an email to discuss a charge. One place owns the field/column set and the two
// serializations (plain text + HTML) so the copy dialog's on-screen preview and what lands on the
// clipboard never drift, and so the single-transaction view and the list view read consistently.
//
// A single transaction is a labeled record (every captured field, including the from-the-file origin
// detail); a list is a compact table of the standard ledger columns. The HTML form is a real
// <table>/<dl> so a rich-text target (Gmail, Outlook, a doc) receives clean structure, with the plain
// text as the fallback for plain editors.

import { formatDate } from './utils.js'
import { formatTransactionAmount } from './moneyDisplay.js'
import { getTxnMerchantLabel } from '../components/TransactionRow.jsx'
import { getTxnOriginRows } from './importSourceFields.js'
import { splitCategoryNames } from './splitRows.js'

// The most rows a list copy carries. A copy is for pasting a handful of transactions into an email or notes,
// and every row goes onto the clipboard twice (HTML and text); a surface holding a larger set offers it as
// a file download instead.
export const TRANSACTION_COPY_ROW_LIMIT = 500

function accountLabel(txn) {
  return `${txn.account_name || ''}${txn.account_mask ? ` ···${txn.account_mask}` : ''}`.trim()
}

// Ordered { label, value } records for one transaction: the ledger-visible fields first (what the
// person is talking about), then the captured from-the-file origin detail the edit panel's "Show more"
// reveals — so everything that otherwise had to be gathered by hand is in one block. A row with an
// empty value is dropped; the origin registry's standalone notices (row.note, e.g. "imported category
// cleared") come through as an unlabeled line.
export function getTransactionShareFields(txn) {
  if (!txn) return []
  const fields = []
  const push = (label, value) => {
    const text = value == null ? '' : String(value).trim()
    if (text) fields.push({ label, value: text })
  }

  push('Date', formatDate(txn.date))
  push('Amount', formatTransactionAmount(txn.amount))
  push('Merchant', getTxnMerchantLabel(txn))
  push('Account', accountLabel(txn))
  push('Category', splitCategoryNames(txn) || txn.category_name || 'Uncategorized')
  if (Array.isArray(txn.tags) && txn.tags.length) {
    push('Tags', txn.tags.map(tag => tag?.name).filter(Boolean).join(', '))
  }
  push('Notes', txn.notes)

  // Append the captured origin rows, skipping the visible merchant (already "Merchant" above). Suffix
  // detail (e.g. "imported 2026-06-21") folds onto the value in parentheses.
  for (const row of getTxnOriginRows(txn)) {
    if (row.key === 'visible_merchant') continue
    if (row.note) {
      fields.push({ label: '', value: row.note })
      continue
    }
    // A followable row's useful content is the URL itself — "View on Amazon" is link text, meaningless
    // once pasted into an email or notes.
    const value = row.href || row.value
    push(row.label, row.suffix ? `${value} (${row.suffix})` : value)
  }

  return fields
}

// The standard ledger columns for the list (table) view. Kept to the columns a shared report shows so
// the table stays narrow and email-pasteable, rather than every captured field.
export const TRANSACTION_SHARE_COLUMNS = [
  { key: 'date', label: 'Date', get: txn => formatDate(txn.date) },
  { key: 'merchant', label: 'Merchant', get: txn => getTxnMerchantLabel(txn) },
  { key: 'category', label: 'Category', get: txn => splitCategoryNames(txn) || txn.category_name || 'Uncategorized' },
  { key: 'account', label: 'Account', get: accountLabel },
  { key: 'amount', label: 'Amount', get: txn => formatTransactionAmount(txn.amount), align: 'right', numeric: true },
]

// Leading characters a spreadsheet reads as the start of a formula. Merchant names and the like are
// largely written by others, so a text cell starting with one is prefixed with `'` in the plain-text
// copy, which a spreadsheet takes as "this is text" (backup.py's CSV export does the same). A `numeric`
// column is left alone: a negative amount starts with `-` and has to stay a number.
const SPREADSHEET_FORMULA_START = /^[=+\-@\t\r]/

function spreadsheetSafe(text, col) {
  return !col.numeric && SPREADSHEET_FORMULA_START.test(text) ? `'${text}` : text
}

export function getTransactionListRows(rows) {
  return (rows || []).map(txn => TRANSACTION_SHARE_COLUMNS.map(col => col.get(txn) || ''))
}

function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

// --- plain-text serializations -------------------------------------------------------------------

export function buildSingleShareText(txn) {
  return getTransactionShareFields(txn)
    .map(field => (field.label ? `${field.label}: ${field.value}` : field.value))
    .join('\n')
}

// One CSV field: quoted only when it needs it — a field containing a comma, whitespace ("blank"), or a
// double-quote (category names like "Clothing, shoes, glasses, etc", account labels, most merchants),
// with any embedded double-quote doubled per RFC 4180. A bare token like an amount (-$17.99) stays
// unquoted. This also avoids the tab-stop padding of the old TSV, which made short cells look like they
// had trailing spaces when pasted into a plain-text target.
function csvField(value) {
  const text = String(value ?? '')
  return /[",\s]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function buildListShareText(rows) {
  return tableShareText(TRANSACTION_SHARE_COLUMNS, getTransactionListRows(rows))
}

// Any table as CSV: `columns` are `{ label, align, numeric }`, `rows` arrays of cell text in their order.
function tableShareText(columns, rows) {
  const header = columns.map(col => csvField(col.label)).join(',')
  const body = rows.map(cells => cells.map((cell, i) => csvField(spreadsheetSafe(cell, columns[i]))).join(','))
  return [header, ...body].join('\n')
}

// --- HTML serializations (for rich-text paste targets) --------------------------------------------

export function buildSingleShareHtml(txn) {
  const rows = getTransactionShareFields(txn).map(field => (
    field.label
      ? `<tr><td style="padding:2px 12px 2px 0;color:#666;vertical-align:top;white-space:nowrap">${escapeHtml(field.label)}</td><td style="padding:2px 0;vertical-align:top">${escapeHtml(field.value)}</td></tr>`
      : `<tr><td colspan="2" style="padding:2px 0;color:#666">${escapeHtml(field.value)}</td></tr>`
  )).join('')
  return `<table style="border-collapse:collapse;font-size:13px">${rows}</table>`
}

export function buildListShareHtml(rows) {
  return tableShareHtml(TRANSACTION_SHARE_COLUMNS, getTransactionListRows(rows))
}

function tableShareHtml(columns, rows) {
  const align = col => (col.align === 'right' ? 'right' : 'left')
  const head = columns
    .map(col => `<th style="text-align:${align(col)};padding:3px 10px;border-bottom:1px solid #ccc;color:#666">${escapeHtml(col.label)}</th>`)
    .join('')
  const body = rows.map(cells => (
    `<tr>${cells.map((cell, i) => `<td style="text-align:${align(columns[i])};padding:3px 10px;border-bottom:1px solid #eee">${escapeHtml(cell)}</td>`).join('')}</tr>`
  )).join('')
  return `<table style="border-collapse:collapse;font-size:13px"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`
}

// A table other than a transaction list, in both forms `copyShare` writes, made the way a list's are.
export function buildTableShare(columns, rows) {
  return { text: tableShareText(columns, rows), html: tableShareHtml(columns, rows) }
}

// Last-resort clipboard copy for insecure contexts (plain HTTP on a non-localhost host — the common
// WSL2/LAN case), where `navigator.clipboard` isn't exposed at all. A temporary off-screen textarea +
// the legacy `execCommand('copy')` still works there. Plain-text only (execCommand can't reliably carry
// rich HTML), so a rich copy degrades to its plain-text flavor rather than failing outright.
function legacyCopyText(text) {
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    // Off-screen but still selectable — display:none / visibility:hidden would make the selection fail.
    ta.style.position = 'fixed'
    ta.style.top = '-9999px'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    ta.setSelectionRange(0, ta.value.length)
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

// Write both a rich-HTML and a plain-text flavor to the clipboard so a rich target (email, doc) gets the
// table/record and a plain editor gets readable text. Falls back to plain-only where the async
// ClipboardItem API isn't available. Returns true on success.
export async function copyShare({ text, html }) {
  try {
    if (navigator.clipboard && typeof window.ClipboardItem === 'function' && html) {
      const item = new window.ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([text], { type: 'text/plain' }),
      })
      await navigator.clipboard.write([item])
      return true
    }
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // The async API exists but threw (permissions, focus, …) — try its plain-text form before the
    // legacy fallback.
    try {
      await navigator.clipboard?.writeText?.(text)
      return true
    } catch {
      return legacyCopyText(text)
    }
  }
  // No async clipboard API at all (insecure context): the legacy textarea path is the only option.
  return legacyCopyText(text)
}
