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
  push('Category', txn.category_name || 'Uncategorized')
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
    push(row.label, row.suffix ? `${row.value} (${row.suffix})` : row.value)
  }

  return fields
}

// The standard ledger columns for the list (table) view. Kept to the columns a shared report shows so
// the table stays narrow and email-pasteable, rather than every captured field.
export const TRANSACTION_SHARE_COLUMNS = [
  { key: 'date', label: 'Date', get: txn => formatDate(txn.date) },
  { key: 'merchant', label: 'Merchant', get: txn => getTxnMerchantLabel(txn) },
  { key: 'category', label: 'Category', get: txn => txn.category_name || 'Uncategorized' },
  { key: 'account', label: 'Account', get: accountLabel },
  { key: 'amount', label: 'Amount', get: txn => formatTransactionAmount(txn.amount), align: 'right' },
]

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

export function buildListShareText(rows) {
  const header = TRANSACTION_SHARE_COLUMNS.map(col => col.label).join('\t')
  const body = getTransactionListRows(rows).map(cells => cells.join('\t'))
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
  const head = TRANSACTION_SHARE_COLUMNS
    .map(col => `<th style="text-align:${col.align === 'right' ? 'right' : 'left'};padding:3px 10px;border-bottom:1px solid #ccc;color:#666">${escapeHtml(col.label)}</th>`)
    .join('')
  const body = getTransactionListRows(rows).map(cells => (
    `<tr>${cells.map((cell, i) => `<td style="text-align:${TRANSACTION_SHARE_COLUMNS[i].align === 'right' ? 'right' : 'left'};padding:3px 10px;border-bottom:1px solid #eee">${escapeHtml(cell)}</td>`).join('')}</tr>`
  )).join('')
  return `<table style="border-collapse:collapse;font-size:13px"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`
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
    // Fall through to the plain-text attempt below before giving up.
    try {
      await navigator.clipboard?.writeText?.(text)
      return true
    } catch {
      return false
    }
  }
  return false
}
