// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useState } from 'react'
import { api } from '../../lib/api.js'
import { Button, Input, Select } from '../ui.jsx'

// Choosing which Amazon account order files import into — the one control the import form and the saved
// source's editor both show.
//
// It is one component because it is one question, and because the second copy is what went wrong: the
// source editor was written with a plain select over the accounts that already existed, so the only
// Amazon account picker in the app that could not create one was the one reached while setting a source
// up for the first time (`ui-patterns.md` → "Creating is available wherever assigning is").
//
// The host owns the account list and reloads it in `onCreated` — each one already holds that list for its
// other fields — so what this owns is only the creating half.

const NEW_ACCOUNT = '__new__'

export default function AmazonAccountPicker({
  id, accounts = [], value, onChange, onCreated, onError, style, defaultName = 'Amazon',
}) {
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState(defaultName)
  const [saving, setSaving] = useState(false)

  // An account chosen from outside — the import form filling itself in from a saved source — answers the
  // same question, so the half-filled create row below is stale and goes away. Choosing "new" sets the
  // value to '' and so cannot trip this.
  useEffect(() => { if (value) setCreating(false) }, [value])

  // With no account yet the first option is the instruction rather than an invitation to pick from an
  // empty list: the entry that does something is the last one, which is otherwise easy to miss.
  const options = [
    { value: '', label: accounts.length ? 'Select an account…' : 'No Amazon account yet — create one →' },
    ...accounts.map(account => ({ value: account.id, label: account.display_name || account.name })),
    { value: NEW_ACCOUNT, label: '＋ New Amazon account…' },
  ]

  const choose = (next) => {
    if (next === NEW_ACCOUNT) { setCreating(true); onChange('') }
    else { setCreating(false); onChange(next) }
  }

  const create = async () => {
    const trimmed = name.trim()
    if (!trimmed) return
    setSaving(true)
    // The host shows the failure in its own error slot, so clearing it is this component's to ask for:
    // a message left over from the last attempt reads as a verdict on this one.
    onError?.('')
    try {
      const created = await api.createAccount({ name: trimmed, type: 'amazon' })
      await onCreated?.(created)
      onChange(created.id)
      setCreating(false)
    } catch (e) {
      onError?.(e?.message || 'Could not create account')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      <Select
        id={id}
        value={creating ? NEW_ACCOUNT : value}
        onChange={choose}
        options={options}
        style={style}
      />
      {creating ? (
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <Input value={name} onChange={setName} placeholder="Account name"
            aria-label="New account name" style={{ flex: 1 }} />
          <Button small onClick={create} disabled={saving || !name.trim()}>
            {saving ? 'Creating…' : 'Create'}
          </Button>
          <Button small variant="ghost" onClick={() => { setCreating(false); setName(defaultName) }}>
            Cancel
          </Button>
        </div>
      ) : null}
    </div>
  )
}
