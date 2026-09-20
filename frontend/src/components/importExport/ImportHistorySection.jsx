// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// The "Data sources" history section shown below the import form on every stage
// except mapping: the Manage-sources / Group-imported-categories / Generate-rules
// header actions, and the per-source list with expandable recent-import file
// rows (inline rename + description, imported-category usage toggle, assigning an
// unsaved file — temporary draft or unknown — to a data source, per-file detail / rejected-rows / duplicates
// drill-ins, and undo). Purely presentational — all state and callbacks live in
// ImportTab and arrive as props.

import TransientTextInput from '../TransientTextInput.jsx'
import { Button, Card, EmptyState, Tooltip } from '../ui.jsx'
import { ActionCountBadge, ImportedCategoryUsageInline } from './importPresentational.jsx'
import { SourceAccountChip } from './SourceAccountChip.jsx'
import { getSuggestedDataSourceName } from '../../lib/importExport/importDraft.js'
import { providerLabel } from '../../lib/importSourceFields.js'
import { summarizeImportOutcome } from '../../lib/importExport/importOutcome.js'
import { MarketplaceImportHistory } from './MarketplaceImportHistory.jsx'
import ContextualExplainer from '../../help/ContextualExplainer.jsx'
import {
  summarizeImportedCategorySettings,
  extractImportedCategorySettings,
} from '../../lib/importExport/importedCategorySettings.js'

export function ImportHistorySection({
  dataSourceRows,
  profiles,
  expandedSourceRows,
  setExpandedSourceRows,
  setShowDataSourceManager,
  openSystemCategoryWorkspace,
  totalSystemCategoryWorkspaceCount,
  pendingSystemCategoryCount,
  openRuleSuggestionReview,
  hasSystemRuleSuggestionWork,
  pendingSystemRuleSuggestionCount,
  editingSourceNameKey,
  setEditingSourceNameKey,
  getSourceNameEditKey,
  sourceNameDraft,
  setSourceNameDraft,
  saveSourceName,
  editingSourceDescriptionId,
  setEditingSourceDescriptionId,
  sourceDescriptionDraft,
  setSourceDescriptionDraft,
  saveSourceDescription,
  manualDraftRecord,
  openManualDraftSaveEditor,
  setAssignNewSourceBatchId,
  setAssignNewSourceName,
  assignUnknownBatchToProfile,
  updateBatchImportedCategoryUsage,
  updateBatchEnrichment,
  buildBatchImportedCategoryChoices,
  openBatchImportedCategorySettings,
  openBatchDetail,
  markBatchReviewed,
  handleUndoClick,
  onReviewMoneyMovement,
  openRejectedRowsViewer,
  openUnifiedDuplicatesViewer,
  openReconciliationViewer,
}) {
  return (
        <>
          <div style={{ marginTop: 28, marginBottom: 6 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                <div style={{ fontSize: 16, fontWeight: 600 }}>Data sources</div>
                <button
                  type="button"
                  onClick={() => setShowDataSourceManager(true)}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    minHeight: 24,
                    padding: '2px 9px',
                    borderRadius: 999,
                    border: '1px solid color-mix(in srgb, var(--border) 92%, transparent)',
                    background: 'color-mix(in srgb, var(--surface2) 78%, var(--surface))',
                    color: 'var(--muted)',
                    fontSize: 11,
                    fontWeight: 600,
                    cursor: 'pointer',
                    boxShadow: '0 1px 1px rgba(15, 23, 42, 0.04)',
                    whiteSpace: 'nowrap',
                    position: 'relative',
                    top: -5,
                  }}
                >
                  Manage sources
                </button>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <Tooltip content={totalSystemCategoryWorkspaceCount === 0 ? 'No imported categories are waiting to be grouped' : ''}>
                  <Button
                    small
                    variant="ghost"
                    onClick={openSystemCategoryWorkspace}
                    disabled={totalSystemCategoryWorkspaceCount === 0}
                  >
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                      <span>Group imported categories</span>
                      <ActionCountBadge count={pendingSystemCategoryCount} tone="warning" />
                    </span>
                  </Button>
                </Tooltip>
                <Tooltip content={hasSystemRuleSuggestionWork ? '' : 'Mark a categorized import as clean to generate rules'}>
                  <Button
                    small
                    variant="ghost"
                    onClick={() => openRuleSuggestionReview()}
                    disabled={!hasSystemRuleSuggestionWork}
                    style={hasSystemRuleSuggestionWork
                      ? {
                        background: 'color-mix(in srgb, var(--surface2) 70%, var(--accent) 5%)',
                        border: '1px solid color-mix(in srgb, var(--accent2) 18%, var(--border))',
                        boxShadow: '0 1px 0 rgba(255,255,255,0.03), 0 4px 12px rgba(0,0,0,0.07)',
                      }
                      : {
                        background: 'color-mix(in srgb, var(--surface2) 82%, var(--surface))',
                        color: 'color-mix(in srgb, var(--muted) 88%, var(--text) 12%)',
                        border: '1px solid color-mix(in srgb, var(--border) 92%, transparent)',
                        boxShadow: 'none',
                      }}
                  >
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                      <span>Generate rules</span>
                      <ActionCountBadge count={pendingSystemRuleSuggestionCount} />
                    </span>
                  </Button>
                </Tooltip>
              </div>
            </div>
          </div>
          {dataSourceRows.some(row => row.kind === 'manual' || row.kind === 'unknown') ? (
            <div style={{ marginBottom: 12 }}>
              <ContextualExplainer topic="unknown-data-source" active />
            </div>
          ) : null}
          {dataSourceRows.some(row => row.batches?.some(b => Number(b.needs_review_count || 0) > 0)) ? (
            <div style={{ marginBottom: 12 }}>
              <ContextualExplainer topic="reviewing-transactions" active />
            </div>
          ) : null}
          <Card style={{ padding: 0, overflow: 'hidden', width: '100%' }}>
            {dataSourceRows.length === 0 ? <EmptyState message="No data sources or temporary drafts yet" /> : (
              <>
                {dataSourceRows.map(row => {
                  // A marketplace group (Amazon, …) renders through the shared marketplace section (its
                  // own file ledger / undo / reconciliation / review pills), not the CSV data-source row.
                  if (row.kind === 'marketplace') {
                    return (
                      <MarketplaceImportHistory
                        key={row.key}
                        row={row}
                        expanded={!!expandedSourceRows[row.key]}
                        onToggleExpand={() => setExpandedSourceRows(prev => {
                          const nextState = prev && typeof prev === 'object' ? prev : {}
                          return { ...nextState, [row.key]: !nextState[row.key] }
                        })}
                        onOpenLedger={openBatchDetail}
                        onUndo={handleUndoClick}
                        onMarkReviewed={markBatchReviewed}
                      />
                    )
                  }
                  const isManual = row.kind === 'manual'
                  const isUnknown = row.kind === 'unknown'
                  // A data-source sync group: one row per connection, its monthly period cards as batches.
                  // Rendered through this generic row (shared duplicate/review pills) with a fixed label and
                  // none of the profile affordances (rename/description/assign/undo don't apply to a sync).
                  const isConnection = row.kind === 'connection'
                  // What a card's actions refer to: a sync card holds what a period's syncs delivered, not a file.
                  const batchNoun = isConnection ? 'this card' : 'this file'
                  const rowScopeNoun = isConnection ? "this connection's cards" : 'imports in this data source'
                  const isMarketplace = false
                  const isUnsaved = isManual || isUnknown
                  const rowExpanded = !!expandedSourceRows[row.key]
                  const canExpand = row.batches.length > 0
                  const importedFileCountLabel = row.batches.length === 1 ? '1 imported file' : `${row.batches.length} imported files`
                  // Surface unresolved soft-flag duplicates (per-batch pills only appear when the
                  // row is expanded — collapsed rows would otherwise hide the fact that a file
                  // inside still needs review). Hard-rejected rows (`deduped_count`) are already
                  // resolved at import time and stay out of this aggregate.
                  const unresolvedDuplicateCount = row.batches.reduce(
                    (sum, b) => sum + Math.max(0, Number(b?.suspect_duplicate_count || 0)),
                    0,
                  )
                  // The same reasoning for rows still needing review: each card's "to review" pill and its
                  // Mark all reviewed sit inside the expanded row, so a collapsed row has to say there is
                  // something in there. For a connection this is what new synced rows look like.
                  const needsReviewCount = row.batches.reduce(
                    (sum, b) => sum + Math.max(0, Number(b?.needs_review_count || 0)),
                    0,
                  )
                  // And for the PayPal reconciliation. Counted by row rather than summed: a bank charge with
                  // no PayPal record is listed by every card whose dates cover it.
                  const paypalAttentionCount = openReconciliationViewer
                    ? new Set(row.batches.flatMap(b => b?.paypal_recon_attention_ids || [])).size
                    : 0

                  return (
                    <div key={row.key}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, padding: '12px 16px', fontSize: 13, borderBottom: rowExpanded ? 'none' : '1px solid var(--border)' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                          {canExpand ? (
                            <button
                              type="button"
                              onClick={() => setExpandedSourceRows(prev => {
                                const nextState = prev && typeof prev === 'object' ? prev : {}
                                return { ...nextState, [row.key]: !nextState[row.key] }
                              })}
                              style={{ width: 20, height: 20, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface2)', color: 'var(--muted)', cursor: 'pointer', padding: 0, fontSize: 12, lineHeight: 1 }}
                              title={rowExpanded ? 'Hide recent imports' : 'Show recent imports'}
                            >
                              {rowExpanded ? '−' : '+'}
                            </button>
                          ) : <span style={{ width: 20, height: 20 }} />}
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontStyle: isUnsaved ? 'italic' : 'normal', color: isUnsaved ? 'var(--muted)' : 'var(--text)' }}>
                              {isManual ? 'temporary draft' : isUnknown ? 'unknown data source' : isConnection ? row.label : isMarketplace ? row.label : editingSourceNameKey === getSourceNameEditKey('list', row.profile.id) ? (
                                <TransientTextInput
                                  value={sourceNameDraft}
                                  onChange={setSourceNameDraft}
                                  onCommit={() => saveSourceName(row.profile.id)}
                                  onCancel={() => {
                                    setEditingSourceNameKey('')
                                    setSourceNameDraft('')
                                  }}
                                  restoreOnEscape
                                  placeholder="Data source name"
                                  style={{
                                    width: 220,
                                    maxWidth: '100%',
                                    background: 'var(--surface2)',
                                    color: 'var(--text)',
                                    border: '1px solid var(--accent)',
                                    borderRadius: 999,
                                    padding: '4px 10px',
                                    fontSize: 13,
                                    fontWeight: 500,
                                    outline: 'none',
                                  }}
                                />
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => {
                                    setEditingSourceDescriptionId('')
                                    setSourceDescriptionDraft('')
                                    setEditingSourceNameKey(getSourceNameEditKey('list', row.profile.id))
                                    setSourceNameDraft(row.profile.name || '')
                                  }}
                                  style={{
                                    background: 'none',
                                    border: 'none',
                                    padding: 0,
                                    margin: 0,
                                    color: 'inherit',
                                    font: 'inherit',
                                    fontStyle: 'normal',
                                    cursor: 'pointer',
                                    textAlign: 'left',
                                  }}
                                  title="Click to rename this data source"
                                >
                                  {row.profile.name}
                                </button>
                              )}
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 3, fontSize: 11, color: 'var(--muted)' }}>
                              {isManual ? (
                                row.manualDraftRecord?.filenamePattern ? <span>{row.manualDraftRecord.filenamePattern}</span> : null
                              ) : isConnection ? (
                                // Muted provenance cue on the group header: which data connection these
                                // synced cards came from, so multiple same-institution connections (e.g.
                                // two "Northgate") are distinguishable. Mirrors the hover's Connection row.
                                //
                                // A disconnected group says so outright rather than falling through to
                                // the generic label, which read as an ordinary live connection sitting
                                // beside the real one — two rows under the same institution name, one of
                                // them history. Its cards are kept because they are the provenance of
                                // transactions still in the ledger.
                                <span>{row.disconnected
                                  ? 'Disconnected · import history kept'
                                  : row.provider ? `${providerLabel(row.provider)} connection` : 'Data connection'}</span>
                              ) : isUnknown || isMarketplace ? null : editingSourceDescriptionId === row.profile.id ? (
                                <TransientTextInput
                                  value={sourceDescriptionDraft}
                                  onChange={setSourceDescriptionDraft}
                                  onCommit={() => saveSourceDescription(row.profile.id)}
                                  onCancel={() => {
                                    setEditingSourceDescriptionId('')
                                    setSourceDescriptionDraft('')
                                  }}
                                  restoreOnEscape
                                  placeholder="Description"
                                  style={{
                                    width: 190,
                                    maxWidth: '100%',
                                    background: 'var(--surface2)',
                                    color: 'var(--text)',
                                    border: '1px solid var(--accent)',
                                    borderRadius: 999,
                                    padding: '4px 10px',
                                    fontSize: 11,
                                    outline: 'none',
                                  }}
                                />
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => {
                                    setEditingSourceNameKey('')
                                    setSourceNameDraft('')
                                    setEditingSourceDescriptionId(row.profile.id)
                                    setSourceDescriptionDraft(row.profile.filename_pattern || '')
                                  }}
                                  style={{
                                    background: 'none',
                                    border: 'none',
                                    padding: 0,
                                    margin: 0,
                                    color: 'var(--muted)',
                                    fontSize: 11,
                                    cursor: 'pointer',
                                  }}
                                  title={row.profile.filename_pattern ? 'Click to edit description' : 'Click to add description'}
                                >
                                  {row.profile.filename_pattern || 'add description'}
                                </button>
                              )}
                              {!rowExpanded ? (
                                <>
                                  {/* A connection's cards are per month, not per file, and how many there are
                                      says nothing worth reading; its recency is the last sync, since the newest
                                      card's creation time stops moving after the month's first sync. */}
                                  {isConnection ? (
                                    row.lastSyncedAt ? (
                                      <span>Last synced {row.lastSyncedAt.slice(0, 16).replace('T', ' ')}</span>
                                    ) : null
                                  ) : (
                                    <>
                                      <span>{importedFileCountLabel}</span>
                                      {row.latestBatch ? (
                                        <span style={{ marginLeft: 12 }}>
                                          Last used {row.latestBatch.imported_at.slice(0, 16).replace('T', ' ')}
                                        </span>
                                      ) : null}
                                    </>
                                  )}
                                  {unresolvedDuplicateCount > 0 ? (
                                    <button
                                      type="button"
                                      onClick={() => setExpandedSourceRows(prev => {
                                        const nextState = prev && typeof prev === 'object' ? prev : {}
                                        return { ...nextState, [row.key]: true }
                                      })}
                                      title={`${unresolvedDuplicateCount} flagged duplicate${unresolvedDuplicateCount === 1 ? '' : 's'} across ${rowScopeNoun} — expand to open the per-${isConnection ? 'card' : 'file'} report`}
                                      style={{
                                        display: 'inline-flex',
                                        alignItems: 'center',
                                        gap: 4,
                                        marginLeft: 4,
                                        padding: '1px 7px',
                                        borderRadius: 99,
                                        background: 'color-mix(in srgb, var(--warning) 12%, var(--surface2))',
                                        color: 'var(--warning)',
                                        border: '1px solid color-mix(in srgb, var(--warning) 50%, var(--border))',
                                        fontSize: 11,
                                        fontWeight: 600,
                                        cursor: 'pointer',
                                        lineHeight: 1.5,
                                      }}
                                    >
                                      ⚠ {unresolvedDuplicateCount} duplicate{unresolvedDuplicateCount === 1 ? '' : 's'}
                                    </button>
                                  ) : null}
                                  {needsReviewCount > 0 ? (
                                    <button
                                      type="button"
                                      onClick={() => setExpandedSourceRows(prev => {
                                        const nextState = prev && typeof prev === 'object' ? prev : {}
                                        return { ...nextState, [row.key]: true }
                                      })}
                                      title={`${needsReviewCount} transaction${needsReviewCount === 1 ? '' : 's'} across ${rowScopeNoun} still need review — expand to review or mark them reviewed`}
                                      style={{
                                        display: 'inline-flex',
                                        alignItems: 'center',
                                        gap: 4,
                                        marginLeft: 4,
                                        padding: '1px 7px',
                                        borderRadius: 99,
                                        background: 'color-mix(in srgb, var(--review-marker-color) 14%, var(--surface2))',
                                        color: 'var(--review-marker-color)',
                                        border: '1px solid color-mix(in srgb, var(--review-marker-color) 50%, var(--border))',
                                        fontSize: 11,
                                        fontWeight: 600,
                                        cursor: 'pointer',
                                        lineHeight: 1.5,
                                      }}
                                    >
                                      {needsReviewCount} to review
                                    </button>
                                  ) : null}
                                  {paypalAttentionCount > 0 ? (
                                    <button
                                      type="button"
                                      onClick={() => setExpandedSourceRows(prev => {
                                        const nextState = prev && typeof prev === 'object' ? prev : {}
                                        return { ...nextState, [row.key]: true }
                                      })}
                                      title={`${paypalAttentionCount} PayPal reconciliation item${paypalAttentionCount === 1 ? '' : 's'} across ${rowScopeNoun} need${paypalAttentionCount === 1 ? 's' : ''} a look — expand to open the per-${isConnection ? 'card' : 'file'} reconciliation`}
                                      style={{
                                        display: 'inline-flex',
                                        alignItems: 'center',
                                        gap: 4,
                                        marginLeft: 4,
                                        padding: '1px 7px',
                                        borderRadius: 99,
                                        background: 'color-mix(in srgb, var(--warning) 12%, var(--surface2))',
                                        color: 'var(--warning)',
                                        border: '1px solid color-mix(in srgb, var(--warning) 50%, var(--border))',
                                        fontSize: 11,
                                        fontWeight: 600,
                                        cursor: 'pointer',
                                        lineHeight: 1.5,
                                      }}
                                    >
                                      ⚠ {paypalAttentionCount} to resolve
                                    </button>
                                  ) : null}
                                </>
                              ) : null}
                            </div>
                          </div>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap', flexShrink: 0 }}>
                          {row.profile?.source_kind === 'source:paypal' && onReviewMoneyMovement ? (
                            <button
                              type="button"
                              onClick={() => onReviewMoneyMovement(row.profile.id)}
                              title="Review which PayPal transaction types are transfers (deposits, withdrawals, holds…) so they're excluded from spending and income totals"
                              style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--accent2)', cursor: 'pointer', fontSize: 12, padding: '3px 8px' }}
                            >
                              Review transfer classifications
                            </button>
                          ) : null}
                          {isManual && row.manualDraftRecord ? (
                            <button
                              type="button"
                              onClick={() => {
                                openManualDraftSaveEditor(getSuggestedDataSourceName({
                                  draftRecord: row.manualDraftRecord || manualDraftRecord,
                                }))
                              }}
                              style={{
                                background: 'color-mix(in srgb, var(--accent) 10%, var(--surface2))',
                                color: 'var(--accent2)',
                                border: '1px solid color-mix(in srgb, var(--accent) 28%, var(--border))',
                                borderRadius: 6,
                                padding: '4px 10px',
                                fontSize: 12,
                                fontWeight: 600,
                                cursor: 'pointer',
                                whiteSpace: 'nowrap',
                              }}
                            >
                              Save as data source
                            </button>
                          ) : null}
                        </div>
                      </div>

                      {canExpand && rowExpanded ? (
                        <div style={{ borderTop: '2px solid color-mix(in srgb, var(--border) 92%, var(--accent))', borderBottom: '1px solid var(--border)', background: 'color-mix(in srgb, var(--surface2) 36%, var(--surface))', boxShadow: 'inset 0 1px 0 color-mix(in srgb, white 5%, transparent)' }}>
                          {row.batches.map(b => {
                            const summary = summarizeImportOutcome(b)
                            // Every duplicate the card's report lists: rejected at import, removed by a later
                            // decision (Replace, Reject, a merge), and suspects still awaiting one. One total,
                            // since all three open the same report; only the suspects need action.
                            const suspectDuplicates = Number(b.suspect_duplicate_count || 0)
                            // Rejected rows the report still flags amber — a covered date that paired with
                            // nothing, or paired only two days out. They never entered the ledger, so they
                            // are counted in the duplicates pill's "to review" rather than given a pill of
                            // their own; without this the card said nothing at all about them and they sat
                            // unreviewed forever behind a muted total. They stay out of the Tasks page,
                            // which counts only what is in the ledger awaiting a decision.
                            const advisoryReview = Number(b.advisory_review_count || 0)
                            const settledDuplicates = summary.dedupedCount + Number(b.removed_duplicate_count || 0)
                            const duplicateTotal = settledDuplicates + suspectDuplicates
                            // The card's share of the PayPal reconciliation (a PayPal file, or a sync that
                            // includes a PayPal account), offered only when it lists something and tinted
                            // when something in it needs a look.
                            const hasPaypalRecon = Number(b.paypal_recon_rows || 0) > 0 && !!openReconciliationViewer
                            const paypalAttention = (b.paypal_recon_attention_ids || []).length
                            const batchImportedCategoryChoices = buildBatchImportedCategoryChoices(b)
                            const batchImportedCategorySummary = summarizeImportedCategorySettings(
                              extractImportedCategorySettings(b),
                              batchImportedCategoryChoices,
                              { hideAllScopeLabel: true },
                            )
                            return (
                              <div key={b.id}>
                                <div style={{ padding: '10px 16px 10px 46px', fontSize: 13, borderBottom: (b.accounts?.length || summary.rejectedCount > 0 || duplicateTotal > 0) ? 'none' : '1px solid color-mix(in srgb, var(--border) 80%, transparent)' }}>
                                  <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 160px 90px', gap: 12, alignItems: 'start' }}>
                                    <div style={{ minWidth: 0 }}>
                                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                                        <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={b.filename}>{b.filename}</div>
                                        {summary.importedCount > 0 ? (
                                          <button
                                            type="button"
                                            onClick={() => openBatchDetail(b)}
                                            title={`View imported transactions from ${batchNoun}`}
                                            style={{
                                              background: 'none',
                                              border: 'none',
                                              color: 'var(--accent2)',
                                              cursor: 'pointer',
                                              fontSize: 11,
                                              lineHeight: 1,
                                              padding: 0,
                                              flexShrink: 0,
                                            }}
                                          >
                                            ↗
                                          </button>
                                        ) : null}
                                      </div>
                                    </div>
                                    <span style={{ fontSize: 12, color: 'var(--muted)' }}>{b.imported_at.slice(0, 16).replace('T', ' ')}</span>
                                    {/* From the same summary the duplicate and rejected pills read, so the headline
                                        cannot be one tally while the pills beside it are another. */}
                                    <span style={{ textAlign: 'center' }}>{summary.totalRows} rows</span>
                                  </div>

                                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'stretch', marginTop: 8 }}>
                                    <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between', flexWrap: 'wrap', alignItems: 'flex-start' }}>
                                      {/* Marketplace imports (Amazon, …) always carry their own category
                                          detail from the importer, so the per-file opt-ins don't apply —
                                          the empty spacer keeps Undo right-aligned. The categories toggle
                                          only renders when the source actually carried categories (a
                                          disabled no-op checkbox on e.g. a PayPal card was just noise);
                                          the enrich toggle only when the batch recorded rejected
                                          duplicates whose detail could fold into their matches. */}
                                      {isMarketplace ? <div /> : (
                                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', flex: '1 1 420px', minWidth: 0 }}>
                                        {b.has_imported_categories ? (
                                        <label
                                          style={{
                                            display: 'inline-flex',
                                            alignItems: 'flex-start',
                                            gap: 8,
                                            fontSize: 11,
                                            color: 'var(--text)',
                                            cursor: 'pointer',
                                            lineHeight: 1.45,
                                            flex: '1 1 260px',
                                            minWidth: 0,
                                            border: '1px solid var(--border)',
                                            borderRadius: 8,
                                            padding: '8px 10px',
                                            background: 'color-mix(in srgb, var(--surface2) 50%, transparent)',
                                          }}
                                        >
                                          <input
                                            type="checkbox"
                                            checked={!!b.use_imported_categories}
                                            onChange={event => updateBatchImportedCategoryUsage(b.id, event.target.checked)}
                                          />
                                          <ImportedCategoryUsageInline
                                            showFilter={b.use_imported_categories && batchImportedCategoryChoices.length > 1}
                                            onFilterClick={() => openBatchImportedCategorySettings(b)}
                                          />
                                        </label>
                                        ) : null}
                                        {Number(b.duplicate_row_count || 0) > 0 ? (
                                        <label
                                          style={{
                                            display: 'inline-flex',
                                            alignItems: 'flex-start',
                                            gap: 8,
                                            fontSize: 11,
                                            color: 'var(--text)',
                                            cursor: 'pointer',
                                            lineHeight: 1.45,
                                            flex: '1 1 260px',
                                            minWidth: 0,
                                            border: '1px solid var(--border)',
                                            borderRadius: 8,
                                            padding: '8px 10px',
                                            background: 'color-mix(in srgb, var(--surface2) 50%, transparent)',
                                          }}
                                          title="Fold each rejected duplicate's novel detail (memos, transaction ids, richer names) into the transaction it matched — additive and reversible; rows with no unambiguous match or nothing new are skipped."
                                        >
                                          <input
                                            type="checkbox"
                                            checked={Number(b.enriched_duplicate_count || 0) > 0}
                                            onChange={event => updateBatchEnrichment(b.id, event.target.checked)}
                                          />
                                          <span>
                                            Enrich existing transactions from this source
                                            {Number(b.enriched_duplicate_count || 0) > 0
                                              ? ` — ${b.enriched_duplicate_count} row${Number(b.enriched_duplicate_count) === 1 ? '' : 's'} added detail`
                                              : ''}
                                          </span>
                                        </label>
                                        ) : null}
                                      </div>
                                      )}
                                      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap', alignItems: 'center', flexShrink: 0 }}>
                                        {isUnsaved ? (
                                            <select
                                              value=""
                                              title="Move this imported file under a data source"
                                              onChange={event => {
                                                const value = event.target.value
                                                if (value === '__new__') {
                                                  setAssignNewSourceName(getSuggestedDataSourceName({ previewLike: { filename: b.filename } }))
                                                  setAssignNewSourceBatchId(b.id)
                                                } else if (value) {
                                                  assignUnknownBatchToProfile(b.id, value)
                                                }
                                              }}
                                              style={{
                                                background: 'var(--surface2)', color: 'var(--text)', border: '1px solid var(--border)',
                                                borderRadius: 6, padding: '3px 8px', fontSize: 12, cursor: 'pointer', maxWidth: 200,
                                              }}
                                            >
                                              <option value="">Assign to data source…</option>
                                              {profiles.length > 0 ? (
                                                <optgroup label="Existing data sources">
                                                  {profiles.map(p => (
                                                    <option key={p.id} value={p.id}>{p.name}</option>
                                                  ))}
                                                </optgroup>
                                              ) : null}
                                              <option value="__new__">+ New data source from this file…</option>
                                            </select>
                                        ) : null}
                                        {/* Undo removes an imported *file*. A sync period card isn't an
                                            undoable file event (it accretes across daily fetches), so it
                                            carries no Undo — synced rows are managed on the ledger instead. */}
                                        {isConnection ? null : (
                                          <button onClick={() => handleUndoClick(b)} style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--danger)', cursor: 'pointer', fontSize: 12, padding: '3px 8px' }}>Undo</button>
                                        )}
                                      </div>
                                    </div>
                                    {!isMarketplace && b.use_imported_categories && batchImportedCategorySummary ? (
                                      <div style={{ fontSize: 11, color: 'var(--muted)', textAlign: 'right' }}>
                                        {batchImportedCategorySummary}
                                      </div>
                                    ) : null}
                                  </div>
                                </div>
                                {(b.accounts?.length > 0 || hasPaypalRecon || summary.rejectedCount > 0 || duplicateTotal > 0 || Number(b.needs_review_count || 0) > 0) && (
                                  <div style={{ padding: '4px 16px 10px 58px', borderBottom: '1px solid color-mix(in srgb, var(--border) 80%, transparent)' }}>
                                    {/* Descriptive account chips (how many rows came from each account) wrap on
                                        their own row; the clickable action pills are split out into the labeled
                                        outline below so they live in one consistent place instead of flowing in
                                        amongst the account chips. */}
                                    {b.accounts?.length > 0 ? (
                                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                                    {b.accounts.map((a, i) => (
                                      <SourceAccountChip
                                        key={i}
                                        label={a.csv_value || a.account_name || ''}
                                        mappedLabel={a.account_name || ''}
                                        count={a.row_count}
                                        skipped={a.was_skipped}
                                      />
                                    ))}
                                      </div>
                                    ) : null}
                                    {(hasPaypalRecon || summary.rejectedCount > 0 || duplicateTotal > 0 || Number(b.needs_review_count || 0) > 0) ? (
                                      <div style={{
                                        marginTop: b.accounts?.length > 0 ? 8 : 0,
                                        display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
                                        border: '1px dashed color-mix(in srgb, var(--border) 80%, transparent)',
                                        borderRadius: 10, padding: '6px 10px',
                                      }}>
                                    {hasPaypalRecon ? (
                                      <button
                                        type="button"
                                        onClick={() => openReconciliationViewer({ vendor: 'paypal', batchId: b.id, title: b.filename })}
                                        title={paypalAttention > 0
                                          ? `${paypalAttention} PayPal reconciliation item${paypalAttention === 1 ? '' : 's'} in ${batchNoun} need${paypalAttention === 1 ? 's' : ''} a look — open the PayPal reconciliation`
                                          : `How the PayPal transactions in ${batchNoun} match card and bank transactions`}
                                        style={{
                                          display: 'inline-flex', alignItems: 'center', gap: 4,
                                          fontSize: 11, padding: '2px 7px', borderRadius: 99, cursor: 'pointer',
                                          fontWeight: paypalAttention > 0 ? 600 : 400,
                                          background: paypalAttention > 0 ? 'color-mix(in srgb, var(--warning) 12%, var(--surface2))' : 'var(--surface2)',
                                          color: paypalAttention > 0 ? 'var(--warning)' : 'var(--muted)',
                                          border: paypalAttention > 0
                                            ? '1px solid color-mix(in srgb, var(--warning) 50%, var(--border))'
                                            : '1px solid var(--border)',
                                        }}
                                      >
                                        <span>{paypalAttention > 0 ? `⚠ ${paypalAttention} to resolve` : 'Reconciliation'}</span>
                                        <span style={{ color: 'var(--accent2)', fontSize: 10, lineHeight: 1 }} aria-hidden="true">↗</span>
                                      </button>
                                    ) : null}
                                    {summary.rejectedCount > 0 ? (
                                      <button
                                        type="button"
                                        onClick={() => openRejectedRowsViewer({
                                          source: b,
                                          title: b.filename,
                                        })}
                                        title={`View rejected rows from ${batchNoun}`}
                                        style={{
                                          display: 'inline-flex',
                                          alignItems: 'center',
                                          gap: 4,
                                          fontSize: 11,
                                          padding: '2px 7px',
                                          borderRadius: 99,
                                          background: 'var(--surface2)',
                                          color: 'var(--muted)',
                                          border: '1px solid var(--border)',
                                          cursor: 'pointer',
                                        }}
                                      >
                                        <span>{summary.rejectedCount} rejected</span>
                                        <span style={{ color: 'var(--accent2)', fontSize: 10, lineHeight: 1 }} aria-hidden="true">↗</span>
                                      </button>
                                    ) : null}
                                    {(() => {
                                      // Unified pill: every duplicate the report lists, in one entry point.
                                      // Pill colors warm when soft flags are present — those need user
                                      // review, whereas import rejects and later removals are settled.
                                      const soft = suspectDuplicates
                                      const total = duplicateTotal
                                      if (total <= 0) return null
                                      // Warm for anything still wanting a look, advisory rejects included.
                                      // They are the milder half — a row that never landed, against a soft
                                      // flag sitting IN the ledger awaiting Keep/Discard/Replace — but a
                                      // muted count is one nobody reads, and the whole reason for surfacing
                                      // them was that they had been accruing unseen. Warming is the only
                                      // thing on the card that asks for the click.
                                      const toReview = soft + advisoryReview
                                      const hasSoft = toReview > 0
                                      return (
                                        <button
                                          type="button"
                                          onClick={() => openUnifiedDuplicatesViewer({
                                            source: b,
                                            title: b.filename,
                                          })}
                                          title={toReview > 0
                                            ? `View duplicate rows from ${batchNoun} — ${toReview} still to review`
                                            : `View duplicate rows from ${batchNoun}`}
                                          style={{
                                            display: 'inline-flex',
                                            alignItems: 'center',
                                            gap: 4,
                                            fontSize: 11,
                                            padding: '2px 7px',
                                            borderRadius: 99,
                                            background: hasSoft
                                              ? 'color-mix(in srgb, var(--warning) 12%, var(--surface2))'
                                              : 'var(--surface2)',
                                            color: hasSoft ? 'var(--warning)' : 'var(--muted)',
                                            border: hasSoft
                                              ? '1px solid color-mix(in srgb, var(--warning) 50%, var(--border))'
                                              : '1px solid var(--border)',
                                            cursor: 'pointer',
                                            fontWeight: hasSoft ? 600 : 400,
                                          }}
                                        >
                                          <span>
                                            {hasSoft ? '⚠ ' : ''}{total} duplicate{total === 1 ? '' : 's'}
                                            {toReview > 0 ? ` (${toReview} to review)` : ''}
                                          </span>
                                          <span style={{ color: 'var(--accent2)', fontSize: 10, lineHeight: 1 }} aria-hidden="true">↗</span>
                                        </button>
                                      )
                                    })()}
                                    {Number(b.needs_review_count || 0) > 0 ? (
                                      <>
                                        <button
                                          type="button"
                                          // Opens on the rows the pill counts; the report's own quick filter turns it off.
                                          onClick={() => openBatchDetail({ ...b, _attributeFilter: { attribute: 'needs-review', active: true } })}
                                          title={`Review the transactions imported from ${batchNoun}`}
                                          style={{
                                            display: 'inline-flex', alignItems: 'center', gap: 4,
                                            fontSize: 11, padding: '2px 7px', borderRadius: 99,
                                            background: 'color-mix(in srgb, var(--review-marker-color) 14%, var(--surface2))',
                                            color: 'var(--review-marker-color)',
                                            border: '1px solid color-mix(in srgb, var(--review-marker-color) 50%, var(--border))',
                                            cursor: 'pointer', fontWeight: 600,
                                          }}
                                        >
                                          <span>{b.needs_review_count} to review</span>
                                          <span style={{ color: 'var(--accent2)', fontSize: 10, lineHeight: 1 }} aria-hidden="true">↗</span>
                                        </button>
                                        <button
                                          type="button"
                                          onClick={() => markBatchReviewed(b.id)}
                                          title={`Mark every transaction in ${batchNoun} reviewed`}
                                          style={{
                                            display: 'inline-flex', alignItems: 'center', gap: 4,
                                            fontSize: 11, padding: '2px 7px', borderRadius: 99,
                                            background: 'var(--surface2)', color: 'var(--muted)',
                                            border: '1px solid var(--border)', cursor: 'pointer',
                                          }}
                                        >
                                          ✓ Mark all reviewed
                                        </button>
                                      </>
                                    ) : null}
                                      </div>
                                    ) : null}
                                  </div>
                                )}
                              </div>
                            )
                          })}
                        </div>
                      ) : null}
                    </div>
                  )
                })}
              </>
            )}
          </Card>
        </>
  )
}
