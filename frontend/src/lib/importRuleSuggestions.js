// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: GPL-3.0-or-later

// Pure helpers for the import rule-suggestion review surface (no JSX/hooks): sort-order persistence
// keys + normalization, the status palette/symbol used by progress pills and suggestion badges, the
// category-display label resolver, and the amount/filter-pill formatting. Extracted from
// ImportRuleSuggestionReview.jsx so the component file stays focused on state + layout.

import { formatCurrency } from './utils.js'

export const IMPORT_RULE_SORT_STORAGE_KEY = 'import-rule-suggestions-sort-order'
export const IMPORT_RULE_SORT_PREF_KEY = 'ui.importRuleSuggestions.sortOrder'

export function normalizeImportRuleSortOrder(value) {
  return value === 'alpha' || value === 'row_count' ? value : null
}

export function findNearestScrollParent(element) {
  let current = element?.parentElement || null
  while (current) {
    const style = window.getComputedStyle(current)
    const overflowY = style.overflowY || style.overflow || ''
    if (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') {
      return current
    }
    current = current.parentElement
  }
  return null
}

export function buildCategoryDisplayLabel(categories, categoryId, fallbackName = '') {
  if (!categoryId) return fallbackName || ''
  const leaves = categories.filter(category => category.parent_id)
  const groupsById = new Map(categories.filter(category => !category.parent_id).map(group => [group.id, group]))
  const selected = leaves.find(category => String(category.id) === String(categoryId))
  if (!selected) return fallbackName || ''
  const normalizedName = String(selected.name || '').trim().toLowerCase()
  // Imported rows may only know the leaf name; add the parent group only when
  // that leaf label is ambiguous elsewhere in the tree.
  const duplicateCount = leaves.filter(category => String(category.name || '').trim().toLowerCase() === normalizedName).length
  if (duplicateCount <= 1) return selected.name
  const group = groupsById.get(selected.parent_id)
  return group?.name ? `${group.name}: ${selected.name}` : selected.name
}

export function getStatusSymbol(tone) {
  return tone === 'accepted'
    ? '✓'
    : tone === 'discarded'
      ? '×'
      : tone === 'skipped'
        ? '?'
        : null
}

export function getStatusPalette(tone = 'default') {
  const colors = {
    default: {
      background: 'var(--surface2)',
      border: 'var(--border)',
      color: 'var(--muted)',
    },
    pending: {
      background: 'color-mix(in srgb, var(--warning) 10%, var(--surface2))',
      border: 'color-mix(in srgb, var(--warning) 36%, var(--border))',
      color: 'color-mix(in srgb, var(--warning) 72%, var(--text))',
    },
    accepted: {
      background: 'color-mix(in srgb, var(--success) 12%, var(--surface2))',
      border: 'color-mix(in srgb, var(--success) 34%, var(--border))',
      color: 'var(--success)',
    },
    skipped: {
      background: 'color-mix(in srgb, var(--accent2) 8%, var(--surface2))',
      border: 'color-mix(in srgb, var(--accent2) 28%, var(--border))',
      color: 'var(--accent2)',
    },
    discarded: {
      background: 'color-mix(in srgb, var(--danger) 8%, var(--surface2))',
      border: 'color-mix(in srgb, var(--danger) 24%, var(--border))',
      color: 'var(--danger)',
    },
  }
  return colors[tone] || colors.default
}

export function formatSuggestionAmountLabel(min, max) {
  if (min != null && max != null) {
    return min === max
      ? `amount ${formatCurrency(min)}`
      : `amount ${formatCurrency(min)} to ${formatCurrency(max)}`
  }
  if (min != null) return `amount at least ${formatCurrency(min)}`
  if (max != null) return `amount up to ${formatCurrency(max)}`
  return ''
}

export function getSuggestionFilterPills(suggestion) {
  const pills = []
  if (suggestion.owner_name) pills.push({ key: 'owner', label: `and owner ${suggestion.owner_name}`, actionKey: 'removeOwner' })
  if (suggestion.account_name) pills.push({ key: 'account', label: `and account ${suggestion.account_name}`, actionKey: 'removeAccount' })
  const amountLabel = formatSuggestionAmountLabel(suggestion.amount_min, suggestion.amount_max)
  if (amountLabel) pills.push({ key: 'amount', label: `and ${amountLabel}`, actionKey: 'removeAmount' })
  return pills
}
