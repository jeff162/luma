// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { forwardRef, useRef } from 'react'
import { ESCAPE_BEHAVIOR } from '../lib/uiInteractions.js'

/*
 * Inline editors all funnel through this wrapper so Enter, blur, and Escape mean the same thing everywhere.
 * The restore value is captured when the edit begins, which makes Escape behave like "revert this edit" instead
 * of stepping back through each keystroke.
 *
 * Escape always `stopPropagation()`s: the focused field owns the key, so it cancels the local edit and never
 * bubbles up to close a surrounding dismissible layer or page. A container that should close on the same
 * Escape does so through `onCancel` (an explicit callback), not the raw event. Two cancel shapes:
 *   - CANCEL_EDIT (default): revert (if restoreOnEscape) and blur, ending the edit in place.
 *   - REVERT_DRAFT_AND_RESTORE_FOCUS: revert and return focus to `restoreFocusRef` (the trigger that opened
 *     the editor) instead of blurring — the shape a chip/expanding editor wants.
 *
 * `multiline` renders a <textarea> instead of an <input> for free-text fields like notes. Enter then keeps its
 * native meaning (insert a newline) rather than committing, since a multi-line value can't use Enter-to-commit;
 * such fields commit through blur or an explicit Save action instead, while Escape-to-revert stays shared.
 */
const TransientTextInput = forwardRef(function TransientTextInput({
  value,
  onChange,
  onCommit,
  onCancel,
  restoreOnEscape = false,
  blurOnEscape = true,
  escapeBehavior = ESCAPE_BEHAVIOR.CANCEL_EDIT,
  // When set (and escapeBehavior is REVERT_DRAFT_AND_RESTORE_FOCUS), Escape returns focus to this element
  // — the trigger that opened the editor — instead of blurring to nowhere. Used by chip-style editors.
  restoreFocusRef = null,
  onBlurCommit = true,
  autoFocus = true,
  multiline = false,
  onKeyDown,
  onFocus,
  onBlur,
  style,
  ...rest
}, ref) {
  const escapeRestoreValueRef = useRef(value ?? '')
  const hasEscapeRestoreValueRef = useRef(false)
  const Field = multiline ? 'textarea' : 'input'

  return (
    <Field
      {...rest}
      ref={ref}
      autoFocus={autoFocus}
      value={value}
      onChange={event => {
        if (restoreOnEscape && !hasEscapeRestoreValueRef.current) {
          escapeRestoreValueRef.current = value ?? ''
          hasEscapeRestoreValueRef.current = true
        }
        onChange?.(event.target.value)
      }}
      onFocus={event => {
        if (restoreOnEscape) {
          escapeRestoreValueRef.current = value ?? ''
          hasEscapeRestoreValueRef.current = true
        }
        onFocus?.(event)
      }}
      onBlur={event => {
        hasEscapeRestoreValueRef.current = false
        if (onBlurCommit) onCommit?.(event)
        onBlur?.(event)
      }}
      onKeyDown={event => {
        if (event.key === 'Enter' && !multiline) {
          event.preventDefault()
          onCommit?.(event)
        }
        if (event.key === 'Escape') {
          event.preventDefault()
          // The focused field owns Escape: cancel the local edit here, and do NOT let it bubble to a
          // container's Escape handler (a dismissible layer / page). Any intended container close flows
          // through onCancel, never through the raw event — so this can't close the surface behind it.
          event.stopPropagation()
          const field = event.currentTarget
          const revertDraft = () => {
            if (!restoreOnEscape) return
            const restoreValue = hasEscapeRestoreValueRef.current ? escapeRestoreValueRef.current : (value ?? '')
            onChange?.(restoreValue)
          }
          if (escapeBehavior === ESCAPE_BEHAVIOR.CANCEL_EDIT) {
            revertDraft()
            if (blurOnEscape) window.requestAnimationFrame(() => field?.blur?.())
          } else if (escapeBehavior === ESCAPE_BEHAVIOR.REVERT_DRAFT_AND_RESTORE_FOCUS) {
            revertDraft()
            const trigger = restoreFocusRef?.current
            if (trigger) window.requestAnimationFrame(() => trigger.focus?.())
            else if (blurOnEscape) window.requestAnimationFrame(() => field?.blur?.())
          }
          onCancel?.(event)
        }
        onKeyDown?.(event)
      }}
      style={style}
    />
  )
})

export default TransientTextInput
