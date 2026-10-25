// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useState } from 'react'
import TransientTextInput from './TransientTextInput.jsx'
import { Button, LinkButton } from './ui.jsx'

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
  // Inline rather than a dialog: this renders inside a popover and inside the detail panel, so the note
  // to deliver — "still unsaved, here is why" — belongs next to the text it is about, not over it. It
  // doubles as the flag that keeps the failed draft on screen; see the hydration effect.
  const [saveError, setSaveError] = useState('')

  useEffect(() => {
    // Hydrate from the persisted note when it changes (after a save, or when the host swaps the
    // target transaction), but never clobber an in-flight edit — or a *failed* one. `saving` alone
    // used to be the guard, which meant a rejected save flipped it back to false and this effect
    // immediately overwrote the user's typed note with the unchanged persisted value: the edit was
    // discarded, silently, at exactly the moment it needed to be kept for a retry. `saveError` is
    // deliberately not a dependency — clearing it as the user types must not re-run the hydration
    // it is suppressing.
    if (!saving && !saveError) setDraft(saved)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, saving])

  const dirty = draft.trim() !== saved
  const hasNote = saved.length > 0

  async function save(next) {
    if (saving) return
    setSaving(true)
    setSaveError('')
    try {
      await onSave?.(next)
    } catch (err) {
      setSaveError(err?.message || 'The note could not be saved.')
    } finally {
      setSaving(false)
    }
  }

  function cancel() {
    setDraft(saved)
    setSaveError('')
    onCancel?.()
  }

  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <TransientTextInput
        multiline
        rows={3}
        value={draft}
        onChange={next => { setDraft(next); if (saveError) setSaveError('') }}
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
        <Button onClick={() => save(draft.trim() || null)} disabled={saving || !dirty}>
          {saving ? 'Saving…' : 'Save note'}
        </Button>
        {onCancel ? (
          <Button variant="secondary" onClick={cancel}>
            Cancel
          </Button>
        ) : null}
        {hasNote ? (
          <LinkButton tone="danger" onClick={() => save(null)} disabled={saving} style={{ marginLeft: 'auto', fontSize: 12, padding: '6px 4px' }}>
            Remove
          </LinkButton>
        ) : null}
      </div>
      {saveError ? (
        <div style={{ color: 'var(--danger)', fontSize: 12 }}>
          {saveError} The note is still unsaved.
        </div>
      ) : null}
    </div>
  )
}
