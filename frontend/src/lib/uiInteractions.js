// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect, useState } from 'react'

export const ESCAPE_BEHAVIOR = Object.freeze({
  CUSTOM: 'custom',
  DISMISS_POPUP: 'dismissPopup',
  CANCEL_EDIT: 'cancelEdit',
  CLEAR_SELECTION: 'clearSelection',
  REVERT_DRAFT_AND_RESTORE_FOCUS: 'revertDraftAndRestoreFocus',
})

function isEditableTarget(target) {
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
  placementDeps = [],
  disabled = false,
  blurOnEscape = true,
  escapeBehavior = ESCAPE_BEHAVIOR.DISMISS_POPUP,
}) {
  const [openUp, setOpenUp] = useState(false)

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

  useEffect(() => {
    if (!open || !popupRef.current || !anchorRef.current) return
    const anchorRect = anchorRef.current.getBoundingClientRect()
    const popupHeight = popupRef.current.offsetHeight
    setOpenUp(anchorRect.bottom + popupHeight > window.innerHeight - 8)
  }, [anchorRef, open, popupRef, ...placementDeps])

  return { openUp }
}

export function useDismissibleLayer({
  open,
  onClose,
  refs = [],
  closeOnEscape = true,
  blurOnEscape = true,
  escapeBehavior = ESCAPE_BEHAVIOR.DISMISS_POPUP,
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
  }, { enabled: open, escapeBehavior })

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
  normalize = next => next.trim(),
  allowEmpty = false,
} = {}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value ?? '')

  useEffect(() => {
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

  function commitEdit() {
    const normalized = normalize ? normalize(draft) : draft
    setEditing(false)
    setDraft(value ?? '')
    if ((!normalized && !allowEmpty) || normalized === value) return false
    onCommit?.(normalized)
    return true
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
