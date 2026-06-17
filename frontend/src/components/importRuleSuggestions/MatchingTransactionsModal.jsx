// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: GPL-3.0-or-later

// Modal listing the imported transactions a suggestion/rule matches, with per-row and bulk inline
// category editing (the "Set all to" / Maps-To pickers), Preserve / Use-majority actions on conflict
// rows, and width estimation so the sticky header grid stays aligned with the scrollable body. The
// parent owns the row data (`state`) and the mutation callbacks; this component holds only the
// transient edit/picker UI state.

import { useRef, useState } from 'react'
import CategoryPicker from '../CategoryPicker.jsx'
import CategoryDisplay from '../CategoryDisplay.jsx'
import { Spinner } from '../ui.jsx'
import { formatDate } from '../../lib/utils.js'
import { formatTransactionAmount, getTransactionAmountColor } from '../../lib/moneyDisplay.js'
import { buildCategoryDisplayLabel, formatSuggestionAmountLabel } from '../../lib/importRuleSuggestions.js'

export function MatchingTransactionsModal({ state, categories, onClose, onKeepCategory, onSetRowCategory, onSetAllCategories, onCategoriesChanged, applyingAll }) {
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
  if (!state?.open) return null

  const summaryParts = []
  if (state.keyword) summaryParts.push(`merchant contains ${state.keyword}`)
  if (state.ownerName) summaryParts.push(`owner ${state.ownerName}`)
  if (state.accountName) summaryParts.push(`account ${state.accountName}`)
  const amountSummary = formatSuggestionAmountLabel(state.amountMin, state.amountMax)
  if (amountSummary) summaryParts.push(amountSummary)

  function estimateColumnWidth(values, { min = 80, max = 260, perChar = 8, extra = 24 } = {}) {
    const longest = values.reduce((maxLen, value) => Math.max(maxLen, String(value || '').length), 0)
    return Math.max(min, Math.min(max, Math.round(longest * perChar + extra)))
  }

  function measureScrollbarWidth() {
    if (typeof document === 'undefined') return 0
    const probe = document.createElement('div')
    probe.style.width = '120px'
    probe.style.height = '120px'
    probe.style.overflow = 'scroll'
    probe.style.position = 'absolute'
    probe.style.top = '-9999px'
    document.body.appendChild(probe)
    const width = probe.offsetWidth - probe.clientWidth
    document.body.removeChild(probe)
    return width
  }

  const viewerRows = state.rows || []
  const mapsToLabels = viewerRows.map(row => (
    buildCategoryDisplayLabel(categories, row.target_category_id, row.target_category_name || '')
  ))
  const hasConflictRows = viewerRows.some(row => row.conflicts_with_reference)
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
  const merchantWidth = estimateColumnWidth(
    [
      'Merchant',
      ...viewerRows.map(row => row.display_name || row.merchant_name || row.raw_name || 'Unnamed merchant'),
      ...viewerRows.map(row => [row.owner_name, row.account_name ? `${row.account_name}${row.account_mask ? ` ···${row.account_mask}` : ''}` : null].filter(Boolean).join(' · ')),
    ],
    { min: 210, max: 360, perChar: 7.8, extra: 26 },
  )
  const viewerGridTemplateColumns = `${dateWidth}px ${merchantWidth}px ${importedCategoryWidth}px ${mapsToWidth}px ${amountWidth}px`
  const viewerColumnGap = 12
  const tableHorizontalPadding = 32
  // Reserve real scrollbar width so the sticky header grid stays aligned with the
  // scrollable body across platforms that render wider native scrollbars.
  const scrollbarWidth = measureScrollbarWidth()
  const tableContentWidth = dateWidth + merchantWidth + importedCategoryWidth + mapsToWidth + amountWidth + (viewerColumnGap * 4) + tableHorizontalPadding
  const viewerDesiredWidth = Math.max(700, Math.min(1200, tableContentWidth + scrollbarWidth + 36))

  return (
    <div
      onMouseDown={onClose}
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
          width: viewerDesiredWidth,
          maxWidth: '96vw',
          maxHeight: '88vh',
          overflow: 'hidden',
          boxShadow: '0 20px 60px rgba(0,0,0,0.42)',
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
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
        }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 700 }}>Matching imported transactions</div>
            <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 4, lineHeight: 1.5 }}>
              {summaryParts.join(' · ')}
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 5 }}>
              {state.loading ? 'Loading matching rows…' : `${state.count || 0} matching row${state.count === 1 ? '' : 's'}`}
            </div>
            {!state.loading && state.rows?.length ? (
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

        <div style={{ padding: 16, display: 'grid', gap: 12, minHeight: 0, flex: 1 }}>
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
              width: 'fit-content',
              maxWidth: '100%',
            }}>
              <div style={{
                display: 'grid',
                gridTemplateColumns: viewerGridTemplateColumns,
                gap: viewerColumnGap,
                padding: `7px ${12 + scrollbarWidth}px 7px 12px`,
                fontSize: 10.5,
                fontWeight: 600,
                color: 'var(--muted)',
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
                background: 'var(--surface2)',
                borderBottom: '1px solid var(--border)',
              }}>
                <span>Date</span>
                <span>Merchant</span>
                <span>Category From File</span>
                <span>Maps To</span>
                <span style={{ textAlign: 'right' }}>Amount</span>
              </div>
              <div style={{ overflowY: 'auto', minHeight: 0, scrollbarGutter: 'stable' }}>
                {state.rows.map(row => {
                  const resolvedCategoryLabel = buildCategoryDisplayLabel(
                    categories,
                    row.target_category_id,
                    row.target_category_name || '',
                  )
                  return (
                    <div
                      key={row.id}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: viewerGridTemplateColumns,
                        gap: viewerColumnGap,
                        padding: '8px 12px',
                        alignItems: 'start',
                        fontSize: 12.5,
                        borderBottom: '1px solid var(--border)',
                      }}
                    >
                      <span style={{ color: 'var(--muted)', fontSize: 11.5 }}>{formatDate(row.date)}</span>
                      <div style={{ minWidth: 0 }}>
                        <div style={{
                          fontWeight: 600,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}>
                          {row.display_name || row.merchant_name || row.raw_name || 'Unnamed merchant'}
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
                      <div style={{ minWidth: 0 }}>
                        <div style={{
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          justifySelf: 'start',
                        }}>
                          {row.imported_category}
                        </div>
                      </div>
                      <div style={{ minWidth: 0, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        {editingRowId === row.id ? (
                          <div style={{ minWidth: 200, maxWidth: 280 }}>
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
                        {row.category_source === 'manual' ? (
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
                        {row.conflicts_with_reference ? (
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
                        {row.target_category_id && row.category_source !== 'manual' && row.conflicts_with_reference ? (
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
                        {state.referenceTargetCategoryId
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
                      <div style={{ textAlign: 'right' }}>
                        <span style={{
                          fontVariantNumeric: 'tabular-nums',
                          color: getTransactionAmountColor(row.amount),
                        }}>
                          {formatTransactionAmount(row.amount)}
                        </span>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
