// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { forwardRef, useRef } from 'react'
import { ESCAPE_BEHAVIOR } from '../lib/uiInteractions.js'

/*
 * Inline editors all funnel through this wrapper so Enter, blur, and Escape mean the same thing everywhere.
 * The restore value is captured when the edit begins, which makes Escape behave like "revert this edit" instead
 * of stepping back through each keystroke.
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
          if (escapeBehavior === ESCAPE_BEHAVIOR.CANCEL_EDIT) {
            if (restoreOnEscape) {
              const restoreValue = hasEscapeRestoreValueRef.current ? escapeRestoreValueRef.current : (value ?? '')
              onChange?.(restoreValue)
            }
            if (blurOnEscape) {
              window.requestAnimationFrame(() => {
                event.currentTarget?.blur?.()
              })
            }
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
