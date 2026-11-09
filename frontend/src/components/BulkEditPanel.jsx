// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from 'react'
import { Button, FilterChip, SegmentedToggle, getFormControlStyle } from './ui.jsx'
import FloatingDialog from './FloatingDialog.jsx'
import CategoryPicker from './CategoryPicker.jsx'
import TagPickerWithCreate from './TagPickerWithCreate.jsx'
import { useTags } from '../lib/useTags.js'

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
          <FilterChip
            key={tag.id}
            selected={on}
            tone={tone === 'remove' ? 'danger' : undefined}
            onClick={() => onToggle(tag.id)}
          >
            <span style={{ width: 8, height: 8, borderRadius: 999, background: tag.color || 'var(--muted)' }} />
            {tag.name}
          </FilterChip>
        )
      })}
    </div>
  )
}

export default function BulkEditPanel({ count, categories = [], onApply, onCancel, applying = false }) {
  const { tags: allTags, addTag } = useTags()
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
  const [setReview, setSetReview] = useState(false)
  // false = mark reviewed (clears the flag), true = flag for another look. Reviewed is the common case.
  const [reviewNeedsReview, setReviewNeedsReview] = useState(false)


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
    if (setReview) actions.push({ type: 'set_review_status', needs_review: reviewNeedsReview })
    return actions
  }

  const actions = buildActions()
  const canApply = actions.length > 0 && !applying

  return (
    <FloatingDialog
      panelKey="ui.bulkEdit.panel"
      title={`Edit ${count} transaction${count === 1 ? '' : 's'}`}
      description="Only the fields you enable are changed. Drag the header to move this aside and see the transactions."
      onClose={onCancel}
      width={560}
      actions={(
        <>
          <Button variant="secondary" onClick={onCancel}>Cancel</Button>
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
          onTagCreated={addTag}
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

      <FieldRow enabled={setReview} onToggle={setSetReview} label="Set review status">
        <SegmentedToggle
          size="compact"
          ariaLabel="Review status"
          value={reviewNeedsReview ? 'needs_review' : 'reviewed'}
          onChange={v => setReviewNeedsReview(v === 'needs_review')}
          options={[
            { value: 'reviewed', label: 'Reviewed' },
            { value: 'needs_review', label: 'Needs review' },
          ]}
        />
      </FieldRow>
    </FloatingDialog>
  )
}
