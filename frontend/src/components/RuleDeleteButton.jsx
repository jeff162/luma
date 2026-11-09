// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from 'react'
import { createPortal } from 'react-dom'
import { IconButton, AppConfirmDialog } from './ui.jsx'

// The 🗑 in a rule editor's header and the confirm behind it, shared by every editor that opens on an
// existing rule. Destructive, so it sits apart from Save, and behind a confirm. Deleting from an editor
// saves opening the rule, deciding against it, and hunting the same rule down in the list to remove it.
// `onDelete(reconcile)` performs the delete; `reconcile` is the confirm's re-evaluate answer.
export default function RuleDeleteButton({ onDelete, disabled = false }) {
  // Kept separate from an editor's own re-evaluate choice: the two answer the same question but about
  // different acts, and carrying one answer over to the other would silently apply a choice made about an
  // edit the user then abandoned.
  const [confirming, setConfirming] = useState(false)
  const [reconcile, setReconcile] = useState(false)

  function close() {
    setConfirming(false)
    setReconcile(false)
  }

  return (
    <>
      {/* Kept out of the header's drag: a press here must not also pick the dialog up. */}
      <span onPointerDown={event => event.stopPropagation()} style={{ display: 'inline-flex', marginLeft: 'auto', flexShrink: 0 }}>
        <IconButton onClick={() => setConfirming(true)} disabled={disabled} aria-label="Delete this rule">
          🗑
        </IconButton>
      </span>

      {/* Portalled: `AppDialog` does not portal itself, and mounted inside an editor it would stack and
          position against the editor's own fixed, blurred backdrop rather than the viewport. See the
          comment on `AppDialog` in `ui.jsx`. */}
      {confirming ? createPortal(
        <AppConfirmDialog
          title="Delete this rule?"
          description="The rule moves to the rules trash, where it can be restored from Settings."
          confirmLabel="Delete rule"
          // Not "Cancel": the editor's own Cancel is on screen behind this, abandoning the whole edit
          // rather than just the deletion, and two buttons reading the same word mean different things.
          cancelLabel="Keep rule"
          confirmVariant="danger"
          onConfirm={() => { const revert = reconcile; close(); onDelete(revert) }}
          onCancel={close}
          borderColor="var(--danger)"
        >
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 12.5, color: 'var(--muted)', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={reconcile}
              onChange={e => setReconcile(e.target.checked)}
              style={{ marginTop: 2 }}
            />
            <span>
              Also re-evaluate the transactions this rule categorized, so they fall to another matching
              rule or back to uncategorized. Off leaves their categories as they are.
            </span>
          </label>
        </AppConfirmDialog>,
        document.body,
      ) : null}
    </>
  )
}
