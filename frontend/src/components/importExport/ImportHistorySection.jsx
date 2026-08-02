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
import { Button, Card, EmptyState } from '../ui.jsx'
import { ActionCountBadge, ImportedCategoryUsageInline } from './importPresentational.jsx'
import { getSuggestedDataSourceName } from '../../lib/importExport/importDraft.js'
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
                <Button
                  small
                  variant="ghost"
                  onClick={openSystemCategoryWorkspace}
                  disabled={totalSystemCategoryWorkspaceCount === 0}
                  title={totalSystemCategoryWorkspaceCount === 0 ? 'No imported categories are waiting to be grouped' : ''}
                >
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                    <span>Group imported categories</span>
                    <ActionCountBadge count={pendingSystemCategoryCount} tone="warning" />
                  </span>
                </Button>
                <Button
                  small
                  variant="ghost"
                  onClick={() => openRuleSuggestionReview()}
                  disabled={!hasSystemRuleSuggestionWork}
                  title={hasSystemRuleSuggestionWork ? '' : 'Mark a categorized import as clean to generate rules'}
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
                              ) : isUnknown || isMarketplace || isConnection ? null : editingSourceDescriptionId === row.profile.id ? (
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
                                  <span>{importedFileCountLabel}</span>
                                  {row.latestBatch ? (
                                    <span style={{ marginLeft: 12 }}>
                                      Last used {row.latestBatch.imported_at.slice(0, 16).replace('T', ' ')}
                                    </span>
                                  ) : null}
                                  {unresolvedDuplicateCount > 0 ? (
                                    <button
                                      type="button"
                                      onClick={() => setExpandedSourceRows(prev => {
                                        const nextState = prev && typeof prev === 'object' ? prev : {}
                                        return { ...nextState, [row.key]: true }
                                      })}
                                      title={`${unresolvedDuplicateCount} flagged duplicate${unresolvedDuplicateCount === 1 ? '' : 's'} across imports in this data source — expand to open the per-file report`}
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
                            const batchImportedCategoryChoices = buildBatchImportedCategoryChoices(b)
                            const batchImportedCategorySummary = summarizeImportedCategorySettings(
                              extractImportedCategorySettings(b),
                              batchImportedCategoryChoices,
                              { hideAllScopeLabel: true },
                            )
                            return (
                              <div key={b.id}>
                                <div style={{ padding: '10px 16px 10px 46px', fontSize: 13, borderBottom: (b.accounts?.length || summary.rejectedCount > 0 || summary.dedupedCount > 0) ? 'none' : '1px solid color-mix(in srgb, var(--border) 80%, transparent)' }}>
                                  <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 160px 90px', gap: 12, alignItems: 'start' }}>
                                    <div style={{ minWidth: 0 }}>
                                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                                        <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={b.filename}>{b.filename}</div>
                                        {summary.importedCount > 0 ? (
                                          <button
                                            type="button"
                                            onClick={() => openBatchDetail(b)}
                                            title="View imported transactions from this file"
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
                                    <span style={{ textAlign: 'center' }}>{b.row_count} rows</span>
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
                                {(b.accounts?.length > 0 || summary.rejectedCount > 0 || summary.dedupedCount > 0 || Number(b.needs_review_count || 0) > 0) && (
                                  <div style={{ padding: '4px 16px 10px 58px', borderBottom: '1px solid color-mix(in srgb, var(--border) 80%, transparent)' }}>
                                    {/* Descriptive account chips (how many rows came from each account) wrap on
                                        their own row; the clickable action pills are split out into the labeled
                                        outline below so they live in one consistent place instead of flowing in
                                        amongst the account chips. */}
                                    {b.accounts?.length > 0 ? (
                                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                                    {b.accounts.map((a, i) => {
                                      const count = Number(a.row_count || 0)
                                      const csvLabel = a.csv_value || a.account_name || ''
                                      const mappedLabel = a.account_name || ''
                                      // Not skipped by the user, but contributed no new rows (every row was a duplicate of
                                      // an earlier file, or the rows were later removed). It reads as a third state — muted
                                      // with a minus — so the green check never implies rows loaded when none did.
                                      const noNewRows = !a.was_skipped && count === 0
                                      const muted = a.was_skipped || noNewRows
                                      // If the CSV's original account label differs from the account it currently
                                      // resolves to, the user mapped it after the import completed. Surface both
                                      // so the file card matches what the user saw at import time, with the mapped
                                      // destination as a faded suffix.
                                      const showMapping = !a.was_skipped && mappedLabel && csvLabel && mappedLabel !== csvLabel
                                      const truncate = s => (s && s.length > 22 ? s.slice(0, 20) + '…' : s)
                                      const primary = csvLabel
                                      const baseTooltip = showMapping
                                        ? `${csvLabel} → ${mappedLabel}`
                                        : (a.was_skipped ? csvLabel : (mappedLabel || csvLabel))
                                      const tooltip = noNewRows ? `${baseTooltip} · no new transactions` : baseTooltip
                                      return (
                                        <span key={i} title={tooltip} style={{
                                          display: 'inline-flex', alignItems: 'center', gap: 4,
                                          fontSize: 11, padding: '2px 7px', borderRadius: 99,
                                          background: muted
                                            ? 'var(--surface2)'
                                            : 'color-mix(in srgb, var(--accent) 10%, var(--surface2))',
                                          color: muted ? 'var(--muted)' : 'var(--text)',
                                          border: '1px solid var(--border)',
                                        }}>
                                          <span style={{ color: muted ? 'var(--muted)' : 'var(--success)', fontWeight: 600 }}>
                                            {a.was_skipped ? '✕' : noNewRows ? '−' : '✓'}
                                          </span>
                                          {truncate(primary)}
                                          {showMapping ? (
                                            <>
                                              <span style={{ color: 'var(--muted)', opacity: 0.7 }}>→</span>
                                              <span style={{ color: 'var(--muted)' }}>{truncate(mappedLabel)}</span>
                                            </>
                                          ) : null}
                                          {count > 0 && <span style={{ color: 'var(--muted)' }}>{count}</span>}
                                        </span>
                                      )
                                    })}
                                      </div>
                                    ) : null}
                                    {(summary.rejectedCount > 0 || (summary.dedupedCount + Number(b.suspect_duplicate_count || 0)) > 0 || Number(b.needs_review_count || 0) > 0) ? (
                                      <div style={{
                                        marginTop: b.accounts?.length > 0 ? 8 : 0,
                                        display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
                                        border: '1px dashed color-mix(in srgb, var(--border) 80%, transparent)',
                                        borderRadius: 10, padding: '6px 10px',
                                      }}>
                                    {summary.rejectedCount > 0 ? (
                                      <button
                                        type="button"
                                        onClick={() => openRejectedRowsViewer({
                                          source: b,
                                          title: b.filename,
                                        })}
                                        title="View rejected rows from this file"
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
                                      // Unified pill: combines hard-reject (`deduped_count`)
                                      // and soft-flag (`suspect_duplicate_count`) totals into
                                      // one entry point. Pill colors warm when soft flags are
                                      // present — those need user review, whereas hard rejects
                                      // are already resolved.
                                      const hard = summary.dedupedCount
                                      const soft = Number(b.suspect_duplicate_count || 0)
                                      const total = hard + soft
                                      if (total <= 0) return null
                                      const hasSoft = soft > 0
                                      return (
                                        <button
                                          type="button"
                                          onClick={() => openUnifiedDuplicatesViewer({
                                            source: b,
                                            title: b.filename,
                                          })}
                                          title="View duplicate rows from this file"
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
                                            {hasSoft ? ` (${soft} to review)` : ''}
                                          </span>
                                          <span style={{ color: 'var(--accent2)', fontSize: 10, lineHeight: 1 }} aria-hidden="true">↗</span>
                                        </button>
                                      )
                                    })()}
                                    {Number(b.needs_review_count || 0) > 0 ? (
                                      <>
                                        <button
                                          type="button"
                                          onClick={() => openBatchDetail(b)}
                                          title="Review the transactions imported from this file"
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
                                          title="Mark every transaction in this file reviewed"
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
