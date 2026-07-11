// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import React, { useState } from 'react'
import { summarizeImportOutcome } from '../../lib/importExport/importOutcome.js'
import { AmazonReconciliationDialog } from './AmazonReconciliationDialog.jsx'

// The shared import-history card for one marketplace vendor (Amazon, and any future AliExpress/Temu-style
// vendor), rendered both in the generic Import tab's data-sources section and on the vendor's own import
// tab. It shows the vendor's imported files (the `↗` file ledger, Undo, the "to review" pills) plus any
// vendor-specific row action from the registry below. Marketplace batches skip the CSV-source machinery
// (category opt-in, account mapping, data-source assignment), so this is deliberately the lean subset the
// generic `ImportHistorySection` toggled off for them — extracted so the two surfaces share one control.
// Undo and the file ledger come in as handlers (the hosts own those flows via `useBatchUndo` /
// `useBatchDetailPanels`); this component owns only the vendor's row layout + its vendor-specific action.

const pillActionStyle = { background: 'none', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--accent2)', cursor: 'pointer', fontSize: 12, padding: '3px 8px' }

// A vendor's extra per-file action. Amazon's is the reconciliation report (self-managing its dialog so
// neither host has to wire it). A new vendor registers its own here.
function AmazonReconciliationAction({ batch }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title="How this import's orders line up with your card charges"
        style={pillActionStyle}
      >
        Reconciliation ↗
      </button>
      {open ? <AmazonReconciliationDialog batchId={batch.id} onClose={() => setOpen(false)} /> : null}
    </>
  )
}

const VENDOR_ROW_ACTION = {
  amazon: AmazonReconciliationAction,
}

export function MarketplaceImportHistory({ row, expanded, onToggleExpand, onOpenLedger, onUndo, onMarkReviewed }) {
  const { label, batches, latestBatch } = row
  const RowAction = VENDOR_ROW_ACTION[row.vendor] || null
  const canExpand = batches.length > 0
  const fileCountLabel = batches.length === 1 ? '1 imported file' : `${batches.length} imported files`

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
            return (
              <div key={b.id}>
                <div style={{ padding: '10px 16px 10px 46px', fontSize: 13, borderBottom: needsReview > 0 ? 'none' : '1px solid color-mix(in srgb, var(--border) 80%, transparent)' }}>
                  <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 160px 90px', gap: 12, alignItems: 'start' }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                        <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={b.filename}>{b.filename}</div>
                        {summary.importedCount > 0 ? (
                          <button
                            type="button"
                            onClick={() => onOpenLedger(b)}
                            title="View imported transactions from this file"
                            style={{ background: 'none', border: 'none', color: 'var(--accent2)', cursor: 'pointer', fontSize: 11, lineHeight: 1, padding: 0, flexShrink: 0 }}
                          >
                            ↗
                          </button>
                        ) : null}
                      </div>
                    </div>
                    <span style={{ fontSize: 12, color: 'var(--muted)' }}>{b.imported_at.slice(0, 16).replace('T', ' ')}</span>
                    <span style={{ textAlign: 'center' }}>{b.row_count} rows</span>
                  </div>

                  <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap', alignItems: 'center', marginTop: 8 }}>
                    {RowAction ? <RowAction batch={b} /> : null}
                    <button onClick={() => onUndo(b)} style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--danger)', cursor: 'pointer', fontSize: 12, padding: '3px 8px' }}>Undo</button>
                  </div>
                </div>

                {needsReview > 0 ? (
                  <div style={{ padding: '4px 16px 10px 58px', borderBottom: '1px solid color-mix(in srgb, var(--border) 80%, transparent)' }}>
                    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', border: '1px dashed color-mix(in srgb, var(--border) 80%, transparent)', borderRadius: 10, padding: '6px 10px' }}>
                      <button
                        type="button"
                        onClick={() => onOpenLedger(b)}
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
