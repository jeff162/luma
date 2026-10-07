// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import CopyTransactionsButton from './CopyTransactionsButton.jsx'
import { Button, RefreshButton } from './ui.jsx'

/*
 * The "Copy the shown rows + toggle Bulk Edit" row that sits above a TransactionListTable on every
 * activity/drill surface — AccountDetail, CategoryDetail, PeriodDetail, TagDetail, the payee
 * TransactionDetail, and the dashboard category drill. Pair it with a <BulkEditChrome controller={bulk}/>
 * rendered just below (kept separate so each host controls that chrome's own wrapper/padding).
 *
 * `bulk` is a useBulkTransactionEditing() controller (reads `.bulkMode`, calls `.toggle`). `copy` is a
 * paged list's `usePagedTransactions().copy`, so the copy reaches past the loaded pages and, past the copy
 * limit, offers the list as a download. `style` overrides the default right-aligned wrapper for the rare
 * host that needs different spacing (the dashboard drill uses card padding instead of a bottom margin).
 *
 * `onRefresh` / `refreshing` are the paged list's `reload` / `reloading`. Every list here lets an edited
 * row linger when it no longer matches the scope (ui-patterns: an edited transaction lingers where it was
 * found), and that model owes the user an explicit way to re-query — without it a row edited out of the
 * scope has no way back off the screen, and the figures the panel header reads from the server stay behind
 * the ledger. A host that genuinely has nothing to re-query passes neither and the button is absent.
 */
export default function TransactionListToolbar({ rows, copy = null, title, bulk, onRefresh = null, refreshing = false, style }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6, marginBottom: 8, ...style }}>
      {onRefresh ? (
        <RefreshButton
          onRefresh={onRefresh}
          loading={refreshing}
          title="Refresh — re-query the list and drop transactions that no longer match"
        />
      ) : null}
      <CopyTransactionsButton
        rows={rows}
        loadRows={copy?.loadRows}
        total={copy?.total}
        onDownload={copy?.onDownload}
        title={title}
        tooltip="Copy the transactions shown"
      />
      <Button variant="ghost" small onClick={bulk.toggle}>
        {bulk.bulkMode ? '✕ Done' : 'Bulk Edit'}
      </Button>
    </div>
  )
}
