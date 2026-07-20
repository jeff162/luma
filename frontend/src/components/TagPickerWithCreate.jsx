// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../lib/api.js'
import { useDismissibleLayer } from '../lib/uiInteractions.js'
import { TagGlyph, TAG_COLOR_PALETTE } from './TagUi.jsx'
import { addTagToCache } from '../lib/useTags.js'

/*
 * Shared tag picker used wherever the user can attach tags — transaction rows,
 * the Categories page (group/leaf tags), and rule editing. The picker shows
 * existing tags as checkboxes and offers an inline "+ New tag" affordance so
 * users do not have to hop to Settings just to invent a new tag name.
 *
 * Newly created tags optimistically appear in the list with a tiny placeholder
 * id while the create request is in flight. Once the API returns, the parent
 * is notified via onTagCreated so the canonical tag list (with the real id)
 * can replace the placeholder. If creation fails, the placeholder is dropped.
 */
export default function TagPickerWithCreate({
  allTags,
  selectedTagIds,
  inheritedTagIds = null,
  // Tags the user has hidden on this transaction (inherited/rule opt-out). Render unchecked with a
  // "hidden here" affordance; re-checking restores them. Only the transaction pickers pass this — the
  // Categories/Rules pickers (which attach tags to a category/account, where the concept has no
  // meaning) omit it. When set, inherited tags also become uncheckable (unchecking blocks them).
  blockedTagIds = null,
  onToggleTag,
  onTagCreated,
  onClose,
  loading = false,
  emptyHint = 'No tags yet. Create one below.',
  positioning = 'absolute',
  align = 'right',
}) {
  const ref = useRef(null)
  const [createMode, setCreateMode] = useState(false)
  const [createName, setCreateName] = useState('')
  const [createColor, setCreateColor] = useState(TAG_COLOR_PALETTE[0])
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState('')
  const nameInputRef = useRef(null)

  useDismissibleLayer({
    open: true,
    onClose,
    refs: [ref],
  })

  useEffect(() => {
    if (createMode) nameInputRef.current?.focus()
  }, [createMode])

  const sortedTags = useMemo(
    () => [...(allTags || [])].sort((a, b) => {
      const orderA = Number(a?.sort_order) || 0
      const orderB = Number(b?.sort_order) || 0
      if (orderA !== orderB) return orderA - orderB
      return String(a?.name || '').localeCompare(String(b?.name || ''))
    }),
    [allTags],
  )

  const trimmedName = createName.trim()
  const nameAlreadyTaken = trimmedName !== '' && sortedTags.some(
    tag => String(tag.name || '').trim().toLowerCase() === trimmedName.toLowerCase(),
  )

  async function submitCreate() {
    if (!trimmedName || creating || nameAlreadyTaken) return
    setCreating(true)
    setCreateError('')
    try {
      const created = await api.createTag({ name: trimmedName, color: createColor })
      if (created?.id) {
        // Inline create is the one chokepoint for new tags, so fold it into the shared cache here —
        // every useTags() consumer (bulk edit, rule editor, …) then shows it without its own handler.
        addTagToCache(created)
        onTagCreated?.(created)
        // Auto-select the newly created tag so users do not have to click again.
        onToggleTag?.(created, true)
      }
      setCreateName('')
      setCreateMode(false)
    } catch (err) {
      setCreateError(err?.message || 'Failed to create tag')
    } finally {
      setCreating(false)
    }
  }

  const positionStyle = positioning === 'absolute'
    ? {
      position: 'absolute', zIndex: 520,
      top: '100%', marginTop: 4,
      ...(align === 'right' ? { right: 0 } : { left: 0 }),
    }
    : { position: 'relative' }

  return (
    <div
      ref={ref}
      style={{
        ...positionStyle,
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 10,
        boxShadow: positioning === 'absolute' ? '0 8px 24px rgba(0,0,0,0.3)' : 'none',
        padding: 10,
        minWidth: 240,
      }}
      onClick={event => event.stopPropagation()}
    >
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', marginBottom: 8 }}>
        Tags
      </div>
      {loading ? null : sortedTags.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>
          {emptyHint}
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 4, maxHeight: 240, overflowY: 'auto' }}>
          {sortedTags.map(tag => {
            const checked = selectedTagIds.has(tag.id)
            const inherited = !!inheritedTagIds && inheritedTagIds.has(tag.id)
            // In a transaction context (blockedTagIds supplied) inherited tags can be unchecked to
            // hide them on just this row, and hidden ones re-checked to restore. Outside it (Categories/
            // Rules pickers) inherited tags stay read-only — unchecking there would be meaningless.
            const blockable = !!blockedTagIds
            const blocked = blockable && blockedTagIds.has(tag.id)
            const readOnly = inherited && !blockable
            const title = blocked
              ? 'Hidden on this transaction — check to restore'
              : inherited
                ? (blockable
                  ? 'Inherited — uncheck to hide on just this transaction'
                  : 'Inherited from category — manage on the Categories page')
                : undefined
            return (
              <label
                key={tag.id}
                title={title}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  cursor: readOnly ? 'default' : 'pointer',
                  padding: '6px 2px', fontSize: 13,
                  opacity: readOnly ? 0.7 : 1,
                }}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={readOnly}
                  onChange={() => {
                    if (readOnly) return
                    onToggleTag?.(tag, !checked)
                  }}
                />
                <TagGlyph color={tag.color} size={13} outline={inherited || blocked} />
                <span style={{
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  ...(blocked ? { textDecoration: 'line-through', color: 'var(--muted)' } : {}),
                }}>
                  {tag.name}
                </span>
                {blocked ? (
                  <span style={{ fontSize: 10, color: 'var(--muted)', fontStyle: 'italic' }}>
                    hidden here
                  </span>
                ) : inherited ? (
                  <span style={{ fontSize: 10, color: 'var(--muted)', fontStyle: 'italic' }}>
                    inherited
                  </span>
                ) : null}
              </label>
            )
          })}
        </div>
      )}

      <div style={{ borderTop: '1px solid var(--border)', marginTop: 8, paddingTop: 8 }}>
        {createMode ? (
          <div style={{ display: 'grid', gap: 8 }}>
            <input
              ref={nameInputRef}
              type="text"
              value={createName}
              placeholder="New tag name"
              autoComplete="off"
              onChange={event => setCreateName(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  submitCreate()
                } else if (event.key === 'Escape') {
                  event.preventDefault()
                  setCreateMode(false)
                  setCreateName('')
                  setCreateError('')
                }
              }}
              style={{
                background: 'var(--surface2)', color: 'var(--text)',
                border: '1px solid var(--border)', borderRadius: 6,
                padding: '5px 8px', fontSize: 13, outline: 'none',
              }}
            />
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {TAG_COLOR_PALETTE.map(color => (
                <button
                  key={color}
                  type="button"
                  onClick={() => setCreateColor(color)}
                  title={color}
                  style={{
                    width: 18, height: 18, borderRadius: '50%',
                    border: createColor === color
                      ? '2px solid var(--text)'
                      : '1px solid color-mix(in srgb, ' + color + ' 50%, var(--border))',
                    background: color,
                    cursor: 'pointer', padding: 0,
                  }}
                />
              ))}
            </div>
            {nameAlreadyTaken ? (
              <div style={{ fontSize: 11, color: 'var(--danger)' }}>A tag with that name already exists.</div>
            ) : createError ? (
              <div style={{ fontSize: 11, color: 'var(--danger)' }}>{createError}</div>
            ) : null}
            <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
              <button
                type="button"
                onClick={() => { setCreateMode(false); setCreateName(''); setCreateError('') }}
                style={{
                  background: 'none', border: 'none', cursor: 'pointer',
                  color: 'var(--muted)', fontSize: 12, padding: '4px 8px',
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={submitCreate}
                disabled={!trimmedName || creating || nameAlreadyTaken}
                style={{
                  background: 'var(--accent)', color: '#fff',
                  border: 'none', borderRadius: 6,
                  padding: '4px 10px', fontSize: 12,
                  cursor: trimmedName && !creating && !nameAlreadyTaken ? 'pointer' : 'not-allowed',
                  opacity: trimmedName && !creating && !nameAlreadyTaken ? 1 : 0.5,
                }}
              >
                {creating ? 'Creating…' : 'Create & add'}
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setCreateMode(true)}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              color: 'var(--accent2)', fontSize: 13, padding: '4px 0',
              display: 'inline-flex', alignItems: 'center', gap: 4,
            }}
          >
            + New tag
          </button>
        )}
      </div>
    </div>
  )
}
