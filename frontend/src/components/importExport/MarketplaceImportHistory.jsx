// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { summarizeImportOutcome } from '../../lib/importExport/importOutcome.js'
import { useAmazonReconciliationViewer } from '../../contexts/AmazonReconciliationViewerContext.jsx'
import { useAmazonImportDetailViewer } from '../../contexts/AmazonImportDetailViewerContext.jsx'

// The shared import-history card for one marketplace vendor (Amazon, and any future AliExpress/Temu-style
// vendor), rendered both in the generic Import tab's data-sources section and on the vendor's own import
// tab. It shows the vendor's imported files (the `↗` file ledger, Undo, the "to review" pills) plus any
// vendor-specific row action from the registry below. Marketplace batches skip the CSV-source machinery
// (category opt-in, account mapping, data-source assignment), so this is deliberately the lean subset the
// generic `ImportHistorySection` toggled off for them — extracted so the two surfaces share one control.
// Undo and the file ledger come in as handlers (the hosts own those flows via `useBatchUndo` /
// `useBatchDetailPanels`); this component owns only the vendor's row layout + its vendor-specific action.

// A vendor's extra per-file action, rendered as a count pill inside the per-file pills box — mirroring the
// standard import card's "N duplicates" pill. Amazon's opens the reconciliation report through the app-level
// viewer (so it floats free of the page and survives navigation) — neither host has to wire it; a new vendor
// registers its own here. `count` is the number of transactions the file imported; `attention` is how many
// of its orders need action (a duplicate to resolve, a split match to confirm), which tints the pill.
function AmazonReconciliationAction({ batch, count, attention = 0 }) {
  const { open } = useAmazonReconciliationViewer()
  const warn = attention > 0
  return (
    <button
      type="button"
      onClick={() => open({ batchId: batch.id, title: batch.filename })}
      title={warn
        ? `${attention} order${attention === 1 ? '' : 's'} need review — open the reconciliation report`
        : "Reconcile this import's orders against your card charges"}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, padding: '2px 7px', borderRadius: 99, cursor: 'pointer',
        fontWeight: warn ? 600 : 400,
        background: warn ? 'color-mix(in srgb, var(--warning) 14%, var(--surface2))' : 'var(--surface2)',
        color: warn ? 'var(--warning)' : 'var(--muted)',
        border: warn ? '1px solid color-mix(in srgb, var(--warning) 50%, var(--border))' : '1px solid var(--border)',
      }}
    >
      <span>{count} transaction{count === 1 ? '' : 's'}</span>
      {warn ? <span>· {attention} to resolve</span> : null}
      <span style={{ color: warn ? 'var(--warning)' : 'var(--accent2)', fontSize: 10, lineHeight: 1 }} aria-hidden="true">↗</span>
    </button>
  )
}

const VENDOR_ROW_ACTION = {
  amazon: AmazonReconciliationAction,
}

// One import-outcome pill: a count + label that opens the import-detail report at its category. `warn`
// tints it (used for discarded items — a missing orders file).
function DetailPill({ count, label, title, warn, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, padding: '2px 7px', borderRadius: 99, cursor: 'pointer',
        fontWeight: warn ? 600 : 400,
        background: warn ? 'color-mix(in srgb, var(--warning) 14%, var(--surface2))' : 'var(--surface2)',
        color: warn ? 'var(--warning)' : 'var(--muted)',
        border: warn ? '1px solid color-mix(in srgb, var(--warning) 50%, var(--border))' : '1px solid var(--border)',
      }}
    >
      <span>{count} {label}</span>
      <span style={{ color: warn ? 'var(--warning)' : 'var(--accent2)', fontSize: 10, lineHeight: 1 }} aria-hidden="true">↗</span>
    </button>
  )
}

// The import-outcome pills for an Amazon file, read from the persisted import summary. Each opens the
// import-detail report (floating viewer) pre-selected to its category so the user can investigate — which
// file each row came from, what was discarded, etc. Only non-empty categories are shown.
function AmazonImportDetailPills({ batch, summary }) {
  const { open } = useAmazonImportDetailViewer()
  const s = summary || {}
  const openAt = (category) => open({ batchId: batch.id, title: batch.filename, category })
  const orders = Number(s.orders_imported || 0) + Number(s.non_cash || 0)
  const matched = Number(s.items_enriched || 0)
  const alreadyEnriched = Number(s.already_enriched || 0)
  const discarded = Number(s.items_discarded || 0)
  // How many of this items-before-orders card's items are *still* waiting for their orders file, live from
  // the ledger (`unmatched_item_count`). Once a later orders import attaches them the pill flips from a warn
  // "no match" to a resolved "attached to orders" — so the card stops nagging about a resolved state.
  const stillWaiting = batch.unmatched_item_count == null ? discarded : Number(batch.unmatched_item_count)
  const dups = Number(s.already_applied || 0)
  const charges = Number(s.charges_matched || 0)
  return (
    <>
      {orders > 0 ? <DetailPill count={orders} label={`order${orders === 1 ? '' : 's'}`} title="Orders this import created — click to see them and which file each came from" onClick={() => openAt('orders')} /> : null}
      {matched > 0 ? <DetailPill count={matched} label="items matched" title="Item detail folded into an order" onClick={() => openAt('items_matched')} /> : null}
      {alreadyEnriched > 0 ? <DetailPill count={alreadyEnriched} label="already enriched" title="Item rows whose order already had item detail — a re-imported items file" onClick={() => openAt('already_enriched')} /> : null}
      {discarded > 0 && stillWaiting > 0 ? <DetailPill count={stillWaiting} label="no match" warn title="Item rows whose orders file isn’t here yet. Their detail is saved and will attach automatically when you import the orders file." onClick={() => openAt('items_discarded')} /> : null}
      {discarded > 0 && stillWaiting === 0 ? <DetailPill count={discarded} label="attached to orders" title="These items had no orders file when imported; their detail has since been attached to orders from a later import." onClick={() => openAt('items_discarded')} /> : null}
      {dups > 0 ? <DetailPill count={dups} label="duplicates" title="Orders already imported (this file added nothing new). Click to see which." onClick={() => openAt('duplicates')} /> : null}
      {charges > 0 ? <DetailPill count={charges} label="payments" title="Matched card charges, by payment method" onClick={() => openAt('payments')} /> : null}
    </>
  )
}

// The batch's file list, split back out of the joined batch filename, with any file that contributed
// nothing (every row discarded — the summary's `skipped_files`) struck through: its content isn't in the
// ledger and it can be re-imported (its hash is deliberately not remembered).
function BatchFileNames({ batch }) {
  const struck = new Set(batch.import_summary?.skipped_files || [])
  const parts = String(batch.filename || '').split(', ')
  return parts.map((name, i) => (
    <span
      key={`${name}:${i}`}
      style={struck.has(name) ? { textDecoration: 'line-through', opacity: 0.55 } : undefined}
      title={struck.has(name) ? 'Nothing was imported from this file (every row was discarded) — it can be re-imported.' : undefined}
    >
      {name}{i < parts.length - 1 ? ', ' : ''}
    </span>
  ))
}

// The count of item rows an import touched (enriched / already-enriched / discarded) — used to show
// "N items" on an items-only file card instead of a misleading "0 rows" (items create no transactions).
function importItemsCount(summary) {
  const s = summary || {}
  return Number(s.items_enriched || 0) + Number(s.already_enriched || 0) + Number(s.items_discarded || 0)
}

// Whether an Amazon batch's persisted summary has any import-outcome pill to show.
function hasImportDetailPills(vendor, summary) {
  if (vendor !== 'amazon' || !summary) return false
  return ['orders_imported', 'non_cash', 'items_enriched', 'already_enriched', 'items_discarded', 'already_applied', 'charges_matched']
    .some(k => Number(summary[k] || 0) > 0)
}

export function MarketplaceImportHistory({ row, expanded, onToggleExpand, onOpenLedger, onUndo, onMarkReviewed }) {
  const { label, batches, latestBatch } = row
  const RowAction = VENDOR_ROW_ACTION[row.vendor] || null
  const canExpand = batches.length > 0
  const fileCountLabel = batches.length === 1 ? '1 imported file' : `${batches.length} imported files`
  // Actionable reconciliation items across this vendor's files (duplicates to resolve, split matches to
  // confirm), surfaced as a warning chip on the collapsed card so it's visible without expanding.
  const totalAttention = batches.reduce((sum, b) => sum + Number(b.recon_attention_count || 0), 0)

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, padding: '12px 16px', fontSize: 13, borderBottom: expanded ? 'none' : '1px solid var(--border)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          {canExpand ? (
            <button
              type="button"
              onClick={onToggleExpand}
              style={{ width: 20, height: 20, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface2)', color: 'var(--muted)', cursor: 'pointer', padding: 0, fontSize: 12, lineHeight: 1 }}
              title={expanded ? 'Hide recent imports' : 'Show recent imports'}
            >
              {expanded ? '−' : '+'}
            </button>
          ) : <span style={{ width: 20, height: 20 }} />}
          <div style={{ minWidth: 0 }}>
            <div style={{ color: 'var(--text)' }}>{label}</div>
            {!expanded ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 3, fontSize: 11, color: 'var(--muted)' }}>
                <span>{fileCountLabel}</span>
                {latestBatch ? <span style={{ marginLeft: 12 }}>Last used {latestBatch.imported_at.slice(0, 16).replace('T', ' ')}</span> : null}
                {totalAttention > 0 ? (
                  <span
                    title="Some Amazon orders need review — expand to open the reconciliation report"
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '1px 8px', borderRadius: 99, fontWeight: 600,
                      background: 'color-mix(in srgb, var(--warning) 14%, var(--surface2))', color: 'var(--warning)',
                      border: '1px solid color-mix(in srgb, var(--warning) 50%, var(--border))' }}
                  >
                    ⚠ {totalAttention} to resolve
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {canExpand && expanded ? (
        <div style={{ borderTop: '2px solid color-mix(in srgb, var(--border) 92%, var(--accent))', borderBottom: '1px solid var(--border)', background: 'color-mix(in srgb, var(--surface2) 36%, var(--surface))', boxShadow: 'inset 0 1px 0 color-mix(in srgb, white 5%, transparent)' }}>
          {batches.map(b => {
            const summary = summarizeImportOutcome(b)
            const needsReview = Number(b.needs_review_count || 0)
            const attention = Number(b.recon_attention_count || 0)
            // All the per-file action pills (the reconciliation entry + the review group) share one box; it
            // goes warning-toned when the file has actionable reconciliation items or transactions to review.
            const showVendorAction = RowAction && summary.importedCount > 0
            const showDetailPills = hasImportDetailPills(row.vendor, b.import_summary)
            // Warn-tone the box only while items are still unmatched; a resolved (auto-attached) orphan card
            // is informational, not actionable. `unmatched_item_count` is the live count from the ledger.
            const detailWarn = (b.unmatched_item_count == null
              ? Number(b.import_summary?.items_discarded || 0)
              : Number(b.unmatched_item_count)) > 0
            const showBox = showVendorAction || showDetailPills || needsReview > 0
            const boxWarn = attention > 0 || detailWarn || needsReview > 0
            return (
              <div key={b.id}>
                <div style={{ padding: '10px 16px 10px 46px', fontSize: 13, borderBottom: showBox ? 'none' : '1px solid color-mix(in srgb, var(--border) 80%, transparent)' }}>
                  <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 160px 90px', gap: 12, alignItems: 'start' }}>
                    <div style={{ minWidth: 0 }}>
                      {/* The ledger arrow leads the name: with the list clamped to 3 lines, a trailing arrow
                          gets clipped whenever the names overflow into the ellipsis — the head is the only
                          spot that's always visible. Full name list is on hover. */}
                      <div style={{ display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden', wordBreak: 'break-word' }} title={b.filename}>
                        {summary.importedCount > 0 ? (
                          <span
                            role="button"
                            tabIndex={0}
                            onClick={() => onOpenLedger(b)}
                            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpenLedger(b) } }}
                            title="View imported transactions from this file"
                            aria-label="View imported transactions from this file"
                            style={{ color: 'var(--accent2)', cursor: 'pointer', fontSize: 11, marginRight: 6 }}
                          >
                            ↗
                          </span>
                        ) : null}
                        <BatchFileNames batch={b} />
                      </div>
                    </div>
                    <span style={{ fontSize: 12, color: 'var(--muted)' }}>{b.imported_at.slice(0, 16).replace('T', ' ')}</span>
                    <span style={{ textAlign: 'center' }}>
                      {b.row_count > 0
                        ? `${b.row_count} rows`
                        : (importItemsCount(b.import_summary) > 0 ? `${importItemsCount(b.import_summary)} items` : '0 rows')}
                    </span>
                  </div>

                  <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap', alignItems: 'center', marginTop: 8 }}>
                    <button onClick={() => onUndo(b)} style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--danger)', cursor: 'pointer', fontSize: 12, padding: '3px 8px' }}>Undo</button>
                  </div>
                </div>

                {showBox ? (
                  <div style={{ padding: '4px 16px 10px 58px', borderBottom: '1px solid color-mix(in srgb, var(--border) 80%, transparent)' }}>
                    <div style={{
                      display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', borderRadius: 10, padding: '6px 10px',
                      border: boxWarn
                        ? '1px solid color-mix(in srgb, var(--warning) 45%, var(--border))'
                        : '1px dashed color-mix(in srgb, var(--border) 80%, transparent)',
                      background: boxWarn ? 'color-mix(in srgb, var(--warning) 8%, var(--surface2))' : 'transparent',
                    }}>
                      {showVendorAction ? <RowAction batch={b} count={summary.importedCount} attention={attention} /> : null}
                      {showDetailPills ? <AmazonImportDetailPills batch={b} summary={b.import_summary} /> : null}
                      {needsReview > 0 ? (
                        <>
                          <button
                            type="button"
                            // Opens on the rows the pill counts; the report's own quick filter turns it off.
                            onClick={() => onOpenLedger({ ...b, _attributeFilter: { attribute: 'needs-review', active: true } })}
                            title="Review the transactions imported from this file"
                            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, padding: '2px 7px', borderRadius: 99, background: 'color-mix(in srgb, var(--review-marker-color) 14%, var(--surface2))', color: 'var(--review-marker-color)', border: '1px solid color-mix(in srgb, var(--review-marker-color) 50%, var(--border))', cursor: 'pointer', fontWeight: 600 }}
                          >
                            <span>{needsReview} to review</span>
                            <span style={{ color: 'var(--accent2)', fontSize: 10, lineHeight: 1 }} aria-hidden="true">↗</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => onMarkReviewed(b.id)}
                            title="Mark every transaction in this file reviewed"
                            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, padding: '2px 7px', borderRadius: 99, background: 'var(--surface2)', color: 'var(--muted)', border: '1px solid var(--border)', cursor: 'pointer' }}
                          >
                            ✓ Mark all reviewed
                          </button>
                        </>
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </div>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}
