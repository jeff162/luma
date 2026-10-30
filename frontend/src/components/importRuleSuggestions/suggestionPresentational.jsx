// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// Small prop-driven presentational pieces for the import rule-suggestion review surface, extracted
// from ImportRuleSuggestionReview.jsx: the progress-summary pill, the status badge, the action
// button, the merchant/keyword criteria group, the editable filter pill, and the inline-editable
// keyword. They hold no state beyond local edit-focus restoration; the parent owns all data.

import { useEffect, useRef } from 'react'
import { Button, IconButton, Tooltip } from '../ui.jsx'
import TransientTextInput from '../TransientTextInput.jsx'
import {
  getSharedPillCornerRemoveButtonStyle,
  getSharedPillLabelStyle,
  getSharedPillStyle,
} from '../pillStyles.js'
import { getStatusPalette, getStatusSymbol } from '../../lib/importRuleSuggestions.js'

// `title` explains where the pill's contents come from, on hover — the filter's own description is only
// rendered once it's the *active* view, which is too late for the pill you don't understand yet.
export function ProgressPill({ label, value, tone = 'default', active = false, onClick, disabled = false, title = undefined }) {
  const palette = getStatusPalette(tone)
  const symbol = getStatusSymbol(tone)
  const content = (
    <span className="ui-pill-face" style={{
      position: 'relative',
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      padding: '6px 10px',
      borderRadius: 999,
      border: `1px solid ${active ? `color-mix(in srgb, ${palette.border} 82%, var(--text) 18%)` : palette.border}`,
      background: active
        ? `linear-gradient(180deg, color-mix(in srgb, ${palette.color} 18%, var(--surface2)), ${palette.background})`
        : palette.background,
      color: palette.color,
      fontSize: 12,
      fontWeight: active ? 750 : 600,
      boxShadow: active
        ? `0 0 0 2px color-mix(in srgb, ${palette.border} 34%, transparent), 0 10px 22px rgba(15, 23, 42, 0.18), inset 0 1px 0 rgba(255,255,255,0.12)`
        : 'none',
      opacity: disabled ? 0.5 : 1,
      transform: active ? 'translateY(-1px)' : 'none',
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
      <span style={{ fontWeight: active ? 700 : 500 }}>{label}</span>
    </span>
  )
  if (!onClick) return title ? <span title={title}>{content}</span> : content
  return (
    <button
      type="button"
      className="ui-pill-host"
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{ background: 'none', border: 'none', padding: 0, cursor: disabled ? 'not-allowed' : 'pointer' }}
    >
      {content}
    </button>
  )
}

// The "opens a report" affordance in the rule-suggestion review: a `↗` beside a plain count label rather
// than an underlined count, so every report launcher here reads the same.
export function ReportArrowButton({ onClick, title = 'Open matching transactions report' }) {
  return (
    <IconButton size="compact" tone="accent" aria-label={title} onClick={onClick} style={{ flexShrink: 0 }}>
      &#8599;
    </IconButton>
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
    <Button variant="secondary" pressed={active} onClick={onClick} disabled={disabled} style={style}>
      {children}
    </Button>
  )
}

// The per-row disposition action cluster, shared so a suggestion's status buttons read and behave the
// same whether it renders as a full card or as a row in a settled-view conflict table. Row buttons act
// on this one suggestion only (the bulk-actions bar owns the selection). The
// handlers and `editingSuggestionId` are owned by the parent; this component is pure layout.
export function SuggestionDispositionActions({
  suggestion,
  resolvedSuggestion,
  editingSuggestionId,
  onEditSuggestion,
  runRowStatusAction,
  runRowSaveAction,
  onRejectSuggestionDisposition,
  align = 'flex-end',
  editLabel = 'Open Rule Editor',
  editOpenLabel = 'Rule Editor Open',
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flexShrink: 0, alignItems: align }}>
      {suggestion.review_status === 'discarded' ? (
        <SuggestionActionButton onClick={() => runRowStatusAction(suggestion, resolvedSuggestion, 'pending')}>
          Restore
        </SuggestionActionButton>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: align }}>
            <SuggestionActionButton onClick={() => onEditSuggestion(suggestion.id)} active={editingSuggestionId === suggestion.id}>
              {editingSuggestionId === suggestion.id ? editOpenLabel : editLabel}
            </SuggestionActionButton>
            {suggestion.review_status === 'skipped' ? (
              <SuggestionActionButton onClick={() => runRowStatusAction(suggestion, resolvedSuggestion, 'pending')}>
                Resume
              </SuggestionActionButton>
            ) : (
              <SuggestionActionButton onClick={() => runRowStatusAction(suggestion, resolvedSuggestion, 'skipped')}>
                Defer
              </SuggestionActionButton>
            )}
            {suggestion.review_status !== 'accepted' ? (
              <SuggestionActionButton onClick={() => runRowSaveAction(suggestion, resolvedSuggestion)}>
                Save
              </SuggestionActionButton>
            ) : null}
          </div>
          {suggestion.review_status !== 'accepted' ? (
            // Reject the suggestion and settle the rows it covered. The two buttons complete the
            // "discard and …" label and are grouped in a bordered chip so it reads as one unit; the
            // wording ("…categorization") makes clear it acts on the transactions, not the category.
            // 'remove' -> cleared source; 'keep' -> file category becomes a manual decision.
            <div style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              border: '1px solid var(--border)', borderRadius: 9, padding: '3px 4px 3px 8px',
              background: 'color-mix(in srgb, var(--surface) 70%, transparent)',
            }}>
              <span style={{ fontSize: 11, color: 'var(--muted)', whiteSpace: 'nowrap' }}>discard and</span>
              <Tooltip content="Discard this proposed rule and clear the transactions' categorization">
                <SuggestionActionButton
                  onClick={() => onRejectSuggestionDisposition(suggestion, 'clear')}
                  style={{ fontSize: 11, padding: '3px 8px' }}
                >
                  remove categorization
                </SuggestionActionButton>
              </Tooltip>
              <Tooltip content="Discard this proposed rule but keep the transactions' current categorization">
                <SuggestionActionButton
                  onClick={() => onRejectSuggestionDisposition(suggestion, 'keep')}
                  style={{ fontSize: 11, padding: '3px 8px' }}
                >
                  keep categorization
                </SuggestionActionButton>
              </Tooltip>
            </div>
          ) : null}
        </>
      )}
    </div>
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

// The label is a button when the pill does something: `onClick`, or `onMouseDown` for a pill that opens a
// picker as the press lands. A keyboard press only clicks, so a mousedown-only pill also answers a click
// that no pointer made (`detail` 0).
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
  const actionable = Boolean(onClick || onMouseDown) && !editing
  const LabelTag = actionable ? 'button' : 'span'
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
      className={actionable ? 'ui-pill' : undefined}
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
          type={actionable ? 'button' : undefined}
          onMouseDown={event => {
            if (!onMouseDown) return
            event.stopPropagation()
            event.preventDefault()
            onMouseDown()
          }}
          onClick={event => {
            event.stopPropagation()
            if (onClick) onClick()
            else if (onMouseDown && event.detail === 0) onMouseDown()
          }}
          style={{
            ...getSharedPillLabelStyle({ muted: tone === 'muted' }),
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            minWidth: 0,
            ...(actionable ? {
              background: 'none',
              border: 'none',
              padding: 0,
              cursor: 'pointer',
              textAlign: 'left',
            } : {}),
          }}
        >
          <span style={maxWidth ? { overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 } : undefined}>{label}</span>
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
