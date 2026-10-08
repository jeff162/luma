// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { GENERIC_IMPORT_ACCOUNT_TYPES } from '../lib/accountTypes.js'
import { findExactAccountNameMatch } from '../lib/importExport/importAccountMatching.js'

const fieldStyle = {
  background: 'var(--surface)', color: 'var(--text)',
  border: '1px solid var(--border)', borderRadius: 6,
  padding: '6px 10px', fontSize: 13, width: '100%', outline: 'none',
}

// The name + type editor `ImportAccountHandlingPicker` shows under itself once "Create new account…" is
// chosen — in the picker's own cell, so the fields read as the answer to that choice. Refuses a name
// that already exists (the backend refuses it too; this makes the refusal visible before saving).
export default function ImportNewAccountFields({ value, accounts, onChange, inputRef = null }) {
  const nameTaken = !!findExactAccountNameMatch(accounts, value.name)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <input
        ref={inputRef}
        name="single-new-account-name"
        aria-label="New account name"
        value={value.name}
        onChange={e => onChange({ ...value, name: e.target.value })}
        placeholder="New account name"
        style={{ ...fieldStyle, borderColor: nameTaken || !value.name.trim() ? 'var(--danger)' : 'var(--border)' }}
      />
      <select
        name="single-new-account-type"
        aria-label="New account type"
        value={value.type}
        onChange={e => onChange({ ...value, type: e.target.value })}
        style={{ ...fieldStyle, cursor: 'pointer' }}
      >
        {GENERIC_IMPORT_ACCOUNT_TYPES.map(option => (
          <option key={option.value} value={option.value}>{option.shortLabel}</option>
        ))}
      </select>
      {nameTaken && (
        <div style={{ fontSize: 11, color: 'var(--danger)' }}>
          Account name already exists. Select it from the list instead.
        </div>
      )}
    </div>
  )
}
