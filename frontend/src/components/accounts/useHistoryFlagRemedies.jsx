// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from 'react'
import { api } from '../../lib/api.js'
import { formatDate } from '../../lib/utils.js'
import { LinkButton } from '../ui.jsx'
import AccountBalanceDialog from './AccountBalanceDialog.jsx'
import BalanceTotalsStartDialog from './BalanceTotalsStartDialog.jsx'

/*
 * What can be done about an account whose transactions do not explain its earlier history (the history
 * flag, `backend/services/balance_totals.py`), offered wherever the flag shows: the Balances table and the
 * account's page.
 *
 * - **Enter a balance from a statement**, on the day it fixes the most (`balance_date`): where the account
 *   switched from imported files to a connection when there is such a day, otherwise the last day the
 *   history goes wrong on. It gives the earlier history its own starting point, and keeps it.
 * - **Count from a date**: the balance totals leave the account out before it. Offered on the furthest date back the
 *   transactions hold up, and any other can be chosen.
 * - **Dismiss**: stop flagging it, changing nothing.
 *
 * A hook rather than a component because the links often sit in a tooltip, which closes as the pointer
 * leaves it: the dialogs they open are rendered by the caller, outside it. `onChanged` re-reads whatever
 * shows the flag. An account is `{ id, type, balanceTotalsFrom }` for the group's top account.
 */
export function useHistoryFlagRemedies(onChanged) {
  const [open, setOpen] = useState(null)
  function actionsFor(account, flag) {
    const dismiss = () => api.dismissHistoryFlag(account.id).then(onChanged).catch(() => { })
    return (
      <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 12 }}>
        <LinkButton onClick={() => setOpen({ kind: 'balance', account, flag })}>
          Enter the balance on {formatDate(flag.balance_date)}
        </LinkButton>
        <LinkButton onClick={() => setOpen({ kind: 'start', account, flag })}>
          Count from {formatDate(flag.suggested_from)}
        </LinkButton>
        <LinkButton onClick={dismiss}>Dismiss</LinkButton>
      </span>
    )
  }
  const close = () => setOpen(null)
  const dialogs = open?.kind === 'balance' ? (
    <AccountBalanceDialog
      account={{ id: open.account.id, type: open.account.type, balance: null }}
      initialDate={open.flag.balance_date}
      onClose={close}
      onSaved={onChanged}
    />
  ) : open?.kind === 'start' ? (
    <BalanceTotalsStartDialog
      accountId={open.account.id}
      current={open.account.balanceTotalsFrom || null}
      suggested={open.flag.suggested_from}
      onClose={close}
      onSaved={onChanged}
    />
  ) : null
  return { actionsFor, dialogs }
}
