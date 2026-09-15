// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/* eslint-disable react-refresh/only-export-components -- provider + useTransactionShare hook live together by design */

// App-level state for the "copy for sharing" dialog (TransactionShareDialog). Any surface that shows a
// transaction or a list of them — the single-transaction editor, the merchant/category/account/tag/
// month reports, the Dashboard drills, the Transactions ledger — opens it through this one context, so
// each surface just drops in a copy button rather than hosting its own dialog. The dialog renders here
// at the provider (AppDialog portals to a high-z overlay, so it sits over whatever opened it). The
// payload is transient: there is nothing to persist or reconcile — the dialog is read-only.

import { createContext, useCallback, useContext, useMemo, useState } from 'react'
import TransactionShareDialog from '../components/TransactionShareDialog.jsx'

const TransactionShareContext = createContext(null)

export function useTransactionShare() {
  const ctx = useContext(TransactionShareContext)
  if (!ctx) {
    throw new Error('useTransactionShare must be used inside <TransactionShareProvider>')
  }
  return ctx
}

export function TransactionShareProvider({ children }) {
  const [share, setShare] = useState(null)

  const openTransaction = useCallback((txn, { title } = {}) => {
    if (txn) setShare({ mode: 'single', txn, title })
  }, [])
  const openTransactions = useCallback((rows, { title, loadRows, total, onDownload } = {}) => {
    setShare({
      mode: 'list', rows: rows || [], loadRows: loadRows || null, total: total ?? null,
      onDownload: onDownload || null, title,
    })
  }, [])
  const close = useCallback(() => setShare(null), [])

  const value = useMemo(() => ({ openTransaction, openTransactions, close }), [openTransaction, openTransactions, close])

  return (
    <TransactionShareContext.Provider value={value}>
      {children}
      {share ? (
        <TransactionShareDialog
          mode={share.mode}
          txn={share.txn}
          rows={share.rows}
          loadRows={share.loadRows}
          total={share.total}
          onDownload={share.onDownload}
          title={share.title}
          onClose={close}
        />
      ) : null}
    </TransactionShareContext.Provider>
  )
}
