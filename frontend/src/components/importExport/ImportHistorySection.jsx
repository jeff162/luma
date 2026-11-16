// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// The import history, under the drop zone on the Import page's Data Import tab: every card an import or a
// sync has produced, grouped under the source it came
// from (a saved data source, a marketplace vendor, a connection, the temporary draft, or the unknown
// bucket), with the Group-imported-categories / Generate-rules follow-up actions above the list. A card
// carries its own outcome and drill-ins (file ledger, not-imported, duplicates, reconciliation, undo), so
// this is also where a finished import or sync lands: `focus` names the cards to bring into view —
// their rows are opened, the first is scrolled to, and each is marked until the focus changes. The
// sources themselves are managed on the File Sources tab, not here. Purely presentational — all state
// and callbacks live in ImportTab and arrive as props.

import { useEffect, useMemo, useRef } from 'react'
import { Button, Card, EmptyState, Tooltip, IconButton } from '../ui.jsx'
import { ActionCountBadge, BatchCoverageCell, HistoryAttentionPill, ImportedCategoryUsageInline } from './importPresentational.jsx'
import { FOCUSED_CARD_STYLE, LANDING_SCROLL_MARGIN } from '../../lib/importExport/constants.js'
import { SourceAccountChip } from './SourceAccountChip.jsx'
import { StatusPill } from '../connections/ConnectionStatus.jsx'
import { getSuggestedDataSourceName } from '../../lib/importExport/importDraft.js'
import { providerLabel } from '../../lib/importSourceFields.js'
import { summarizeImportOutcome } from '../../lib/importExport/importOutcome.js'
import { describeDataSourceRow, partitionImportHistory, summarizeBatchAttention } from '../../lib/importExport/importHistoryWindow.js'
import { MarketplaceImportHistory } from './MarketplaceImportHistory.jsx'
import { ImportHistoryArchive } from './ImportHistoryArchive.jsx'
import ContextualExplainer from '../../help/ContextualExplainer.jsx'
import {
  summarizeImportedCategorySettings,
  extractImportedCategorySettings,
} from '../../lib/importExport/importedCategorySettings.js'

export function ImportHistorySection({
  dataSourceRows,
  profiles,
  focus,
  notice,
  expandedSourceRows,
  setExpandedSourceRows,
  openSystemCategoryWorkspace,
  totalSystemCategoryWorkspaceCount,
  pendingSystemCategoryCount,
  openRuleSuggestionReview,
  hasSystemRuleSuggestionWork,
  pendingSystemRuleSuggestionCount,
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
  openUnifiedDuplicatesViewer,
  openReconciliationViewer,
}) {
  // A saved source that has imported nothing has no history; it is listed with the sources.
  const historyRows = useMemo(() => dataSourceRows.filter(row => row.batches.length > 0), [dataSourceRows])
  const { rowKeys: focusedRowKeys, batchIds: focusedBatchIds } = useMemo(
    () => resolveHistoryFocus(historyRows, focus), [historyRows, focus],
  )

  // Bring the focused cards into view once, when they first exist: a focus can arrive before the
  // batch list that holds its cards has loaded, and a card only reaches the DOM a render after its row
  // opens, so the scroll waits on the card itself rather than on the focus.
  const listRef = useRef(null)
  const pinnedRef = useRef(null)
  const landedFocusRef = useRef(null)
  const scrollPendingRef = useRef(false)
  useEffect(() => {
    if (!focus || landedFocusRef.current === focus.token || focusedRowKeys.length === 0) return
    landedFocusRef.current = focus.token
    scrollPendingRef.current = true
    setExpandedSourceRows(prev => ({
      ...(prev && typeof prev === 'object' ? prev : {}),
      ...Object.fromEntries(focusedRowKeys.map(key => [key, true])),
    }))
  }, [focus, focusedRowKeys, setExpandedSourceRows])
  useEffect(() => {
    if (!scrollPendingRef.current) return
    const list = listRef.current
    // A row with no card singled out (a connection with nothing waiting) is landed on by its heading.
    const target = focusedBatchIds.size > 0
      ? list?.querySelector('[data-focused-card="true"]')
      : list?.querySelector('[data-focused-row="true"]')
    if (!target) return
    scrollPendingRef.current = false
    // Rest the target just beneath the pinned block, which would otherwise cover it.
    list.style.setProperty('--pinned-height', `${pinnedRef.current?.offsetHeight || 0}px`)
    target.scrollIntoView({ behavior: 'smooth', block: 'start' })
  })

  return (
        <>
          {/* Pinned to the top of the page's scroll area, so the summary of an import stays on screen
              beside the card it landed on however far down the history that card sits. The padding
              and matching negative margin keep a gap under the tab row once the block is stuck. */}
          <div
            ref={pinnedRef}
            style={{ position: 'sticky', top: 0, zIndex: 2, background: 'var(--bg)', paddingTop: 12, marginTop: -12, paddingBottom: 10 }}
          >
            {notice}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', }}>
              <div style={{ fontSize: 16, fontWeight: 600, marginRight: 'auto' }}>Import history</div>
              <Tooltip describeTrigger content={totalSystemCategoryWorkspaceCount === 0 ? 'No imported categories are waiting to be grouped' : ''}>
                <Button
                  variant="secondary"
                  onClick={openSystemCategoryWorkspace}
                  disabled={totalSystemCategoryWorkspaceCount === 0}
                >
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                    <span>Group imported categories</span>
                    <ActionCountBadge count={pendingSystemCategoryCount} tone="warning" />
                  </span>
                </Button>
              </Tooltip>
              <Tooltip describeTrigger content={hasSystemRuleSuggestionWork ? '' : 'Mark a categorized import as clean to generate rules'}>
                <Button
                  variant="secondary"
                  onClick={() => openRuleSuggestionReview()}
                  disabled={!hasSystemRuleSuggestionWork}
                >
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                    <span>Generate rules</span>
                    <ActionCountBadge count={pendingSystemRuleSuggestionCount} />
                  </span>
                </Button>
              </Tooltip>
            </div>
          </div>
          {/* Callouts only. Once dismissed, the saved-sources guidance is the `?` on the File Sources tab's
              source list, and the needs-review one is reached from the page's help — it explains the
              pills on the cards, so a `?` up here had nothing to sit beside. */}
          <ContextualExplainer topic="unknown-data-source" persistentButton={false} style={{ marginBottom: 12 }}
            active={historyRows.some(row => row.kind === 'manual' || row.kind === 'unknown')} />
          <ContextualExplainer topic="reviewing-transactions" persistentButton={false} style={{ marginBottom: 12 }}
            active={historyRows.some(row => row.batches?.some(b => Number(b.needs_review_count || 0) > 0))} />
          <Card style={{ padding: 0, overflow: 'hidden', width: '100%' }}>
            <div ref={listRef}>
            {historyRows.length === 0 ? <EmptyState message="Nothing imported yet" /> : (
              <>
                {historyRows.map(row => {
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
                        focusedBatchIds={focusedBatchIds}
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
                  // What the cards inside still want done, summarized the same way the archive does it
                  // (`summarizeBatchAttention`) — per-batch pills only appear when the row is expanded, so
                  // a collapsed row that said nothing would hide the fact that a file inside needs a look.
                  // Hard-rejected rows already settled at import (`deduped_count`) stay out of it; the
                  // rejections still flagged amber (`advisory_review_count`) do not, which is how the
                  // card's own duplicates pill counts them, and leaving them out here left a source whose
                  // only outstanding work was of that kind reading as entirely clean.
                  const attention = summarizeBatchAttention(row.batches)
                  const unresolvedDuplicateCount = attention.unresolvedDuplicates
                  const needsReviewCount = attention.needsReview
                  const walletAttentionCount = openReconciliationViewer ? attention.walletAttention : 0

                  // Only the recent cards are listed; the rest stay reachable through the year archive
                  // below them, which renders them with this same card renderer.
                  const { recent: recentBatches, archive: archivedBatches } = partitionImportHistory(row.batches)
                  const renderBatchCard = b => {
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
                    // A cleared card's `deduped_count` stays true as a fact about the import but no
                    // longer names rows the report can show, so it leaves this total — the pill's
                    // contract is the report's own count, and offering to open an empty report is
                    // worse than not offering. What survives a clear is counted from `txn`.
                    const settledDuplicates = (b.detail_cleared_at ? 0 : summary.dedupedCount)
                      + Number(b.removed_duplicate_count || 0)
                    const duplicateTotal = settledDuplicates + suspectDuplicates
                    // The card's share of the wallet reconciliation (a PayPal file, or a sync that
                    // includes a wallet account), offered only when it lists something and tinted
                    // when something in it needs a look.
                    const hasWalletRecon = Number(b.wallet_recon_rows || 0) > 0 && !!openReconciliationViewer
                    const walletAttention = (b.wallet_recon_attention_ids || []).length
                    const batchImportedCategoryChoices = buildBatchImportedCategoryChoices(b)
                    const batchImportedCategorySummary = summarizeImportedCategorySettings(
                      extractImportedCategorySettings(b),
                      batchImportedCategoryChoices,
                      { hideAllScopeLabel: true },
                    )
                    const focused = focusedBatchIds.has(b.id)
                    return (
                      <div key={b.id} data-focused-card={focused ? 'true' : undefined} style={focused ? FOCUSED_CARD_STYLE : undefined}>
                        <div style={{ padding: '10px 16px 10px 46px', fontSize: 13, borderBottom: (b.accounts?.length || summary.rejectedCount > 0 || duplicateTotal > 0) ? 'none' : '1px solid color-mix(in srgb, var(--border) 80%, transparent)' }}>
                          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 160px 90px', gap: 12, alignItems: 'start' }}>
                            <div style={{ minWidth: 0 }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                                <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={b.filename}>{b.filename}</div>
                                {summary.importedCount > 0 ? (
                                  <IconButton
                                    size="compact"
                                    tone="accent"
                                    onClick={() => openBatchDetail(b)}
                                    aria-label={`View imported transactions from ${batchNoun}`}
                                    style={{ flexShrink: 0 }}
                                  >
                                    ↗
                                  </IconButton>
                                ) : null}
                              </div>
                            </div>
                            <BatchCoverageCell batch={b} />
                            {/* From the same summary the duplicate and rejected pills read, so the headline
                                cannot be one tally while the pills beside it are another. */}
                            <span style={{ textAlign: 'center' }}>
                              {summary.totalRows} rows
                              {/* How many of them landed, where that is not all of them — the figure a
                                  finished import leads with, kept on the card that outlives it. */}
                              {summary.importedCount !== summary.totalRows ? (
                                <span style={{ display: 'block', fontSize: 11, color: 'var(--muted)' }}>
                                  {summary.importedCount} imported
                                </span>
                              ) : null}
                            </span>
                          </div>

                          {/* A file that re-states a period an earlier import already covered lands
                              nothing, and the card otherwise says so only by arithmetic — "6 rows" above
                              a duplicates pill of the same size. It is the ordinary outcome of importing
                              statements over an activity export, so it is stated plainly, and stated as
                              what it did rather than as a failure: the rows it could not add are usually
                              the same rows whose detail it folded into the ledger. */}
                          {/* Why a card that refused rows now shows no duplicates pill. Without it a
                              cleared card is indistinguishable from an import that found nothing. */}
                          {b.detail_cleared_at ? (
                            <div style={{ marginTop: 6, fontSize: 11, color: 'var(--muted)', fontStyle: 'italic' }}>
                              Stored detail cleared — the duplicate report this import kept has been freed
                            </div>
                          ) : null}
                          {summary.importedCount === 0 && (summary.dedupedCount + summary.ignoredCount) > 0 ? (
                            <div style={{ marginTop: 6, fontSize: 11, color: 'var(--muted)', fontStyle: 'italic' }}>
                              No new transactions — every row was already in the ledger
                              {Number(b.enriched_duplicate_count || 0) > 0
                                ? `, and ${b.enriched_duplicate_count} existing row${Number(b.enriched_duplicate_count) === 1 ? '' : 's'} gained detail from it`
                                : ''}
                            </div>
                          ) : null}
                          {/* An amount this import corrected on a row it did not create. It is stated on
                              the card because nothing else records it: the row shows its revised figure
                              and no longer says it moved. */}
                          {summary.updatedCount > 0 ? (
                            <div style={{ marginTop: 6, fontSize: 11, color: 'var(--muted)', fontStyle: 'italic' }}>
                              {summary.updatedCount} existing transaction{summary.updatedCount === 1 ? '' : 's'} updated to a revised amount
                            </div>
                          ) : null}
                          {/* Rows this source restated from its own prior import. Stated as a count with
                              nothing to open, which is the whole point — the transaction each one
                              duplicates is in the ledger, so there is no second copy to go and read. The
                              line above already says it for a file that landed nothing. */}
                          {summary.ignoredCount > 0 && summary.importedCount > 0 ? (
                            <div style={{ marginTop: 6, fontSize: 11, color: 'var(--muted)', fontStyle: 'italic' }}>
                              {summary.ignoredCount} row{summary.ignoredCount === 1 ? '' : 's'} already in the ledger
                            </div>
                          ) : null}

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
                                  <Button size="compact" variant="quiet" tone="danger" onClick={() => handleUndoClick(b)}>Undo</Button>
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
                        {(b.accounts?.length > 0 || hasWalletRecon || summary.rejectedCount > 0 || duplicateTotal > 0 || Number(b.needs_review_count || 0) > 0) && (
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
                                label={a.nickname || a.csv_value || a.account_name || ''}
                                mappedLabel={a.account_name || ''}
                                count={a.row_count}
                                skipped={a.was_skipped}
                              />
                            ))}
                              </div>
                            ) : null}
                            {(hasWalletRecon || summary.rejectedCount > 0 || duplicateTotal > 0 || Number(b.needs_review_count || 0) > 0) ? (
                              <div style={{
                                marginTop: b.accounts?.length > 0 ? 8 : 0,
                                display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
                                border: '1px dashed color-mix(in srgb, var(--border) 80%, transparent)',
                                borderRadius: 10, padding: '6px 10px',
                              }}>
                            {hasWalletRecon ? (
                              <StatusPill
                                mark="report"
                                tone={walletAttention > 0 ? 'warning' : 'muted'}
                                onClick={() => openReconciliationViewer({ vendor: 'wallet', batchId: b.id, title: b.filename })}
                                title={walletAttention > 0
                                  ? `${walletAttention} wallet reconciliation item${walletAttention === 1 ? '' : 's'} in ${batchNoun} need${walletAttention === 1 ? 's' : ''} a look — open the wallet reconciliation`
                                  : `How the wallet transactions in ${batchNoun} match card and bank transactions`}
                              >
                                {walletAttention > 0 ? `⚠ ${walletAttention} to resolve` : 'Reconciliation'}
                              </StatusPill>
                            ) : null}
                            {summary.rejectedCount > 0 ? (
                              <StatusPill
                                mark="report"
                                tone="muted"
                                // The rows themselves live in the file's own report, beside the
                                // ones that did arrive — the pill is the count and the way in,
                                // not a second viewer.
                                onClick={() => openBatchDetail({ ...b, _view: 'not-imported' })}
                                title={`View the rows not imported from ${batchNoun}`}
                              >
                                {summary.rejectedCount} rejected
                              </StatusPill>
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
                                <StatusPill
                                  mark="report"
                                  tone={hasSoft ? 'warning' : 'muted'}
                                  onClick={() => openUnifiedDuplicatesViewer({
                                    source: b,
                                    title: b.filename,
                                  })}
                                  title={toReview > 0
                                    ? `View duplicate rows from ${batchNoun} — ${toReview} still to review`
                                    : `View duplicate rows from ${batchNoun}`}
                                >
                                  {hasSoft ? '⚠ ' : ''}{total} duplicate{total === 1 ? '' : 's'}
                                  {toReview > 0 ? ` (${toReview} to review)` : ''}
                                </StatusPill>
                              )
                            })()}
                            {Number(b.needs_review_count || 0) > 0 ? (
                              <>
                                <StatusPill
                                  mark="report"
                                  tone="review"
                                  // Opens on the rows the pill counts; the report's own quick filter turns it off.
                                  onClick={() => openBatchDetail({ ...b, _attributeFilter: { attribute: 'needs-review', active: true } })}
                                  title={`Review the transactions imported from ${batchNoun}`}
                                >
                                  {b.needs_review_count} to review
                                </StatusPill>
                                <Button size="compact" variant="secondary" onClick={() => markBatchReviewed(b.id)} title={`Mark every transaction in ${batchNoun} reviewed`}>
                                  ✓ Mark all reviewed
                                </Button>
                              </>
                            ) : null}
                              </div>
                            ) : null}
                          </div>
                        )}
                      </div>
                    )
                  }

                  return (
                    <div key={row.key} data-focused-row={focusedRowKeys.includes(row.key) ? 'true' : undefined} style={{ scrollMarginTop: LANDING_SCROLL_MARGIN }}>
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
                              {isManual ? 'temporary draft' : isUnknown ? 'unknown data source' : isConnection ? row.label : row.profile.name}
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
                                <span>{describeDataSourceRow(row, providerLabel).qualifier}</span>
                              ) : isUnknown ? null : (
                                row.profile.filename_pattern ? <span>{row.profile.filename_pattern}</span> : null
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
                                    <HistoryAttentionPill
                                      onClick={() => setExpandedSourceRows(prev => {
                                        const nextState = prev && typeof prev === 'object' ? prev : {}
                                        return { ...nextState, [row.key]: true }
                                      })}
                                      title={`${unresolvedDuplicateCount} duplicate-report row${unresolvedDuplicateCount === 1 ? '' : 's'} across ${rowScopeNoun} still waiting for a verdict — expand to open the per-${isConnection ? 'card' : 'file'} report`}
                                    >
                                      ⚠ {unresolvedDuplicateCount} duplicate{unresolvedDuplicateCount === 1 ? '' : 's'}
                                    </HistoryAttentionPill>
                                  ) : null}
                                  {needsReviewCount > 0 ? (
                                    <HistoryAttentionPill
                                      tone="review"
                                      onClick={() => setExpandedSourceRows(prev => {
                                        const nextState = prev && typeof prev === 'object' ? prev : {}
                                        return { ...nextState, [row.key]: true }
                                      })}
                                      title={`${needsReviewCount} transaction${needsReviewCount === 1 ? '' : 's'} across ${rowScopeNoun} still need review — expand to review or mark them reviewed`}
                                    >
                                      {needsReviewCount} to review
                                    </HistoryAttentionPill>
                                  ) : null}
                                  {walletAttentionCount > 0 ? (
                                    <HistoryAttentionPill
                                      onClick={() => setExpandedSourceRows(prev => {
                                        const nextState = prev && typeof prev === 'object' ? prev : {}
                                        return { ...nextState, [row.key]: true }
                                      })}
                                      title={`${walletAttentionCount} wallet reconciliation item${walletAttentionCount === 1 ? '' : 's'} across ${rowScopeNoun} need${walletAttentionCount === 1 ? 's' : ''} a look — expand to open the per-${isConnection ? 'card' : 'file'} reconciliation`}
                                    >
                                      ⚠ {walletAttentionCount} to resolve
                                    </HistoryAttentionPill>
                                  ) : null}
                                </>
                              ) : null}
                            </div>
                          </div>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap', flexShrink: 0 }}>
                          {isManual && row.manualDraftRecord ? (
                            <Button
                              size="compact"
                              variant="secondary"
                              onClick={() => {
                                openManualDraftSaveEditor(getSuggestedDataSourceName({
                                  draftRecord: row.manualDraftRecord || manualDraftRecord,
                                }))
                              }}
                            >
                              Save as data source
                            </Button>
                          ) : null}
                        </div>
                      </div>

                      {canExpand && rowExpanded ? (
                        <div style={{ borderTop: '2px solid color-mix(in srgb, var(--border) 92%, var(--accent))', borderBottom: '1px solid var(--border)', background: 'color-mix(in srgb, var(--surface2) 36%, var(--surface))', boxShadow: 'inset 0 1px 0 color-mix(in srgb, white 5%, transparent)' }}>
                          {recentBatches.map(renderBatchCard)}
                          <ImportHistoryArchive
                            archive={archivedBatches}
                            revealIds={focusedBatchIds}
                            renderBatch={renderBatchCard}
                            noun={isConnection ? 'cards' : 'imports'}
                          />
                        </div>
                      ) : null}
                    </div>
                  )
                })}
              </>
            )}
            </div>
          </Card>
        </>
  )
}

// What a landing opens and marks. Cards are named outright (a finished import, the cards a sync wrote
// to); a connection named without cards opens its row and marks whichever of its cards still hold
// something to review, which is what the pill that leads here was counting.
function resolveHistoryFocus(rows, focus) {
  if (!focus) return { rowKeys: [], batchIds: new Set() }
  const batchIds = new Set(focus.batchIds || [])
  const connectionIds = new Set(focus.connectionIds || [])
  const rowKeys = []
  for (const row of rows) {
    const named = connectionIds.has(row.connectionId)
    if (named) {
      row.batches
        .filter(b => summarizeBatchAttention([b]).unresolvedDuplicates > 0)
        .forEach(b => batchIds.add(b.id))
    }
    if (named || row.batches.some(b => batchIds.has(b.id))) rowKeys.push(row.key)
  }
  return { rowKeys, batchIds }
}
