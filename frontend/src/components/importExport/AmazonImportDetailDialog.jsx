// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo, useState } from 'react'
import { Tooltip, ROW_HOVER_OPEN_DELAY_MS } from '../ui.jsx'
import { DetailPanelShell, useDetailPanelChrome, useRestorablePanelGeometry } from '../detailShared.jsx'
import { formatTransactionAmount } from '../../lib/moneyDisplay.js'
import { AMAZON_IMPORT_DETAIL_COLUMNS_PREF_KEY } from '../../lib/importExport/constants.js'
import FeatureExplainer from '../../help/FeatureExplainer.jsx'
import { MerchantOriginHoverCard } from '../OriginFields.jsx'
import { MatchReport } from './MatchReport.jsx'
import { TransactionMatchCell } from './TransactionMatchCell.jsx'

// The "what did this import do" report for one Amazon batch — the investigative companion to the
// reconciliation report. It answers "which file did this come from?" for every category of the import
// outcome: the orders it created, the items that got matched into them, the items it discarded (no
// matching order), the orders that were already imported (duplicates), and the matched card charges tallied
// by payment method. Data + loading/error/reload are owned by AmazonImportDetailViewerContext (so the report
// floats free of the page and survives navigation); this component is presentational.

const AMAZON_IMPORT_DETAIL_PANEL_PREF_KEY = 'ui.amazonImportDetail.panel'

// A backend txn summary → the record TransactionMatchCell wants.
function toRecord(txn) {
  if (!txn) return null
  return { date: txn.date, merchant: txn.name, amount: txn.amount, account_name: txn.account }
}

// An order cell with the ledger's shared origin-fields card on hover (source file, evidence, …).
function OrderCell({ txn }) {
  if (!txn) return <TransactionMatchCell record={null} />
  return (
    // The dwell keeps the card from strobing at every row that scrolls under a resting cursor.
    <Tooltip content={<MerchantOriginHoverCard txn={txn} />} maxWidth={380} triggerStyle={{ minWidth: 0 }} openDelay={ROW_HOVER_OPEN_DELAY_MS}>
      <div><TransactionMatchCell record={toRecord(txn)} /></div>
    </Tooltip>
  )
}

const SourceFile = ({ value }) => (
  <span style={{ fontSize: 11, color: value ? 'var(--muted)' : 'var(--border)' }} title={value || ''}>{value || '—'}</span>
)

// Per-category presentation: label, the rows it draws from the payload, and its columns. `warn` marks the
// two "you probably lost something" categories (discarded items, duplicate orders).
const CATEGORIES = [
  {
    key: 'orders', label: 'Orders', rows: (d) => d.orders || [],
    columns: [
      { key: 'order', label: 'Amazon order', width: 380, render: (e) => <OrderCell txn={e} /> },
      { key: 'file', label: 'Source file', render: (e) => <SourceFile value={e.source_file} /> },
    ],
    getRowId: (e) => e.id,
  },
  {
    key: 'items_matched', label: 'Items matched', rows: (d) => d.items_matched || [],
    columns: [
      { key: 'order', label: 'Amazon order', width: 380, render: (e) => <OrderCell txn={e} /> },
      { key: 'file', label: 'Source file', render: (e) => <SourceFile value={e.source_file} /> },
    ],
    getRowId: (e) => e.id,
  },
  {
    key: 'already_enriched', label: 'Already enriched', rows: (d) => d.already_enriched || [],
    columns: [
      { key: 'order', label: 'Amazon order', width: 380, render: (e) => <OrderCell txn={e} /> },
      { key: 'file', label: 'Source file', render: (e) => <SourceFile value={e.source_file} /> },
    ],
    getRowId: (e, i) => e.id || `ae:${i}`,
  },
  {
    key: 'items_discarded', label: 'Items discarded', warn: true, rows: (d) => d.items_discarded || [],
    columns: [
      { key: 'order_id', label: 'Order id', width: 220, render: (e) => <span style={{ fontSize: 12 }}>{e.order_id}</span> },
      { key: 'desc', label: 'Item', render: (e) => <span style={{ fontSize: 12 }}>{e.description || '—'}</span> },
      { key: 'date', label: 'Order date', width: 140, render: (e) => <span style={{ fontSize: 12, color: 'var(--muted)' }}>{e.date || '—'}</span> },
      { key: 'file', label: 'Source file', width: 220, render: (e) => <SourceFile value={e.source_file} /> },
    ],
    getRowId: (e, i) => `${e.order_id}:${i}`,
  },
  {
    key: 'duplicates', label: 'Duplicates', warn: true, rows: (d) => d.duplicate_orders || [],
    columns: [
      { key: 'order_id', label: 'Order id', width: 220, render: (e) => <span style={{ fontSize: 12 }}>{e.order_id}</span> },
      { key: 'date', label: 'Order date', width: 140, render: (e) => <span style={{ fontSize: 12, color: 'var(--muted)' }}>{e.date || '—'}</span> },
      { key: 'file', label: 'Source file', render: (e) => <SourceFile value={e.source_file} /> },
    ],
    getRowId: (e, i) => `${e.order_id}:${i}`,
  },
  {
    key: 'payments', label: 'Payments', rows: (d) => d.payments || [],
    columns: [
      { key: 'account', label: 'Payment method', render: (e) => <span style={{ fontSize: 13 }}>{e.account}</span> },
      { key: 'count', label: 'Charges', width: 120, align: 'right', render: (e) => e.count },
      { key: 'total', label: 'Total', width: 140, align: 'right', render: (e) => formatTransactionAmount(e.total) },
    ],
    getRowId: (e) => e.account,
  },
]

const CATEGORY_HELP = {
  orders: 'Every order this import created, with the file it came from.',
  items_matched: 'Orders whose per-item detail (from an items file) was folded into them.',
  already_enriched: 'Item rows whose order already had item detail — a re-imported items file, so nothing new was added.',
  items_discarded: 'Item rows whose order was never imported, so there was nothing to attach them to — import the matching orders file, then re-import the items.',
  duplicates: 'Orders that were already imported, so this file added nothing new.',
  payments: 'The matched card charges, tallied by the ledger account they landed on.',
}

export function AmazonImportDetailDialog({
  data,
  loading = false,
  error = '',
  initialCategory = 'orders',
  onClose,
  onReload,
  onMinimize,
  stackIndex = 0,
  isTopmost = true,
}) {
  const [activeKey, setActiveKey] = useState(initialCategory || 'orders')

  const { initialPosition, initialSize, onGestureEnd } = useRestorablePanelGeometry(
    AMAZON_IMPORT_DETAIL_PANEL_PREF_KEY, { fallbackWidth: 900, fallbackHeight: 640 })
  const { pos, size, panelRef, onDragStart, onResizeStart } = useDetailPanelChrome(onClose, {
    forceFloating: true, stackIndex, initialPosition, initialSize, onGestureEnd,
  })

  const active = CATEGORIES.find(c => c.key === activeKey) || CATEGORIES[0]
  const entries = useMemo(() => (data ? active.rows(data) : []), [data, active])

  const chromeButtonStyle = {
    background: 'var(--surface2)', border: '1px solid var(--border)',
    borderRadius: 6, padding: '4px 10px', cursor: 'pointer', color: 'var(--muted)', fontSize: 13,
  }
  const dialogHeader = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, flex: 1 }}>
      <span onMouseDown={e => e.stopPropagation()} style={{ display: 'inline-flex', flexShrink: 0 }}>
        <FeatureExplainer topic="amazon-import-detail" placement="bottom-left" />
      </span>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1 }}>
        <div style={{ fontWeight: 600, fontSize: 15 }}>Amazon import detail</div>
        <div style={{ fontSize: 12, color: 'var(--muted)' }}>What this import did, and which file each row came from.</div>
      </div>
      {onReload ? (
        <button type="button" title="Refresh" disabled={loading} onClick={onReload}
          onMouseDown={e => e.stopPropagation()} style={chromeButtonStyle}>↻ Refresh</button>
      ) : null}
      {onMinimize ? (
        <button type="button" title="Minimize to nav bar (state is preserved — click the pill to restore)"
          onClick={onMinimize} onMouseDown={e => e.stopPropagation()} style={chromeButtonStyle}>– Minimize</button>
      ) : null}
    </div>
  )

  return (
    <DetailPanelShell
      pos={pos}
      size={size}
      panelRef={panelRef}
      onDragStart={onDragStart}
      onResizeStart={onResizeStart}
      onClose={onClose}
      header={dialogHeader}
      isTopmost={isTopmost}
    >
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, margin: '-20px -24px', overflow: 'hidden' }}>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', padding: '8px 16px', borderBottom: '1px solid var(--border)' }}>
          <span style={{ fontSize: 11, color: 'var(--muted)', flexShrink: 0 }}>Show:</span>
          {CATEGORIES.map(cat => {
            const count = data ? (cat.rows(data)?.length || 0) : 0
            const isActive = cat.key === activeKey
            const accent = cat.warn ? 'var(--warning)' : 'var(--accent)'
            return (
              <button
                key={cat.key}
                type="button"
                title={CATEGORY_HELP[cat.key]}
                onClick={() => setActiveKey(cat.key)}
                style={{
                  fontSize: 11, padding: '2px 10px', borderRadius: 99, cursor: 'pointer', flexShrink: 0,
                  fontWeight: isActive ? 600 : (cat.warn && count > 0 ? 600 : 500),
                  background: isActive ? accent : `color-mix(in srgb, ${accent} 12%, var(--surface2))`,
                  color: isActive ? 'white' : `color-mix(in srgb, ${accent} 75%, var(--text))`,
                  border: `1px solid color-mix(in srgb, ${accent} 45%, var(--border))`,
                }}
              >
                {cat.label} ({count})
              </button>
            )
          })}
        </div>
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <MatchReport
            // Each category tab is its own column set, so each remembers its own geometry — a single
            // shared key would merge unrelated columns through normalizeColumnConfig.
            columnsPrefKey={`${AMAZON_IMPORT_DETAIL_COLUMNS_PREF_KEY}.${active.key}`}
            columns={active.columns}
            entries={entries}
            getRowId={active.getRowId}
            loading={loading}
            error={error}
            emptyMessage={`No ${active.label.toLowerCase()} in this import.`}
          />
        </div>
      </div>
    </DetailPanelShell>
  )
}
