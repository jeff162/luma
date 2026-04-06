// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: GPL-3.0-or-later

import { forwardRef, useRef } from 'react'
import { ESCAPE_BEHAVIOR } from '../lib/uiInteractions.js'

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
  onKeyDown,
  onFocus,
  onBlur,
  style,
  ...rest
}, ref) {
  const escapeRestoreValueRef = useRef(value ?? '')
  const hasEscapeRestoreValueRef = useRef(false)

  return (
    <input
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
        if (event.key === 'Enter') {
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
