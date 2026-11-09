// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// The dialogs a connection operation raises, rendered wherever the operation was started.
//
// They travel with `useConnectionOperations` rather than living on a page, so the confirmation for a
// destructive action is written once, beside the action it confirms.
//
// Exported as a function returning a node rather than as a component, so the hook can hand it back
// alongside its actions the way `useBatchDetailPanels` hands back `panelsNode`: the caller renders one
// value and gets both halves, instead of wiring a component and its seven props by hand at every host.

import { AppConfirmDialog, AppNoticeDialog, Spinner } from '../ui.jsx'
import { EditedTransactionsWarning } from '../EditedTransactionsWarning.jsx'
import { formatRelativeTimestamp, formatTimestamp } from '../../lib/utils.js'

export function connectionOperationDialogs({
  notice, onDismissNotice,
  removeSyncTarget, removingSync, onConfirmRemoveSynced, onCancelRemoveSynced,
  resyncConfirm, onConfirmResync, onCancelResync,
}) {
  const summary = removeSyncTarget?.summary
  const edited = summary?.edited_transactions || []
  const count = summary?.transaction_count || 0
  return (
    <>
      {removeSyncTarget ? (
        <AppConfirmDialog
          title={`Remove synced transactions from ${removeSyncTarget.connection.institution || 'this bank'}?`}
          // The label states the size of what is about to happen, which is the number the preflight went
          // and fetched. Until it lands there is nothing honest to promise, so the button waits.
          confirmLabel={removingSync ? 'Removing…'
            : edited.length ? 'Remove all anyway'
              : count ? `Remove ${count} transaction${count === 1 ? '' : 's'}`
                : 'Reset sync history'}
          confirmVariant="danger"
          confirmDisabled={!summary || removingSync}
          cancelDisabled={removingSync}
          onConfirm={() => onConfirmRemoveSynced(edited.length > 0)}
          onCancel={onCancelRemoveSynced}
        >
          {!summary ? <Spinner /> : (
            <>
              <EditedTransactionsWarning rows={edited} suffix="after syncing" />
              <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.6 }}>
                {count
                  ? `${count} transaction${count === 1 ? '' : 's'} synced from this connection will be permanently deleted, along with ${summary.card_count === 1 ? 'its sync card' : `their ${summary.card_count} sync cards`} in the import history.`
                  : 'No synced transactions are recorded for this connection.'}
                {' '}The connection stays linked and its accounts and mapping are kept. What resets is how
                far this connection has pulled, so the next sync re-imports its history from the provider
                rather than only changes since the last one.
              </div>
            </>
          )}
        </AppConfirmDialog>
      ) : null}

      {resyncConfirm ? (
        <AppConfirmDialog
          title="Sync again?"
          description={`Every connection synced ${formatRelativeTimestamp(resyncConfirm.lastSynced)} (${formatTimestamp(resyncConfirm.lastSynced)}).`}
          confirmLabel="Sync again"
          onConfirm={onConfirmResync}
          onCancel={onCancelResync}
        />
      ) : null}

      {notice ? (
        <AppNoticeDialog title={notice.title} description={notice.description} onClose={onDismissNotice} />
      ) : null}
    </>
  )
}
