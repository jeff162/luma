// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: GPL-3.0-or-later

// Small prop-driven presentational pieces for the import rule-suggestion review surface, extracted
// from ImportRuleSuggestionReview.jsx: the progress-summary pill, the status badge, the action
// button, the merchant/keyword criteria group, the editable filter pill, and the inline-editable
// keyword. They hold no state beyond local edit-focus restoration; the parent owns all data.

import { useEffect, useRef } from 'react'
import { Button } from '../ui.jsx'
import TransientTextInput from '../TransientTextInput.jsx'
import {
  getSharedPillCornerRemoveButtonStyle,
  getSharedPillLabelStyle,
  getSharedPillStyle,
} from '../pillStyles.js'
import { getStatusPalette, getStatusSymbol } from '../../lib/importRuleSuggestions.js'

export function ProgressPill({ label, value, tone = 'default', active = false, onClick, disabled = false }) {
  const palette = getStatusPalette(tone)
  const symbol = getStatusSymbol(tone)
  const content = (
    <span style={{
      position: 'relative',
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      padding: '6px 10px',
      borderRadius: 999,
      border: `1px solid ${active ? `color-mix(in srgb, ${palette.border} 70%, white 14%)` : palette.border}`,
      background: palette.background,
      color: palette.color,
      fontSize: 12,
      fontWeight: 600,
      boxShadow: active ? '0 8px 18px rgba(15, 23, 42, 0.14)' : 'none',
      opacity: disabled ? 0.5 : 1,
    }}>
      {symbol ? (
        <span style={{
          position: 'absolute',
          top: -6,
          right: -6,
          width: 16,
          height: 16,
          borderRadius: 999,
          border: `1px solid ${palette.border}`,
          background: palette.background,
          color: palette.color,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: tone === 'discarded' ? 11 : 10,
          fontWeight: 700,
          lineHeight: 1,
          boxShadow: '0 3px 8px rgba(15, 23, 42, 0.12)',
        }}>
          {symbol}
        </span>
      ) : null}
      <span>{value}</span>
      <span style={{ fontWeight: 500 }}>{label}</span>
    </span>
  )
  if (!onClick) return content
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{ background: 'none', border: 'none', padding: 0, cursor: disabled ? 'not-allowed' : 'pointer' }}
    >
      {content}
    </button>
  )
}

// The shared "opens a report" affordance: a small boxed ↗ glyph — the app-wide signal that a count
// drills into a report (matching the import file cards' rejected-rows / duplicates pattern). Pair it
// with a plain count label rather than turning the label itself into an underlined link, so every
// report launcher in the rule-suggestion review reads the same.
export function ReportArrowButton({ onClick, title = 'Open matching transactions report' }) {
  return (
    <button
      type="button"
      aria-label={title}
      title={title}
      onClick={onClick}
      style={{
        border: '1px solid var(--border)',
        background: 'var(--surface2)',
        color: 'var(--accent2)',
        borderRadius: 6,
        width: 18,
        height: 18,
        padding: 0,
        fontSize: 11,
        lineHeight: 1,
        cursor: 'pointer',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
      }}
    >
      &#8599;
    </button>
  )
}

export function SuggestionStatusBadge({ label, tone, left = 14 }) {
  const palette = getStatusPalette(tone)
  const symbol = getStatusSymbol(tone)
  return (
    <div style={{
      position: 'absolute',
      top: 10,
      left,
      width: 22,
      height: 22,
      borderRadius: 999,
      border: `1px solid ${palette.border}`,
      background: palette.background,
      color: palette.color,
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontSize: tone === 'discarded' ? 13 : 11.5,
      fontWeight: 700,
      lineHeight: 1,
      zIndex: 1,
      boxShadow: '0 4px 10px rgba(15, 23, 42, 0.12)',
    }} title={label}>
      {symbol}
    </div>
  )
}

export function SuggestionActionButton({ children, onClick, active = false, disabled = false, style }) {
  return (
    <Button
      small
      variant="ghost"
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      style={{
        border: `1px solid ${active ? 'color-mix(in srgb, var(--accent) 42%, var(--border))' : 'color-mix(in srgb, var(--border) 72%, white 12%)'}`,
        background: active
          ? 'linear-gradient(180deg, color-mix(in srgb, var(--accent) 16%, var(--surface2)), color-mix(in srgb, var(--accent) 8%, var(--surface)))'
          : 'linear-gradient(180deg, color-mix(in srgb, var(--surface2) 96%, white 4%), color-mix(in srgb, var(--surface2) 84%, var(--surface)))',
        color: active ? 'var(--accent2)' : 'var(--text)',
        boxShadow: active
          ? '0 8px 18px rgba(15, 23, 42, 0.16)'
          : '0 4px 12px rgba(15, 23, 42, 0.10), inset 0 1px 0 rgba(255,255,255,0.04)',
        opacity: disabled ? 0.45 : 1,
        ...style,
      }}
    >
      {children}
    </Button>
  )
}

export function CriteriaGroup({
  merchantLabel,
  keyword,
  filterPills,
  onRemoveFilter,
  editing,
  draftValue,
  onEditSuggestion,
  onBeginKeywordEdit,
  onKeywordChange,
  onKeywordCommit,
  onKeywordCancel,
}) {
  return (
    <span style={{
      display: 'inline-flex',
      flexDirection: 'column',
      alignItems: 'flex-start',
      gap: 4,
      maxWidth: '100%',
    }}>
      <span style={{
        ...getSharedPillStyle({ tone: 'accent' }),
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        flexWrap: 'wrap',
        minWidth: 0,
        maxWidth: '100%',
        padding: '5px 10px',
      }}>
        <button
          type="button"
          onClick={onEditSuggestion}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            minWidth: 0,
            background: 'none',
            border: 'none',
            padding: 0,
            cursor: 'pointer',
            color: 'inherit',
            textAlign: 'left',
          }}
        >
          <span style={{ fontSize: 14, fontWeight: 600, lineHeight: 1.3 }}>
            {merchantLabel}
          </span>
        </button>
        <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--muted)', lineHeight: 1.4 }}>
          contains
        </span>
        <EditableKeyword
          value={keyword}
          editing={editing}
          draftValue={draftValue}
          onBeginEdit={onBeginKeywordEdit}
          onChange={onKeywordChange}
          onCommit={onKeywordCommit}
          onCancel={onKeywordCancel}
        />
      </span>
      {filterPills.length > 0 ? (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', paddingLeft: 24 }}>
          {filterPills.map(filter => (
            <SuggestionPill
              key={filter.key}
              label={filter.label}
              tone="accent"
              onRemove={filter.actionKey ? () => onRemoveFilter?.(filter.actionKey) : undefined}
            />
          ))}
        </span>
      ) : null}
    </span>
  )
}

export function SuggestionPill({
  label,
  tone = 'default',
  onRemove,
  onClick,
  onMouseDown,
  editing = false,
  editValue = '',
  onEditValueChange,
  onEditCommit,
  onEditCancel,
  maxWidth,
  title,
}) {
  const pillTone = tone === 'muted' ? 'default' : 'accent'
  const LabelTag = onClick && !editing ? 'button' : 'span'
  const labelRef = useRef(null)
  const restoreFocusRef = useRef(false)

  useEffect(() => {
    if (!editing && restoreFocusRef.current) {
      labelRef.current?.focus()
      restoreFocusRef.current = false
    }
  }, [editing])

  return (
    <span
      title={title}
      style={{ ...getSharedPillStyle({ tone: pillTone }), position: 'relative', maxWidth, minWidth: 0 }}
    >
      {editing ? (
        <TransientTextInput
          value={editValue}
          onChange={nextValue => onEditValueChange?.(nextValue)}
          onCommit={() => onEditCommit?.()}
          onCancel={() => {
            restoreFocusRef.current = true
            onEditCancel?.()
          }}
          restoreOnEscape
          onKeyDown={event => event.stopPropagation()}
          style={{
            ...getSharedPillLabelStyle({ muted: tone === 'muted' }),
            minWidth: 150,
            background: 'none',
            border: 'none',
            padding: 0,
            outline: 'none',
          }}
        />
      ) : (
        <LabelTag
          ref={labelRef}
          type={onClick ? 'button' : undefined}
          onMouseDown={event => {
            if (!onMouseDown) return
            event.stopPropagation()
            event.preventDefault()
            onMouseDown()
          }}
          onClick={event => {
            event.stopPropagation()
            onClick?.()
          }}
          style={{
            ...getSharedPillLabelStyle({ muted: tone === 'muted' }),
            ...(onClick ? {
              background: 'none',
              border: 'none',
              padding: 0,
              cursor: 'pointer',
              textAlign: 'left',
            } : {}),
            ...(maxWidth ? { overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 } : {}),
          }}
        >
          {label}
        </LabelTag>
      )}
      {onRemove ? (
        <button
          type="button"
          onClick={event => {
            event.stopPropagation()
            onRemove()
          }}
          title={`Remove ${label}`}
          style={getSharedPillCornerRemoveButtonStyle()}
        >
          ×
        </button>
      ) : null}
    </span>
  )
}

export function EditableKeyword({ value, editing, draftValue, onBeginEdit, onChange, onCommit, onCancel }) {
  const triggerRef = useRef(null)
  const restoreFocusRef = useRef(false)

  useEffect(() => {
    if (!editing && restoreFocusRef.current) {
      triggerRef.current?.focus()
      restoreFocusRef.current = false
    }
  }, [editing])

  if (editing) {
    return (
      <TransientTextInput
        value={draftValue}
        onChange={onChange}
        onCommit={onCommit}
        onCancel={() => {
          restoreFocusRef.current = true
          onCancel()
        }}
        restoreOnEscape
        onKeyDown={event => event.stopPropagation()}
        style={{
          fontSize: 12,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
          background: 'color-mix(in srgb, var(--surface2) 90%, var(--surface))',
          color: 'var(--text)',
          border: '1px solid color-mix(in srgb, var(--accent) 24%, var(--border))',
          borderRadius: 8,
          padding: '4px 8px',
          minWidth: 120,
          outline: 'none',
        }}
      />
    )
  }

  return (
    <button
      ref={triggerRef}
      type="button"
      onClick={onBeginEdit}
      style={{
        background: 'none',
        border: 'none',
        padding: 0,
        margin: 0,
        cursor: 'pointer',
        color: 'inherit',
      }}
    >
      <code style={{ fontSize: 12 }}>{value}</code>
    </button>
  )
}
