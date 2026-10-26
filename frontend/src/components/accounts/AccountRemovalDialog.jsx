// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo, useRef, useState } from 'react'
import { AppDialog, Button } from '../ui.jsx'
import ImportNewAccountFields from '../ImportNewAccountFields.jsx'
import {
  findExactAccountNameMatch,
  getAccountOptionLabel,
  selectableAccountOptions,
} from '../../lib/importExport/importAccountMatching.js'

/*
 * "Where do these transactions end up?" — the one question removing an account asks, and the only thing
 * it asks. The account's own fate is not a choice: it is removed, and every answer here is permanent.
 *
 * **Why there is no undo, and what stands in for one.** Reassigning immediately while keeping the
 * account recoverable cannot work: once the rows have moved, nothing tells them apart from the ones
 * already on the target, so restoring would need a per-row record of what moved — unbounded, which
 * `scale-and-limits.md` forbids. Deferring the move until an account trash is emptied does work, and
 * was built and then retired, because it turns this dialog's answer into a promise with no delivery
 * date: nothing outside the accounts listing filters `account.trashed_at`, so the rows go on being
 * reported under the old account until someone empties the trash, which may be never. That is
 * invisible for a merged child only because those rows resolve to the parent either way, which is why
 * the one case that worked did not generalise.
 *
 * So the accident is prevented rather than reversed, which suits the economics too: a trash earns its
 * keep where the action is routine and the undo is one column, and this one is rare and spans eight
 * tables. Removal lives behind the row's ⋯ menu rather than a one-press ×, and the default answer — the
 * parent, for a group member — puts the rows where they already displayed, so a mis-click on the
 * default does nothing visible. The answers that do real damage are the ones deliberately chosen.
 *
 * An account holding no transactions has nothing to decide, and gets a plain confirmation instead of a
 * question about nothing.
 */

const REASSIGN = 'reassign'
const DELETE = 'delete'
const NEW_ACCOUNT = '__new__'

const fieldStyle = {
  background: 'var(--surface)', color: 'var(--text)',
  border: '1px solid var(--border)', borderRadius: 6,
  padding: '6px 10px', fontSize: 13, width: '100%', outline: 'none', cursor: 'pointer',
}

function Rung({ value, chosen, onChoose, label, children }) {
  const selected = chosen === value
  return (
    <label
      style={{
        display: 'grid', gridTemplateColumns: 'auto 1fr', gap: 10, alignItems: 'start',
        padding: '10px 12px', borderRadius: 8, cursor: 'pointer',
        border: `1px solid ${selected ? 'var(--accent2)' : 'var(--border)'}`,
        background: selected ? 'color-mix(in srgb, var(--accent2) 7%, transparent)' : 'transparent',
      }}
    >
      <input
        type="radio"
        name="account-removal-disposition"
        value={value}
        checked={selected}
        onChange={() => onChoose(value)}
        style={{ marginTop: 2, cursor: 'pointer' }}
      />
      <div style={{ display: 'grid', gap: 6 }}>
        <div style={{ fontSize: 13 }}>{label}</div>
        {selected ? children : null}
      </div>
    </label>
  )
}

export default function AccountRemovalDialog({ account, accounts, onCancel, onSubmit, busy = false }) {
  const transactionCount = Number(account?.transaction_count || 0)
  const hasTransactions = transactionCount > 0
  const [chosen, setChosen] = useState(REASSIGN)
  const [targetId, setTargetId] = useState(account?.parent_account_id || '')
  // A new account standing in for the one being removed is almost always the same kind of account, so
  // its type seeds the field rather than the import screen's generic 'depository'.
  const [newAccount, setNewAccount] = useState({ name: '', type: account?.type || 'depository' })
  const newNameRef = useRef(null)

  const accountsById = useMemo(() => new Map((accounts || []).map(a => [a.id, a])), [accounts])
  // Roots, less the account being removed — it cannot inherit from itself, and a group's other members
  // are reachable through their root, which is what every scope resolves to anyway.
  const targets = useMemo(
    () => selectableAccountOptions(accounts, account?.parent_account_id || '')
      .filter(option => option.id !== account?.id),
    [accounts, account],
  )

  const newNameTaken = !!findExactAccountNameMatch(accounts, newAccount.name)
  const creatingNew = chosen === REASSIGN && targetId === NEW_ACCOUNT
  const label = account?.display_name || account?.name || 'this account'

  let blocked = null
  if (chosen === REASSIGN) {
    if (creatingNew) {
      if (!newAccount.name.trim()) blocked = 'Name the new account.'
      else if (newNameTaken) blocked = 'That name is taken — select the account from the list instead.'
    } else if (!targetId) {
      blocked = 'Choose the account to keep the transactions.'
    }
  }

  function submit() {
    if (blocked || busy) return
    if (chosen === DELETE) return onSubmit({ mode: DELETE })
    if (creatingNew) return onSubmit({ mode: REASSIGN, newAccount })
    return onSubmit({ mode: REASSIGN, targetAccountId: targetId })
  }

  if (!hasTransactions) {
    return (
      <AppDialog
        title="Remove account?"
        description={<>Remove <strong>{label}</strong>? It holds no transactions.</>}
        onClose={onCancel}
        width="min(520px, 100%)"
        borderColor="color-mix(in srgb, var(--danger) 35%, var(--border))"
        actions={(
          <>
            <Button variant="secondary" onClick={onCancel} disabled={busy}>Cancel</Button>
            <Button variant="danger" onClick={() => onSubmit({ mode: DELETE })} disabled={busy}>
              Remove
            </Button>
          </>
        )}
      />
    )
  }

  return (
    <AppDialog
      title="Remove account?"
      description={(
        <>
          <strong>{label}</strong> holds {transactionCount} transaction{transactionCount === 1 ? '' : 's'}.
          <p>Transactions must map to an account. Pick a new account for these transactions or
            delete them. These actions cannot be undone.</p>
        </>
      )}
      onClose={onCancel}
      width="min(620px, 100%)"
      borderColor="color-mix(in srgb, var(--danger) 35%, var(--border))"
      actions={(
        <>
          <Button variant="secondary" onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button
            variant="danger"
            onClick={submit}
            disabled={busy || !!blocked}
            title={blocked || undefined}
          >
            {chosen === DELETE ? `Delete ${transactionCount === 1 ? 'it' : 'them'} and remove` : 'Move and remove'}
          </Button>
        </>
      )}
    >
      <div style={{ display: 'grid', gap: 8 }}>
        <Rung
          value={REASSIGN}
          chosen={chosen}
          onChoose={setChosen}
          label="Move the transactions to another account"
        >
          <select
            aria-label="Account to keep the transactions"
            value={targetId}
            onChange={event => {
              setTargetId(event.target.value)
              if (event.target.value === NEW_ACCOUNT) {
                window.setTimeout(() => newNameRef.current?.focus(), 0)
              }
            }}
            style={fieldStyle}
          >
            <option value="">— Select account —</option>
            {targets.map(option => (
              <option key={option.id} value={option.id}>
                {getAccountOptionLabel(option, accountsById)}
              </option>
            ))}
            <option value={NEW_ACCOUNT}>Create new account…</option>
          </select>
          {creatingNew ? (
            <ImportNewAccountFields
              value={newAccount}
              accounts={accounts}
              onChange={setNewAccount}
              inputRef={newNameRef}
            />
          ) : null}
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>
            Rules, recurring series, and import data sources will be updated
            as well.
          </div>
        </Rung>

        <Rung
          value={DELETE}
          chosen={chosen}
          onChoose={setChosen}
          label="Delete the associated transactions"
        >
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>
            This is not reversible. Rules and recurring series scoped to this account
            are removed as well.
          </div>
        </Rung>
      </div>
    </AppDialog>
  )
}
