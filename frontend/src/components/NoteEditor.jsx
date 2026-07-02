// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useState } from 'react'
import TransientTextInput from './TransientTextInput.jsx'

/*
 * Shared transaction-note editor. Both surfaces that edit a note — the right-click note popover
 * and the transaction detail panel — render this so note editing reads the same everywhere: a
 * multi-line field where ⌘/Ctrl+Enter saves (plain Enter inserts a newline, since the value can be
 * multi-line), Escape cancels the edit, and Save stays dimmed until there is an unsaved change.
 *
 * Persistence stays with the host: onSave(next) receives the trimmed note (or null to clear) and
 * returns a promise; the host owns the API call and any list reconciliation. onCancel is optional —
 * when provided (the popover) a Cancel button shows and Escape also dismisses; without it (the
 * embedded detail-panel field) Escape just reverts the draft in place.
 */
export default function NoteEditor({ value, onSave, onCancel, autoFocus = false }) {
  const saved = value || ''
  const [draft, setDraft] = useState(saved)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    // Hydrate from the persisted note when it changes (after a save, or when the host swaps the
    // target transaction), but never clobber an in-flight edit.
    if (!saving) setDraft(saved)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, saving])

  const dirty = draft.trim() !== saved
  const hasNote = saved.length > 0

  async function save(next) {
    if (saving) return
    setSaving(true)
    try {
      await onSave?.(next)
    } catch (err) {
      console.error('Failed to save transaction note', err)
    } finally {
      setSaving(false)
    }
  }

  function cancel() {
    setDraft(saved)
    onCancel?.()
  }

  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <TransientTextInput
        multiline
        rows={3}
        value={draft}
        onChange={setDraft}
        onCancel={cancel}
        onBlurCommit={false}
        autoFocus={autoFocus}
        onKeyDown={event => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            if (dirty) save(draft.trim() || null)
          }
        }}
        placeholder="Add a note…"
        style={{
          width: '100%',
          boxSizing: 'border-box',
          resize: 'vertical',
          background: 'var(--surface2)',
          color: 'var(--text)',
          border: '1px solid var(--border)',
          borderRadius: 8,
          padding: '8px 10px',
          fontSize: 13,
          outline: 'none',
        }}
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button
          type="button"
          onClick={() => save(draft.trim() || null)}
          disabled={saving || !dirty}
          style={{
            background: dirty ? 'var(--accent)' : 'var(--surface)',
            color: dirty ? '#fff' : 'var(--muted)',
            border: dirty ? 'none' : '1px solid var(--border)',
            borderRadius: 8,
            padding: '6px 12px',
            fontSize: 12,
            cursor: dirty && !saving ? 'pointer' : 'default',
          }}
        >
          {saving ? 'Saving…' : 'Save note'}
        </button>
        {onCancel ? (
          <button
            type="button"
            onClick={cancel}
            style={{
              background: 'var(--surface)',
              color: 'var(--muted)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              padding: '6px 10px',
              fontSize: 12,
              cursor: 'pointer',
            }}
          >
            Cancel
          </button>
        ) : null}
        {hasNote ? (
          <button
            type="button"
            onClick={() => save(null)}
            disabled={saving}
            style={{
              marginLeft: 'auto',
              background: 'none',
              border: 'none',
              color: 'var(--danger)',
              fontSize: 12,
              cursor: saving ? 'default' : 'pointer',
              padding: '6px 4px',
            }}
          >
            Remove
          </button>
        ) : null}
      </div>
    </div>
  )
}
