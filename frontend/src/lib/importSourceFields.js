// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// The single seam for the import-source detail we capture per transaction. It turns a transaction
// row into an ordered list of populated "origin" fields, resolving each value from either a
// first-class column (raw_name, imported_category, the source file) or a path into the captured
// `import_evidence_json` object — including the dynamic, source-specific `extra_text_fields` bag
// (e.g. an "Original Statement" column), whose label is the file's own header.
//
// This is deliberately dynamic-aware so source-specific columns surface without being hardcoded.
// Consumers (the transaction detail Origin block, the merchant origin hover, and — later — rule
// matching on source text or selectable report columns) all read from here rather than re-parsing
// the evidence themselves. See docs/import-source-fields-plan.md.
//
// Row shape: { key, label, value, scope, always?, suffix?, note? }
//   scope  — 'name' (identity), 'text' (source free text), 'meta' (file / provenance)
//   always — shown without an expand toggle (the identity + raw rows)
//   suffix — muted trailing detail on the same line (e.g. "imported 2026-06-21 19:21")
//   note   — a standalone muted line with no "label:" prefix (the cleared-category notice)

const CATEGORIZED_BY_LABEL = {
  rule: 'a categorization rule',
  import: 'category present in the source data',
  manual: 'manual edit',
}

export function parseImportEvidence(txn) {
  if (!txn?.import_evidence_json) return null
  try {
    return JSON.parse(txn.import_evidence_json)
  } catch {
    return null
  }
}

function visibleMerchant(txn) {
  return txn.display_name || txn.merchant_name || txn.raw_name || '—'
}

function importedMerchant(txn) {
  return txn.merchant_name || txn.raw_name || txn.display_name || '—'
}

// Ordered, populated origin rows for a transaction. Empty/absent values are omitted so a consumer
// can render the list as-is. Mirrors the field set the transaction detail panel has always shown.
export function getTxnOriginRows(txn) {
  if (!txn) return []
  const rows = []

  const imported = importedMerchant(txn)
  const renamed = Boolean(txn.display_name && txn.display_name !== imported)

  rows.push({ key: 'visible_merchant', label: 'Visible merchant', value: visibleMerchant(txn), scope: 'name', always: true })
  if (renamed) {
    rows.push({ key: 'imported_merchant', label: 'Imported merchant', value: txn.merchant_name || '—', scope: 'name', always: true })
  }
  rows.push({ key: 'raw', label: 'Raw source text', value: txn.raw_name || '—', scope: 'text', always: true })

  if (txn.import_batch_filename) {
    const importedAt = txn.import_batch_imported_at
      ? String(txn.import_batch_imported_at).slice(0, 16).replace('T', ' ')
      : null
    rows.push({
      key: 'source_file',
      label: 'Source file',
      value: txn.import_batch_filename,
      suffix: importedAt ? `imported ${importedAt}` : null,
      scope: 'meta',
    })
  } else {
    rows.push({ key: 'source_file', label: 'Source file', value: '— (not from an import)', scope: 'meta' })
  }

  if (txn.imported_category) {
    rows.push({ key: 'imported_category', label: 'Imported category', value: txn.imported_category, scope: 'meta' })
  }

  const evidence = parseImportEvidence(txn)
  if (evidence) {
    if (evidence.account?.value) {
      rows.push({
        key: 'source_account',
        label: `Source account label (${evidence.account.header || 'Account'})`,
        value: evidence.account.value,
        scope: 'meta',
      })
    }
    // The normalized description slot is only worth showing when it differs from the raw name we
    // already render above (otherwise it is a duplicate line).
    if (evidence.description?.value && evidence.description.value !== txn.raw_name) {
      rows.push({
        key: 'source_description',
        label: `Source description (${evidence.description.header || 'Description'})`,
        value: evidence.description.value,
        scope: 'text',
      })
    }
    const extras = Array.isArray(evidence.extra_text_fields) ? evidence.extra_text_fields : []
    extras.forEach((field, idx) => {
      if (field?.value) {
        rows.push({ key: `extra_${idx}`, label: field.header || 'Other', value: field.value, scope: 'text' })
      }
    })
  }

  if (txn.category_source === 'cleared') {
    rows.push({ key: 'categorized_by', note: 'Imported category cleared — rules can re-categorize it.', scope: 'meta' })
  } else if (txn.category_source) {
    rows.push({
      key: 'categorized_by',
      label: 'Categorized by',
      value: CATEGORIZED_BY_LABEL[txn.category_source] || txn.category_source,
      scope: 'meta',
    })
  }

  return rows
}

// The subset relevant to a merchant-name hover: the source free text the visible merchant doesn't
// show, plus the originating file. The visible-merchant title is rendered separately by the hover,
// and placeholder dashes (no raw text, not from an import) are dropped so the card stays meaningful.
export function getTxnMerchantOriginRows(txn) {
  return getTxnOriginRows(txn).filter(row => {
    if (row.key === 'visible_merchant' || row.note) return false
    if (!(row.scope === 'name' || row.scope === 'text' || row.key === 'source_file')) return false
    const value = String(row.value || '').trim()
    return value && value !== '—' && !value.startsWith('—')
  })
}

// Whether a merchant hover card would carry anything beyond the visible name — used to decide whether
// to attach the hover at all (a bare, untruncated, non-imported name needs no popover).
export function hasMerchantOriginDetail(txn) {
  return getTxnMerchantOriginRows(txn).length > 0
}
