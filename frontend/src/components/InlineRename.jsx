// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from 'react'
import { useTransientTextEdit } from '../lib/uiInteractions.js'
import TransientTextInput from './TransientTextInput.jsx'

/*
 * A name shown as text that is clicked to rename in place, for a heading or label whose value is saved on
 * its own (`onRename(name)`, a promise). Commits on blur or Enter and reverts on Escape, as every in-place
 * rename does (`TransientTextInput`). A save that fails keeps the field open, outlined, with the reason on
 * hover. The field takes the text's font and line height, so the row around it keeps its height.
 *
 * `value` is what is stored ('' for nothing); `shown` is what reads when idle, which may be a fallback such
 * as the provider's own name, and is also the field's placeholder. Clearing the field passes ''.
 */
export default function InlineRename({ value = '', shown, onRename, ariaLabel, title, style }) {
  const [error, setError] = useState('')
  const name = useTransientTextEdit(value, {
    onCommit: onRename,
    onCommitError: err => setError(err?.message || 'Could not save that name'),
    // Committing the fallback unchanged is not naming it.
    normalize: next => (!value && next.trim() === shown ? '' : next.trim()),
    allowEmpty: true,
  })
  if (name.editing) {
    return (
      <TransientTextInput
        value={name.draft}
        onChange={next => { setError(''); name.setDraft(next) }}
        onCommit={name.commitEdit}
        onCancel={() => { setError(''); name.cancelEdit() }}
        restoreOnEscape
        onFocus={event => event.target.select()}
        onClick={event => event.stopPropagation()}
        aria-label={ariaLabel}
        aria-invalid={error ? 'true' : undefined}
        title={error || undefined}
        placeholder={shown}
        style={{
          ...style,
          font: 'inherit', lineHeight: 'inherit', color: 'var(--text)', background: 'var(--surface)',
          border: 'none', borderRadius: 4, padding: '0 4px', margin: '0 -4px', outline: 'none',
          boxShadow: `0 0 0 1px ${error ? 'var(--danger)' : 'var(--accent)'}`,
          width: `${Math.min(Math.max(name.draft.length, (shown || '').length, 8), 48) + 2}ch`,
          maxWidth: '100%',
        }}
      />
    )
  }
  return (
    <button
      type="button"
      onClick={event => { event.stopPropagation(); setError(''); name.beginEdit(value || shown || '') }}
      title={title}
      style={{
        ...style,
        font: 'inherit', color: 'inherit', background: 'none', border: 'none', padding: 0, margin: 0,
        cursor: 'text', textAlign: 'left',
      }}
    >
      {shown}
    </button>
  )
}
