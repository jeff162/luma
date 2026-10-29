// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// "Are these two accounts the same account?" — asked in the duplicate report, about a pile of flagged
// rows that all sit between one pair of accounts.
//
// A stack of cross-account flags between one pair is not N questions, it is one: either the accounts are
// the same and the rows are duplicates, or they are different and every flag between them is a false
// positive. Both answers settle the whole pile, which is why the report offers them instead of asking the
// user through the list a row at a time.
//
// It is the same question the "Possible duplicate account?" chooser asks at mapping time
// (`importConfirmDialogs.jsx`), deliberately in the same words, because it *is* the same question — just
// reached later, by a route that had no mapping step or where the answer has changed. The two differ only
// in what "same account" can mean at each moment: before any rows exist it is a mapping choice, and
// afterwards it is a merge.
//
// This replaces a much worse arrangement, in which the account-level decision rode invisibly on a Keep
// clicked against a single transaction — so a durable assertion that suppressed detection between the two
// accounts forever was made by a button labelled for what it did to one row, and bulk-selecting five rows
// resolved forty-two.

import { useState } from 'react'
import { Button, Tooltip } from '../ui.jsx'

function accountLabel(account) {
  const name = account?.name || 'this account'
  return account?.mask ? `${name} ···${account.mask}` : name
}

export function AccountIdentityPrompt({ pair, onMerge, onMarkDistinct, onDismiss, busy = false }) {
  const [pending, setPending] = useState('')
  if (!pair) return null
  const incoming = accountLabel(pair.incoming)
  const matched = accountLabel(pair.matched)
  const n = Number(pair.flag_count || 0)

  async function run(kind, fn) {
    setPending(kind)
    try {
      await fn()
    } finally {
      setPending('')
    }
  }

  const disabled = busy || !!pending

  return (
    <div style={{
      border: '1px solid color-mix(in srgb, var(--accent) 32%, var(--border))',
      background: 'color-mix(in srgb, var(--accent) 7%, var(--surface2))',
      borderRadius: 10, padding: '10px 12px', display: 'grid', gap: 10, fontSize: 13,
    }}>
      <div style={{ display: 'grid', gap: 4 }}>
        <div style={{ fontWeight: 600 }}>
          {n} flagged {n === 1 ? 'row is' : 'rows are'} between <b>{incoming}</b> and <b>{matched}</b>.
        </div>
        <div style={{ color: 'var(--muted)', lineHeight: 1.55 }}>
          Are these the same real-world account? Either answer settles all of them.
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        {/* The merge half is offered only when the accounts can actually be merged — same type,
            compatible owners, neither already grouped. Decided server-side (`can_merge`) so this and the
            Accounts page cannot disagree about whether it is possible. Shown disabled rather than hidden:
            "you can't do that here, and here's why" beats an option that silently isn't there. */}
        <Tooltip describeTrigger content={pair.can_merge
          ? 'Merge the two accounts. Identical matches between them resolve as duplicates; anything that only looks similar stays for review.'
          : 'These accounts cannot be merged from here — they differ in type or owner, or one is already grouped. Merge them on the Accounts page.'}>
          <Button
            disabled={disabled || !pair.can_merge}
            onClick={() => run('merge', onMerge)}
          >
            {pending === 'merge' ? 'Merging…' : 'Same account — merge them'}
          </Button>
        </Tooltip>
        <Button
          variant="secondary"
          disabled={disabled}
          onClick={() => run('distinct', onMarkDistinct)}
          title={`Record that these are different accounts. Clears all ${n} flagged ${n === 1 ? 'row' : 'rows'} between them and stops future imports checking this pair.`}
        >
          {pending === 'distinct' ? 'Saving…' : 'Different accounts — keep both'}
        </Button>
        <Button variant="quiet" disabled={disabled} onClick={onDismiss}
          style={{ marginLeft: 'auto' }}
          title="Leave these rows to resolve individually. This will not be asked again for this pair.">
          Not now
        </Button>
      </div>
      {!pair.can_merge ? (
        <div style={{ fontSize: 12, color: 'var(--muted)' }}>
          Merging is unavailable for this pair — the accounts differ in type or owner, or one is already
          grouped. Both can still be merged from the Accounts page.
        </div>
      ) : null}
    </div>
  )
}
