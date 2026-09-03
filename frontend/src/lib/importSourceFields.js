// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// The single seam for the import-source detail we capture per transaction. It turns a transaction
// row into an ordered list of populated "origin" fields, resolving each value from either a
// first-class column (raw_name, imported_category, the source file) or a path into the captured
// `import_evidence_json` object — including the dynamic, source-specific `extra_text_fields` bag
// (e.g. an "Original Statement" column), whose label is the file's own header.
//
// This is deliberately dynamic-aware so source-specific columns surface without being hardcoded.
// Consumers (the transaction detail Origin block, the merchant origin hover, and the rule editor's
// source panel) all read from here rather than re-parsing the evidence themselves.
// See docs/ui-patterns.md → Row-level metadata, and docs/data-model.md → import_evidence_json.
//
// Row shape: { key, label, value, scope, always?, suffix?, note?, href? }
//   scope  — 'name' (identity), 'text' (source free text), 'meta' (file / provenance)
//   always — shown without an expand toggle (the identity + raw rows)
//   suffix — muted trailing detail on the same line (e.g. "imported 2026-06-21 19:21")
//   note   — a standalone muted line with no "label:" prefix (the cleared-category notice)
//   href   — makes the row followable; only ever a scheme-checked http(s) URL (see safeExternalUrl)

import { safeExternalUrl } from './utils.js'

const CATEGORIZED_BY_LABEL = {
  rule: 'a categorization rule',
  import: 'category present in the source data',
  manual: 'manual edit',
}

// Display names for data-connection providers. A synced batch's `import_batch_provider` is the raw
// provider key (e.g. 'plaid'); this renders it for the origin hover / group header so a user can tie a
// transaction back to which connection it came from. Unknown keys fall back to a capitalized form.
const PROVIDER_LABELS = { plaid: 'Plaid', simplefin: 'SimpleFIN' }

export function providerLabel(provider) {
  const key = String(provider || '').toLowerCase()
  if (PROVIDER_LABELS[key]) return PROVIDER_LABELS[key]
  return key ? key[0].toUpperCase() + key.slice(1) : ''
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
    // Labeled "Source" (not "Source file") because a data-connection batch isn't a file. For a synced
    // batch the provider is surfaced as its own row below so two same-institution connections stay
    // distinguishable from the hover alone (the group header carries the same provider cue).
    rows.push({
      key: 'source_file',
      label: 'Source',
      value: txn.import_batch_filename,
      suffix: importedAt ? `imported ${importedAt}` : null,
      scope: 'meta',
    })
    if (txn.import_batch_provider) {
      rows.push({
        key: 'connection',
        label: 'Connection',
        value: providerLabel(txn.import_batch_provider),
        scope: 'meta',
      })
    }
  } else {
    rows.push({ key: 'source_file', label: 'Source', value: '— (not from an import)', scope: 'meta' })
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
    // A deep link back to the source record's own page (an Amazon order, …). `href` marks the row as
    // followable so renderers can make it a real link; the value stays readable text for the rest.
    // Scheme-checked because the value came out of an imported file — see safeExternalUrl.
    const sourceHref = safeExternalUrl(evidence.source_url)
    if (sourceHref) {
      rows.push({
        key: 'source_url',
        label: 'Order page',
        value: 'View on Amazon',
        href: sourceHref,
        scope: 'meta',
      })
    }
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

// The subset relevant to a rule's source text: the free text the visible merchant doesn't show, plus
// the originating file. Used by the rule-building surfaces (the RuleForm source panel, the
// matching-transactions report), which care about the text a rule matches on, not how a row was
// categorized. The visible-merchant title is rendered separately, and placeholder dashes (no raw text,
// not from an import) are dropped so the card stays meaningful.
export function getTxnMerchantOriginRows(txn) {
  return getTxnOriginRows(txn).filter(row => {
    if (row.key === 'visible_merchant' || row.note) return false
    if (!(row.scope === 'name' || row.scope === 'text' || row.key === 'source_file')) return false
    const value = String(row.value || '').trim()
    return value && value !== '—' && !value.startsWith('—')
  })
}

// The from-the-file facts for the transaction-row merchant hover: every populated origin row EXCEPT the
// visible-merchant title (the hover renders it as the heading) and the *derived* categorization
// provenance — the "Categorized by" line and the cleared-category note, which describe how the row was
// categorized rather than what the file carried and stay on the edit panel's Origin block. This is
// deliberately broader than getTxnMerchantOriginRows: it also surfaces the imported category and source
// account label, so the hover shows everything "Show more" does without a trip to the edit page.
export function getTxnFileOriginRows(txn) {
  return getTxnOriginRows(txn).filter(row => {
    if (row.key === 'visible_merchant' || row.key === 'categorized_by' || row.note) return false
    const value = String(row.value || '').trim()
    return value && value !== '—' && !value.startsWith('—')
  })
}

// Whether a row carries any rule-relevant source text/file detail (rule surfaces' has-check for the
// getTxnMerchantOriginRows subset).
export function hasMerchantOriginDetail(txn) {
  return getTxnMerchantOriginRows(txn).length > 0
}

// Whether a merchant hover card would carry any from-the-file detail beyond the visible name — used to
// decide whether to attach the hover at all (a bare, untruncated, non-imported name needs no popover).
export function hasFileOriginDetail(txn) {
  return getTxnFileOriginRows(txn).length > 0
}
