// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useState } from 'react'
import { api } from '../../lib/api.js'
import { txnMutations } from '../../lib/txnMutations.js'

/*
 * The Generate Rules review's matching-transactions report: the rows behind one card, and the edits made
 * to them from the report. It opens either as a modal or, beside the rule editor, as a read-only
 * reference (`referenceMode`).
 *
 * The caller decides what a card's report covers and passes it as `target`: the labels the report shows
 * and the `query` sent to `loadMatches`. Every edit here changes transaction categories, so it reloads
 * the suggestions (`onRowsChanged`) and then the report, because the cards regenerate from those rows.
 *
 * Two ways to settle a row, and they mean different things:
 * - **set a row's category** corrects the file's categorization: the row stays `import` with its file
 *   label rewritten, so it keeps driving suggestions, now toward the new category.
 * - **keep a row's category** makes it a manual exception: no rule changes it and it leaves the
 *   suggestions.
 *
 * A row's merchant ↗ opens the merchant spending report (`merchantReport`), fetched as the full
 * transaction because a match row lacks the fields that report shows.
 */

const CLOSED = {
  open: false,
  loading: false,
  error: '',
  referenceMode: false,
  merchantLabel: '',
  keyword: '',
  referenceTargetCategoryId: null,
  ownerName: '',
  accountName: '',
  amountMin: null,
  amountMax: null,
  query: null,
  count: 0,
  rows: [],
  applyingAll: false,
}

export function useSuggestionMatchViewer({ loadMatches, onRowsChanged }) {
  const [state, setState] = useState(CLOSED)
  const [merchantReport, setMerchantReport] = useState(null)

  // Stable, so a caller can close the reference from an effect.
  const closeReference = useCallback(() => {
    setState(prev => (prev.open && prev.referenceMode ? { ...prev, open: false, referenceMode: false } : prev))
  }, [])

  function markRow(rowId, keeping) {
    setState(prev => ({ ...prev, rows: prev.rows.map(row => (row.id === rowId ? { ...row, keeping } : row)) }))
  }

  async function open(target, { referenceMode = false } = {}) {
    if (!loadMatches) return
    const { query } = target
    setState({
      ...CLOSED,
      open: true,
      loading: true,
      referenceMode,
      merchantLabel: target.merchantLabel,
      ownerName: target.ownerName || '',
      accountName: target.accountName || '',
      keyword: query.keyword,
      referenceTargetCategoryId: query.reference_target_category_id,
      amountMin: query.amount_min,
      amountMax: query.amount_max,
      query,
    })
    try {
      const result = await loadMatches(query)
      setState(prev => ({ ...prev, loading: false, count: result.count || 0, rows: result.transactions || [] }))
    } catch (err) {
      setState(prev => ({ ...prev, loading: false, error: err.message || 'Unable to load matching imported rows.' }))
    }
  }

  async function reload() {
    const result = await loadMatches?.(state.query)
    setState(prev => ({ ...prev, loading: false, error: '', count: result?.count || 0, rows: result?.transactions || [] }))
  }

  async function afterRowsChanged() {
    await onRowsChanged?.()
    await reload()
  }

  async function setRowCategory(row, categoryId) {
    if (!row?.id || !categoryId) return
    markRow(row.id, true)
    try {
      await txnMutations.setImportedCategory(row.id, categoryId)
      await afterRowsChanged()
    } catch (err) {
      markRow(row.id, false)
      setState(prev => ({ ...prev, error: err.message || 'Unable to set this category.' }))
    }
  }

  async function keepRowCategory(row) {
    if (!row?.id || !row?.target_category_id) return
    markRow(row.id, true)
    try {
      await txnMutations.setCategory(row.id, row.target_category_id)
      await afterRowsChanged()
    } catch (err) {
      markRow(row.id, false)
      setState(prev => ({ ...prev, error: err.message || 'Unable to preserve this categorization.' }))
    }
  }

  // Corrects every row not already on `categoryId`, collapsing a conflict onto one suggestion.
  async function setAllCategories(categoryId) {
    if (!categoryId || state.applyingAll) return
    const targets = state.rows.filter(row => String(row.target_category_id) !== String(categoryId))
    if (!targets.length) return
    setState(prev => ({ ...prev, applyingAll: true, error: '' }))
    try {
      for (const row of targets) {
        await txnMutations.setImportedCategory(row.id, categoryId)
      }
      await afterRowsChanged()
    } catch (err) {
      setState(prev => ({ ...prev, error: err.message || 'Unable to set the category for these rows.' }))
    } finally {
      setState(prev => ({ ...prev, applyingAll: false }))
    }
  }

  async function openMerchantReport(row) {
    if (!row?.id) return
    try {
      const result = await api.getTransactions({ ids: row.id })
      setMerchantReport(result?.transactions?.[0] || row)
    } catch {
      setMerchantReport(row)
    }
  }

  return {
    state,
    open,
    close: () => setState(prev => ({ ...prev, open: false })),
    closeReference,
    reload,
    setRowCategory,
    keepRowCategory,
    setAllCategories,
    merchantReport,
    openMerchantReport,
    closeMerchantReport: () => setMerchantReport(null),
  }
}
