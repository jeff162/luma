// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: GPL-3.0-or-later

// The "Rule editor" modal for the import rule-suggestion review: wraps the shared RuleForm in an
// overlay, holds the draft/working/error state for one suggestion, and exposes Accept / Save /
// Close-with-draft / Discard. The parent owns the suggestion and the persistence callbacks.
//
// In draft-only mode (editing a conflict-set member) it offers only Close: accept/defer/discard belong
// to the conflict card's Apply, and Close always stashes the edits as the card's draft, so leaving the
// editor — via the button, the × , or the backdrop — is never destructive.

import { useEffect, useRef, useState } from 'react'
import RuleForm from '../RuleForm.jsx'

export function RuleEditorModal({
  suggestion,
  categories,
  owners,
  accounts,
  onCategoriesChanged,
  onAccept,
  onSaveAccepted,
  onCloseWithDraft,
  onDiscard,
  // When the editor is opened to tweak a conflict-set winner, accepting here would bypass the card's
  // Apply (which handles the other rows' dispositions). In that mode the primary action just saves the
  // edits as a draft and closes; the conflict card's Apply then creates the rule from those edits.
  draftOnly = false,
}) {
  const isAccepted = suggestion.review_status === 'accepted'
  const formRef = useRef(null)
  const [draftState, setDraftState] = useState({
    data: {
      keyword: suggestion.keyword,
      category_id: suggestion.target_category_id || null,
      amount_min: suggestion.amount_min,
      amount_max: suggestion.amount_max,
      clean_name: suggestion.clean_name_suggestion || null,
      owner_id: suggestion.owner_id || null,
      account_id: suggestion.account_id || null,
      clear_amount_min: suggestion.amount_min == null,
      clear_amount_max: suggestion.amount_max == null,
      clear_clean_name: !suggestion.clean_name_suggestion,
      clear_owner: !suggestion.owner_id,
      clear_account: !suggestion.account_id,
      applyToExisting: false,
    },
    canSave: Boolean(suggestion.keyword && suggestion.target_category_id),
  })
  const [working, setWorking] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    // Rehydrate from the current suggestion whenever the editor is retargeted so
    // in-progress edits from one card never bleed into another.
    setDraftState({
      data: {
        keyword: suggestion.keyword,
        category_id: suggestion.target_category_id || null,
        amount_min: suggestion.amount_min,
        amount_max: suggestion.amount_max,
        clean_name: suggestion.clean_name_suggestion || null,
        owner_id: suggestion.owner_id || null,
        account_id: suggestion.account_id || null,
        clear_amount_min: suggestion.amount_min == null,
        clear_amount_max: suggestion.amount_max == null,
        clear_clean_name: !suggestion.clean_name_suggestion,
        clear_owner: !suggestion.owner_id,
        clear_account: !suggestion.account_id,
        applyToExisting: false,
      },
      canSave: Boolean(suggestion.keyword && suggestion.target_category_id),
    })
    setWorking(false)
    setError('')
  }, [suggestion])

  function getCurrentDraftState() {
    return formRef.current?.getDraftState?.() || draftState
  }

  async function handleCloseWithDraft() {
    onCloseWithDraft(getCurrentDraftState().data)
  }

  async function handleAccept() {
    const currentDraftState = getCurrentDraftState()
    if (!currentDraftState.canSave || working) return
    setWorking(true)
    setError('')
    try {
      await onAccept(currentDraftState.data)
    } catch (err) {
      setError(err.message || 'Unable to accept this rule.')
      setWorking(false)
    }
  }

  async function handleSaveAccepted() {
    const currentDraftState = getCurrentDraftState()
    if (!currentDraftState.canSave || working) return
    setWorking(true)
    setError('')
    try {
      await onSaveAccepted(currentDraftState.data)
    } catch (err) {
      setError(err.message || 'Unable to save this rule.')
      setWorking(false)
    }
  }

  return (
    <div
      onMouseDown={() => {
        if (working) return
        if (isAccepted) onDiscard()
        else handleCloseWithDraft()
      }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 900,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0,0,0,0.5)',
        padding: 24,
      }}
    >
      <div
        onMouseDown={event => event.stopPropagation()}
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 14,
          width: 640,
          maxWidth: '94vw',
          maxHeight: '90vh',
          overflowY: 'auto',
          boxShadow: '0 20px 60px rgba(0,0,0,0.45)',
        }}
      >
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 16,
          padding: '16px 20px',
          borderBottom: '1px solid var(--border)',
        }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 600 }}>Rule editor</div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
              {draftOnly
                ? 'Refine this rule. Your edits stay on the conflict card and are used when you Apply it.'
                : 'Review and refine the proposed rule before saving it.'}
            </div>
          </div>
          <button
            type="button"
            title={isAccepted ? 'Cancel' : 'Close'}
            onClick={() => {
              if (working) return
              if (isAccepted) onDiscard()
              else handleCloseWithDraft()
            }}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--muted)',
              cursor: 'pointer',
              fontSize: 20,
              lineHeight: 1,
              padding: 2,
            }}
          >
            ×
          </button>
        </div>

        <RuleForm
          ref={formRef}
          initialValues={{
            keyword: suggestion.keyword,
            owner_id: suggestion.owner_id || '',
            account_id: suggestion.account_id || '',
            amount_min: suggestion.amount_min,
            amount_max: suggestion.amount_max,
            catId: suggestion.target_category_id || '',
            cleanName: suggestion.clean_name_suggestion || '',
            tagIds: suggestion.tag_ids || [],
          }}
          categories={categories}
          owners={owners}
          accounts={accounts}
          showApplyToExisting={false}
          hideFooter
          onDraftChange={setDraftState}
          onCategoriesChanged={onCategoriesChanged}
        />

        <div style={{
          padding: '12px 20px',
          background: 'var(--surface2)',
          borderTop: '1px solid var(--border)',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}>
          {error ? <span style={{ fontSize: 12, color: 'var(--danger)', flex: 1 }}>{error}</span> : <span style={{ flex: 1 }} />}
          <div style={{ display: 'flex', gap: 8, marginLeft: 'auto' }}>
            {isAccepted ? (
              <>
                <button
                  type="button"
                  onClick={onDiscard}
                  disabled={working}
                  style={{ background: 'transparent', color: 'var(--muted)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 16px', fontSize: 13, cursor: working ? 'not-allowed' : 'pointer', opacity: working ? 0.7 : 1 }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleSaveAccepted}
                  disabled={working || !draftState.canSave}
                  style={{
                    background: draftState.canSave ? 'var(--accent)' : 'var(--surface)',
                    color: draftState.canSave ? '#fff' : 'var(--muted)',
                    border: draftState.canSave ? 'none' : '1px solid var(--border)',
                    borderRadius: 8,
                    padding: '8px 20px',
                    fontSize: 13,
                    fontWeight: 500,
                    cursor: working || !draftState.canSave ? 'not-allowed' : 'pointer',
                    opacity: working ? 0.7 : 1,
                  }}
                >
                  {working ? 'Saving…' : 'Save'}
                </button>
              </>
            ) : draftOnly ? (
              // Conflict-member edit: there is no accept/save here — those belong to the conflict card's
              // Apply. Close just keeps the edits (always stashed as the draft), so it's never destructive.
              <button
                type="button"
                onClick={handleCloseWithDraft}
                disabled={working}
                title="Close — your edits stay on the conflict card; its Apply creates the rule"
                style={{ background: 'transparent', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 16px', fontSize: 13, cursor: working ? 'not-allowed' : 'pointer', opacity: working ? 0.7 : 1 }}
              >
                Close
              </button>
            ) : (
              <>
                <button
                  type="button"
                  onClick={onDiscard}
                  disabled={working}
                  style={{ background: 'transparent', color: 'var(--muted)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 16px', fontSize: 13, cursor: working ? 'not-allowed' : 'pointer', opacity: working ? 0.7 : 1 }}
                >
                  Discard
                </button>
                <button
                  type="button"
                  onClick={handleCloseWithDraft}
                  disabled={working}
                  style={{ background: 'transparent', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 16px', fontSize: 13, cursor: working ? 'not-allowed' : 'pointer', opacity: working ? 0.7 : 1 }}
                >
                  Close
                </button>
                <button
                  type="button"
                  onClick={handleAccept}
                  disabled={working || !draftState.canSave}
                  style={{
                    background: draftState.canSave ? 'var(--accent)' : 'var(--surface)',
                    color: draftState.canSave ? '#fff' : 'var(--muted)',
                    border: draftState.canSave ? 'none' : '1px solid var(--border)',
                    borderRadius: 8,
                    padding: '8px 20px',
                    fontSize: 13,
                    fontWeight: 500,
                    cursor: working || !draftState.canSave ? 'not-allowed' : 'pointer',
                    opacity: working ? 0.7 : 1,
                  }}
                >
                  {working ? 'Saving…' : 'Accept Rule'}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
