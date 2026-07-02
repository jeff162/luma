// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useState } from 'react'
import { AppDialog, Button, getFormControlStyle } from './ui.jsx'
import CategoryPicker from './CategoryPicker.jsx'
import TagPickerWithCreate from './TagPickerWithCreate.jsx'
import { api } from '../lib/api.js'

/*
 * Bulk edit form for a selection of transactions. Each field has an enable checkbox so an Apply only
 * touches the fields the user turned on; enabled fields are assembled into the ordered `actions` list
 * the bulk endpoint expects. Trash is intentionally not here — it's a destructive action the caller
 * surfaces separately with its own confirm. Tag add/remove uses inline chips (existing tags only) to
 * stay self-contained; per-row tag creation lives on the transaction rows.
 */
function FieldRow({ enabled, onToggle, label, children }) {
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
        <input type="checkbox" checked={enabled} onChange={e => onToggle(e.target.checked)} />
        {label}
      </label>
      {enabled ? <div style={{ paddingLeft: 24 }}>{children}</div> : null}
    </div>
  )
}

function TagChips({ tags, selected, onToggle, tone }) {
  if (tags.length === 0) return <div style={{ fontSize: 12, color: 'var(--muted)' }}>No tags defined yet.</div>
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      {tags.map(tag => {
        const on = selected.has(tag.id)
        return (
          <button
            key={tag.id}
            type="button"
            onClick={() => onToggle(tag.id)}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '4px 10px', borderRadius: 999, fontSize: 12, cursor: 'pointer',
              border: `1px solid ${on ? (tone === 'remove' ? 'var(--danger)' : 'var(--accent)') : 'var(--border)'}`,
              background: on
                ? `color-mix(in srgb, ${tone === 'remove' ? 'var(--danger)' : 'var(--accent)'} 16%, var(--surface2))`
                : 'var(--surface)',
              color: 'var(--text)',
            }}
          >
            <span style={{ width: 8, height: 8, borderRadius: 999, background: tag.color || 'var(--muted)' }} />
            {tag.name}
          </button>
        )
      })}
    </div>
  )
}

export default function BulkEditPanel({ count, categories = [], onApply, onCancel, applying = false }) {
  const [allTags, setAllTags] = useState([])
  const [setCategory, setSetCategory] = useState(false)
  const [categoryId, setCategoryId] = useState(null)
  const [doAddTags, setDoAddTags] = useState(false)
  const [addTagIds, setAddTagIds] = useState(() => new Set())
  const [doRemoveTags, setDoRemoveTags] = useState(false)
  const [removeTagIds, setRemoveTagIds] = useState(() => new Set())
  const [setNotes, setSetNotes] = useState(false)
  const [notesValue, setNotesValue] = useState('')
  const [setMerchant, setSetMerchant] = useState(false)
  const [merchantValue, setMerchantValue] = useState('')
  const [setDate, setSetDate] = useState(false)
  const [dateValue, setDateValue] = useState('')

  useEffect(() => {
    let cancelled = false
    api.getTags().then(rows => { if (!cancelled) setAllTags(rows || []) }).catch(() => {})
    return () => { cancelled = true }
  }, [])

  function toggleIn(setter) {
    return id => setter(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function buildActions() {
    const actions = []
    if (setCategory) actions.push({ type: 'set_category', category_id: categoryId || null })
    if (doAddTags && addTagIds.size) actions.push({ type: 'add_tags', tag_ids: [...addTagIds] })
    if (doRemoveTags && removeTagIds.size) actions.push({ type: 'remove_tags', tag_ids: [...removeTagIds] })
    if (setNotes) actions.push({ type: 'set_notes', notes: notesValue })          // empty clears
    if (setMerchant && merchantValue.trim()) actions.push({ type: 'set_merchant', merchant: merchantValue.trim() })
    if (setDate && dateValue) actions.push({ type: 'set_date', date: dateValue })
    return actions
  }

  const actions = buildActions()
  const canApply = actions.length > 0 && !applying

  return (
    <AppDialog
      title={`Edit ${count} transaction${count === 1 ? '' : 's'}`}
      description="Only the fields you enable are changed. Drag the header to move this aside and see the transactions."
      onClose={onCancel}
      width="min(560px, 100%)"
      draggable
      actions={(
        <>
          <Button variant="ghost" onClick={onCancel}>Cancel</Button>
          <Button onClick={() => onApply(actions)} disabled={!canApply}>
            {applying ? 'Applying…' : `Apply to ${count}`}
          </Button>
        </>
      )}
    >
      <FieldRow enabled={setCategory} onToggle={setSetCategory} label="Set category">
        <CategoryPicker
          value={categoryId}
          categories={categories}
          placeholder="Choose a category…"
          showSelectedBadge
          panelZIndex={1300}
          onChange={value => setCategoryId(value)}
        />
      </FieldRow>

      <FieldRow enabled={doAddTags} onToggle={setDoAddTags} label="Add tags">
        {/* Shared picker so a brand-new tag can be invented and added here too — "everywhere a tag can be
            assigned, it can be created" (same affordance as the rows / detail panel / rule editor). Remove
            tags stays existing-only chips: you can't create a tag in order to strip it. */}
        <TagPickerWithCreate
          allTags={allTags}
          selectedTagIds={addTagIds}
          onToggleTag={(tag, present) => setAddTagIds(prev => {
            const next = new Set(prev)
            if (present) next.add(tag.id)
            else next.delete(tag.id)
            return next
          })}
          onTagCreated={created => setAllTags(prev => (
            prev.some(tag => tag.id === created.id) ? prev : [...prev, created]
          ))}
          onClose={() => {}}
          positioning="relative"
        />
      </FieldRow>

      <FieldRow enabled={doRemoveTags} onToggle={setDoRemoveTags} label="Remove tags">
        <TagChips tags={allTags} selected={removeTagIds} onToggle={toggleIn(setRemoveTagIds)} tone="remove" />
      </FieldRow>

      <FieldRow enabled={setNotes} onToggle={setSetNotes} label="Set notes">
        <input
          value={notesValue}
          onChange={e => setNotesValue(e.target.value)}
          placeholder="Note text (leave empty to clear)"
          style={{ ...getFormControlStyle({ size: 'md' }), width: '100%' }}
        />
      </FieldRow>

      <FieldRow enabled={setMerchant} onToggle={setSetMerchant} label="Set merchant name">
        <input
          value={merchantValue}
          onChange={e => setMerchantValue(e.target.value)}
          placeholder="Display name, e.g. Amazon"
          style={{ ...getFormControlStyle({ size: 'md' }), width: '100%' }}
        />
      </FieldRow>

      <FieldRow enabled={setDate} onToggle={setSetDate} label="Set date">
        <input
          type="date"
          value={dateValue}
          onChange={e => setDateValue(e.target.value)}
          style={{ ...getFormControlStyle({ size: 'md' }) }}
        />
      </FieldRow>
    </AppDialog>
  )
}
