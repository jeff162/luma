// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: GPL-3.0-or-later

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
  buildBatchImportedCategoryChoices,
  openBatchImportedCategorySettings,
  openBatchDetail,
  handleUndoClick,
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
          <Card style={{ padding: 0, overflow: 'hidden', width: '100%' }}>
            {dataSourceRows.length === 0 ? <EmptyState message="No data sources or temporary drafts yet" /> : (
              <>
                {dataSourceRows.map(row => {
                  const isManual = row.kind === 'manual'
                  const isUnknown = row.kind === 'unknown'
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
                              {isManual ? 'temporary draft' : isUnknown ? 'unknown data source' : editingSourceNameKey === getSourceNameEditKey('list', row.profile.id) ? (
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
                              ) : isUnknown ? null : editingSourceDescriptionId === row.profile.id ? (
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
                                        background: 'color-mix(in srgb, #f59e0b 12%, var(--surface2))',
                                        color: '#f59e0b',
                                        border: '1px solid color-mix(in srgb, #f59e0b 50%, var(--border))',
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
                                      <label
                                        style={{
                                          display: 'inline-flex',
                                          alignItems: 'flex-start',
                                          gap: 8,
                                          fontSize: 11,
                                          color: b.has_imported_categories ? 'var(--text)' : 'var(--muted)',
                                          cursor: b.has_imported_categories ? 'pointer' : 'not-allowed',
                                          lineHeight: 1.45,
                                          flex: '1 1 420px',
                                          minWidth: 0,
                                          border: '1px solid var(--border)',
                                          borderRadius: 8,
                                          padding: '8px 10px',
                                          background: 'color-mix(in srgb, var(--surface2) 50%, transparent)',
                                        }}
                                        title={b.has_imported_categories
                                          ? ''
                                          : summary.importedCount > 0
                                            ? 'This import did not include a category column'
                                            : 'This import did not load any new transactions'}
                                      >
                                        <input
                                          type="checkbox"
                                          checked={!!b.use_imported_categories}
                                          disabled={!b.has_imported_categories}
                                          onChange={event => updateBatchImportedCategoryUsage(b.id, event.target.checked)}
                                        />
                                        <ImportedCategoryUsageInline
                                          showFilter={b.use_imported_categories && batchImportedCategoryChoices.length > 1}
                                          onFilterClick={() => openBatchImportedCategorySettings(b)}
                                        />
                                      </label>
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
                                        <button onClick={() => handleUndoClick(b)} style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--danger)', cursor: 'pointer', fontSize: 12, padding: '3px 8px' }}>Undo</button>
                                      </div>
                                    </div>
                                    {b.use_imported_categories && batchImportedCategorySummary ? (
                                      <div style={{ fontSize: 11, color: 'var(--muted)', textAlign: 'right' }}>
                                        {batchImportedCategorySummary}
                                      </div>
                                    ) : null}
                                  </div>
                                </div>
                                {(b.accounts?.length > 0 || summary.rejectedCount > 0 || summary.dedupedCount > 0) && (
                                  <div style={{ padding: '4px 16px 10px 58px', borderBottom: '1px solid color-mix(in srgb, var(--border) 80%, transparent)', display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
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
                                              ? 'color-mix(in srgb, #f59e0b 12%, var(--surface2))'
                                              : 'var(--surface2)',
                                            color: hasSoft ? '#f59e0b' : 'var(--muted)',
                                            border: hasSoft
                                              ? '1px solid color-mix(in srgb, #f59e0b 50%, var(--border))'
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
