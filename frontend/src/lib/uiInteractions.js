// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useState } from 'react'

/*
 * These hooks centralize the app's dismissal and inline-edit conventions so popovers, menus, and text edits
 * respond to Escape, outside clicks, and draft resets the same way across otherwise unrelated screens.
 */
export const ESCAPE_BEHAVIOR = Object.freeze({
  CUSTOM: 'custom',
  DISMISS_POPUP: 'dismissPopup',
  CANCEL_EDIT: 'cancelEdit',
  CLEAR_SELECTION: 'clearSelection',
  REVERT_DRAFT_AND_RESTORE_FOCUS: 'revertDraftAndRestoreFocus',
})

export function isEditableTarget(target) {
  const tagName = target?.tagName
  return !!(
    target?.isContentEditable ||
    tagName === 'INPUT' ||
    tagName === 'TEXTAREA' ||
    tagName === 'SELECT'
  )
}

function refContainsTarget(ref, target) {
  return !!(ref?.current && target && ref.current.contains(target))
}

function blurActiveElementIfContained(refs) {
  const active = document.activeElement
  if (!(active instanceof HTMLElement)) return
  if (!refs.some(ref => refContainsTarget(ref, active))) return
  active.blur()
}

export function useEscapeAction(
  onEscape,
  {
    enabled = true,
    ignoreEditableTarget = false,
    escapeBehavior = ESCAPE_BEHAVIOR.CUSTOM,
  } = {}
) {
  useEffect(() => {
    if (!enabled) return undefined

    function handleKeyDown(event) {
      if (event.key !== 'Escape') return
      if (ignoreEditableTarget && isEditableTarget(event.target)) return
      onEscape?.(event)
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [enabled, ignoreEditableTarget, onEscape, escapeBehavior])
}

export function useDismissiblePopup({
  open,
  setOpen,
  anchorRef,
  popupRef,
  disabled = false,
  blurOnEscape = true,
  escapeBehavior = ESCAPE_BEHAVIOR.DISMISS_POPUP,
}) {
  useEffect(() => {
    if (disabled && open) setOpen(false)
  }, [disabled, open, setOpen])

  useEffect(() => {
    if (!open) return undefined

    function handlePointerDown(event) {
      if (anchorRef.current && !anchorRef.current.contains(event.target)) {
        setOpen(false)
      }
    }

    document.addEventListener('mousedown', handlePointerDown)
    return () => document.removeEventListener('mousedown', handlePointerDown)
  }, [anchorRef, open, setOpen])

  useEscapeAction(() => {
    if (blurOnEscape) {
      blurActiveElementIfContained([anchorRef, popupRef])
    }
    setOpen(false)
  }, { enabled: open, escapeBehavior })
}

export function useDismissibleLayer({
  open,
  onClose,
  refs = [],
  closeOnEscape = true,
  blurOnEscape = true,
  escapeBehavior = ESCAPE_BEHAVIOR.DISMISS_POPUP,
  // When true, Escape does NOT close the layer while focus is in a raw editable field it contains — the
  // field's own Escape (e.g. a cancel-edit) should win first. Shared `TransientTextInput`s already
  // stopPropagation on Escape, so this is only needed for layers wrapping plain inputs/textareas that
  // shouldn't be dismissed mid-edit. Default false preserves the usual "Escape closes the popover".
  ignoreEditableTarget = false,
  closeOnBlur = false,
  closeOnScrollResize = false,
} = {}) {
  useEffect(() => {
    if (!open) return undefined

    function containsTarget(target) {
      return refs.some(ref => refContainsTarget(ref, target))
    }

    function handlePointerDown(event) {
      if (containsTarget(event.target)) return
      onClose?.(event)
    }

    document.addEventListener('mousedown', handlePointerDown)
    return () => document.removeEventListener('mousedown', handlePointerDown)
  }, [open, onClose, refs])

  useEscapeAction(event => {
    if (!closeOnEscape) return
    if (blurOnEscape) {
      blurActiveElementIfContained(refs)
    }
    onClose?.(event)
  }, { enabled: open, escapeBehavior, ignoreEditableTarget })

  useEffect(() => {
    if (!open || !closeOnBlur) return undefined

    function handleBlur(event) {
      onClose?.(event)
    }

    window.addEventListener('blur', handleBlur)
    return () => window.removeEventListener('blur', handleBlur)
  }, [closeOnBlur, onClose, open])

  useEffect(() => {
    if (!open || !closeOnScrollResize) return undefined

    function handleDismiss(event) {
      onClose?.(event)
    }

    window.addEventListener('scroll', handleDismiss, true)
    window.addEventListener('resize', handleDismiss)
    return () => {
      window.removeEventListener('scroll', handleDismiss, true)
      window.removeEventListener('resize', handleDismiss)
    }
  }, [closeOnScrollResize, onClose, open])
}

export function useTransientTextEdit(value, {
  onCommit,
  onCommitError,
  normalize = next => next.trim(),
  allowEmpty = false,
} = {}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value ?? '')

  useEffect(() => {
    // Server refreshes should hydrate idle fields, but never overwrite an in-progress draft mid-typing.
    if (!editing) setDraft(value ?? '')
  }, [editing, value])

  function beginEdit(initialValue = value ?? '') {
    setDraft(initialValue)
    setEditing(true)
  }

  function cancelEdit() {
    setDraft(value ?? '')
    setEditing(false)
  }

  async function commitEdit() {
    const normalized = normalize ? normalize(draft) : draft
    if ((!normalized && !allowEmpty) || normalized === value) {
      // Nothing to persist, but the edit session is still over — exit edit mode and
      // revert the draft rather than leaving the editor stranded open. This is what
      // lets commit-on-blur close when the value is unchanged; only a thrown onCommit
      // (handled below) should keep the editor open for a retry.
      cancelEdit()
      return false
    }
    setEditing(false)
    try {
      await onCommit?.(normalized)
      setDraft(value ?? '')
      return true
    } catch (error) {
      setDraft(normalized)
      setEditing(true)
      onCommitError?.(error, normalized)
      return false
    }
  }

  return {
    editing,
    setEditing,
    draft,
    setDraft,
    beginEdit,
    cancelEdit,
    commitEdit,
  }
}
