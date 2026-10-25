// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState, useEffect, useId, useRef } from 'react'
import { api } from '../lib/api.js'
import FeatureExplainer from '../help/FeatureExplainer.jsx'
import { AppDialog, Button, Spinner, getFormControlStyle, AppConfirmDialog, IconButton } from './ui.jsx'
import { useTransientTextEdit } from '../lib/uiInteractions.js'
import TransientTextInput from './TransientTextInput.jsx'
import { TagGlyph, TAG_COLOR_PALETTE } from './TagUi.jsx'
import { invalidateTags } from '../lib/useTags.js'

// `compact` shrinks the swatches and tightens the gap so the full 18-color palette fits on a single
// row in the narrow per-tag palette column (the tag list); the add-tag form spans the dialog width and
// keeps the roomier default targets.
function TagColorPalette({ value, onChange, compact = false, align = 'flex-start' }) {
  const swatch = compact ? 22 : 28
  const glyph = compact ? 12 : 14
  const gap = compact ? 4 : 6
  // `align='flex-end'` (used by the tag list) pins the palette to the right of its column so every
  // row's swatches line up in shared columns regardless of label width, and leaves the grid gap
  // before the delete button. A long label still shrinks the column and wraps the swatches.
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap, justifyContent: align }}>
      {TAG_COLOR_PALETTE.map(color => {
        const selected = value === color
        return (
          <button
            key={color}
            type="button"
            onClick={() => onChange(color)}
            title={color}
            style={{
              width: swatch,
              height: swatch,
              borderRadius: 999,
              border: `1px solid ${selected ? 'var(--accent)' : 'var(--border)'}`,
              background: selected
                ? 'color-mix(in srgb, var(--accent) 10%, var(--surface2))'
                : 'var(--surface2)',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              padding: 0,
            }}
          >
            <TagGlyph color={color} size={glyph} />
          </button>
        )
      })}
    </div>
  )
}

function EditableTagName({ tag, onCommit }) {
  const {
    editing,
    draft,
    setDraft,
    beginEdit,
    cancelEdit,
    commitEdit,
  } = useTransientTextEdit(tag.name || '', { onCommit })

  if (editing) {
    return (
      <TransientTextInput
        value={draft}
        onChange={setDraft}
        onCommit={commitEdit}
        onCancel={cancelEdit}
        restoreOnEscape
        style={{
          background: 'var(--surface)',
          color: 'var(--text)',
          border: '1px solid var(--accent)',
          borderRadius: 999,
          padding: '4px 10px',
          fontSize: 13,
          fontWeight: 600,
          lineHeight: 1.2,
          minWidth: 120,
          outline: 'none',
        }}
      />
    )
  }

  return (
    <button
      type="button"
      onClick={() => beginEdit(tag.name || '')}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        background: 'var(--surface2)',
        color: 'var(--text)',
        border: '1px solid var(--border)',
        borderRadius: 999,
        padding: '4px 10px',
        fontSize: 13,
        fontWeight: 600,
        lineHeight: 1.2,
        cursor: 'text',
      }}
    >
      <TagGlyph color={tag.color} size={13} />
      <span>{tag.name}</span>
    </button>
  )
}

/*
 * The tag manager: add, rename, recolour and delete tags. Opened from the Transactions page, whose rows
 * are where tags show.
 *
 * `onClose` is passed `{ changed }` — true when a tag those rows may be showing was renamed, recoloured or
 * deleted, so the host can refetch them.
 */
export default function TagsDialog({ onClose }) {
  const fieldIdBase = useId()
  const changedRef = useRef(false)
  const [tags, setTags] = useState([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')
  const [pendingDeleteTag, setPendingDeleteTag] = useState(null)
  const [form, setForm] = useState({
    name: '',
    color: TAG_COLOR_PALETTE[0],
  })

  async function load() {
    setLoading(true)
    try {
      setTags(await api.getTags())
      setError('')
    } catch (err) {
      setError(err.message || 'Failed to load tags')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  async function handleCreate(event) {
    event.preventDefault()
    setCreating(true)
    setError('')
    try {
      const created = await api.createTag(form)
      setTags(prev => [...prev, created].sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name)))
      setForm({ name: '', color: form.color })
      invalidateTags()  // keep the shared tag-picker cache (useTags) in step with this management edit
    } catch (err) {
      setError(err.message || 'Failed to create tag')
    } finally {
      setCreating(false)
    }
  }

  async function handleUpdateTag(tagId, payload) {
    try {
      const updated = await api.updateTag(tagId, payload)
      setTags(prev => prev.map(tag => tag.id === tagId ? updated : tag))
      setError('')
      changedRef.current = true
      invalidateTags()
    } catch (err) {
      setError(err.message || 'Failed to update tag')
      throw err
    }
  }

  async function handleDeleteTag(tag) {
    setPendingDeleteTag(null)
    try {
      await api.deleteTag(tag.id)
      setTags(prev => prev.filter(item => item.id !== tag.id))
      setError('')
      changedRef.current = true
      invalidateTags()
    } catch (err) {
      setError(err.message || 'Failed to delete tag')
    }
  }

  return (
    <>
      <AppDialog
        title={(
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            Tags
            <FeatureExplainer topic="tags" placement="bottom-left" />
          </span>
        )}
        description="Tags are lightweight labels you can add manually or through rules. They show up on transaction rows and can filter dashboard views and exports."
        onClose={() => onClose({ changed: changedRef.current })}
        width="min(760px, 100%)"
        bodyPadding={0}
        bodyStyle={{ gap: 0 }}
        actions={<Button onClick={() => onClose({ changed: changedRef.current })}>Close</Button>}
      >
        <form onSubmit={handleCreate} style={{ display: 'grid', gap: 12, padding: '16px 20px', borderBottom: '1px solid var(--border)' }}>
          <input
            id={`${fieldIdBase}-tag-name`}
            name="new-tag-name"
            value={form.name}
            onChange={event => setForm(prev => ({ ...prev, name: event.target.value }))}
            placeholder="Tag name"
            aria-label="Tag name"
            style={{ ...getFormControlStyle({ size: 'md', surface: 'base' }), width: '100%' }}
          />
          <div style={{ display: 'grid', gap: 8 }}>
            <div style={{ fontSize: 11, color: 'var(--muted)', display: 'block' }}>Color</div>
            <TagColorPalette
              value={form.color}
              onChange={color => setForm(prev => ({ ...prev, color }))}
            />
          </div>
          <div>
            <Button type="submit" disabled={creating || !form.name.trim()}>
              {creating ? 'Saving...' : 'Add tag'}
            </Button>
          </div>
        </form>

        {error ? (
          <div style={{ padding: '10px 20px', color: 'var(--danger)', fontSize: 13, borderBottom: '1px solid var(--border)' }}>
            {error}
          </div>
        ) : null}

        {loading && tags.length === 0 ? <Spinner /> : tags.length === 0 ? (
          <div style={{ padding: '18px 20px', color: 'var(--muted)', fontSize: 13 }}>
            No tags created yet.
          </div>
        ) : (
          tags.map((tag, index) => (
            <div
              key={tag.id}
              style={{
                // Label keeps a guaranteed minimum so it can never be squeezed to
                // nothing; the palette column takes the remaining width and wraps to
                // additional rows (flexWrap) rather than expanding over the label.
                display: 'grid',
                gridTemplateColumns: 'minmax(130px, max-content) minmax(0, 1fr) auto',
                gap: 12,
                alignItems: 'center',
                padding: '8px 20px',
                // The dialog's footer rules off the last row itself.
                borderBottom: index === tags.length - 1 ? 'none' : '1px solid var(--border)',
              }}
            >
              <EditableTagName
                tag={tag}
                onCommit={name => handleUpdateTag(tag.id, { name })}
              />
              <TagColorPalette
                value={tag.color}
                onChange={color => handleUpdateTag(tag.id, { color })}
                compact
                align="flex-end"
              />
              <IconButton tone="danger" onClick={() => setPendingDeleteTag(tag)} aria-label={`Delete tag ${tag.name}`} style={{ fontSize: 18 }}>
                ×
              </IconButton>
            </div>
          ))
        )}
      </AppDialog>

      {/* After the dialog, so it stacks above it. */}
      {pendingDeleteTag ? (
        <AppConfirmDialog
          title="Delete tag?"
          description={`Delete tag "${pendingDeleteTag.name}"? Existing transaction assignments will be removed too.`}
          confirmLabel="Delete"
          confirmVariant="danger"
          borderColor="color-mix(in srgb, var(--danger) 35%, var(--border))"
          onConfirm={() => handleDeleteTag(pendingDeleteTag)}
          onCancel={() => setPendingDeleteTag(null)}
          width="min(500px, 100%)"
        />
      ) : null}
    </>
  )
}
