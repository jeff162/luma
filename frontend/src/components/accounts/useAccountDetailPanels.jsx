// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useState } from 'react'
import AccountDetail from '../AccountDetail.jsx'

// The stack of floating account panels a surface opens from its own `↗` launchers — the Accounts list,
// and a connection's account list on the Connections tab. The hook owns the stack and its
// render, the same shape as `useBatchDetailPanels`, so an account opens the same way from either place.
//
// `accounts` is the caller's live list: an open panel's title follows a rename made underneath it.
// `getInitialPosition` lets a caller open the panel beside the thing it was launched from; without it
// the panel takes its own default.
export function useAccountDetailPanels({ accounts, categories, getInitialPosition = null }) {
  const [detailAccounts, setDetailAccounts] = useState([])

  const openAccountDetail = useCallback((account) => {
    if (!account?.id) return
    setDetailAccounts(prev => [
      ...prev.filter(item => item.id !== account.id),
      account,
    ])
  }, [])

  const closeAccountDetail = useCallback((accountId) => {
    setDetailAccounts(prev => prev.filter(item => item.id !== accountId))
  }, [])

  useEffect(() => {
    setDetailAccounts(current => current.map(detail => {
      const nextAccount = (accounts || []).find(account => account.id === detail.id)
      return nextAccount
        ? { ...detail, name: nextAccount.display_name || nextAccount.name, mask: nextAccount.mask }
        : detail
    }))
  }, [accounts])

  const panelsNode = detailAccounts.map((account, index) => (
    <AccountDetail
      key={account.id}
      account={account}
      categories={categories}
      forceFloating
      stackIndex={index}
      initialPosition={getInitialPosition ? getInitialPosition() : null}
      isTopmost={index === detailAccounts.length - 1}
      onClose={() => closeAccountDetail(account.id)}
    />
  ))

  return { openAccountDetail, panelsNode }
}
