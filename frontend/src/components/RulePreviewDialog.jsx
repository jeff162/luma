// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import FloatingDialog from './FloatingDialog.jsx'
import TransactionListTable from './TransactionListTable.jsx'
import TransactionDetail from './TransactionDetail.jsx'
import { applyCategoryChange, makeRowReconciler } from '../lib/txnMutations.js'
import { useTransactionTableLayout } from '../lib/transactionTablePreferences.js'
import { vh } from '../lib/displaySize.js'

/*
 * The transactions a rule reaches: what a draft rule would change (opened from the rule editor) or what a
 * saved rule matches (from the Rules page). A floating dialog over the shared transaction list, so its
 * rows are edited, sorted and opened as on any other list.
 *
 * `onChanged` is called after an edit to a row, for a host whose list is a computation: the editor re-runs
 * its preview, so a row trashed or given the rule's own category leaves it. A row given some other category
 * by hand stays, because applying the rule to existing transactions overrides a manual edit. `offerRules`
 * is off there, because a second "create a rule?" would compete with the rule being written.
 */
export default function RulePreviewDialog({
  transactions,
  categories,
  onClose,
  title = 'Transactions Affected by This Rule',
  subtitle,
  onChanged = null,
  offerRules = true,
}) {
  const [rows, setRows] = useState(transactions)
  useEffect(() => { setRows(transactions) }, [transactions])
  const [detail, setDetail] = useState(null)
  const [columnConfig, setColumnConfig] = useTransactionTableLayout({ preferenceKey: 'ui.rules.affectedTransactions.columns' })

  const patchRow = (patch, id) => setRows(prev => prev.map(row => (row.id === id ? { ...row, ...patch } : row)))
  const changed = () => onChanged?.()
  async function saveCategory(txnId, catId, catObj) {
    await applyCategoryChange(txnId, catObj || categories.find(c => c.id === catId), patchRow)
    changed()
  }
  const reconcile = makeRowReconciler(setRows)

  // Portalled whole, so the detail panel a row opens takes its own place in the panel stack rather than
  // sitting inside the rule editor that rendered this.
  return createPortal(
    <>
      <FloatingDialog
        panelKey="ui.rulePreview.panel"
        title={title}
        description={subtitle ?? `${rows.length} transaction${rows.length !== 1 ? 's' : ''} where applying this rule would make a change`}
        onClose={onClose}
        width={960}
        bodyPadding="0 18px 18px"
      >
        <TransactionListTable
          rows={rows}
          categories={categories}
          onCategorySave={saveCategory}
          onTransactionOpenDetail={setDetail}
          onRowsChange={setRows}
          onTrashed={changed}
          onSplitSaved={changed}
          onRuleSaved={changed}
          columnConfig={columnConfig}
          onColumnConfigChange={setColumnConfig}
          offerRuleSuggestions={offerRules}
          maxHeight={vh(60)}
          emptyMessage="No transactions would be affected."
        />
      </FloatingDialog>
      {detail ? (
        <TransactionDetail
          txn={detail}
          categories={categories}
          onClose={() => setDetail(null)}
          onReconcile={(txnId, patch) => { reconcile(txnId, patch); changed() }}
          forceFloating
          stackIndex={1}
        />
      ) : null}
    </>,
    document.body,
  )
}
