// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: GPL-3.0-or-later

// Matching imported-transaction report for rule suggestions. The standalone modal is an editing
// surface (per-row and bulk category reconciliation, Preserve / Use-majority actions); the embedded
// rule-editor panel is read-only reference material with pinnable source-file detail. The table is the
// shared resizable/reorderable pill-header control (PillGridTable): the shell owns one outer scroll
// container with the header pinned via position: sticky, and column geometry (order + widths) persists
// through useUserPreference like the duplicate-rows dialog reference. The parent owns the row data and
// mutation callbacks; this component holds only transient edit/picker/reference UI state.

import { useMemo, useRef, useState } from 'react'
import CategoryPicker from '../CategoryPicker.jsx'
import CategoryDisplay from '../CategoryDisplay.jsx'
import PillGridTable from '../PillGridTable.jsx'
import { Spinner, Tooltip } from '../ui.jsx'
import { MerchantOriginHoverCard, OriginFieldList } from '../OriginFields.jsx'
import { getTxnMerchantOriginRows, hasMerchantOriginDetail } from '../../lib/importSourceFields.js'
import { useColumnPreference } from '../../lib/useColumnPreference.js'
import { formatDate } from '../../lib/utils.js'
import { formatTransactionAmount, getTransactionAmountColor } from '../../lib/moneyDisplay.js'
import {
  buildCategoryDisplayLabel,
  formatSuggestionAmountLabel,
  IMPORT_RULE_MATCHES_COLUMNS_PREF_KEY,
} from '../../lib/importRuleSuggestions.js'

function estimateColumnWidth(values, { min = 80, max = 260, perChar = 8, extra = 24 } = {}) {
  const longest = values.reduce((maxLen, value) => Math.max(maxLen, String(value || '').length), 0)
  return Math.max(min, Math.min(max, Math.round(longest * perChar + extra)))
}

export function MatchingTransactionsReport({ state, categories, onClose, onKeepCategory, onSetRowCategory, onSetAllCategories, onCategoriesChanged, applyingAll, onOpenMerchantReport, embedded = false, readOnly = false, allowPinnedOrigin = false }) {
  // Per-row inline category edit: editingRowId picks the row whose Maps-To picker is open; the token
  // force-opens the picker the moment edit mode is entered (CategoryPicker only auto-opens on a bump).
  const [editingRowId, setEditingRowId] = useState(null)
  const [rowPickerToken, setRowPickerToken] = useState(0)
  // "Set all to" opens the same picker from a button so it reads as a control rather than a faint field.
  const [bulkEditing, setBulkEditing] = useState(false)
  const [bulkPickerToken, setBulkPickerToken] = useState(0)
  // CategoryPicker emits onOpenChange(false) once on mount before openToken actually opens it; these
  // refs let us ignore that stray close so entering edit mode doesn't instantly cancel (the "blink").
  const rowPickerOpenedRef = useRef(false)
  const bulkPickerOpenedRef = useRef(false)
  const [pinnedOriginRow, setPinnedOriginRow] = useState(null)
  // Client-side column sort for the (fully-loaded) match rows. Seeded to the order the backend already
  // returns the rows in (date descending — see the /rule-suggestions/matches ORDER BY) so the Date pill
  // shows its sort indicator from first paint and the user can see how the list is ordered.
  const [sort, setSort] = useState({ key: 'date', dir: 'desc' })

  const viewerRows = state?.rows || []
  const showCategoryActions = !readOnly
  const mapsToLabels = viewerRows.map(row => (
    buildCategoryDisplayLabel(categories, row.target_category_id, row.target_category_name || '')
  ))
  const hasConflictRows = showCategoryActions && viewerRows.some(row => row.conflicts_with_reference)
  const dateWidth = estimateColumnWidth(
    ['Date', ...viewerRows.map(row => formatDate(row.date))],
    { min: 86, max: 104, perChar: 7.2, extra: 12 },
  )
  const importedCategoryWidth = estimateColumnWidth(
    ['Category From File', ...viewerRows.map(row => row.imported_category || '')],
    { min: 140, max: 280, perChar: 7.6, extra: 22 },
  )
  const mapsToWidth = estimateColumnWidth(
    ['Maps To', ...mapsToLabels],
    { min: 150, max: 320, perChar: 7.8, extra: hasConflictRows ? 120 : 34 },
  )
  const amountWidth = estimateColumnWidth(
    ['Amount', ...viewerRows.map(row => formatTransactionAmount(row.amount))],
    { min: 92, max: 118, perChar: 8, extra: 18 },
  )
  // Size to the merchant name only. The owner·account subtitle below it ellipsizes, so feeding its
  // (often long) "Account ···1234" text into the estimate is what blew this column out to its max and
  // left a wide empty gap before the next column; the floor still leaves the subtitle a readable home.
  const merchantWidth = estimateColumnWidth(
    ['Merchant', ...viewerRows.map(row => row.display_name || row.merchant_name || row.raw_name || 'Unnamed merchant')],
    { min: 180, max: 280, perChar: 7.4, extra: 22 },
  )

  // Default geometry seeded from the content estimates; the user's persisted order/widths win over it.
  const defaultColumns = useMemo(() => ([
    { key: 'date', label: 'Date', width: dateWidth, minWidth: 80, align: 'start' },
    { key: 'merchant', label: 'Merchant', width: merchantWidth, minWidth: 160, align: 'start' },
    { key: 'imported_category', label: 'Category From File', width: importedCategoryWidth, minWidth: 120, align: 'start' },
    { key: 'maps_to', label: 'Maps To', width: mapsToWidth, minWidth: 150, align: 'start' },
    { key: 'amount', label: 'Amount', width: amountWidth, minWidth: 90, align: 'end' },
  ]), [dateWidth, merchantWidth, importedCategoryWidth, mapsToWidth, amountWidth])

  const [cols, handleColumnUpdate] = useColumnPreference(IMPORT_RULE_MATCHES_COLUMNS_PREF_KEY, defaultColumns)

  const summaryParts = []
  if (state?.keyword) summaryParts.push(`${state?.matchSourceText ? 'merchant/source detail' : 'merchant'} contains ${state.keyword}`)
  if (state?.ownerName) summaryParts.push(`owner ${state.ownerName}`)
  if (state?.accountName) summaryParts.push(`account ${state.accountName}`)
  const amountSummary = formatSuggestionAmountLabel(state?.amountMin, state?.amountMax)
  if (amountSummary) summaryParts.push(amountSummary)

  // Breakdown of where the matched rows currently map, largest-first, so the conflict is legible at a
  // glance and the per-row "Use majority" action has a visible referent. Counts update live as rows are
  // recategorized; the reference (majority) category is flagged.
  const categoryBreakdown = (() => {
    const counts = new Map()
    for (const row of viewerRows) {
      const key = row.target_category_id || '__none__'
      const existing = counts.get(key)
      if (existing) { existing.count += 1; continue }
      counts.set(key, {
        id: row.target_category_id || null,
        label: buildCategoryDisplayLabel(categories, row.target_category_id, row.target_category_name || '') || 'Unresolved',
        count: 1,
      })
    }
    return [...counts.values()].sort((a, b) => b.count - a.count)
  })()

  function sortValue(row, key) {
    switch (key) {
      case 'date': return row.date || ''
      case 'merchant': return (row.display_name || row.merchant_name || row.raw_name || '').toLowerCase()
      case 'imported_category': return (row.imported_category || '').toLowerCase()
      case 'maps_to': return buildCategoryDisplayLabel(categories, row.target_category_id, row.target_category_name || '').toLowerCase()
      case 'amount': return Number(row.amount) || 0
      default: return ''
    }
  }
  function handleSort(key) {
    setSort(prev => (prev?.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }))
  }
  const sortedRows = !sort ? viewerRows : [...viewerRows].sort((a, b) => {
    const dir = sort.dir === 'desc' ? -1 : 1
    const av = sortValue(a, sort.key)
    const bv = sortValue(b, sort.key)
    if (av < bv) return -dir
    if (av > bv) return dir
    return 0
  })

  function renderCell(col, row) {
    if (col.key === 'date') {
      return <span style={{ color: 'var(--muted)', fontSize: 11.5 }}>{formatDate(row.date)}</span>
    }
    if (col.key === 'merchant') {
      const merchantHasOriginDetail = hasMerchantOriginDetail(row)
      return (
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
            {merchantHasOriginDetail ? (
              <Tooltip
                content={(
                  <MerchantOriginHoverCard
                    txn={row}
                    onPin={allowPinnedOrigin ? () => setPinnedOriginRow(row) : null}
                  />
                )}
                maxWidth={380}
                interactive={allowPinnedOrigin}
                triggerStyle={{ minWidth: 0, overflow: 'hidden' }}
              >
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {row.display_name || row.merchant_name || row.raw_name || 'Unnamed merchant'}
                </span>
              </Tooltip>
            ) : (
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {row.display_name || row.merchant_name || row.raw_name || 'Unnamed merchant'}
              </span>
            )}
            {onOpenMerchantReport ? (
              <Tooltip content="Open merchant spending report">
                <button
                  type="button"
                  aria-label="Open merchant spending report"
                  onClick={() => onOpenMerchantReport(row)}
                  style={{
                    flexShrink: 0, border: '1px solid var(--border)', background: 'var(--surface2)',
                    color: 'var(--accent2)', borderRadius: 6, width: 18, height: 18, padding: 0,
                    fontSize: 11, lineHeight: 1, cursor: 'pointer',
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  }}
                >↗</button>
              </Tooltip>
            ) : null}
          </div>
          <div style={{
            marginTop: 3,
            fontSize: 11.5,
            color: 'var(--muted)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            {[row.owner_name, row.account_name ? `${row.account_name}${row.account_mask ? ` ···${row.account_mask}` : ''}` : null].filter(Boolean).join(' · ')}
          </div>
        </div>
      )
    }
    if (col.key === 'imported_category') {
      return (
        <div title={row.imported_category} style={{
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          justifySelf: 'start',
        }}>
          {row.imported_category}
        </div>
      )
    }
    if (col.key === 'maps_to') {
      const resolvedCategoryLabel = buildCategoryDisplayLabel(
        categories,
        row.target_category_id,
        row.target_category_name || '',
      )
      return (
        <div style={{ minWidth: 0, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {editingRowId === row.id && showCategoryActions ? (
            <div style={{ minWidth: 0, flex: 1 }}>
              <CategoryPicker
                value={row.target_category_id}
                categories={categories}
                onChange={value => { setEditingRowId(null); rowPickerOpenedRef.current = false; if (value) onSetRowCategory?.(row, value) }}
                onCategoryCreated={onCategoriesChanged}
                compact
                openToken={rowPickerToken}
                onOpenChange={open => {
                  if (open) { rowPickerOpenedRef.current = true; return }
                  if (rowPickerOpenedRef.current) { setEditingRowId(null); rowPickerOpenedRef.current = false }
                }}
              />
            </div>
          ) : (
            <>
              {showCategoryActions ? (
                <button
                  type="button"
                  onClick={() => { setEditingRowId(row.id); setRowPickerToken(token => token + 1) }}
                  disabled={row.keeping}
                  title="Change the category for this transaction"
                  style={{ background: 'none', border: 'none', padding: 0, margin: 0, cursor: row.keeping ? 'wait' : 'pointer', textAlign: 'left' }}
                >
                  <CategoryDisplay
                    id={row.target_category_id}
                    name={resolvedCategoryLabel}
                    emptyLabel="Unresolved"
                    emptyFontSize={12}
                  />
                </button>
              ) : (
                <CategoryDisplay
                  id={row.target_category_id}
                  name={resolvedCategoryLabel}
                  emptyLabel="Unresolved"
                  emptyFontSize={12}
                />
              )}
              {showCategoryActions && row.category_source === 'manual' ? (
                <span style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '2px 7px',
                  borderRadius: 999,
                  fontSize: 10.5,
                  fontWeight: 600,
                  color: 'color-mix(in srgb, var(--accent2) 70%, var(--text))',
                  background: 'color-mix(in srgb, var(--accent2) 10%, var(--surface2))',
                  border: '1px solid color-mix(in srgb, var(--accent2) 24%, var(--border))',
                  whiteSpace: 'nowrap',
                }}>
                  manual override
                </span>
              ) : null}
              {showCategoryActions && row.conflicts_with_reference ? (
                <span style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '2px 7px',
                  borderRadius: 999,
                  fontSize: 10.5,
                  fontWeight: 600,
                  color: 'color-mix(in srgb, var(--warning) 72%, var(--text))',
                  background: 'color-mix(in srgb, var(--warning) 10%, var(--surface2))',
                  border: '1px solid color-mix(in srgb, var(--warning) 28%, var(--border))',
                  whiteSpace: 'nowrap',
                }}>
                  conflicting rule
                </span>
              ) : null}
              {showCategoryActions && row.target_category_id && row.category_source !== 'manual' && row.conflicts_with_reference ? (
                <button
                  type="button"
                  onClick={() => onKeepCategory?.(row)}
                  disabled={row.keeping}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '2px 8px',
                    borderRadius: 999,
                    fontSize: 10.5,
                    fontWeight: 600,
                    color: 'var(--text)',
                    background: 'color-mix(in srgb, var(--surface2) 82%, white 4%)',
                    border: '1px solid color-mix(in srgb, var(--border) 84%, white 8%)',
                    cursor: row.keeping ? 'wait' : 'pointer',
                    opacity: row.keeping ? 0.7 : 1,
                    whiteSpace: 'nowrap',
                  }}
                >
                  {row.keeping ? 'Keeping…' : 'Preserve This Categorization'}
                </button>
              ) : null}
              {showCategoryActions
                && state.referenceTargetCategoryId
                && row.category_source !== 'manual'
                && row.conflicts_with_reference
                && String(row.target_category_id) !== String(state.referenceTargetCategoryId) ? (
                <button
                  type="button"
                  onClick={() => onSetRowCategory?.(row, state.referenceTargetCategoryId)}
                  disabled={row.keeping}
                  title={`Recategorize this transaction as ${buildCategoryDisplayLabel(categories, state.referenceTargetCategoryId) || 'the majority category'}`}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '2px 8px',
                    borderRadius: 999,
                    fontSize: 10.5,
                    fontWeight: 600,
                    color: 'var(--accent)',
                    background: 'color-mix(in srgb, var(--accent) 10%, var(--surface2))',
                    border: '1px solid color-mix(in srgb, var(--accent) 28%, var(--border))',
                    cursor: row.keeping ? 'wait' : 'pointer',
                    opacity: row.keeping ? 0.7 : 1,
                    whiteSpace: 'nowrap',
                  }}
                >
                  Use majority
                </button>
              ) : null}
            </>
          )}
        </div>
      )
    }
    if (col.key === 'amount') {
      return (
        <div style={{ textAlign: 'right' }}>
          <span style={{
            fontVariantNumeric: 'tabular-nums',
            color: getTransactionAmountColor(row.amount),
          }}>
            {formatTransactionAmount(row.amount)}
          </span>
        </div>
      )
    }
    return null
  }

  if (!state?.open) return null

  return (
    <div
      style={{
        background: 'var(--surface)',
        border: embedded ? '1px solid var(--border)' : 'none',
        borderRadius: embedded ? 12 : 0,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        flex: embedded ? 1 : undefined,
        minHeight: 0,
        height: embedded ? '100%' : undefined,
      }}
    >
        <div style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 16,
          padding: '18px 20px',
          borderBottom: '1px solid var(--border)',
          background: 'color-mix(in srgb, var(--surface) 94%, rgba(15, 23, 42, 0.12))',
        }}
        >
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <div style={{ fontSize: 15, fontWeight: 700 }}>Matching imported transactions</div>
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 4, lineHeight: 1.5 }}>
              {summaryParts.join(' · ')}
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 5 }}>
              {state.loading ? 'Loading matching rows…' : `${state.count || 0} matching row${state.count === 1 ? '' : 's'}`}
            </div>
            {!state.loading && categoryBreakdown.length >= 2 ? (
              <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                {categoryBreakdown.map(entry => {
                  const isMajority = state.referenceTargetCategoryId != null
                    && String(entry.id) === String(state.referenceTargetCategoryId)
                  return (
                    <span
                      key={entry.id || '__none__'}
                      title={`${entry.label} · ${entry.count} row${entry.count === 1 ? '' : 's'}${isMajority ? ' · majority' : ''}`}
                      style={{
                        display: 'inline-flex', alignItems: 'center', gap: 6,
                        padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 600,
                        whiteSpace: 'nowrap', maxWidth: 240,
                        color: isMajority ? 'var(--accent2)' : 'var(--muted)',
                        background: isMajority ? 'color-mix(in srgb, var(--accent) 12%, var(--surface2))' : 'var(--surface2)',
                        border: `1px solid ${isMajority ? 'color-mix(in srgb, var(--accent) 36%, var(--border))' : 'var(--border)'}`,
                      }}
                    >
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{entry.label}</span>
                      <span style={{ fontVariantNumeric: 'tabular-nums', opacity: 0.85, flexShrink: 0 }}>{entry.count}</span>
                      {isMajority ? (
                        <span style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', flexShrink: 0 }}>majority</span>
                      ) : null}
                    </span>
                  )
                })}
              </div>
            ) : null}
            {pinnedOriginRow ? (
              <div style={{
                marginTop: 10,
                padding: '9px 10px',
                borderRadius: 10,
                border: '1px solid color-mix(in srgb, var(--accent2) 24%, var(--border))',
                background: 'color-mix(in srgb, var(--accent2) 7%, var(--surface2))',
                display: 'grid',
                gap: 6,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                  <div style={{ minWidth: 0, fontSize: 12, fontWeight: 700 }}>
                    Source detail: {pinnedOriginRow.display_name || pinnedOriginRow.merchant_name || pinnedOriginRow.raw_name || 'Unnamed merchant'}
                  </div>
                  <button
                    type="button"
                    onClick={() => setPinnedOriginRow(null)}
                    style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: 0 }}
                  >
                    ×
                  </button>
                </div>
                <OriginFieldList rows={getTxnMerchantOriginRows(pinnedOriginRow)} />
              </div>
            ) : null}
            {showCategoryActions && !state.loading && state.rows?.length ? (
              <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                {bulkEditing ? (
                  <div style={{ minWidth: 220, maxWidth: 300 }}>
                    <CategoryPicker
                      value={null}
                      categories={categories}
                      placeholder="Choose a category…"
                      onChange={value => { setBulkEditing(false); bulkPickerOpenedRef.current = false; if (value && !applyingAll) onSetAllCategories?.(value) }}
                      onCategoryCreated={onCategoriesChanged}
                      compact
                      openToken={bulkPickerToken}
                      onOpenChange={open => {
                        if (open) { bulkPickerOpenedRef.current = true; return }
                        if (bulkPickerOpenedRef.current) { setBulkEditing(false); bulkPickerOpenedRef.current = false }
                      }}
                    />
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => { setBulkEditing(true); setBulkPickerToken(token => token + 1) }}
                    disabled={applyingAll}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '7px 14px',
                      borderRadius: 8,
                      fontSize: 12.5,
                      fontWeight: 600,
                      color: 'var(--text)',
                      background: 'color-mix(in srgb, var(--accent) 14%, var(--surface2))',
                      border: '1px solid color-mix(in srgb, var(--accent) 42%, var(--border))',
                      cursor: applyingAll ? 'wait' : 'pointer',
                      boxShadow: '0 1px 0 rgba(255,255,255,0.04), 0 6px 14px rgba(15,23,42,0.12)',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {applyingAll
                      ? 'Applying…'
                      : `Set all ${state.count || state.rows.length} rows to a category…`}
                  </button>
                )}
              </div>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
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

        <div style={{ padding: 16, display: 'grid', gap: 12, minHeight: 0, flex: 1, minWidth: 0 }}>
          {state.error ? (
            <div style={{ fontSize: 13, color: 'var(--danger)' }}>{state.error}</div>
          ) : state.loading ? (
            <Spinner />
          ) : !state.rows?.length ? (
            <div style={{ fontSize: 13, color: 'var(--muted)' }}>
              No imported transactions match the current rule criteria.
            </div>
          ) : (
            <div style={{
              border: '1px solid var(--border)',
              borderRadius: 10,
              overflow: 'hidden',
              display: 'flex',
              flexDirection: 'column',
              minHeight: 0,
            }}>
              {/* Single outer scroll container; PillGridTable's header pins via position: sticky. A
                  nested body scroll would consume width from the last column under this grid model. */}
              <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
                <PillGridTable
                  columns={cols.map(col => ({
                    ...col,
                    title: `Click to sort. Drag to move ${col.label}`,
                  }))}
                  onColumnsChange={handleColumnUpdate}
                  sortState={sort}
                  onSort={handleSort}
                  headerStyle={{
                    padding: '6px 0',
                    background: 'color-mix(in srgb, var(--surface2) 92%, var(--surface))',
                    position: 'sticky',
                    top: 0,
                    zIndex: 2,
                  }}
                  renderBody={({ columns: activeColumns, gridTemplateColumns }) => (
                    <div style={{ fontSize: 12.5 }}>
                      {sortedRows.map(row => (
                        <div
                          key={row.id}
                          style={{
                            display: 'grid',
                            gridTemplateColumns,
                            alignItems: 'start',
                            borderBottom: '1px solid var(--border)',
                          }}
                        >
                          {activeColumns.map(col => (
                            <div key={`${row.id}:${col.key}`} style={{ padding: '8px 8px', minWidth: 0 }}>
                              {renderCell(col, row)}
                            </div>
                          ))}
                        </div>
                      ))}
                    </div>
                  )}
                />
              </div>
            </div>
          )}
        </div>
    </div>
  )
}

export function MatchingTransactionsModal(props) {
  if (!props.state?.open) return null

  return (
    <div
      onMouseDown={props.onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 905,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0,0,0,0.48)',
        padding: 24,
      }}
    >
      <div
        onMouseDown={event => event.stopPropagation()}
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 14,
          width: 'min(1200px, 96vw)',
          maxHeight: '88vh',
          overflow: 'hidden',
          boxShadow: '0 20px 60px rgba(0,0,0,0.42)',
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
        }}
      >
        <MatchingTransactionsReport {...props} />
      </div>
    </div>
  )
}
