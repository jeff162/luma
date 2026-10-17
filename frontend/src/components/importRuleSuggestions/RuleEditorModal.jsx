// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// The "Rule editor" modal for the import rule-suggestion review: wraps the shared RuleForm in an
// overlay, holds the draft/working/error state for one suggestion, and exposes Accept / Save /
// Close-with-draft / Discard. The parent owns the suggestion and the persistence callbacks.
//
// In draft-only mode (editing a conflict-set member) it offers only Close: accept/defer/discard belong
// to the conflict card's Apply, and Close always stashes the edits as the card's draft, so leaving the
// editor via the button or backdrop is never destructive.

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
  onTagCreated,
  // The single resolved source row when this suggestion is backed by exactly one — feeds RuleForm's
  // read-only "From the source file" panel. Null for multi-row suggestions (use the matching report).
  exampleTransaction = null,
  // When the editor is opened to tweak a conflict-set winner, accepting here would bypass the card's
  // Apply (which handles the other rows' dispositions). In that mode the primary action just saves the
  // edits as a draft and closes; the conflict card's Apply then creates the rule from those edits.
  draftOnly = false,
  mode = 'full',
  matchCount = 0,
  onOpenMatchingTransactions,
  matchingRowsOpen = false,
  matchingRowsPanel = null,
}) {
  const matchOnly = mode === 'match-only'
  const isAccepted = suggestion.review_status === 'accepted'
  const formRef = useRef(null)
  const [draftState, setDraftState] = useState({
    data: {
      keyword: suggestion.keyword,
      category_id: suggestion.target_category_id || null,
      amount_min: suggestion.amount_min,
      amount_max: suggestion.amount_max,
      clean_name: suggestion.clean_name_suggestion || null,
      tag_ids: suggestion.tag_ids || [],
      owner_id: suggestion.owner_id || null,
      account_id: suggestion.account_id || null,
      clear_amount_min: suggestion.amount_min == null,
      clear_amount_max: suggestion.amount_max == null,
      clear_clean_name: !suggestion.clean_name_suggestion,
      clear_owner: !suggestion.owner_id,
      clear_account: !suggestion.account_id,
      applyToExisting: false,
    },
    canSave: matchOnly ? Boolean(suggestion.keyword) : Boolean(suggestion.keyword && suggestion.target_category_id),
  })
  const [working, setWorking] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    // Rehydrate from the current suggestion whenever the editor is re-targeted so
    // in-progress edits from one card never bleed into another.
    setDraftState({
      data: {
        keyword: suggestion.keyword,
        category_id: suggestion.target_category_id || null,
        amount_min: suggestion.amount_min,
        amount_max: suggestion.amount_max,
        clean_name: suggestion.clean_name_suggestion || null,
        tag_ids: suggestion.tag_ids || [],
        owner_id: suggestion.owner_id || null,
        account_id: suggestion.account_id || null,
        clear_amount_min: suggestion.amount_min == null,
        clear_amount_max: suggestion.amount_max == null,
        clear_clean_name: !suggestion.clean_name_suggestion,
        clear_owner: !suggestion.owner_id,
        clear_account: !suggestion.account_id,
        applyToExisting: false,
      },
      canSave: matchOnly ? Boolean(suggestion.keyword) : Boolean(suggestion.keyword && suggestion.target_category_id),
    })
    setWorking(false)
    setError('')
  }, [suggestion, matchOnly])

  function getCurrentDraftState() {
    return formRef.current?.getDraftState?.() || draftState
  }

  async function handleCloseWithDraft() {
    if (working) return
    setWorking(true)
    setError('')
    try {
      await onCloseWithDraft(getCurrentDraftState().data)
    } catch (err) {
      setError(err.message || 'Unable to close this rule editor.')
      setWorking(false)
    }
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

  const quietHeaderButtonStyle = {
    background: 'transparent',
    color: 'var(--muted)',
    border: '1px solid var(--border)',
    borderRadius: 8,
    padding: '5px 11px',
    fontSize: 12,
    fontWeight: 500,
    cursor: working ? 'not-allowed' : 'pointer',
    opacity: working ? 0.65 : 1,
  }
  const primaryHeaderButtonStyle = {
    background: draftState.canSave ? 'color-mix(in srgb, var(--accent) 12%, var(--surface))' : 'var(--surface)',
    color: draftState.canSave ? 'var(--accent2)' : 'var(--muted)',
    border: `1px solid ${draftState.canSave ? 'color-mix(in srgb, var(--accent) 40%, var(--border))' : 'var(--border)'}`,
    borderRadius: 8,
    padding: '5px 12px',
    fontSize: 12,
    fontWeight: 600,
    cursor: working || !draftState.canSave ? 'not-allowed' : 'pointer',
    opacity: working ? 0.65 : 1,
  }

  function renderHeaderActions() {
    if (draftOnly) {
      return (
        <button
          type="button"
          onClick={handleCloseWithDraft}
          disabled={working}
          title="Close — your edits stay on the conflict card; its Apply creates the rule"
          style={quietHeaderButtonStyle}
        >
          Close
        </button>
      )
    }
    if (!isAccepted && !matchOnly) {
      return (
        <>
          <button
            type="button"
            onClick={handleCloseWithDraft}
            disabled={working}
            title="Close — your edits stay on the suggestion card; use the card's Save button when ready"
            style={primaryHeaderButtonStyle}
          >
            Close
          </button>
          <button
            type="button"
            onClick={handleAccept}
            disabled={working || !draftState.canSave}
            title="Create this rule now and move the suggestion to accepted"
            style={{
              ...quietHeaderButtonStyle,
              cursor: working || !draftState.canSave ? 'not-allowed' : 'pointer',
              opacity: working || !draftState.canSave ? 0.65 : 1,
            }}
          >
            {working ? 'Saving…' : 'Save rule'}
          </button>
        </>
      )
    }
    const cancelAction = isAccepted ? onDiscard : handleCloseWithDraft
    const saveAction = isAccepted ? handleSaveAccepted : handleAccept
    const saveLabel = isAccepted ? 'Save' : matchOnly ? 'Save match' : 'Save rule'
    return (
      <>
        <button
          type="button"
          onClick={saveAction}
          disabled={working || !draftState.canSave}
          style={primaryHeaderButtonStyle}
        >
          {working ? 'Saving…' : saveLabel}
        </button>
        <button
          type="button"
          onClick={cancelAction}
          disabled={working}
          style={quietHeaderButtonStyle}
        >
          Cancel
        </button>
      </>
    )
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
          boxShadow: '0 20px 60px rgba(0,0,0,0.45)',
          width: matchingRowsPanel ? 'min(1280px, 96vw)' : 640,
          maxWidth: '96vw',
          maxHeight: '90vh',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
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
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 600 }}>Rule editor</div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
              {matchOnly
                ? 'Refine the selection criteria for this suggestion. Saving regenerates the cards in place.'
                : draftOnly
                  ? 'Refine this rule. Your edits stay on the conflict card and are used when you Apply it.'
                  : 'Review and refine the proposed rule before saving it.'}
            </div>
            {onOpenMatchingTransactions && matchCount ? (
              <button
                type="button"
                onClick={onOpenMatchingTransactions}
                title={matchOnly
                  ? (matchingRowsOpen ? 'Hide the current suggestion rows' : 'Show the current suggestion rows as a reference')
                  : (matchingRowsOpen ? 'Hide matching imported transactions' : 'Show matching imported transactions as a reference')}
                style={{
                  marginTop: 8,
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '3px 8px',
                  borderRadius: 999,
                  border: '1px solid var(--border)',
                  background: 'var(--surface2)',
                  color: 'var(--muted)',
                  fontSize: 11.5,
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                {matchingRowsOpen
                  ? 'Hide reference rows'
                  : matchOnly
                    ? `${matchCount} row${matchCount === 1 ? '' : 's'} in this suggestion`
                    : `${matchCount} matching row${matchCount === 1 ? '' : 's'}`}
                <span style={{ color: 'var(--accent2)', fontSize: 10, lineHeight: 1 }} aria-hidden="true">↗</span>
              </button>
            ) : null}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto', flexShrink: 0 }}>
            {renderHeaderActions()}
          </div>
        </div>

        <div style={{
          display: matchingRowsPanel ? 'grid' : 'block',
          gridTemplateColumns: matchingRowsPanel ? 'minmax(360px, 0.8fr) minmax(460px, 1.2fr)' : undefined,
          gap: matchingRowsPanel ? 16 : 0,
          padding: matchingRowsPanel ? '0 20px 16px 0' : 0,
          alignItems: matchingRowsPanel ? 'stretch' : undefined,
          overflow: 'auto',
          flex: 1,
          minHeight: 0,
        }}>
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
              match_source_text: suggestion.match_source_text,
            }}
            sourceTransaction={exampleTransaction}
            categories={categories}
            owners={owners}
            accounts={accounts}
            showApplyToExisting={false}
            hideFooter
            onDraftChange={setDraftState}
            onCategoriesChanged={onCategoriesChanged}
            onTagCreated={onTagCreated}
            mode={matchOnly ? 'match-only' : 'full'}
            // A suggestion is one keyword plus scope all the way through the review (grouping, coverage,
            // accept), and carries no account type, so the editor offers only what an accepted suggestion
            // keeps. Further words or spellings, and an account type, are set on the rule once it exists.
            suggestionFields
          />

          {matchingRowsPanel ? (
            <div style={{ minWidth: 0, minHeight: 0, paddingTop: 16, display: 'flex' }}>
              {matchingRowsPanel}
            </div>
          ) : null}
        </div>

        {error ? (
          <div style={{
            padding: '8px 20px',
            background: 'var(--surface2)',
            borderTop: '1px solid var(--border)',
            fontSize: 12,
            color: 'var(--danger)',
          }}>
            {error}
          </div>
        ) : null}
      </div>
    </div>
  )
}
