// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: GPL-3.0-or-later

import React, { useState, useEffect, useRef, useMemo } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api } from '../lib/api.js'
import { refreshTaskBadge } from '../App.jsx'
import { useFilters } from '../lib/FilterContext.jsx'
import {
  Card,
  DialogActions,
  PageHeader,
  Button,
  Spinner,
  EmptyState,
  FloatingPanel,
  FloatingPanelHeader,
  OverlayBackdrop,
  AppConfirmDialog,
  AppNoticeDialog,
  getFloatingPanelHeaderBackground,
  getFloatingPanelSurfaceStyle,
} from '../components/ui.jsx'
import CategoryPicker from '../components/CategoryPicker.jsx'
import CategoryImportWorkspace from '../components/CategoryImportWorkspace.jsx'
import ImportColumnMappingSection from '../components/ImportColumnMappingSection.jsx'
import ImportProfilesManager from '../components/ImportProfilesManager.jsx'
import TransientTextInput from '../components/TransientTextInput.jsx'
import { cloneCategoryImportSnapshot, createCategoryImportDraftState, sanitizeCategoryImportDraftAgainstExistingCategories } from '../lib/categoryImportState.js'
import {
  analyzeImportColumns,
  formatLikelyMatchLabel,
  inferFilenamePattern,
  inferImportFileCharacteristicsFromPreview,
  inferUnambiguousImportMappingFromPreview,
} from '../lib/importColumnInference.js'
import { formatCurrency } from '../lib/utils.js'
import { formatTransactionAmount, getTransactionAmountColor } from '../lib/moneyDisplay.js'
import { useUserPreference } from '../lib/UserPreferencesContext.jsx'
import { ACCOUNT_TYPES } from '../lib/accountTypes.js'

const AMOUNT_CONVENTIONS = [
  { value: 'single_signed', label: 'Single column — negative = debit (Chase, most banks)' },
  { value: 'single_unsigned', label: 'Single column — always positive, direction column' },
  { value: 'two_column', label: 'Two columns — separate debit and credit' },
]
const DATE_FORMATS = [
  { value: '%m/%d/%Y', label: 'MM/DD/YYYY  (e.g. 01/31/2024)' },
  { value: '%Y-%m-%d', label: 'YYYY-MM-DD  (e.g. 2024-01-31)' },
  { value: '%Y/%m/%d', label: 'YYYY/MM/DD  (e.g. 2024/01/31)' },
  { value: '%d/%m/%Y', label: 'DD/MM/YYYY  (e.g. 31/01/2024)' },
  { value: '%m-%d-%Y', label: 'MM-DD-YYYY  (e.g. 01-31-2024)' },
  { value: '%d-%m-%Y', label: 'DD-MM-YYYY  (e.g. 31-01-2024)' },
  { value: '%b %d, %Y', label: 'Mon DD, YYYY  (e.g. Jan 31, 2024)' },
  { value: '%b-%d-%Y', label: 'MMM-DD-YYYY  (e.g. Mar-23-2026)' },
]
const EXPORT_COLUMNS = [
  { key: 'date', label: 'Date' },
  { key: 'merchant_name', label: 'Merchant' },
  { key: 'raw_name', label: 'Raw description' },
  { key: 'amount', label: 'Amount' },
  { key: 'account', label: 'Account' },
  { key: 'category', label: 'Category' },
  { key: 'group', label: 'Group' },
  { key: 'owner', label: 'Owner' },
  { key: 'notes', label: 'Notes' },
  { key: 'is_pending', label: 'Pending' },
  { key: 'overridden', label: 'Manually categorized' },
  { key: 'import_batch', label: 'Import batch ID' },
]
const DEFAULT_EXPORT_COLS = ['date', 'merchant_name', 'amount', 'account', 'category']
const IMPORT_CONFIG_MAX_WIDTH = 'min(900px, 100%)'
const MANUAL_DATA_SOURCE_VALUE = '__skip_for_now__'
const LAST_IMPORT_DATA_SOURCE_PREF_KEY = 'import.lastDataSourceId'
const EXPANDED_IMPORT_SOURCE_ROWS_PREF_KEY = 'import.expandedDataSourceRows'
const DATA_SOURCE_MANAGER_POS_PREF_KEY = 'import.dataSourceManagerPos'

function getBlankImportSnapshot() {
  return {
    column_map: {},
    category_assignments: {},
    account_map: {},
    skip_accounts: [],
    account_new: {},
    account_id: null,
    single_account_new: null,
    date_format: '%m/%d/%Y',
    amount_convention: 'single_signed',
    skip_rows: 0,
    apply_categorization: true,
    category_workspace_draft: null,
  }
}

function getBlankMappingSuggestions() {
  return {
    date: '',
    amount: '',
    debit: '',
    credit: '',
    direction: '',
    description: '',
    category: '',
    notes: '',
    pending: '',
    account: '',
  }
}

function stableSerialize(value) {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function clampFloatingPanelPosition(pos, size, viewport = { width: window.innerWidth, height: window.innerHeight }) {
  if (!pos) return null
  const panelWidth = Number(size?.width || 0)
  const panelHeight = Number(size?.height || 0)
  const maxX = Math.max(24, viewport.width - panelWidth - 24)
  const maxY = Math.max(24, viewport.height - panelHeight - 24)
  return {
    x: Math.max(24, Math.min(maxX, Math.round(pos.x))),
    y: Math.max(24, Math.min(maxY, Math.round(pos.y))),
  }
}

function CategoryWorkspaceApplyDialog({
  summary,
  replacementId,
  onReplacementChange,
  replacementOptions,
  onConfirm,
  onCancel,
  saving,
}) {
  const requiresReplacement = (summary?.txn_count || 0) > 0
  const canConfirm = !requiresReplacement || !!replacementId
  if (!summary) return null
  return (
    <OverlayBackdrop zIndex={1200} tint="rgba(15, 23, 42, 0.34)">
      <FloatingPanel style={{ width: 'min(620px, 100%)' }}>
        <FloatingPanelHeader style={{ padding: '16px 20px' }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 600 }}>Apply category changes?</div>
            <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4 }}>
              Importing this mapping will remove {summary.delete_count} existing categor{summary.delete_count === 1 ? 'y' : 'ies'} from the live category list.
            </div>
          </div>
        </FloatingPanelHeader>
        <div style={{ padding: 20, display: 'grid', gap: 14 }}>
          <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.6 }}>
            The following live data is affected by categories removed from the draft:
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 10 }}>
            {[
              { label: 'transactions', value: summary.txn_count || 0 },
              { label: 'rules', value: summary.rule_count || 0 },
              { label: 'profile mappings', value: summary.profile_mapping_count || 0 },
              { label: 'import mappings', value: summary.batch_mapping_count || 0 },
            ].map(item => (
              <div key={item.label} style={{ padding: '10px 12px', borderRadius: 10, border: '1px solid var(--border)', background: 'color-mix(in srgb, var(--surface2) 70%, var(--surface))' }}>
                <div style={{ fontSize: 20, fontWeight: 700 }}>{item.value}</div>
                <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>{item.label}</div>
              </div>
            ))}
          </div>
          {requiresReplacement ? (
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Move affected transactions to</div>
              <CategoryPicker
                value={replacementId}
                categories={replacementOptions}
                onChange={onReplacementChange}
                placeholder="Choose replacement category…"
              />
              <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>
                Rules and saved import mappings pointing at deleted categories will also be redirected there where possible.
              </div>
            </div>
          ) : (
            <div style={{ fontSize: 12, color: 'var(--muted)' }}>
              No transactions are currently assigned to the deleted categories. Rules and saved import mappings will be removed or redirected automatically as needed.
            </div>
          )}
        </div>
        <DialogActions>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={onConfirm} disabled={!canConfirm || saving}>
            {saving ? 'Applying…' : 'Apply changes'}
          </Button>
        </DialogActions>
      </FloatingPanel>
    </OverlayBackdrop>
  )
}

function DataSourceMismatchDialog({
  profileName,
  chooserOpen = false,
  profiles = [],
  selectedProfileId = '',
  fileHeaderFingerprint = '',
  onSelectProfile,
  onSelectTemporaryDraft,
  onCloseChooser,
  onConfirm,
  onCancel,
  onChangeDataSource,
}) {
  if (!profileName) return null
  return (
    <OverlayBackdrop zIndex={1200} tint="rgba(15, 23, 42, 0.38)">
      <FloatingPanel style={{ width: 'min(560px, 100%)' }}>
        <FloatingPanelHeader style={{ padding: '16px 20px' }}>
          <div>
            {chooserOpen ? (
              <>
                <div style={{ fontSize: 16, fontWeight: 600 }}>Choose a different data source</div>
                <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4, lineHeight: 1.5 }}>
                  Choose a different data source or skip using a data source with this file.
                </div>
              </>
            ) : (
              <>
                <div style={{ fontSize: 16, fontWeight: 600 }}>Mismatch detected</div>
                <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4, lineHeight: 1.5 }}>
                  <span style={{ color: 'var(--text)', fontWeight: 600 }}>{profileName}</span> has a different header signature and may not match this file.
                </div>
              </>
            )}
          </div>
        </FloatingPanelHeader>
        {chooserOpen ? (
          <>
            <div style={{ padding: 20, display: 'grid', gap: 12 }}>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, justifyContent: 'center' }}>
                <DataSourcePill
                  label="Skip"
                  selected={!selectedProfileId}
                  onClick={onSelectTemporaryDraft}
                  title="Use a temporary draft for this file"
                />
                {profiles.map(profile => (
                  <DataSourcePill
                    key={profile.id}
                    label={profile.name}
                    selected={selectedProfileId === profile.id}
                    onClick={() => onSelectProfile?.(profile.id)}
                    title="Use this saved data source"
                    likelyMatch={
                      !!fileHeaderFingerprint &&
                      !!profile.header_fingerprint &&
                      profile.header_fingerprint === fileHeaderFingerprint
                    }
                  />
                ))}
              </div>
              {profiles.length === 0 ? (
                <div style={{ fontSize: 12, color: 'var(--muted)', textAlign: 'center' }}>
                  No saved data sources are available yet.
                </div>
              ) : null}
            </div>
            <DialogActions align="center">
              <Button variant="ghost" onClick={onCloseChooser}>
                Back
              </Button>
            </DialogActions>
          </>
        ) : (
          <DialogActions align="center">
            <Button variant="ghost" onClick={onChangeDataSource}>
              Change data source
            </Button>
            <Button variant="ghost" onClick={onConfirm}>
              OK
            </Button>
            <Button variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          </DialogActions>
        )}
      </FloatingPanel>
    </OverlayBackdrop >
  )
}

function CompatibleBatchAttachDialog({ prompt, onConfirm, onCancel, attaching = false }) {
  if (!prompt) return null
  const batches = Array.isArray(prompt.batches) ? prompt.batches : []
  return (
    <OverlayBackdrop zIndex={1200} tint="rgba(15, 23, 42, 0.38)">
      <FloatingPanel style={{ width: 'min(640px, 100%)' }}>
        <FloatingPanelHeader style={{ padding: '16px 20px' }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 600 }}>Attach compatible unknown imports?</div>
            <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4, lineHeight: 1.5 }}>
              <span style={{ color: 'var(--text)', fontWeight: 600 }}>{prompt.profileName}</span> looks compatible with {batches.length} uncategorized import{batches.length === 1 ? '' : 's'}.
            </div>
          </div>
        </FloatingPanelHeader>
        <div style={{ padding: 20, display: 'grid', gap: 14 }}>
          <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.55 }}>
            Attach these imports now so they move under the saved data source? You can still leave them under unknown data source and undo or re-import them later instead.
          </div>
          <div style={{
            maxHeight: 240,
            overflowY: 'auto',
            border: '1px solid var(--border)',
            borderRadius: 12,
            background: 'color-mix(in srgb, var(--surface2) 72%, var(--surface))',
          }}>
            {batches.map(batch => (
              <div key={batch.id} style={{ padding: '10px 12px', borderBottom: '1px solid color-mix(in srgb, var(--border) 72%, transparent)' }}>
                <div style={{ fontSize: 13, fontWeight: 500 }}>{batch.filename}</div>
                <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3 }}>
                  {formatImportBatchTimestamp(batch.imported_at)} · {batch.row_count} rows
                </div>
              </div>
            ))}
          </div>
        </div>
        <DialogActions>
          <Button variant="ghost" onClick={onCancel} disabled={attaching}>
            Leave separate
          </Button>
          <Button onClick={onConfirm} disabled={attaching}>
            {attaching ? 'Attaching…' : `Attach ${batches.length} import${batches.length === 1 ? '' : 's'}`}
          </Button>
        </DialogActions>
      </FloatingPanel>
    </OverlayBackdrop>
  )
}

function SectionTitle({ children }) {
  return <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 6, marginTop: 28 }}>{children}</div>
}

function DataSourcePill({ label, selected, onClick, muted, subtle, title, showMarker = true, likelyMatch = false }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        minHeight: 36,
        padding: '7px 14px',
        borderRadius: 999,
        border: `1px solid ${selected ? 'color-mix(in srgb, var(--accent) 42%, var(--border))' : 'color-mix(in srgb, var(--border) 88%, transparent)'}`,
        background: selected
          ? 'color-mix(in srgb, var(--accent) 11%, var(--surface2))'
          : (subtle ? 'transparent' : 'var(--surface2)'),
        color: selected ? 'var(--accent2)' : (muted ? 'var(--muted)' : 'var(--text)'),
        cursor: 'pointer',
        fontSize: 13,
        fontWeight: selected ? 600 : 500,
        boxShadow: selected ? '0 0 0 1px color-mix(in srgb, var(--accent) 12%, transparent)' : 'none',
        transition: 'background 0.15s ease, border-color 0.15s ease, color 0.15s ease, box-shadow 0.15s ease',
      }}
    >
      {showMarker ? (
        <span
          aria-hidden="true"
          style={{
            width: 7,
            height: 7,
            borderRadius: '50%',
            background: selected ? 'currentColor' : 'color-mix(in srgb, currentColor 58%, transparent)',
            opacity: selected ? 0.9 : 0.42,
            flexShrink: 0,
          }}
        />
      ) : null}
      {label}
      {likelyMatch ? (
        <span
          style={{
            fontSize: 10,
            fontWeight: 600,
            color: 'var(--success)',
            background: 'color-mix(in srgb, var(--success) 14%, transparent)',
            borderRadius: 999,
            padding: '1px 5px',
            marginLeft: 2,
            flexShrink: 0,
          }}
        >
          possible match
        </span>
      ) : null}
    </button>
  )
}

function summarizeImportOutcome(source) {
  if (!source) {
    return {
      totalRows: 0,
      importedCount: 0,
      skippedCount: 0,
      dedupedCount: 0,
      accountSkippedCount: 0,
      zeroAmountCount: 0,
      validationErrorCount: 0,
      rejectedCount: 0,
      trailingNonTransactionCount: 0,
      otherSkippedCount: 0,
      rejectedHeaders: [],
      rejectedRows: [],
      duplicateHeaders: [],
      duplicateRows: [],
    }
  }

  const rawSummary = source.import_summary && typeof source.import_summary === 'object'
    ? source.import_summary
    : null
  const importedCount = Number(
    rawSummary?.imported_count
    ?? source.imported
    ?? (Number(source.row_count || 0) - Number(source.skipped_count || 0) - Number(source.deduped_count || 0)),
  ) || 0
  const skippedCount = Number(rawSummary?.skipped_count ?? source.skipped ?? source.skipped_count) || 0
  const dedupedCount = Number(rawSummary?.deduped_count ?? source.deduped ?? source.deduped_count) || 0
  const accountSkippedCount = Number(rawSummary?.account_skipped_count ?? source.account_skipped) || 0
  const zeroAmountCount = Number(rawSummary?.zero_amount_count ?? source.zero_amount_count) || 0
  const validationErrorCount = Number(rawSummary?.validation_error_count ?? source.validation_error_count) || 0
  const trailingNonTransactionCount = Number(
    rawSummary?.trailing_non_transaction_count
    ?? (source.trailing_non_transaction_suspected ? source.trailing_error_count : 0),
  ) || 0
  const rejectedCount = Number(rawSummary?.rejected_count ?? (zeroAmountCount + validationErrorCount)) || 0
  const totalRows = Number(
    rawSummary?.total_rows
    ?? source.row_count
    ?? (importedCount + skippedCount + dedupedCount),
  ) || 0
  const otherSkippedCount = Math.max(
    0,
    skippedCount - accountSkippedCount - rejectedCount - trailingNonTransactionCount,
  )
  const rejectedHeaders = Array.isArray(rawSummary?.rejected_headers)
    ? rawSummary.rejected_headers
    : []
  const rejectedRows = Array.isArray(rawSummary?.rejected_rows)
    ? rawSummary.rejected_rows
    : Array.isArray(source.rejected_rows)
      ? source.rejected_rows
      : []
  const duplicateHeaders = Array.isArray(rawSummary?.duplicate_headers)
    ? rawSummary.duplicate_headers
    : []
  const duplicateRows = Array.isArray(rawSummary?.duplicate_rows)
    ? rawSummary.duplicate_rows
    : Array.isArray(source.duplicate_rows)
      ? source.duplicate_rows
      : []

  return {
    totalRows,
    importedCount,
    skippedCount,
    dedupedCount,
    accountSkippedCount,
    zeroAmountCount,
    validationErrorCount,
    rejectedCount,
    trailingNonTransactionCount,
    otherSkippedCount,
    rejectedHeaders,
    rejectedRows,
    duplicateHeaders,
    duplicateRows,
  }
}

function getUndoTargetForSource(source) {
  if (!source) return null
  return {
    ...source,
    id: source.id || source.batch_id || '',
  }
}

function RejectedRowsDialog({ rows = [], headers = [], count = 0, title = 'this import', onClose, onOpenRawViewer }) {
  const effectiveCount = Math.max(count, rows.length)
  const tableHeaders = headers.length > 0
    ? headers
    : Array.from(new Set(rows.flatMap(row => Object.keys(row?.values || {}))))
  const hasSavedRowValues = tableHeaders.length > 0
  return (
    <OverlayBackdrop zIndex={1200} tint="rgba(15, 23, 42, 0.42)">
      <FloatingPanel style={{ width: 'min(1200px, 100%)', maxHeight: '80vh', display: 'flex', flexDirection: 'column' }}>
        <FloatingPanelHeader style={{ padding: '16px 20px 14px' }}>
          <div>
            <div style={{ fontSize: 17, fontWeight: 600, marginBottom: 4 }}>
              {effectiveCount} rejected row{effectiveCount === 1 ? '' : 's'} from {title}
            </div>
            <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.5 }}>
              These rows were not imported because they either had a zero amount or did not validate against the selected column mappings.
            </div>
          </div>
        </FloatingPanelHeader>
        <div style={{ padding: 18, overflow: 'auto' }}>
          {rows.length > 0 ? (
            <div style={{ minWidth: hasSavedRowValues ? 920 : 420, display: 'grid', gap: 12 }}>
              {!hasSavedRowValues ? (
                <div style={{ padding: '10px 12px', borderRadius: 10, border: '1px solid var(--border)', background: 'color-mix(in srgb, var(--surface2) 36%, var(--surface))', fontSize: 13, color: 'var(--muted)', lineHeight: 1.6 }}>
                  Detailed CSV cell values were not saved for this import, so only the rejection reason and row number are available here.
                </div>
              ) : null}
              <table style={{ width: '100%', borderCollapse: 'separate', borderSpacing: 0, fontSize: 13 }}>
                <thead>
                  <tr>
                    <th style={{ position: 'sticky', top: 0, zIndex: 1, textAlign: 'left', padding: '10px 12px', background: 'color-mix(in srgb, var(--surface2) 84%, var(--surface))', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}>Reason</th>
                    <th style={{ position: 'sticky', top: 0, zIndex: 1, textAlign: 'left', padding: '10px 12px', background: 'color-mix(in srgb, var(--surface2) 84%, var(--surface))', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}>Row</th>
                    {tableHeaders.map(header => (
                      <th key={header} style={{ position: 'sticky', top: 0, zIndex: 1, textAlign: 'left', padding: '10px 12px', background: 'color-mix(in srgb, var(--surface2) 84%, var(--surface))', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}>
                        {header}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, index) => (
                    <tr key={`${row.row}:${index}`}>
                      <td style={{ verticalAlign: 'top', padding: '10px 12px', borderBottom: '1px solid color-mix(in srgb, var(--border) 72%, transparent)', minWidth: 160 }}>
                        <div style={{ display: 'grid', gap: 4 }}>
                          <span style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            width: 'fit-content',
                            padding: '2px 8px',
                            borderRadius: 999,
                            fontSize: 11,
                            fontWeight: 600,
                            border: '1px solid var(--border)',
                            background: row.kind === 'zero_amount'
                              ? 'color-mix(in srgb, #f59e0b 12%, var(--surface2))'
                              : 'color-mix(in srgb, #ef4444 10%, var(--surface2))',
                            color: row.kind === 'zero_amount' ? '#b45309' : '#dc2626',
                          }}>
                            {row.kind === 'zero_amount' ? 'Zero amount' : 'Validation error'}
                          </span>
                          <span>{row.reason}</span>
                        </div>
                      </td>
                      <td style={{ verticalAlign: 'top', padding: '10px 12px', borderBottom: '1px solid color-mix(in srgb, var(--border) 72%, transparent)', whiteSpace: 'nowrap', color: 'var(--muted)', fontWeight: 600 }}>
                        {row.row}
                      </td>
                      {tableHeaders.map(header => (
                        <td key={header} style={{ verticalAlign: 'top', padding: '10px 12px', borderBottom: '1px solid color-mix(in srgb, var(--border) 72%, transparent)', whiteSpace: 'nowrap' }}>
                          {String(row?.values?.[header] ?? '')}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div style={{ padding: '12px 14px', borderRadius: 10, border: '1px solid var(--border)', background: 'color-mix(in srgb, var(--surface2) 36%, var(--surface))', fontSize: 13, color: 'var(--muted)', lineHeight: 1.6 }}>
              Detailed rejected rows are not available for this import summary, but the raw file viewer can still be opened to inspect the file around the affected rows.
            </div>
          )}
        </div>
        <div style={{ padding: '14px 18px', borderTop: '1px solid var(--border)', background: 'color-mix(in srgb, var(--surface2) 66%, var(--surface))', display: 'flex', justifyContent: onOpenRawViewer ? 'space-between' : 'flex-end', gap: 10, flexWrap: 'wrap' }}>
          {onOpenRawViewer ? <Button variant="ghost" onClick={onOpenRawViewer}>Open raw file viewer</Button> : null}
          <Button variant="ghost" onClick={onClose}>Close</Button>
        </div>
      </FloatingPanel>
    </OverlayBackdrop>
  )
}

function DuplicateRowsDialog({
  rows = [],
  headers = [],
  count = 0,
  title = 'this import',
  loading = false,
  error = '',
  importing = false,
  onClose,
  onImportSelected,
  onImportAll,
}) {
  const effectiveCount = Math.max(count, rows.length)
  const tableHeaders = headers.length > 0
    ? headers
    : Array.from(new Set(rows.flatMap(row => Object.keys(row?.values || {}))))
  const hasSavedRowValues = tableHeaders.length > 0
  const duplicateDisplayRows = useMemo(
    () => rows.map(row => {
      const matchedTransaction = row?.matched_transaction || null
      return {
        ...row,
        matchedSummary: matchedTransaction
          ? `${matchedTransaction.date || ''} · ${matchedTransaction.merchant_name || ''} · ${formatTransactionAmount(matchedTransaction.amount)}`
          : (row.reason || 'Existing FinTrack transaction'),
      }
    }),
    [rows],
  )
  const importableRowNumbers = useMemo(
    () => rows.filter(row => row?.txn_payload).map(row => Number(row.row)).filter(Boolean),
    [rows],
  )
  const estimateColumnWidthCh = useMemo(
    () => (values, { header = '', min = 8, max = 22, fallback = 12 } = {}) => {
      const lengths = values
        .map(value => String(value ?? '').trim().length)
        .filter(length => length > 0)
        .sort((a, b) => a - b)
      const percentileLength = lengths.length > 0
        ? lengths[Math.min(lengths.length - 1, Math.floor((lengths.length - 1) * 0.85))]
        : 0
      const target = Math.max(header.length + 1, percentileLength + 1, fallback)
      return Math.max(min, Math.min(max, target))
    },
    [],
  )
  const rowWidthCh = 6
  const matchWidthCh = useMemo(
    () => estimateColumnWidthCh(
      duplicateDisplayRows.map(row => row.matchedSummary),
      { header: 'Matches', min: 18, max: 30, fallback: 22 },
    ),
    [duplicateDisplayRows, estimateColumnWidthCh],
  )
  const dataColumnWidths = useMemo(
    () => Object.fromEntries(
      tableHeaders.map(header => [
        header,
        estimateColumnWidthCh(
          duplicateDisplayRows.map(row => row?.values?.[header] ?? ''),
          { header, min: 8, max: 20, fallback: Math.max(10, String(header || '').length + 2) },
        ),
      ]),
    ),
    [duplicateDisplayRows, estimateColumnWidthCh, tableHeaders],
  )
  const tableMinWidthCh = useMemo(
    () => 6 + rowWidthCh + matchWidthCh + tableHeaders.reduce((sum, header) => sum + (dataColumnWidths[header] || 10), 0),
    [dataColumnWidths, matchWidthCh, rowWidthCh, tableHeaders],
  )
  const [selectedRows, setSelectedRows] = useState(() => new Set())

  useEffect(() => {
    setSelectedRows(new Set())
  }, [importableRowNumbers])

  const allImportableSelected = importableRowNumbers.length > 0 && importableRowNumbers.every(row => selectedRows.has(row))
  const selectedImportableCount = importableRowNumbers.filter(row => selectedRows.has(row)).length

  function toggleAllImportable(checked) {
    setSelectedRows(checked ? new Set(importableRowNumbers) : new Set())
  }

  function toggleRowSelection(rowNumber, checked) {
    setSelectedRows(prev => {
      const next = new Set(prev)
      if (checked) next.add(rowNumber)
      else next.delete(rowNumber)
      return next
    })
  }

  return (
    <OverlayBackdrop zIndex={1200} tint="rgba(15, 23, 42, 0.42)">
      <FloatingPanel style={{ width: 'min(1280px, 100%)', maxHeight: '80vh', display: 'flex', flexDirection: 'column' }}>
        <FloatingPanelHeader style={{ padding: '16px 20px 14px' }}>
          <div>
            <div style={{ fontSize: 17, fontWeight: 600 }}>
              {effectiveCount} possible duplicate row{effectiveCount === 1 ? '' : 's'} detected in {title}
            </div>
          </div>
        </FloatingPanelHeader>
        <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          {loading ? (
            <div style={{ display: 'grid', placeItems: 'center', minHeight: 180, padding: 18 }}>
              <Spinner />
            </div>
          ) : error ? (
            <div style={{ margin: 18, padding: '12px 14px', borderRadius: 10, border: '1px solid var(--danger)', background: 'color-mix(in srgb, var(--danger) 8%, var(--surface2))', fontSize: 13, color: 'var(--muted)', lineHeight: 1.6 }}>
              {error}
            </div>
          ) : rows.length > 0 ? (
            <>
              <div style={{ padding: '14px 18px 10px', display: 'grid', gap: 10 }}>
                {!hasSavedRowValues ? (
                  <div style={{ padding: '10px 12px', borderRadius: 10, border: '1px solid var(--border)', background: 'color-mix(in srgb, var(--surface2) 36%, var(--surface))', fontSize: 13, color: 'var(--muted)', lineHeight: 1.6 }}>
                    Detailed CSV cell values were not saved for this import, so only the matching transaction and row number are available here.
                  </div>
                ) : null}
                {importableRowNumbers.length === 0 ? (
                  <div style={{ padding: '10px 12px', borderRadius: 10, border: '1px solid var(--border)', background: 'color-mix(in srgb, var(--surface2) 36%, var(--surface))', fontSize: 13, color: 'var(--muted)', lineHeight: 1.6 }}>
                    These duplicate rows were saved without enough transaction payload data to import them from this report.
                  </div>
                ) : (
                  <div style={{ fontSize: 13, color: 'var(--muted)' }}>
                    {selectedImportableCount} selected for import.
                  </div>
                )}
              </div>
              <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
                <div style={{ minWidth: hasSavedRowValues ? `${tableMinWidthCh}ch` : 380, padding: '0 18px 18px' }}>
                  <table style={{ width: '100%', borderCollapse: 'separate', borderSpacing: 0, fontSize: 12.5, tableLayout: 'fixed' }}>
                    <thead>
                      <tr>
                        <th style={{ position: 'sticky', top: 0, zIndex: 1, textAlign: 'center', padding: '7px 8px', background: 'color-mix(in srgb, var(--surface2) 92%, var(--surface))', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', width: 40 }}>
                          {importableRowNumbers.length > 0 ? (
                            <input
                              type="checkbox"
                              checked={allImportableSelected}
                              onChange={event => toggleAllImportable(event.target.checked)}
                            />
                          ) : null}
                        </th>
                        <th style={{ position: 'sticky', top: 0, zIndex: 1, textAlign: 'left', padding: '7px 8px', background: 'color-mix(in srgb, var(--surface2) 92%, var(--surface))', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', width: `${rowWidthCh}ch` }}>Row</th>
                        {tableHeaders.map(header => (
                          <th key={header} style={{ position: 'sticky', top: 0, zIndex: 1, textAlign: 'left', padding: '7px 8px', background: 'color-mix(in srgb, var(--surface2) 92%, var(--surface))', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', width: `${dataColumnWidths[header] || 10}ch` }}>
                            {header}
                          </th>
                        ))}
                        <th style={{ position: 'sticky', top: 0, zIndex: 1, textAlign: 'left', padding: '7px 8px', background: 'color-mix(in srgb, var(--surface2) 92%, var(--surface))', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', width: `${matchWidthCh}ch` }}>Matches</th>
                      </tr>
                    </thead>
                    <tbody>
                      {duplicateDisplayRows.map((row, index) => {
                        const rowNumber = Number(row.row)
                        const importable = !!row?.txn_payload
                        return (
                          <tr key={`${row.row}:${index}`}>
                            <td style={{ verticalAlign: 'middle', padding: '6px 8px', borderBottom: '1px solid color-mix(in srgb, var(--border) 72%, transparent)', textAlign: 'center' }}>
                              {importable ? (
                                <input
                                  type="checkbox"
                                  checked={selectedRows.has(rowNumber)}
                                  onChange={event => toggleRowSelection(rowNumber, event.target.checked)}
                                />
                              ) : (
                                <span style={{ color: 'var(--muted)' }}>-</span>
                              )}
                            </td>
                            <td style={{ verticalAlign: 'middle', padding: '6px 8px', borderBottom: '1px solid color-mix(in srgb, var(--border) 72%, transparent)', whiteSpace: 'nowrap', color: 'var(--muted)', fontWeight: 600 }}>
                              {row.row}
                            </td>
                            {tableHeaders.map(header => {
                              const value = String(row?.values?.[header] ?? '')
                              return (
                                <td
                                  key={header}
                                  style={{ verticalAlign: 'middle', padding: '6px 8px', borderBottom: '1px solid color-mix(in srgb, var(--border) 72%, transparent)', fontSize: 12 }}
                                  title={value}
                                >
                                  <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                    {value}
                                  </div>
                                </td>
                              )
                            })}
                            <td
                              style={{ verticalAlign: 'middle', padding: '6px 8px', borderBottom: '1px solid color-mix(in srgb, var(--border) 72%, transparent)', fontSize: 12 }}
                              title={row.matchedSummary}
                            >
                              <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {row.matchedSummary}
                              </div>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          ) : (
            <div style={{ margin: 18, padding: '12px 14px', borderRadius: 10, border: '1px solid var(--border)', background: 'color-mix(in srgb, var(--surface2) 36%, var(--surface))', fontSize: 13, color: 'var(--muted)', lineHeight: 1.6 }}>
              Detailed duplicate rows are not available for this import summary.
            </div>
          )}
        </div>
        <div style={{ padding: '14px 18px', borderTop: '1px solid var(--border)', background: 'color-mix(in srgb, var(--surface2) 66%, var(--surface))', display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            {!loading && !error && importableRowNumbers.length > 0 ? (
              <>
                <Button
                  onClick={() => onImportSelected?.(Array.from(selectedRows))}
                  disabled={importing || selectedRows.size === 0}
                >
                  {importing ? 'Importing…' : `Import selected${selectedRows.size > 0 ? ` (${selectedRows.size})` : ''}`}
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => onImportAll?.()}
                  disabled={importing}
                >
                  {importing ? 'Importing…' : 'Import all duplicates'}
                </Button>
              </>
            ) : null}
          </div>
          <Button variant="ghost" onClick={onClose}>Close</Button>
        </div>
      </FloatingPanel>
    </OverlayBackdrop>
  )
}

function DuplicateImportConfirmDialog({
  pending,
  importing = false,
  onCancel,
  onConfirm,
}) {
  const dialogRef = useRef(null)

  useEffect(() => {
    dialogRef.current?.focus()
  }, [])

  if (!pending) return null

  return (
    <OverlayBackdrop
      onClick={onCancel}
      zIndex={1250}
      tint="rgba(15, 23, 42, 0.45)"
    >
      <FloatingPanel
        ref={dialogRef}
        tabIndex={-1}
        onClick={event => event.stopPropagation()}
        onKeyDownCapture={event => {
          if (event.key === 'Enter') {
            event.preventDefault()
            event.stopPropagation()
          }
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            onCancel?.()
          }
        }}
        style={{
          width: 'min(360px, calc(100% - 48px))',
          border: '1px solid color-mix(in srgb, var(--accent) 28%, var(--border))',
          padding: '18px 18px 16px',
          display: 'grid',
          gap: 10,
          outline: 'none',
        }}
      >
        <div style={{ fontSize: 16, fontWeight: 600, textAlign: 'center' }}>Confirm import?</div>
        <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.6, textAlign: 'center' }}>
          {pending.importAll
            ? `Import all ${pending.count} row${pending.count === 1 ? '' : 's'}?`
            : `Import ${pending.count} selected row${pending.count === 1 ? '' : 's'}?`}
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap', marginTop: 2 }}>
          <Button small variant="ghost" onClick={onCancel} disabled={importing}>
            Cancel
          </Button>
          <Button small variant="ghost" onClick={onConfirm} disabled={importing}>
            {importing ? 'Importing…' : 'Import duplicates'}
          </Button>
        </div>
      </FloatingPanel>
    </OverlayBackdrop>
  )
}

function deriveImportSourceHints(previewLike) {
  const filename = previewLike?.filename || ''
  const filenamePattern = filename.replace(/[_\-\d.]+\.(csv)$/i, '').trim().toLowerCase()
  return {
    headerFingerprint: previewLike?.header_fingerprint || '',
    filenamePattern,
  }
}

function buildEmptyDataSourceBody(name) {
  return {
    name: name.trim(),
    filename_pattern: null,
    header_fingerprint: null,
    template_filename: null,
    template_file_hash: null,
    column_map: {},
    account_id: null,
    date_format: '%m/%d/%Y',
    amount_convention: 'single_signed',
    skip_rows: 0,
    apply_categorization: true,
  }
}

// Import persistence model:
// - If a matching profile exists, the profile is the source of truth for reusable
//   import state (column mapping, account mapping, category mapping workspace,
//   set-aside list, collapsed bucket state, etc.).
// - Local draft storage is only the "last manual import draft" fallback for the
//   no-profile case. It should never override a matched profile.
// - The local draft is header-compatible rather than file-specific, so manual
//   mapping work can carry forward only when the next file still looks like the
//   same provider shape.
function getImportDraftStorageKey(instanceId, subjectId) {
  return instanceId && subjectId ? `fintrack.importDraft.v2.${instanceId}.${subjectId}` : null
}

function loadSavedImportDraftRecord(instanceId, subjectId) {
  const storageKey = getImportDraftStorageKey(instanceId, subjectId)
  if (!storageKey) return null
  try {
    const raw = window.localStorage.getItem(storageKey)
    if (!raw) return null
    const saved = JSON.parse(raw)
    if (!saved?.snapshot) return null
    return saved
  } catch {
    return null
  }
}

function loadSavedImportDraft(previewLike, instanceId, subjectId) {
  const saved = loadSavedImportDraftRecord(instanceId, subjectId)
  if (!saved) return null
  const { headerFingerprint } = deriveImportSourceHints(previewLike)
  if (saved.headerFingerprint && headerFingerprint && saved.headerFingerprint !== headerFingerprint) return null
  return saved.snapshot
}

function saveImportDraft(previewLike, snapshot, instanceId, subjectId) {
  const storageKey = getImportDraftStorageKey(instanceId, subjectId)
  if (!storageKey) return
  try {
    const { headerFingerprint, filenamePattern } = deriveImportSourceHints(previewLike)
    const record = {
      headerFingerprint,
      filenamePattern,
      templateFilename: previewLike?.filename || '',
      templateFileHash: previewLike?.file_content_hash || '',
      snapshot,
    }
    window.localStorage.setItem(storageKey, JSON.stringify(record))
    return record
  } catch { }
}

function saveImportDraftRecord(record, instanceId, subjectId) {
  const storageKey = getImportDraftStorageKey(instanceId, subjectId)
  if (!storageKey) return null
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(record))
    return record
  } catch { }
}

function clearSavedImportDraft(instanceId, subjectId) {
  const storageKey = getImportDraftStorageKey(instanceId, subjectId)
  if (!storageKey) return
  try {
    window.localStorage.removeItem(storageKey)
  } catch { }
}

function buildProfileBodyFromSnapshot(name, draftRecord) {
  const snapshot = draftRecord?.snapshot
  if (!snapshot) return null
  const columnMap = { ...(snapshot.column_map || {}) }
  if (snapshot.category_workspace_draft) {
    columnMap.category_workspace_draft = clonePersistedCategoryWorkspaceDraft(snapshot.category_workspace_draft)
  }
  if (snapshot.single_account_new?.name?.trim()) {
    columnMap.single_account_new = {
      name: snapshot.single_account_new.name.trim(),
      type: snapshot.single_account_new.type || 'depository',
    }
  }
  if (snapshot.account_map && Object.keys(snapshot.account_map).length > 0) {
    columnMap.account_assignments = { ...snapshot.account_map }
  }
  if (snapshot.skip_accounts?.length > 0) {
    columnMap.account_skips = [...snapshot.skip_accounts]
  }
  if (snapshot.account_new && Object.keys(snapshot.account_new).length > 0) {
    columnMap.account_new = { ...snapshot.account_new }
  }
  return {
    name: name.trim(),
    filename_pattern: draftRecord?.filenamePattern || null,
    header_fingerprint: draftRecord?.headerFingerprint || null,
    template_filename: draftRecord?.templateFilename || null,
    template_file_hash: draftRecord?.templateFileHash || null,
    column_map: columnMap,
    account_id: snapshot.account_id || null,
    date_format: snapshot.date_format || '%m/%d/%Y',
    amount_convention: snapshot.amount_convention || 'single_signed',
    skip_rows: snapshot.skip_rows || 0,
    apply_categorization: snapshot.apply_categorization !== false,
  }
}

function buildDraftRecordFromPreview(previewLike, snapshot) {
  if (!previewLike || !snapshot) return null
  const { headerFingerprint, filenamePattern } = deriveImportSourceHints(previewLike)
  return {
    headerFingerprint,
    filenamePattern,
    templateFilename: previewLike?.filename || '',
    templateFileHash: previewLike?.file_content_hash || '',
    snapshot,
  }
}

function doesDraftMatchPreview(draftRecord, previewLike) {
  if (!draftRecord || !previewLike) return false
  const draftFileHash = String(draftRecord.templateFileHash || '').trim()
  const previewFileHash = String(previewLike.file_content_hash || '').trim()
  if (draftFileHash && previewFileHash) return draftFileHash === previewFileHash
  const draftHeader = String(draftRecord.headerFingerprint || '').trim()
  const previewHeader = String(previewLike.header_fingerprint || '').trim()
  return !!draftHeader && !!previewHeader && draftHeader === previewHeader
}

function formatImportBatchTimestamp(value) {
  const normalized = String(value || '').trim()
  return normalized ? normalized.slice(0, 16).replace('T', ' ') : ''
}

function clonePersistedCategoryWorkspaceDraft(draft) {
  if (!draft?.snapshot) return null
  if (draft?.snapshot?.mappings) return null
  return {
    snapshot: cloneCategoryImportSnapshot(draft.snapshot),
    undoStack: (draft.undoStack || []).map(cloneCategoryImportSnapshot),
    redoStack: (draft.redoStack || []).map(cloneCategoryImportSnapshot),
    selectionAnchor: draft.selectionAnchor || null,
    activeSection: draft.activeSection === 'income' ? 'income' : 'expense',
  }
}

function getCategoryWorkspaceActionLabel(remainingCount) {
  return remainingCount > 0
    ? `Import categories (${remainingCount} uncategorized)`
    : 'View imported categories'
}

function collectCategoryWorkspaceSourceValues(draft) {
  const snapshot = draft?.snapshot
  if (!snapshot) return []
  const seen = new Set()
  const ordered = []
  const addValue = value => {
    const normalized = String(value || '').trim()
    if (!normalized || seen.has(normalized)) return
    seen.add(normalized)
    ordered.push(normalized)
  }
    ; (snapshot.sourceOrder || []).forEach(addValue)
    ; (snapshot.setAsideOrder || []).forEach(addValue)
  for (const sectionType of ['income', 'expense']) {
    for (const group of snapshot.tree?.[sectionType] || []) {
      for (const child of group.children || []) {
        addValue(child?.sourceValue || child?.name)
      }
    }
  }
  return ordered
}

function summarizeCategoryWorkspaceDraft(draft) {
  const sourceValues = collectCategoryWorkspaceSourceValues(draft)
  return {
    sourceValues,
    totalCount: sourceValues.length,
    remainingCount: draft?.snapshot?.sourceOrder?.length || 0,
  }
}

function summarizeRuleSuggestionReview(review) {
  if (!review || typeof review !== 'object') return null
  const summary = review.summary && typeof review.summary === 'object' ? review.summary : null
  return {
    generated_at: review.generated_at || null,
    last_generated_at: review.last_generated_at || null,
    total_count: Number(summary?.total_count || 0),
    reviewed_count: Number(summary?.reviewed_count || 0),
    accepted_count: Number(summary?.accepted_count || 0),
    skipped_count: Number(summary?.skipped_count || 0),
    discarded_count: Number(summary?.discarded_count || 0),
    pending_count: Number(summary?.pending_count || 0),
  }
}

function buildAccountImportStateSnapshot(accountMap) {
  const accountAssignments = {}
  const accountNew = {}
  const skipAccounts = []

  for (const [csvVal, mapping] of Object.entries(accountMap || {})) {
    if (mapping?.skip) {
      skipAccounts.push(csvVal)
    } else if (mapping?.createNew && mapping?.newName?.trim()) {
      accountNew[csvVal] = {
        name: mapping.newName.trim(),
        type: mapping.newType || 'depository',
      }
    } else if (mapping?.accountId) {
      accountAssignments[csvVal] = mapping.accountId
    }
  }

  return {
    account_map: accountAssignments,
    skip_accounts: skipAccounts,
    account_new: accountNew,
  }
}

function profileHeaderClearlyMismatches(profile, previewLike) {
  const profileHeader = String(profile?.header_fingerprint || '').trim()
  const previewHeader = String(previewLike?.header_fingerprint || '').trim()
  return !!profileHeader && !!previewHeader && profileHeader !== previewHeader
}

function RawFilePreview({ rawLines, headerRowIndex, onClose, lineNumberOffset = 0, title = 'Raw file', note = null }) {
  const [pos, setPos] = useState({ x: Math.max(0, window.innerWidth - 560), y: 80 })
  const [size, setSize] = useState({ w: 520, h: 320 })
  const [dragState, setDragState] = useState(null)
  const startRef = useRef({})

  useEffect(() => {
    if (!dragState) return
    function onMove(e) {
      const dx = e.clientX - startRef.current.mx
      const dy = e.clientY - startRef.current.my
      if (dragState === 'move') {
        setPos({
          x: Math.max(0, Math.min(window.innerWidth - 200, startRef.current.x + dx)),
          y: Math.max(0, Math.min(window.innerHeight - 60, startRef.current.y + dy)),
        })
      } else {
        setSize({
          w: Math.max(320, startRef.current.w + dx),
          h: Math.max(160, startRef.current.h + dy),
        })
      }
    }
    function onUp() { setDragState(null) }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
  }, [dragState])

  function startMove(e) {
    startRef.current = { x: pos.x, y: pos.y, mx: e.clientX, my: e.clientY }
    setDragState('move')
    e.preventDefault()
  }

  function startResize(e) {
    startRef.current = { w: size.w, h: size.h, mx: e.clientX, my: e.clientY }
    setDragState('resize')
    e.preventDefault()
    e.stopPropagation()
  }

  if (!rawLines?.length) return null

  return (
    <div style={{
      position: 'fixed', left: pos.x, top: pos.y, zIndex: 1105,
      width: size.w, background: 'var(--surface)',
      border: '1px solid var(--border)', borderRadius: 10,
      boxShadow: '0 8px 32px rgba(0,0,0,0.35)',
      display: 'flex', flexDirection: 'column',
      userSelect: dragState ? 'none' : 'auto',
    }}>
      <div onMouseDown={startMove} style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '8px 12px', cursor: 'grab',
        borderBottom: '1px solid var(--border)',
        background: 'var(--surface2)', borderRadius: '10px 10px 0 0', flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>⠿</span>
          <span style={{ fontSize: 13, fontWeight: 600 }}>{title}</span>
          <span style={{ fontSize: 11, color: 'var(--muted)' }}>
            {headerRowIndex >= 0 ? `header on line ${headerRowIndex + 1} · ` : ''}drag to move · resize ↘
          </span>
        </div>
        <button
          onMouseDown={e => e.stopPropagation()}
          onClick={onClose}
          style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: '0 2px' }}
        >×</button>
      </div>

      {note && (
        <div style={{
          padding: '8px 12px',
          fontSize: 12,
          color: '#f59e0b',
          background: 'color-mix(in srgb, #f59e0b 10%, var(--surface2))',
          borderBottom: '1px solid var(--border)',
        }}>
          {note}
        </div>
      )}
      <div style={{
        fontFamily: 'monospace', fontSize: 12,
        overflowY: 'auto', overflowX: 'auto',
        height: size.h,
        borderRadius: '0 0 10px 10px',
      }}>
        {rawLines.map((line, i) => {
          const actualLineIndex = lineNumberOffset + i
          const isHeader = actualLineIndex === headerRowIndex
          const isData = actualLineIndex > headerRowIndex && actualLineIndex <= headerRowIndex + 4
          const dimmed = !isHeader && !isData && actualLineIndex > headerRowIndex
          return (
            <div key={i} style={{
              display: 'flex', alignItems: 'baseline',
              background: isHeader ? 'color-mix(in srgb, var(--accent) 14%, var(--surface2))' : 'transparent',
              borderBottom: '1px solid var(--border)',
              opacity: dimmed ? 0.25 : 1,
            }}>
              <span style={{ minWidth: 32, padding: '3px 6px', textAlign: 'right', flexShrink: 0, fontSize: 10, color: 'var(--muted)', borderRight: '1px solid var(--border)', background: 'var(--surface2)', fontWeight: isHeader ? 600 : 400 }}>{actualLineIndex + 1}</span>
              <span style={{ padding: '3px 10px', whiteSpace: 'pre', color: 'var(--text)', fontWeight: isHeader ? 600 : 400 }}>{line || ' '}</span>
              {isHeader && <span style={{ marginLeft: 'auto', padding: '3px 8px', flexShrink: 0, fontSize: 10, color: 'var(--accent2)', fontFamily: 'sans-serif', fontWeight: 600 }}>← header</span>}
            </div>
          )
        })}
      </div>

      <div
        onMouseDown={startResize}
        style={{
          position: 'absolute', right: 0, bottom: 0,
          width: 18, height: 18, cursor: 'nwse-resize',
          display: 'flex', alignItems: 'flex-end', justifyContent: 'flex-end',
          padding: '3px', color: 'var(--muted)', fontSize: 12, lineHeight: 1,
          borderRadius: '0 0 10px 0',
        }}
      >⌟</div>
    </div>
  )
}

// Custom dropdown that shows different text when closed vs open:
//   Closed (column mode):  "↔ Column  AccountName"
//   Closed (account mode): "AccountName ···mask"
//   Open list:             plain "AccountName" and plain "HeaderName" (no prefix)

// Keep the import UI recoverable if a preview or mapping render crashes.
class ImportErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null } }
  static getDerivedStateFromError(e) { return { error: e } }
  render() {
    if (this.state.error) {
      return (
        <div style={{
          padding: '20px 24px', background: 'color-mix(in srgb, var(--danger) 10%, var(--surface2))',
          border: '1px solid var(--danger)', borderRadius: 10, margin: '16px 0',
        }}>
          <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 8, color: 'var(--danger)' }}>
            Something went wrong in the import form
          </div>
          <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 12, fontFamily: 'monospace' }}>
            {this.state.error?.message}
          </div>
          <button
            onClick={() => this.setState({ error: null })}
            style={{
              background: 'var(--surface)', border: '1px solid var(--border)',
              borderRadius: 6, padding: '5px 14px', fontSize: 13, cursor: 'pointer',
            }}
          >Try again</button>
        </div>
      )
    }
    return this.props.children
  }
}

function ImportTab() {
  const navigate = useNavigate()
  const [lastImportDataSourceId, setLastImportDataSourceId] = useUserPreference(LAST_IMPORT_DATA_SOURCE_PREF_KEY, '')
  const [expandedSourceRows, setExpandedSourceRows] = useUserPreference(EXPANDED_IMPORT_SOURCE_ROWS_PREF_KEY, {})
  const [savedDataSourceManagerPos, setSavedDataSourceManagerPos] = useUserPreference(DATA_SOURCE_MANAGER_POS_PREF_KEY, null)
  const [dbInstanceId, setDbInstanceId] = useState('')
  const [preferenceSubjectId, setPreferenceSubjectId] = useState('')
  const [stage, setStage] = useState('upload')
  const [preview, setPreview] = useState(null)
  const [profiles, setProfiles] = useState([])
  const [accounts, setAccounts] = useState([])
  const [categories, setCategories] = useState([])
  const [loading, setLoading] = useState(false)
  const [batches, setBatches] = useState([])
  const [undoTarget, setUndoTarget] = useState(null)
  const [undoEdited, setUndoEdited] = useState([])
  const [undoLoading, setUndoLoading] = useState(false)
  const dropRef = useRef(null)
  const fileInputRef = useRef(null)
  const [selectedUploadSource, setSelectedUploadSource] = useState('')
  const [uploadSourcesReady, setUploadSourcesReady] = useState(false)
  const [startupUploadSourceApplied, setStartupUploadSourceApplied] = useState(false)
  const [showUploadSourceCreate, setShowUploadSourceCreate] = useState(false)
  const [uploadSourceDraftName, setUploadSourceDraftName] = useState('')
  const [creatingUploadSource, setCreatingUploadSource] = useState(false)
  const [showMappingSourceChooser, setShowMappingSourceChooser] = useState(false)
  const [mappingBaselineSnapshot, setMappingBaselineSnapshot] = useState('')
  const [pendingMappingBaselineCapture, setPendingMappingBaselineCapture] = useState(false)
  const [manualDraftRecord, setManualDraftRecord] = useState(null)
  const [showManualDraftSave, setShowManualDraftSave] = useState(false)
  const [manualDraftSaveName, setManualDraftSaveName] = useState('')
  const [savingManualDraftSource, setSavingManualDraftSource] = useState(false)
  const [compatibleBatchPrompt, setCompatibleBatchPrompt] = useState(null)
  const [attachingCompatibleBatches, setAttachingCompatibleBatches] = useState(false)
  const [showDataSourceManager, setShowDataSourceManager] = useState(false)
  const [dataSourceManagerEditing, setDataSourceManagerEditing] = useState(false)
  const [dataSourceManagerPos, setDataSourceManagerPos] = useState(null)
  const [dataSourceManagerDragging, setDataSourceManagerDragging] = useState(false)
  const [editingSourceNameKey, setEditingSourceNameKey] = useState('')
  const [sourceNameDraft, setSourceNameDraft] = useState('')
  const [editingSourceDescriptionId, setEditingSourceDescriptionId] = useState('')
  const [sourceDescriptionDraft, setSourceDescriptionDraft] = useState('')

  const [selectedProfile, setSelectedProfile] = useState('')
  const [accountId, setAccountId] = useState('')
  const [dateFormat, setDateFormat] = useState('%m/%d/%Y')
  const [amtConv, setAmtConv] = useState('single_signed')
  const [skipRows, setSkipRows] = useState(0)
  const [applyCat, setApplyCat] = useState(true)
  const [colDate, setColDate] = useState(null)
  const [colAmount, setColAmount] = useState(null)
  const [colDebit, setColDebit] = useState(null)
  const [colCredit, setColCredit] = useState(null)
  const [colDir, setColDir] = useState(null)
  const [colDesc, setColDesc] = useState(null)
  const [colCategory, setColCategory] = useState(null)
  const [colNotes, setColNotes] = useState(null)
  const [colPending, setColPending] = useState(null)
  const [colAccount, setColAccount] = useState(null)
  const [mappingSuggestions, setMappingSuggestions] = useState(getBlankMappingSuggestions())
  const [singleAccountNew, setSingleAccountNew] = useState({ enabled: false, name: '', type: 'depository' })
  const [accountMap, setAccountMap] = useState({})
  const [categoryAssignments, setCategoryAssignments] = useState({})
  const [categoryMappingRows, setCategoryMappingRows] = useState([])
  const [categoryMappingSummary, setCategoryMappingSummary] = useState(null)
  const [showCategoryWorkspace, setShowCategoryWorkspace] = useState(false)
  const [sourceWorkspaceProfileId, setSourceWorkspaceProfileId] = useState('')
  const [sourceWorkspaceBatchId, setSourceWorkspaceBatchId] = useState('')
  const [sourceWorkspaceDraft, setSourceWorkspaceDraft] = useState(null)
  // Snapshot the source values when the workspace opens and keep them stable.
  // Recomputing them from the live draft would churn the array identity and
  // retrigger CategoryImportWorkspace sanitization on every draft update.
  const [sourceWorkspaceSourceValues, setSourceWorkspaceSourceValues] = useState([])
  const [showCategoryImportHelp, setShowCategoryImportHelp] = useState(false)
  const [importCategoryDraft, setImportCategoryDraft] = useState(null)
  const [pendingCategoryApply, setPendingCategoryApply] = useState(null)
  const [pendingCategoryReplacementId, setPendingCategoryReplacementId] = useState('')
  const [importResult, setImportResult] = useState(null)
  const [showRaw, setShowRaw] = useState(false)
  const [rejectedRowsViewer, setRejectedRowsViewer] = useState(null)
  const [duplicateRowsViewer, setDuplicateRowsViewer] = useState(null)
  const [duplicateImporting, setDuplicateImporting] = useState(false)
  const [pendingDuplicateImport, setPendingDuplicateImport] = useState(null)
  const [pendingProfileMismatch, setPendingProfileMismatch] = useState(null)
  const [showProfileMismatchChooser, setShowProfileMismatchChooser] = useState(false)
  const [pendingMappingSourceSwitch, setPendingMappingSourceSwitch] = useState(null)
  const [noticeDialog, setNoticeDialog] = useState(null)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [dateFormatLocked, setDateFormatLocked] = useState(false)
  const duplicateViewerRequestRef = useRef(0)
  const dataSourceManagerRef = useRef(null)
  const dataSourceManagerDragStartRef = useRef(null)

  useEffect(() => {
    Promise.all([
      api.getImportProfiles(),
      api.getAccounts(),
      api.getCategories(),
      api.listBatches(),
      api.getAuthStatus(),
    ]).then(([p, a, c, b, status]) => {
      setProfiles(p)
      setAccounts(a)
      setCategories(c)
      setBatches(b)
      setDbInstanceId(status?.db_instance_id || '')
      setPreferenceSubjectId(status?.preference_profile?.id || status?.user?.id || '')
      setUploadSourcesReady(true)
    })
  }, [])

  useEffect(() => {
    setManualDraftRecord(loadSavedImportDraftRecord(dbInstanceId, preferenceSubjectId))
  }, [dbInstanceId, preferenceSubjectId])

  const activeUploadProfile = useMemo(
    () => profiles.find(p => p.id === selectedUploadSource) || null,
    [profiles, selectedUploadSource]
  )
  const activeSourceWorkspaceProfile = useMemo(
    () => profiles.find(profile => profile.id === sourceWorkspaceProfileId) || null,
    [profiles, sourceWorkspaceProfileId],
  )
  const uploadUsesManualDraft = selectedUploadSource === MANUAL_DATA_SOURCE_VALUE
  const uploadChoiceReady = !!selectedUploadSource
  const uploadSelectionLabel = activeUploadProfile?.name || (uploadUsesManualDraft ? 'Temporary draft' : '')
  const activeSourceWorkspaceSummary = useMemo(
    () => summarizeCategoryWorkspaceDraft(sourceWorkspaceDraft || clonePersistedCategoryWorkspaceDraft(activeSourceWorkspaceProfile?.column_map?.category_workspace_draft)),
    [activeSourceWorkspaceProfile, sourceWorkspaceDraft],
  )

  function selectUploadSource(nextSourceId, options = {}) {
    const { persist = true } = options
    setSelectedUploadSource(nextSourceId)
    if (persist && nextSourceId && nextSourceId !== MANUAL_DATA_SOURCE_VALUE) {
      setLastImportDataSourceId(nextSourceId).catch(() => { })
    } else if (!persist || nextSourceId === MANUAL_DATA_SOURCE_VALUE || !nextSourceId) {
      setLastImportDataSourceId('').catch(() => { })
    }
  }

  function getSourceNameEditKey(location, profileId) {
    return `${location}:${profileId || ''}`
  }

  useEffect(() => {
    if (!uploadSourcesReady || startupUploadSourceApplied) return
    if (!lastImportDataSourceId) {
      setStartupUploadSourceApplied(true)
      return
    }
    if (profiles.some(profile => profile.id === lastImportDataSourceId)) {
      setSelectedUploadSource(lastImportDataSourceId)
    } else {
      setLastImportDataSourceId('').catch(() => { })
    }
    setStartupUploadSourceApplied(true)
  }, [uploadSourcesReady, startupUploadSourceApplied, lastImportDataSourceId, profiles, setLastImportDataSourceId])

  useEffect(() => {
    if (!selectedUploadSource || selectedUploadSource === MANUAL_DATA_SOURCE_VALUE) return
    if (!profiles.some(profile => profile.id === selectedUploadSource)) {
      setSelectedUploadSource('')
      if (lastImportDataSourceId === selectedUploadSource) {
        setLastImportDataSourceId('').catch(() => { })
      }
    }
  }, [profiles, selectedUploadSource, lastImportDataSourceId, setLastImportDataSourceId])

  function getDataSourceManagerDefaultPosition() {
    if (typeof window === 'undefined') return { x: 360, y: 180 }
    const width = Math.min(1040, window.innerWidth - 96)
    const height = Math.max(380, Math.min(window.innerHeight * 0.78, 640))
    return clampFloatingPanelPosition(
      {
        x: Math.max(340, Math.round(window.innerWidth * 0.24)),
        y: 180,
      },
      { width, height },
    )
  }

  function closeDataSourceManager() {
    setShowDataSourceManager(false)
    setDataSourceManagerEditing(false)
    setDataSourceManagerDragging(false)
  }

  function handleManagerDataChange({ profiles: nextProfiles, batches: nextBatches } = {}) {
    if (Array.isArray(nextProfiles)) {
      setProfiles(nextProfiles)
    }
    if (Array.isArray(nextBatches)) {
      setBatches(nextBatches)
    }
  }

  function startDataSourceManagerDrag(event) {
    if (dataSourceManagerEditing || !dataSourceManagerRef.current) return
    const rect = dataSourceManagerRef.current.getBoundingClientRect()
    dataSourceManagerDragStartRef.current = {
      mouseX: event.clientX,
      mouseY: event.clientY,
      x: dataSourceManagerPos?.x ?? rect.left,
      y: dataSourceManagerPos?.y ?? rect.top,
      width: rect.width,
      height: rect.height,
    }
    setDataSourceManagerDragging(true)
    event.preventDefault()
  }

  useEffect(() => {
    if (!showDataSourceManager) return
    const saved = savedDataSourceManagerPos && typeof savedDataSourceManagerPos === 'object'
      ? savedDataSourceManagerPos
      : null
    const rect = dataSourceManagerRef.current?.getBoundingClientRect()
    const nextPos = saved
      ? clampFloatingPanelPosition(saved, rect || { width: Math.min(1040, window.innerWidth - 96), height: Math.max(380, Math.min(window.innerHeight * 0.78, 640)) })
      : getDataSourceManagerDefaultPosition()
    setDataSourceManagerPos(nextPos)
  }, [savedDataSourceManagerPos, showDataSourceManager])

  useEffect(() => {
    if (!showDataSourceManager) return undefined
    function handleResize() {
      const rect = dataSourceManagerRef.current?.getBoundingClientRect()
      setDataSourceManagerPos(prev => clampFloatingPanelPosition(prev || getDataSourceManagerDefaultPosition(), rect || { width: Math.min(1040, window.innerWidth - 96), height: Math.max(380, Math.min(window.innerHeight * 0.78, 640)) }))
    }
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [showDataSourceManager])

  useEffect(() => {
    if (!dataSourceManagerDragging) return undefined
    function handleMove(event) {
      const start = dataSourceManagerDragStartRef.current
      if (!start) return
      setDataSourceManagerPos(clampFloatingPanelPosition({
        x: start.x + (event.clientX - start.mouseX),
        y: start.y + (event.clientY - start.mouseY),
      }, { width: start.width, height: start.height }))
    }
    function handleUp() {
      setDataSourceManagerDragging(false)
      const start = dataSourceManagerDragStartRef.current
      if (!start) return
      setSavedDataSourceManagerPos(prev => {
        const next = dataSourceManagerPos || prev || getDataSourceManagerDefaultPosition()
        return next
      }).catch(() => { })
    }
    window.addEventListener('mousemove', handleMove)
    window.addEventListener('mouseup', handleUp)
    return () => {
      window.removeEventListener('mousemove', handleMove)
      window.removeEventListener('mouseup', handleUp)
    }
  }, [dataSourceManagerDragging, dataSourceManagerPos, setSavedDataSourceManagerPos])

  const distinctAccountValues = useMemo(() => {
    if (!colAccount || !preview?.column_distinct_values) return []
    return preview.column_distinct_values[colAccount] || []
  }, [colAccount, preview])
  const accountValueCounts = useMemo(() => {
    if (!colAccount || !preview?.column_value_counts) return {}
    return preview.column_value_counts[colAccount] || {}
  }, [colAccount, preview])

  const previousImportAccounts = useMemo(
    () => (preview?.previous_batch_accounts || []).filter(a => !a.was_skipped),
    [preview],
  )
  const previousImportAccountsByValue = useMemo(
    () => new Map(previousImportAccounts.filter(a => a.csv_value).map(a => [a.csv_value, a])),
    [previousImportAccounts],
  )
  const remainingAccountValues = useMemo(
    () => distinctAccountValues.filter(value => !previousImportAccountsByValue.has(value)),
    [distinctAccountValues, previousImportAccountsByValue],
  )

  const importableRowCount = useMemo(() => {
    if (!preview) return 0
    const baseRowCount = Math.max(0, Number(preview.total_rows || 0) - skipRows)
    if (!colAccount) {
      return preview.previous_batch ? 0 : baseRowCount
    }
    const alreadyImportedRows = previousImportAccounts.reduce(
      (total, item) => total + Number(item?.row_count || 0),
      0,
    )
    const skippedAccountRows = remainingAccountValues.reduce((total, value) => {
      const mapping = accountMap[value]
      if (!mapping?.skip) return total
      return total + Number(accountValueCounts[value] || 0)
    }, 0)
    return Math.max(0, baseRowCount - alreadyImportedRows - skippedAccountRows)
  }, [preview, skipRows, colAccount, previousImportAccounts, remainingAccountValues, accountMap, accountValueCounts])

  const dataSourceRows = useMemo(() => {
    const savedSourceRows = profiles.map(profile => {
      const draft = clonePersistedCategoryWorkspaceDraft(profile.column_map?.category_workspace_draft)
      const categorySummary = summarizeCategoryWorkspaceDraft(draft)
      const ruleSuggestionReview = summarizeRuleSuggestionReview(profile.column_map?.rule_suggestion_review)
      const profileBatches = batches.filter(batch => batch.profile_id === profile.id).sort((a, b) => String(b.imported_at || '').localeCompare(String(a.imported_at || '')))
      const latestBatch = profileBatches[0] || null
      return {
        key: `profile:${profile.id}`,
        kind: 'profile',
        profile,
        draft,
        categorySummary,
        ruleSuggestionReview,
        hasImportedCategories: profileBatches.some(batch => batch.has_imported_categories),
        batches: profileBatches,
        latestBatch,
      }
    })
    const manualBatches = batches
      .filter(batch => !batch.profile_id && !batch.unknown_source_fallback)
      .sort((a, b) => String(b.imported_at || '').localeCompare(String(a.imported_at || '')))
    const fallbackUnknownBatches = batches
      .filter(batch => !batch.profile_id && batch.unknown_source_fallback)
      .sort((a, b) => String(b.imported_at || '').localeCompare(String(a.imported_at || '')))
    const latestManualBatch = manualBatches[0] || null
    const olderManualBatches = manualBatches.slice(1)

    if (latestManualBatch) {
      savedSourceRows.push({
        key: 'manual-draft',
        kind: 'manual',
        profile: null,
        draft: clonePersistedCategoryWorkspaceDraft(manualDraftRecord?.snapshot?.category_workspace_draft),
        categorySummary: summarizeCategoryWorkspaceDraft(clonePersistedCategoryWorkspaceDraft(manualDraftRecord?.snapshot?.category_workspace_draft)),
        ruleSuggestionReview: null,
        hasImportedCategories: !!latestManualBatch?.has_imported_categories,
        batches: [latestManualBatch],
        latestBatch: latestManualBatch,
        manualDraftRecord,
      })
    }

    const unknownSourceBatches = [
      ...olderManualBatches,
      ...fallbackUnknownBatches,
    ]
      .sort((a, b) => String(b.imported_at || '').localeCompare(String(a.imported_at || '')))

    if (unknownSourceBatches.length > 0) {
      savedSourceRows.push({
        key: 'unknown-source',
        kind: 'unknown',
        profile: null,
        draft: null,
        categorySummary: { sourceValues: [], totalCount: 0, remainingCount: 0 },
        ruleSuggestionReview: null,
        hasImportedCategories: unknownSourceBatches.some(batch => batch.has_imported_categories),
        batches: unknownSourceBatches,
        latestBatch: unknownSourceBatches[0],
        manualDraftRecord: null,
      })
    }
    return savedSourceRows.sort((a, b) => {
      const priority = row => row.kind === 'manual' ? 0 : 1
      const priorityDiff = priority(a) - priority(b)
      if (priorityDiff !== 0) return priorityDiff
      return String(b.latestBatch?.imported_at || '').localeCompare(String(a.latestBatch?.imported_at || ''))
    })
  }, [profiles, batches, manualDraftRecord])

  const columnAnalysis = useMemo(() => analyzeImportColumns(preview, skipRows), [preview, skipRows])

  const selectedDateAnalysis = colDate ? columnAnalysis.dateAnalysisByHeader[colDate] : null
  const selectedAmountAnalysis = colAmount ? columnAnalysis.amountAnalysisByHeader[colAmount] : null
  const sourceCategoryValues = useMemo(() => {
    if (!colCategory || !preview?.column_distinct_values) return []
    return (preview.column_distinct_values[colCategory] || []).filter(Boolean)
  }, [colCategory, preview])
  const sourceCategoryMeta = useMemo(() => {
    if (!colCategory || !preview?.column_distinct_meta) return null
    return preview.column_distinct_meta[colCategory] || null
  }, [colCategory, preview])
  const seededImportCategoryDraft = useMemo(
    () => (colCategory && sourceCategoryValues.length > 0
      ? createCategoryImportDraftState(sourceCategoryValues, categories)
      : null),
    [colCategory, sourceCategoryValues, categories],
  )
  const currentImportCategorySummary = useMemo(
    () => summarizeCategoryWorkspaceDraft(importCategoryDraft || seededImportCategoryDraft),
    [importCategoryDraft, seededImportCategoryDraft],
  )
  const activeDraftCategoryCount = importCategoryDraft?.snapshot?.sourceOrder?.length
  const processedCategoryCount = importCategoryDraft
    ? Math.max(0, currentImportCategorySummary.totalCount - (activeDraftCategoryCount || 0))
    : 0
  const remainingCategoryCount = currentImportCategorySummary.remainingCount
  const hasCurrentImportCategoryWorkspace = colCategory && currentImportCategorySummary.totalCount > 0
  const currentImportCategoryActionLabel = getCategoryWorkspaceActionLabel(remainingCategoryCount)

  const dateSelectHint = selectedDateAnalysis
    ? selectedDateAnalysis.guessedFormat
      ? `Detected ${DATE_FORMATS.find(option => option.value === selectedDateAnalysis.guessedFormat)?.label.split('  ')[0] || selectedDateAnalysis.guessedFormat}.`
      : selectedDateAnalysis.sampleCount
        ? 'Sample values in this column do not strongly look like dates.'
        : ''
    : columnAnalysis.dateCandidates.length > 0
      ? formatLikelyMatchLabel(columnAnalysis.dateCandidates.length)
      : ''

  const amountSelectHint = amtConv === 'two_column'
    ? null
    : selectedAmountAnalysis
      ? selectedAmountAnalysis.amountMatches > 0
        ? (selectedAmountAnalysis.guessedLabel || `${selectedAmountAnalysis.amountMatches}/${selectedAmountAnalysis.sampleCount || 0} sample value${selectedAmountAnalysis.amountMatches === 1 ? '' : 's'} look like amounts.`)
        : selectedAmountAnalysis.sampleCount
          ? 'Sample values in this column do not strongly look like amounts.'
          : ''
      : columnAnalysis.amountCandidates.length > 0
        ? formatLikelyMatchLabel(columnAnalysis.amountCandidates.length)
        : ''

  const categorySelectHint = columnAnalysis.categoryCandidates.length > 0 && !colCategory
    ? formatLikelyMatchLabel(columnAnalysis.categoryCandidates.length)
    : ''
  const accountSelectHint = columnAnalysis.accountCandidates.length > 0 && !colAccount && !accountId && !singleAccountNew.enabled
    ? formatLikelyMatchLabel(columnAnalysis.accountCandidates.length)
    : ''
  function clearMappingSuggestion(field) {
    setMappingSuggestions(prev => prev[field] ? { ...prev, [field]: '' } : prev)
  }

  function handleDateColumnChange(nextValue) {
    setDateFormatLocked(false)
    if (nextValue) clearMappingSuggestion('date')
    setColDate(nextValue)
  }

  function handleCategoryColumnChange(nextValue) {
    setShowCategoryWorkspace(false)
    setShowCategoryImportHelp(false)
    setImportCategoryDraft(null)
    if (nextValue) clearMappingSuggestion('category')
    setColCategory(nextValue)
  }

  function openCurrentImportCategoryWorkspace() {
    const nextDraft = sanitizeWorkspaceDraftForOpen(
      importCategoryDraft || seededImportCategoryDraft || createCategoryImportDraftState(sourceCategoryValues, categories),
    )
    setImportCategoryDraft(nextDraft)
    setShowCategoryWorkspace(true)
  }
  useEffect(() => {
    setAccountMap(prev => {
      const next = { ...prev }
      for (const val of distinctAccountValues) {
        if (!(val in next)) {
          const match = accounts.find(a => a.name.toLowerCase() === val.toLowerCase())
          next[val] = {
            accountId: match ? match.id : '',
            createNew: false,
            newName: val,
            newType: 'depository',
            skip: false,
          }
        }
      }
      for (const [csvVal, entry] of Object.entries(next)) {
        const stillExists = entry.accountId
          ? accounts.find(a => a.id === entry.accountId)
          : null
        if (entry.accountId && !stillExists) {
          const byName = accounts.find(a => a.name.toLowerCase() === csvVal.toLowerCase())
          next[csvVal] = byName
            ? {
              ...entry,
              accountId: byName.id,
              createNew: false,
              newName: byName.name,
              newType: byName.type || entry.newType || 'depository',
              skip: false,
            }
            : {
              accountId: '',
              createNew: false,
              newName: csvVal,
              newType: entry.newType || 'depository',
              skip: false,
            }
        }
        if (entry.createNew && entry.newName && !accounts.some(a => a.name.toLowerCase() === entry.newName.trim().toLowerCase()) && entry.newName !== csvVal) {
          next[csvVal] = {
            accountId: '',
            createNew: false,
            newName: csvVal,
            newType: entry.newType || 'depository',
            skip: false,
          }
        }
      }
      return next
    })
  }, [distinctAccountValues, accounts])

  const hasImportWorkToSave = !!(
    colDate || colAmount || colDebit || colCredit || colDir || colDesc || colCategory || colNotes || colPending ||
    colAccount || accountId || singleAccountNew.enabled || Object.keys(accountMap).length > 0 ||
    Object.keys(categoryAssignments).length > 0 || skipRows > 0 || dateFormat !== '%m/%d/%Y' ||
    amtConv !== 'single_signed' || !applyCat
  )

  useEffect(() => {
    if (!preview || !hasImportWorkToSave || selectedProfile) return
    const savedRecord = saveImportDraft(preview, buildImportSnapshot(), dbInstanceId, preferenceSubjectId)
    setManualDraftRecord(savedRecord || loadSavedImportDraftRecord(dbInstanceId, preferenceSubjectId))
  }, [
    dbInstanceId, preferenceSubjectId,
    preview, hasImportWorkToSave, selectedProfile, accountId, dateFormat, amtConv, skipRows, applyCat,
    colDate, colAmount, colDebit, colCredit, colDir, colDesc, colCategory, colNotes, colPending, colAccount,
    singleAccountNew, accountMap, categoryAssignments, importCategoryDraft,
  ])

  useEffect(() => {
    if (!colDate || dateFormatLocked) return
    const guessedFormat = columnAnalysis.dateAnalysisByHeader[colDate]?.guessedFormat
    if (guessedFormat && guessedFormat !== dateFormat) {
      setDateFormat(guessedFormat)
    }
  }, [colDate, columnAnalysis.dateAnalysisByHeader, dateFormat, dateFormatLocked])

  function computePreviewRows() {
    if (!preview?.rows) return []
    return preview.rows.slice(skipRows).map((row, i) => {
      let amount = null
      let rawAmountStr = null
      try {
        if (amtConv === 'two_column' && colDebit && colCredit) {
          const dRaw = String(row[colDebit] ?? '').replace(/[,$\s]/g, '').replace(/[()]/g, '-')
          const cRaw = String(row[colCredit] ?? '').replace(/[,$\s]/g, '').replace(/[()]/g, '-')
          const d = parseFloat(dRaw), c = parseFloat(cRaw)
          if (!isNaN(d) && d !== 0) amount = d
          else if (!isNaN(c) && c !== 0) amount = -c
        } else if (colAmount) {
          const cell = row[colAmount]
          rawAmountStr = String(cell ?? '')
          // Accept the statement formats we actually see from banks so preview totals
          // and validation stay stable before import.
          const cleaned = rawAmountStr
            .replace(/[$,\s]/g, '')
            .replace(/\(([0-9.]+)\)/, '-$1')
            .replace(/\s*CR$/i, '')
          const val = parseFloat(cleaned)
          if (!isNaN(val)) amount = -val
        }
      } catch (_) { }
      return {
        i,
        rawDate: colDate ? String(row[colDate] ?? '').trim() : null,
        rawDesc: colDesc ? String(row[colDesc] ?? '').trim() : null,
        rawCat: colCategory ? String(row[colCategory] ?? '').trim() : null,
        rawAcct: colAccount ? String(row[colAccount] ?? '').trim() : null,
        rawAmountStr,
        amount,
      }
    })
  }
  const previewRows = computePreviewRows()
  const detectedHeaderOffset = preview?.header_row_index ?? 0
  const displayedSkipRows = skipRows + detectedHeaderOffset
  const showTrailingDataWarning = !!importResult?.trailing_non_transaction_suspected
  const showInvalidDataWarning = !!importResult?.invalid_rows_suspected
  const rawViewerLines = showTrailingDataWarning
    ? (preview?.raw_tail_lines?.length ? preview.raw_tail_lines : preview?.raw_lines)
    : showInvalidDataWarning
      ? (importResult?.invalid_row_context_lines?.length ? importResult.invalid_row_context_lines : preview?.raw_lines)
      : preview?.raw_lines
  const rawViewerOffset = showTrailingDataWarning && preview?.raw_tail_lines?.length
    ? (preview.raw_tail_start_line ?? 0)
    : showInvalidDataWarning
      ? (importResult?.invalid_row_context_start_line ?? 0)
      : 0
  const rawViewerTitle = showTrailingDataWarning
    ? 'File tail'
    : showInvalidDataWarning
      ? 'Invalid rows'
      : 'Raw file'
  const rawViewerNote = showTrailingDataWarning
    ? (importResult?.trailing_non_transaction_message || 'There appears to be non-transaction data at the end of the file. Please verify the file tail.')
    : showInvalidDataWarning
      ? (importResult?.invalid_rows_message || 'There appears to be invalid data in the file. Please verify the highlighted rows.')
      : null

  function buildImportSnapshot() {
    const cm = getColumnMap()
    const categoryWorkspaceDraft = clonePersistedCategoryWorkspaceDraft(importCategoryDraft)
    const accountImportState = buildAccountImportStateSnapshot(accountMap)
    if (!colAccount && singleAccountNew.enabled && singleAccountNew.name.trim()) {
      const snapshot = {
        column_map: { ...cm, single_account_new: { name: singleAccountNew.name.trim(), type: singleAccountNew.type || 'depository' } },
        account_id: null,
        single_account_new: { name: singleAccountNew.name.trim(), type: singleAccountNew.type || 'depository' },
        date_format: dateFormat,
        amount_convention: amtConv,
        skip_rows: skipRows,
        apply_categorization: applyCat,
        ...accountImportState,
      }
      if (categoryWorkspaceDraft) snapshot.category_workspace_draft = categoryWorkspaceDraft
      return snapshot
    }
    const snapshot = {
      column_map: cm,
      account_id: (!colAccount && accountId) ? accountId : null,
      date_format: dateFormat,
      amount_convention: amtConv,
      skip_rows: skipRows,
      apply_categorization: applyCat,
      ...accountImportState,
    }
    if (categoryWorkspaceDraft) snapshot.category_workspace_draft = categoryWorkspaceDraft
    return snapshot
  }

  function buildCurrentManualDraftRecord(previewLike = preview) {
    if (!previewLike) return null
    return buildDraftRecordFromPreview(previewLike, buildImportSnapshot())
  }

  function openManualDraftSaveEditor(defaultName = '') {
    setManualDraftSaveName(current => current || defaultName)
    setShowManualDraftSave(true)
  }

  async function maybePromptCompatibleUnknownImports(profileId) {
    if (!profileId) return
    try {
      const response = await api.getCompatibleImportBatches(profileId)
      const compatibleBatches = Array.isArray(response?.batches) ? response.batches : []
      if (compatibleBatches.length > 0) {
        setCompatibleBatchPrompt({
          profileId,
          profileName: response?.profile_name || profiles.find(profile => profile.id === profileId)?.name || 'Saved data source',
          batches: compatibleBatches,
        })
      }
    } catch {
      // Leave compatible imports untouched if the suggestion lookup fails.
    }
  }

  async function attachCompatibleUnknownImports() {
    const prompt = compatibleBatchPrompt
    if (!prompt?.profileId || !prompt?.batches?.length) {
      setCompatibleBatchPrompt(null)
      return
    }
    setAttachingCompatibleBatches(true)
    try {
      for (const batch of prompt.batches) {
        await api.setBatchProfile(batch.id, prompt.profileId)
      }
      setBatches(await api.listBatches())
      setCompatibleBatchPrompt(null)
    } catch (error) {
      setNoticeDialog({
        title: 'Could not attach compatible imports',
        description: error?.message || 'Please try again.',
      })
    } finally {
      setAttachingCompatibleBatches(false)
    }
  }

  function queueMappingBaselineCapture() {
    setPendingMappingBaselineCapture(true)
  }

  function applyInferredMappingSuggestions(inferredMapping) {
    const columnMap = inferredMapping?.columnMap || {}
    setMappingSuggestions({
      date: columnMap.date || '',
      amount: columnMap.amount || '',
      debit: columnMap.debit || '',
      credit: columnMap.credit || '',
      direction: columnMap.direction || '',
      description: columnMap.description || '',
      category: columnMap.category || '',
      notes: columnMap.notes || '',
      pending: columnMap.pending || '',
      account: columnMap.account || '',
    })
  }

  function buildProfileMappingSuggestions(previewLike, {
    skipRowsValue = 0,
    amountConvention = amtConv,
    currentValues = {},
  } = {}) {
    if (!previewLike?.headers?.length) return getBlankMappingSuggestions()
    const inferredMapping = inferUnambiguousImportMappingFromPreview(previewLike, skipRowsValue)
    const nextSuggestions = getBlankMappingSuggestions()

    const assignSuggestion = (field, currentValue) => {
      const inferredValue = inferredMapping?.columnMap?.[field] || ''
      if (!currentValue && inferredValue && previewLike.headers.includes(inferredValue)) {
        nextSuggestions[field] = inferredValue
      }
    }

    assignSuggestion('date', currentValues.date)
    assignSuggestion('description', currentValues.description)
    assignSuggestion('category', currentValues.category)
    assignSuggestion('notes', currentValues.notes)
    assignSuggestion('pending', currentValues.pending)
    assignSuggestion('account', currentValues.account)

    if (amountConvention === 'two_column') {
      assignSuggestion('debit', currentValues.debit)
      assignSuggestion('credit', currentValues.credit)
    } else if (amountConvention === 'single_unsigned') {
      assignSuggestion('amount', currentValues.amount)
      assignSuggestion('direction', currentValues.direction)
    } else {
      assignSuggestion('amount', currentValues.amount)
    }

    return nextSuggestions
  }

  function getCurrentManualSourceSnapshot(previewLike = preview) {
    const savedDraft = loadSavedImportDraft(previewLike, dbInstanceId, preferenceSubjectId)
    if (savedDraft) return savedDraft
    if (previewLike?.config_snapshot) {
      return {
        ...previewLike.config_snapshot,
        skip_accounts: [],
      }
    }
    return null
  }

  function hasMappingChanges() {
    if (!mappingBaselineSnapshot) return false
    return stableSerialize(buildImportSnapshot()) !== mappingBaselineSnapshot
  }

  function resetToManualImportMapping() {
    setSelectedProfile('')
    setShowCategoryWorkspace(false)
    setShowCategoryImportHelp(false)
    applySnapshot(getBlankImportSnapshot())
    setMappingSuggestions(getBlankMappingSuggestions())
    setDateFormatLocked(false)
  }

  function resetToSuggestedImportMapping(profileId = '', previewLike = preview) {
    const inferredMapping = inferUnambiguousImportMappingFromPreview(previewLike, 0)
    const inferredCharacteristics = inferImportFileCharacteristicsFromPreview(previewLike, 0)
    setSelectedProfile(profileId || '')
    setShowCategoryWorkspace(false)
    setShowCategoryImportHelp(false)
    setShowMappingSourceChooser(false)
    setAccountId('')
    setDateFormat(inferredCharacteristics.dateFormat || '%m/%d/%Y')
    setDateFormatLocked(false)
    setAmtConv(inferredCharacteristics.amountConvention || 'single_signed')
    setSkipRows(0)
    setApplyCat(true)
    setColDate(null)
    setColAmount(null)
    setColDebit(null)
    setColCredit(null)
    setColDir(null)
    setColDesc(null)
    setColCategory(null)
    setColNotes(null)
    setColPending(null)
    setColAccount(null)
    applyInferredMappingSuggestions(inferredMapping)
    setAccountMap({})
    setCategoryAssignments({})
    setCategoryMappingRows([])
    setCategoryMappingSummary(null)
    setImportCategoryDraft(null)
    setSingleAccountNew({ enabled: false, name: '', type: 'depository' })
  }

  function resetToInferredImportMapping(profileId, previewLike = preview) {
    resetToSuggestedImportMapping(profileId, previewLike)
  }

  function resetImportMappingState() {
    setSelectedProfile('')
    setShowMappingSourceChooser(false)
    setMappingBaselineSnapshot('')
    setPendingMappingBaselineCapture(false)
    setAccountId('')
    setDateFormat('%m/%d/%Y')
    setDateFormatLocked(false)
    setAmtConv('single_signed')
    setSkipRows(0)
    setApplyCat(true)
    setColDate(null)
    setColAmount(null)
    setColDebit(null)
    setColCredit(null)
    setColDir(null)
    setColDesc(null)
    setColCategory(null)
    setColNotes(null)
    setColPending(null)
    setColAccount(null)
    setMappingSuggestions(getBlankMappingSuggestions())
    setAccountMap({})
    setCategoryAssignments({})
    setCategoryMappingRows([])
    setCategoryMappingSummary(null)
    setImportCategoryDraft(null)
    setShowCategoryWorkspace(false)
    setShowCategoryImportHelp(false)
    setSingleAccountNew({ enabled: false, name: '', type: 'depository' })
  }

  function performApplyProfile(profileId, previewLike = preview) {
    const p = profiles.find(x => x.id === profileId)
    if (!p) {
      if (!profileId) resetToManualImportMapping()
      else setSelectedProfile(profileId)
      return !profileId
    }
    setSelectedProfile(profileId)
    setMappingSuggestions(getBlankMappingSuggestions())
    const cm = p.column_map || {}
    const existingSingleAccount = cm.single_account_new?.name
      ? accounts.find(a => a.name.toLowerCase() === cm.single_account_new.name.toLowerCase())
      : null
    const existingAssignedAccount = p.account_id
      ? accounts.find(a => a.id === p.account_id)
      : null
    setAccountId(existingSingleAccount ? existingSingleAccount.id : (existingAssignedAccount?.id || '')); setDateFormat(p.date_format || '%m/%d/%Y')
    setDateFormatLocked(true)
    setAmtConv(p.amount_convention || 'single_signed'); setSkipRows(p.skip_rows || 0)
    setApplyCat(!!p.apply_categorization)
    setColDate(cm.date || null); setColAmount(cm.amount || null); setColDebit(cm.debit || null)
    setColCredit(cm.credit || null); setColDir(cm.direction || null)
    setColDesc(cm.description || null); setColCategory(cm.category || null); setColNotes(cm.notes || null); setColPending(cm.pending || null)
    setMappingSuggestions(buildProfileMappingSuggestions(previewLike, {
      skipRowsValue: p.skip_rows || 0,
      amountConvention: p.amount_convention || 'single_signed',
      currentValues: {
        date: cm.date || '',
        amount: cm.amount || '',
        debit: cm.debit || '',
        credit: cm.credit || '',
        direction: cm.direction || '',
        description: cm.description || '',
        category: cm.category || '',
        notes: cm.notes || '',
        pending: cm.pending || '',
        account: cm.account || '',
      },
    }))
    setCategoryAssignments(cm.category_assignments || {})
    setImportCategoryDraft(clonePersistedCategoryWorkspaceDraft(cm.category_workspace_draft))
    setSingleAccountNew(cm.single_account_new && !existingSingleAccount
      ? { enabled: true, name: cm.single_account_new.name || '', type: cm.single_account_new.type || 'depository' }
      : { enabled: false, name: '', type: 'depository' })
    const newColAccount = cm.account || null
    setAccountMap({})
    setColAccount(newColAccount)

    // Validate each stored account ID against the live accounts list — the account
    // may have been deleted since the profile was last saved. Fall back to name-match,
    // then to createNew so the user is prompted rather than silently sending a dead ID.
    if (newColAccount && (cm.account_assignments || cm.account_skips || cm.account_new)) {
      const restored = {}
      for (const [csvVal, aid] of Object.entries(cm.account_assignments || {})) {
        const stillExists = accounts.find(a => a.id === aid)
        if (stillExists) {
          restored[csvVal] = { accountId: aid, createNew: false, newName: stillExists.name, newType: stillExists.type || 'depository', skip: false }
        } else {
          const byName = accounts.find(a => a.name.toLowerCase() === csvVal.toLowerCase())
          if (byName) {
            restored[csvVal] = { accountId: byName.id, createNew: false, newName: byName.name, newType: byName.type || 'depository', skip: false }
          } else {
            restored[csvVal] = { accountId: '', createNew: false, newName: csvVal, newType: 'depository', skip: false }
          }
        }
      }
      for (const csvVal of (cm.account_skips || [])) {
        restored[csvVal] = { accountId: '', createNew: false, newName: csvVal, newType: 'depository', skip: true }
      }
      for (const [csvVal, info] of Object.entries(cm.account_new || {})) {
        const existing = accounts.find(a => a.name.toLowerCase() === info.name.toLowerCase())
        if (existing) {
          restored[csvVal] = { accountId: existing.id, createNew: false, newName: info.name, newType: info.type, skip: false }
        } else {
          restored[csvVal] = { accountId: '', createNew: false, newName: csvVal, newType: info.type, skip: false }
        }
      }
      setAccountMap(restored)
    }
    return true
  }

  function applyProfile(profileId, options = {}) {
    const { bypassMismatchWarning = false, previewLike = preview, mismatchContext = 'mappingSwitch' } = options
    const p = profiles.find(x => x.id === profileId)
    if (!p) return performApplyProfile(profileId, previewLike)

    if (!bypassMismatchWarning && profileHeaderClearlyMismatches(p, previewLike)) {
      setShowProfileMismatchChooser(false)
      setPendingProfileMismatch({
        profileId,
        profileName: p.name,
        previewLike,
        context: mismatchContext,
      })
      return 'pending'
    }

    return performApplyProfile(profileId, previewLike)
  }

  function applySnapshot(snap) {
    if (!snap) return
    const cm = snap.column_map || {}
    const restoredCategoryDraft = clonePersistedCategoryWorkspaceDraft(snap.category_workspace_draft)
    const existingSingleAccount = snap.single_account_new?.name
      ? accounts.find(a => a.name.toLowerCase() === snap.single_account_new.name.toLowerCase())
      : null
    const existingAssignedAccount = snap.account_id
      ? accounts.find(a => a.id === snap.account_id)
      : null
    setDateFormat(snap.date_format || '%m/%d/%Y'); setDateFormatLocked(true); setAmtConv(snap.amount_convention || 'single_signed')
    setSkipRows(snap.skip_rows || 0); setApplyCat(snap.apply_categorization !== false)
    setColDate(cm.date || null); setColAmount(cm.amount || null); setColDebit(cm.debit || null)
    setColCredit(cm.credit || null); setColDir(cm.direction || null)
    setColDesc(cm.description || null); setColCategory(cm.category || null); setColNotes(cm.notes || null); setColPending(cm.pending || null); setColAccount(cm.account || null)
    setMappingSuggestions(buildProfileMappingSuggestions(preview, {
      skipRowsValue: snap.skip_rows || 0,
      amountConvention: snap.amount_convention || 'single_signed',
      currentValues: {
        date: cm.date || '',
        amount: cm.amount || '',
        debit: cm.debit || '',
        credit: cm.credit || '',
        direction: cm.direction || '',
        description: cm.description || '',
        category: cm.category || '',
        notes: cm.notes || '',
        pending: cm.pending || '',
        account: cm.account || '',
      },
    }))
    setCategoryAssignments((snap.category_assignments || cm.category_assignments || {}))
    setImportCategoryDraft(restoredCategoryDraft)
    setAccountId(existingSingleAccount ? existingSingleAccount.id : (existingAssignedAccount?.id || ''))
    setSingleAccountNew(snap.single_account_new && !existingSingleAccount
      ? { enabled: true, name: snap.single_account_new.name || '', type: snap.single_account_new.type || 'depository' }
      : { enabled: false, name: '', type: 'depository' })
    if (snap.account_map || snap.skip_accounts || snap.account_new) {
      const restored = {}
      const skips = new Set(snap.skip_accounts || [])
      for (const [val, aid] of Object.entries(snap.account_map || {})) {
        const stillExists = accounts.find(a => a.id === aid)
        if (stillExists) {
          restored[val] = { accountId: aid, createNew: false, newName: stillExists.name, newType: stillExists.type || 'depository', skip: false }
        } else {
          const byName = accounts.find(a => a.name.toLowerCase() === val.toLowerCase())
          if (byName) {
            restored[val] = { accountId: byName.id, createNew: false, newName: byName.name, newType: byName.type || 'depository', skip: false }
          } else {
            restored[val] = { accountId: '', createNew: false, newName: val, newType: 'depository', skip: false }
          }
        }
      }
      for (const val of skips) {
        restored[val] = { accountId: '', createNew: false, newName: val, newType: 'depository', skip: true }
      }
      for (const [val, info] of Object.entries(snap.account_new || {})) {
        const existing = accounts.find(a => a.name.toLowerCase() === String(info?.name || '').toLowerCase())
        if (existing) {
          restored[val] = { accountId: existing.id, createNew: false, newName: existing.name, newType: existing.type || info?.type || 'depository', skip: false }
        } else {
          restored[val] = { accountId: '', createNew: true, newName: info?.name || val, newType: info?.type || 'depository', skip: false }
        }
      }
      setAccountMap(restored)
    }
    return true
  }

  function switchMappingDataSource(nextSourceId) {
    if (!preview) return false
    const nextIsManual = !nextSourceId || nextSourceId === MANUAL_DATA_SOURCE_VALUE
    const currentIsManual = !selectedProfile
    const sourceChanged = nextIsManual ? !currentIsManual : selectedProfile !== nextSourceId
    if (!sourceChanged) {
      setShowMappingSourceChooser(false)
      return true
    }
    if (hasMappingChanges()) {
      setPendingMappingSourceSwitch({ nextSourceId })
      return false
    }

    if (nextIsManual) {
      selectUploadSource(MANUAL_DATA_SOURCE_VALUE, { persist: false })
      const manualSnapshot = getCurrentManualSourceSnapshot(preview)
      if (manualSnapshot) applySnapshot(manualSnapshot)
      else resetToManualImportMapping()
    } else {
      const applied = applyProfile(nextSourceId, { previewLike: preview, mismatchContext: 'mappingSwitch' })
      if (applied !== true) return false
      selectUploadSource(nextSourceId)
    }

    setShowMappingSourceChooser(false)
    queueMappingBaselineCapture()
    return true
  }

  function confirmMappingSourceSwitch() {
    const nextSourceId = pendingMappingSourceSwitch?.nextSourceId
    setPendingMappingSourceSwitch(null)
    if (nextSourceId === undefined || nextSourceId === null) return
    const nextIsManual = !nextSourceId || nextSourceId === MANUAL_DATA_SOURCE_VALUE

    if (nextIsManual) {
      selectUploadSource(MANUAL_DATA_SOURCE_VALUE, { persist: false })
      const manualSnapshot = getCurrentManualSourceSnapshot(preview)
      if (manualSnapshot) applySnapshot(manualSnapshot)
      else resetToManualImportMapping()
    } else {
      const applied = applyProfile(nextSourceId, { previewLike: preview, mismatchContext: 'mappingSwitch' })
      if (applied !== true) return
      selectUploadSource(nextSourceId)
    }

    setShowMappingSourceChooser(false)
    queueMappingBaselineCapture()
  }

  async function handleFile(file) {
    if (!file || !uploadChoiceReady) return
    setLoading(true)
    try {
      resetImportMappingState()
      const result = await api.previewCsv(file)
      setPreview({ ...result, file }); setAccountMap({})
      setSingleAccountNew({ enabled: false, name: '', type: 'depository' })
      setCategoryAssignments({})
      setCategoryMappingRows([])
      setCategoryMappingSummary(null)
      const savedDraft = loadSavedImportDraft(result, dbInstanceId, preferenceSubjectId)
      if (selectedUploadSource && selectedUploadSource !== MANUAL_DATA_SOURCE_VALUE) {
        const applied = applyProfile(selectedUploadSource, { previewLike: result, mismatchContext: 'upload' })
        if (applied === 'pending') {
          return
        }
        if (applied !== true) {
          setPreview(null)
          return
        }
      } else if (savedDraft) {
        setSelectedProfile('')
        setMappingSuggestions(getBlankMappingSuggestions())
        applySnapshot(savedDraft)
      } else if (result.config_snapshot) {
        setMappingSuggestions(getBlankMappingSuggestions())
        applySnapshot({
          ...result.config_snapshot,
          skip_accounts: [],
        })
      } else {
        const inferredMapping = inferUnambiguousImportMappingFromPreview(result, 0)
        const inferredCharacteristics = inferImportFileCharacteristicsFromPreview(result, 0)
        setDateFormat(inferredCharacteristics.dateFormat || '%m/%d/%Y')
        setAmtConv(inferredCharacteristics.amountConvention || 'single_signed')
        setColDate(null)
        setColAmount(null)
        setColDebit(null)
        setColCredit(null)
        setColDir(null)
        setColDesc(null)
        setColCategory(null)
        setColNotes(null)
        setColPending(null)
        setColAccount(null)
        applyInferredMappingSuggestions(inferredMapping)
      }
      // If header wasn't on the first line, open advanced + raw file so user can see why
      if ((result.header_row_index ?? 0) > 0) {
        setShowAdvanced(true)
        setShowRaw(true)
      }
      queueMappingBaselineCapture()
      setStage('mapping')
    } catch (e) {
      const msg = e?.message || e?.detail || 'Unable to parse CSV file.'
      setNoticeDialog({
        title: 'Failed to parse CSV',
        description: msg,
      })
    } finally { setLoading(false) }
  }

  function handleProfileMismatchConfirm() {
    if (!pendingProfileMismatch?.profileId) return
    const { profileId, previewLike, context } = pendingProfileMismatch
    setPendingProfileMismatch(null)
    setShowProfileMismatchChooser(false)
    resetToInferredImportMapping(profileId, previewLike)

    if (context === 'upload') {
      setStage('mapping')
      queueMappingBaselineCapture()
    } else if (context === 'mappingSwitch') {
      selectUploadSource(profileId)
      setShowMappingSourceChooser(false)
      queueMappingBaselineCapture()
    }
  }

  function handleProfileMismatchCancel() {
    const context = pendingProfileMismatch?.context
    setPendingProfileMismatch(null)
    setShowProfileMismatchChooser(false)
    if (context === 'upload') {
      setPreview(null)
    }
  }

  function handleProfileMismatchChangeDataSource() {
    setShowProfileMismatchChooser(true)
  }

  function handleProfileMismatchChooserBack() {
    setShowProfileMismatchChooser(false)
  }

  function handleProfileMismatchSelectSource(nextSourceId) {
    const pending = pendingProfileMismatch
    if (!pending) return
    const { previewLike, context } = pending

    if (!nextSourceId || nextSourceId === MANUAL_DATA_SOURCE_VALUE) {
      setPendingProfileMismatch(null)
      setShowProfileMismatchChooser(false)
      selectUploadSource(MANUAL_DATA_SOURCE_VALUE, { persist: false })
      resetToSuggestedImportMapping('', previewLike)
      if (context === 'upload') {
        setStage('mapping')
      } else {
        setShowMappingSourceChooser(false)
      }
      queueMappingBaselineCapture()
      return
    }

    const applied = applyProfile(nextSourceId, { previewLike, mismatchContext: context })
    if (applied !== true) return

    setPendingProfileMismatch(null)
    setShowProfileMismatchChooser(false)
    selectUploadSource(nextSourceId)

    if (context === 'upload') {
      setStage('mapping')
    } else {
      setShowMappingSourceChooser(false)
    }
    queueMappingBaselineCapture()
  }

  useEffect(() => {
    if (!pendingMappingBaselineCapture || stage !== 'mapping' || !preview) return
    setMappingBaselineSnapshot(stableSerialize(buildImportSnapshot()))
    setPendingMappingBaselineCapture(false)
  }, [
    pendingMappingBaselineCapture, stage, preview,
    selectedProfile, accountId, dateFormat, amtConv, skipRows, applyCat,
    colDate, colAmount, colDebit, colCredit, colDir, colDesc, colCategory, colNotes, colPending, colAccount,
    singleAccountNew, accountMap, categoryAssignments, importCategoryDraft,
  ])

  function handleDrop(e) {
    e.preventDefault()
    if (!uploadChoiceReady) return
    handleFile(e.dataTransfer.files[0])
  }

  function getColumnMap() {
    return {
      date: colDate, amount: colAmount, debit: colDebit, credit: colCredit,
      direction: colDir, description: colDesc, category: colCategory, notes: colNotes, pending: colPending, account: colAccount
    }
  }

  function getMappingDisabledReason() {
    const missingRequiredColumns = []
    if (!colDate) missingRequiredColumns.push('date')
    if (!colDesc) missingRequiredColumns.push('merchant')
    if (amtConv === 'two_column') {
      if (!colDebit) missingRequiredColumns.push('debit')
      if (!colCredit) missingRequiredColumns.push('credit')
    } else if (!colAmount) {
      missingRequiredColumns.push('amount')
    }

    const issues = []
    if (missingRequiredColumns.length === 1) {
      issues.push(`Map the ${missingRequiredColumns[0]} column.`)
    } else if (missingRequiredColumns.length > 1) {
      issues.push('Map required columns.')
    }

    if (colAccount) {
      let unresolvedCount = 0
      let singleMessage = ''
      for (const value of remainingAccountValues) {
        const mapping = accountMap[value]
        if (!mapping) {
          unresolvedCount += 1
          singleMessage = `Choose an account for "${value}".`
          continue
        }
        if (mapping.skip) continue
        if (mapping.createNew) {
          const name = mapping.newName.trim()
          if (!name) {
            unresolvedCount += 1
            singleMessage = `Enter a new account name for "${value}".`
            continue
          }
          if (accounts.some(a => a.name.toLowerCase() === name.toLowerCase())) {
            unresolvedCount += 1
            singleMessage = `Select the existing account "${name}" instead of creating a duplicate.`
          }
          continue
        }
        if (!mapping.accountId) {
          unresolvedCount += 1
          singleMessage = `Choose an account for "${value}".`
        }
      }
      if (unresolvedCount === 1) issues.push(singleMessage)
      else if (unresolvedCount > 1) issues.push('Resolve unmapped accounts.')
    }

    if (preview?.previous_batch && !colAccount) {
      issues.push('This file has already been imported. Undo the earlier import first.')
    }
    if (preview?.previous_batch && colAccount && remainingAccountValues.length === 0) {
      issues.push('All accounts in this file were already imported.')
    }

    if (singleAccountNew.enabled) {
      const name = singleAccountNew.name.trim()
      if (!name) issues.push('Enter a name for the new account.')
      if (accounts.some(a => a.name.toLowerCase() === name.toLowerCase())) {
        issues.push(`Select the existing account "${name}" instead of creating a duplicate.`)
      }
    }

    if (!colAccount && !singleAccountNew.enabled && !accountId) {
      issues.push('Choose the account to import into.')
    }

    return issues.join(' ')
  }

  function canCreateDataSourceFromCurrentMapping() {
    return !!preview && !selectedProfile && !getMappingDisabledReason()
  }

  function getCreateDataSourceDisabledReason() {
    return getMappingDisabledReason()
  }

  function canImport() {
    if (getMappingDisabledReason()) return false

    if (importableRowCount <= 0 && !(preview?.previous_batch && colAccount && remainingAccountValues.length === 0) && !(preview?.previous_batch && !colAccount)) {
      return false
    }

    if (preview?.previous_batch && !colAccount) return false
    if (preview?.previous_batch && colAccount && remainingAccountValues.length === 0) return false
    return true
  }

  function getImportDisabledReason() {
    const issues = []
    const mappingReason = getMappingDisabledReason()
    if (mappingReason) issues.push(mappingReason)

    if (preview?.previous_batch && !colAccount) {
      issues.push('This file has already been imported. Undo the earlier import first.')
    }
    if (preview?.previous_batch && colAccount && remainingAccountValues.length === 0) {
      issues.push('All accounts in this file were already imported.')
    }

    if (importableRowCount <= 0 && !(preview?.previous_batch && colAccount && remainingAccountValues.length === 0) && !(preview?.previous_batch && !colAccount)) {
      issues.push('No rows remain to import.')
    }

    return issues.join(' ')
  }

  async function runImport() {
    if (!canImport()) return
    setLoading(true)
    try {
      let finalAccountMap = null, newAccounts = null, skipAccounts = null
      if (colAccount) {
        finalAccountMap = {}; newAccounts = []; skipAccounts = []
        // Only process CSV values that actually appear in this file — the accountMap
        // may contain stale entries from previous imports that used the same profile
        const relevantValues = new Set(distinctAccountValues)
        for (const [v, m] of Object.entries(accountMap)) {
          if (!relevantValues.has(v)) continue
          if (m.skip) skipAccounts.push(v)
          else if (m.createNew) newAccounts.push({ csv_value: v, name: m.newName, type: m.newType })
          else if (m.accountId) finalAccountMap[v] = m.accountId
        }
      } else if (singleAccountNew.enabled) {
        newAccounts = [{ csv_value: '__single_account__', name: singleAccountNew.name.trim(), type: singleAccountNew.type || 'depository' }]
      }
      // Snapshot before the import so we can tell post-import whether a prior
      // profileless batch will be displaced into the unknown-source row.
      const hadPriorManualBatch = !selectedProfile && batches.some(b => !b.profile_id && !b.unknown_source_fallback)
      const columnMap = getColumnMap()
      const result = await api.runImport(preview.file, {
        profile_id: selectedProfile || null,
        filename: preview.filename,
        account_id: colAccount || singleAccountNew.enabled ? null : accountId,
        single_account_new: (!colAccount && singleAccountNew.enabled)
          ? { name: singleAccountNew.name.trim(), type: singleAccountNew.type || 'depository' }
          : null,
        account_map: finalAccountMap,
        skip_accounts: skipAccounts,
        new_accounts: newAccounts?.length ? newAccounts : null,
        date_format: dateFormat,
        amount_convention: amtConv,
        column_map: columnMap,
        skip_rows: skipRows,
        apply_categorization: applyCat,
      })
      setImportResult(result)
      if (result.trailing_non_transaction_suspected || result.invalid_rows_suspected) setShowRaw(true)
      refreshTaskBadge()
      const refreshedAccounts = await api.getAccounts()
      setAccounts(refreshedAccounts)
      let nextImportCategoryDraft = importCategoryDraft
      if (!nextImportCategoryDraft && colCategory && sourceCategoryValues.length > 0) {
        nextImportCategoryDraft = createCategoryImportDraftState(sourceCategoryValues, categories)
        setImportCategoryDraft(nextImportCategoryDraft)
      }
      // For profileless imports, persist the category workspace draft into the
      // batch record so it survives beyond the current session and appears on
      // the history row immediately. If the user never opened the workspace
      // before importing, importCategoryDraft is null — eagerly create it from
      // the source values so the button appears on the batch card right away.
      if (!selectedProfile && result.batch_id) {
        const categoryWorkspaceDraft = clonePersistedCategoryWorkspaceDraft(nextImportCategoryDraft)
        if (categoryWorkspaceDraft) {
          api.saveBatchCategoryWorkspaceDraft(result.batch_id, categoryWorkspaceDraft).catch(() => { })
        }
      }
      // Force the target row open so the completed file card is visible immediately,
      // even if this source was collapsed in the user's saved history view.
      // For temporary draft imports, also expand unknown-source if a prior batch
      // is being displaced into it by the new import becoming the active draft.
      const rowKeyToExpand = selectedProfile ? `profile:${selectedProfile}` : 'manual-draft'
      setExpandedSourceRows(prev => {
        const next = { ...(prev && typeof prev === 'object' ? prev : {}), [rowKeyToExpand]: true }
        if (hadPriorManualBatch) next['unknown-source'] = true
        return next
      })
      api.listBatches().then(setBatches)
      if (selectedProfile) {
        await autoSaveProfile(refreshedAccounts, nextImportCategoryDraft).catch(() => { })
      }
      setStage(result.trailing_non_transaction_suspected ? 'review-data' : 'done')
    } catch (e) {
      setNoticeDialog({
        title: 'Import failed',
        description: e.message,
      })
    }
    finally { setLoading(false) }
  }

  async function createUploadDataSource() {
    const nextName = uploadSourceDraftName.trim()
    if (!nextName || creatingUploadSource) return
    setCreatingUploadSource(true)
    try {
      const response = await api.createImportProfile(buildEmptyDataSourceBody(nextName))
      const updatedProfiles = await api.getImportProfiles()
      setProfiles(updatedProfiles)
      selectUploadSource(response?.id || '')
      setShowUploadSourceCreate(false)
      setUploadSourceDraftName('')
    } catch (err) {
      setNoticeDialog({
        title: 'Could not create the data source',
        description: err?.message || 'Please try again.',
      })
    } finally {
      setCreatingUploadSource(false)
    }
  }

  async function saveManualDraftAsDataSource(options = {}) {
    const {
      draftRecord = manualDraftRecord,
      activateAfterSave = false,
    } = options
    const nextName = manualDraftSaveName.trim()
    const body = buildProfileBodyFromSnapshot(nextName, draftRecord)
    if (!body || !nextName || savingManualDraftSource) return
    setSavingManualDraftSource(true)
    try {
      const response = await api.createImportProfile(body)
      const newProfileId = response?.id
      const currentTemporaryDraftBatch = batches
        .filter(batch => !batch.profile_id && !batch.unknown_source_fallback)
        .sort((a, b) => String(b.imported_at || '').localeCompare(String(a.imported_at || '')))[0] || null
      if (newProfileId && currentTemporaryDraftBatch) {
        await api.setBatchProfile(currentTemporaryDraftBatch.id, newProfileId).catch(() => { })
      }
      const updatedProfiles = await api.getImportProfiles()
      setProfiles(updatedProfiles)
      clearSavedImportDraft(dbInstanceId, preferenceSubjectId)
      setManualDraftRecord(loadSavedImportDraftRecord(dbInstanceId, preferenceSubjectId))
      setShowManualDraftSave(false)
      setManualDraftSaveName('')
      if (newProfileId) {
        const shouldAdoptCurrentPreview = !selectedProfile && doesDraftMatchPreview(draftRecord, preview)
        selectUploadSource(newProfileId)
        if (shouldAdoptCurrentPreview) {
          setSelectedProfile(newProfileId)
        }
        setExpandedSourceRows(prev => ({
          ...(prev && typeof prev === 'object' ? prev : {}),
          [`profile:${newProfileId}`]: true,
        }))
        if (activateAfterSave || shouldAdoptCurrentPreview) {
          queueMappingBaselineCapture()
        }
      }
      setBatches(await api.listBatches())
      if (newProfileId) {
        await maybePromptCompatibleUnknownImports(newProfileId)
      }
    } catch (error) {
      setNoticeDialog({
        title: 'Could not save the temporary draft as a data source',
        description: error?.message || 'Please try again.',
      })
    } finally {
      setSavingManualDraftSource(false)
    }
  }

  async function saveSourceDescription(profileId) {
    const nextValue = sourceDescriptionDraft.trim()
    setProfiles(prev => prev.map(item => (
      item.id === profileId
        ? { ...item, filename_pattern: nextValue || null }
        : item
    )))
    setEditingSourceDescriptionId('')
    setSourceDescriptionDraft('')
    try {
      await api.updateImportProfile(profileId, { filename_pattern: nextValue || null })
    } catch (error) {
      api.getImportProfiles().then(setProfiles)
      setNoticeDialog({
        title: 'Could not save the data source description',
        description: error?.message || 'Please try again.',
      })
    }
  }

  async function saveSourceName(profileId) {
    const profile = profiles.find(item => item.id === profileId)
    const nextValue = sourceNameDraft.trim()
    setEditingSourceNameKey('')
    setSourceNameDraft('')
    if (!profile || !nextValue || nextValue === profile.name) return
    setProfiles(prev => prev.map(item => (
      item.id === profileId
        ? { ...item, name: nextValue }
        : item
    )))
    try {
      await api.updateImportProfile(profileId, { name: nextValue })
    } catch (error) {
      api.getImportProfiles().then(setProfiles)
      setNoticeDialog({
        title: 'Could not rename the data source',
        description: error?.message || 'Please try again.',
      })
    }
  }

  // Silently update the active profile after a successful import so account
  // mappings (including new accounts and skips) are never lost
  async function autoSaveProfile(refreshedAccounts, draftOverride = null) {
    if (!selectedProfile) return
    const p = profiles.find(x => x.id === selectedProfile)
    if (!p) return
    // Newly created accounts do not have ids in the pre-import draft, so reconcile
    // them by name before saving the refreshed profile mappings.
    const resolvedMap = {}
    for (const [csvVal, m] of Object.entries(accountMap)) {
      if (m.createNew && m.newName?.trim()) {
        const created = refreshedAccounts.find(a => a.name === m.newName.trim())
        resolvedMap[csvVal] = created
          ? { ...m, createNew: false, accountId: created.id }
          : m
      } else {
        resolvedMap[csvVal] = m
      }
    }
    const savedMap = accountMap
    const existingProfileMap = { ...(p.column_map || {}) }
    const cm = { ...existingProfileMap, ...getColumnMap() }
    const categoryWorkspaceDraft = clonePersistedCategoryWorkspaceDraft(draftOverride || importCategoryDraft)
    if (categoryWorkspaceDraft) cm.category_workspace_draft = categoryWorkspaceDraft
    else delete cm.category_workspace_draft
    if (!colAccount && singleAccountNew.enabled && singleAccountNew.name.trim()) {
      cm.single_account_new = {
        name: singleAccountNew.name.trim(),
        type: singleAccountNew.type || 'depository',
      }
    } else {
      delete cm.single_account_new
    }
    const assignments = {}, skips = [], newAccts = {}
    for (const [csvVal, m] of Object.entries(resolvedMap)) {
      if (m.skip) {
        skips.push(csvVal)
      } else if (m.createNew && m.newName?.trim()) {
        newAccts[csvVal] = { name: m.newName.trim(), type: m.newType || 'depository' }
      } else if (m.accountId) {
        assignments[csvVal] = m.accountId
      }
    }
    const currentFileValues = new Set(distinctAccountValues)
    const mergedAssignments = { ...(existingProfileMap.account_assignments || {}) }
    const mergedNewAccounts = { ...(existingProfileMap.account_new || {}) }
    const mergedSkipSet = new Set(existingProfileMap.account_skips || [])

    for (const csvVal of currentFileValues) {
      delete mergedAssignments[csvVal]
      delete mergedNewAccounts[csvVal]
      mergedSkipSet.delete(csvVal)
    }
    for (const [csvVal, accountId] of Object.entries(assignments)) {
      mergedAssignments[csvVal] = accountId
    }
    for (const [csvVal, info] of Object.entries(newAccts)) {
      mergedNewAccounts[csvVal] = info
    }
    for (const csvVal of skips) {
      mergedSkipSet.add(csvVal)
    }

    if (Object.keys(mergedAssignments).length > 0) cm.account_assignments = mergedAssignments
    else delete cm.account_assignments
    if (mergedSkipSet.size > 0) cm.account_skips = Array.from(mergedSkipSet).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
    else delete cm.account_skips
    if (Object.keys(mergedNewAccounts).length > 0) cm.account_new = mergedNewAccounts
    else delete cm.account_new

    const body = {
      name: p.name,
      filename_pattern: inferFilenamePattern(preview.filename) || null,
      header_fingerprint: preview.header_fingerprint || null,
      template_filename: preview.filename || null,
      template_file_hash: preview.file_content_hash || null,
      column_map: cm,
      account_id: (!colAccount && !singleAccountNew.enabled && accountId) ? accountId : null,
      date_format: dateFormat,
      amount_convention: amtConv,
      skip_rows: skipRows,
      apply_categorization: applyCat,
    }
    await api.updateImportProfile(selectedProfile, body)
    clearSavedImportDraft(dbInstanceId, preferenceSubjectId)
    setManualDraftRecord(loadSavedImportDraftRecord(dbInstanceId, preferenceSubjectId))
    // Await the profiles refresh so state is up to date before the user
    // can cancel and re-upload — prevents stale profile being applied
    const updated = await api.getImportProfiles()
    setProfiles(updated)
  }

  function resetImport() {
    setStage('upload'); setPreview(null); setImportResult(null)
    setAccountMap({})
    setRejectedRowsViewer(null)
    setDuplicateRowsViewer(null)
    setDuplicateImporting(false)
    setColPending(null)
    setSingleAccountNew({ enabled: false, name: '', type: 'depository' })
    setCategoryAssignments({}); setCategoryMappingRows([]); setCategoryMappingSummary(null)
    setShowCategoryWorkspace(false)
    setShowCategoryImportHelp(false)
    setImportCategoryDraft(null)
    setShowRaw(false); setShowAdvanced(false)
    resetImportMappingState()
  }

  function returnToUploadSourceChooser() {
    resetImport()
    setSelectedUploadSource('')
    setShowUploadSourceCreate(false)
    setUploadSourceDraftName('')
  }

  async function handleUndoClick(batch) {
    setUndoTarget(batch); setUndoLoading(true)
    setUndoEdited(await api.getBatchEdited(batch.id)); setUndoLoading(false)
  }

  async function performBatchUndo(batch, force = false) {
    if (!batch?.id) return
    await api.undoBatch(batch.id, force)

    // If the undone batch is the one currently shown in the Import complete box,
    // clear it so the card disappears immediately without waiting for a refresh.
    if (importResult?.batch_id === batch.id) {
      setImportResult(null)
      setStage('upload')
    }

    const remainingBatches = batches.filter(b => b.id !== batch.id)

    if (!batch.profile_id) {
      // Profileless batch: if this was the only remaining profileless import,
      // clear the manual draft (localStorage) so "Save as data source" and the
      // header-level "Import categories" button disappear.
      const remainingManual = remainingBatches.filter(b => !b.profile_id)
      if (remainingManual.length === 0) {
        clearSavedImportDraft(dbInstanceId, preferenceSubjectId)
        setManualDraftRecord(null)
      }
    } else {
      // Profile-linked batch: if this was the last batch for the profile,
      // clear the category workspace draft from the profile so the
      // "Import categories" button on the profile header disappears.
      const remainingForProfile = remainingBatches.filter(b => b.profile_id === batch.profile_id)
      if (remainingForProfile.length === 0) {
        const profile = profiles.find(p => p.id === batch.profile_id)
        if (profile) {
          const nextColumnMap = { ...(profile.column_map || {}) }
          delete nextColumnMap.category_workspace_draft
          delete nextColumnMap.rule_suggestion_review
          api.updateImportProfile(batch.profile_id, { column_map: nextColumnMap })
            .then(() => api.getImportProfiles().then(setProfiles))
            .catch(() => { })
        }
      }
    }

    api.listBatches().then(setBatches)
    refreshTaskBadge()
  }

  async function confirmUndo(force) {
    const batch = undoTarget
    setUndoTarget(null); setUndoEdited([]);
    await performBatchUndo(batch, force)
  }

  function openRuleSuggestionReview({ batchId = '', profileId = '' } = {}) {
    if (profileId) {
      navigate(`/import-export/profiles/${profileId}/rule-suggestions`)
      return
    }
    if (batchId) navigate(`/import-export/batches/${batchId}/rule-suggestions`)
  }

  function getRuleSuggestionProgressLabel(batch) {
    const review = batch?.rule_suggestion_review
    if (!review?.generated_at) return ''
    if (!review.total_count) return 'No suggestions found'
    return `${review.reviewed_count || 0}/${review.total_count} reviewed`
  }

  function getRuleSuggestionActionLabel(review) {
    return review?.generated_at ? 'Review rules' : 'Generate rules'
  }

  function canApplyCategoryMappings() {
    return categoryMappingRows.some(row => !!row.categoryId)
  }

  function getCategoryWorkspaceSnapshot(draft) {
    return draft?.snapshot || draft
  }

  function advancePastDataReview() {
    setShowRaw(false)
    setStage('done')
  }

  async function cancelTrailingDataReview() {
    const batchId = importResult?.batch_id
    if (!batchId) {
      setShowRaw(false)
      resetImport()
      return
    }
    const batch = batches.find(candidate => candidate.id === batchId)
      || { id: batchId, profile_id: selectedProfile || null }
    setLoading(true)
    try {
      await performBatchUndo(batch, false)
      setShowRaw(false)
      resetImport()
    } catch (error) {
      setNoticeDialog({
        title: 'Could not cancel that import',
        description: error?.message || 'Please try again.',
      })
    } finally {
      setLoading(false)
    }
  }

  async function applyImportedCategoryMappings() {
    if (!importResult?.batch_id || !canApplyCategoryMappings()) return
    setLoading(true)
    try {
      const assignments = {}
      for (const row of categoryMappingRows) {
        if (row.categoryId) assignments[row.rawValue] = row.categoryId
      }
      const result = await api.applyBatchCategoryMappings(importResult.batch_id, assignments)
      setCategoryAssignments(prev => ({ ...prev, ...assignments }))
      setCategoryMappingSummary(result)
      setCategories(await api.getCategories())
      if (selectedProfile) api.getImportProfiles().then(setProfiles)
      setImportResult(prev => ({ ...prev, category_mapping_result: result }))
      setStage('done')
    } catch (e) {
      setNoticeDialog({
        title: 'Failed to apply imported category mappings',
        description: e.message,
      })
    } finally {
      setLoading(false)
    }
  }

  function getDraftRetainedIds(draft) {
    const snapshot = getCategoryWorkspaceSnapshot(draft)
    const retained = new Set()
    for (const sectionType of ['income', 'expense']) {
      for (const group of snapshot.tree[sectionType] || []) {
        if (!group.isNew) retained.add(group.id)
        for (const child of group.children || []) {
          if (!child.isNew) retained.add(child.id)
        }
      }
    }
    return retained
  }

  function buildPostApplyCategoryWorkspaceDraft(draft, snapshot) {
    const committedSnapshot = cloneCategoryImportSnapshot(snapshot)
    for (const sectionType of ['income', 'expense']) {
      committedSnapshot.tree[sectionType] = (committedSnapshot.tree[sectionType] || []).map(group => ({
        ...group,
        children: (group.children || []).map(child => (
          child?.sourceValue
            ? { ...child, imported: true }
            : child
        )),
      }))
    }
    committedSnapshot.selectedSourceIds = []
    committedSnapshot.selectedNodeId = null
    return {
      ...(draft || {}),
      snapshot: committedSnapshot,
      undoStack: [],
      redoStack: [],
      selectionAnchor: null,
      selectedBucketCategoryIds: [],
      bucketSelectionAnchor: null,
    }
  }

  async function persistProfileCategoryWorkspaceDraft(profileId, draft) {
    const profile = profiles.find(item => item.id === profileId)
    if (!profile) return false
    const persistedDraft = clonePersistedCategoryWorkspaceDraft(draft)
    const nextColumnMap = { ...(profile.column_map || {}) }
    if (persistedDraft) nextColumnMap.category_workspace_draft = persistedDraft
    else delete nextColumnMap.category_workspace_draft

    setProfiles(prev => prev.map(item => (
      item.id === profileId
        ? { ...item, column_map: nextColumnMap }
        : item
    )))

    try {
      await api.updateImportProfile(profileId, { column_map: nextColumnMap })
      return true
    } catch (error) {
      api.getImportProfiles().then(setProfiles)
      setNoticeDialog({
        title: 'Could not save the data source category mappings',
        description: error?.message || 'Please try again.',
      })
      return false
    }
  }

  function sanitizeWorkspaceDraftForOpen(draft) {
    return sanitizeCategoryImportDraftAgainstExistingCategories(draft, categories)
  }

  function draftsMatch(left, right) {
    return JSON.stringify(left || null) === JSON.stringify(right || null)
  }

  function openSourceCategoryWorkspace(profileId) {
    const draft = profileId === MANUAL_DATA_SOURCE_VALUE
      ? clonePersistedCategoryWorkspaceDraft(manualDraftRecord?.snapshot?.category_workspace_draft)
      : clonePersistedCategoryWorkspaceDraft(profiles.find(item => item.id === profileId)?.column_map?.category_workspace_draft)
    const sanitizedDraft = sanitizeWorkspaceDraftForOpen(draft)
    if (!sanitizedDraft?.snapshot) return
    if (!draftsMatch(draft, sanitizedDraft)) {
      if (profileId === MANUAL_DATA_SOURCE_VALUE) persistManualDraftCategoryWorkspaceDraft(sanitizedDraft)
      else persistProfileCategoryWorkspaceDraft(profileId, sanitizedDraft).catch(() => { })
    }
    setSourceWorkspaceProfileId(profileId)
    setSourceWorkspaceBatchId('')
    setSourceWorkspaceSourceValues([])
    setSourceWorkspaceDraft(sanitizedDraft)
    setShowCategoryWorkspace(true)
  }

  async function openBatchCategoryWorkspace(batchId) {
    // Opens the category workspace backed by a specific profileless batch record.
    // The draft is fetched on demand from the batch's config_snapshot rather than
    // held in memory — batch records are not loaded with their full snapshots by
    // list_batches to keep payloads lean.
    // Source values are captured once here and held in sourceWorkspaceSourceValues
    // state for the lifetime of this workspace session. They must not be recomputed
    // from sourceWorkspaceDraft on each render or they trigger an infinite loop
    // inside CategoryImportWorkspace's sanitizeSnapshot useEffect.
    setLoading(true)
    try {
      const { draft } = await api.getBatchCategoryWorkspaceDraft(batchId)
      const cloned = clonePersistedCategoryWorkspaceDraft(draft)
      const sanitizedDraft = sanitizeWorkspaceDraftForOpen(cloned)
      if (!sanitizedDraft?.snapshot) return
      if (!draftsMatch(cloned, sanitizedDraft)) {
        api.saveBatchCategoryWorkspaceDraft(batchId, clonePersistedCategoryWorkspaceDraft(sanitizedDraft)).catch(() => { })
      }
      const stableSourceValues = collectCategoryWorkspaceSourceValues(sanitizedDraft)
      setSourceWorkspaceProfileId('')
      setSourceWorkspaceBatchId(batchId)
      setSourceWorkspaceSourceValues(stableSourceValues)
      setSourceWorkspaceDraft(sanitizedDraft)
      setShowCategoryWorkspace(true)
    } catch {
      setNoticeDialog({
        title: 'Could not load category workspace for this import',
        description: 'Please try opening the category workspace again.',
      })
    } finally {
      setLoading(false)
    }
  }

  function persistManualDraftCategoryWorkspaceDraft(draft) {
    if (!manualDraftRecord) return false
    const persistedDraft = clonePersistedCategoryWorkspaceDraft(draft)
    const nextRecord = {
      ...manualDraftRecord,
      snapshot: {
        ...manualDraftRecord.snapshot,
        category_workspace_draft: persistedDraft,
      },
    }
    const saved = saveImportDraftRecord(nextRecord, dbInstanceId, preferenceSubjectId)
    setManualDraftRecord(saved || nextRecord)
    return true
  }

  function closeSourceCategoryWorkspace() {
    const profileId = sourceWorkspaceProfileId
    const batchId = sourceWorkspaceBatchId
    const draft = sourceWorkspaceDraft
    setShowCategoryWorkspace(false)
    setSourceWorkspaceProfileId('')
    setSourceWorkspaceBatchId('')
    setSourceWorkspaceSourceValues([])
    setSourceWorkspaceDraft(null)
    if (batchId && draft) {
      const persistedDraft = clonePersistedCategoryWorkspaceDraft(draft)
      api.saveBatchCategoryWorkspaceDraft(batchId, persistedDraft).catch(() => { })
    } else if (profileId && draft) {
      if (profileId === MANUAL_DATA_SOURCE_VALUE) persistManualDraftCategoryWorkspaceDraft(draft)
      else persistProfileCategoryWorkspaceDraft(profileId, draft)
    }
  }

  async function commitCategoryWorkspaceDraftToLiveCategories(draft) {
    const snapshot = getCategoryWorkspaceSnapshot(draft)
    const currentCategories = await api.getCategories()
    const liveGroups = currentCategories.filter(cat => !cat.parent_id)
    const liveChildren = currentCategories.filter(cat => !!cat.parent_id)
    const groupByKey = new Map(
      liveGroups.map(group => [
        `${String(group.category_type || 'expense').toLowerCase()}::${group.name.trim().toLowerCase()}`,
        group,
      ]),
    )
    const childrenByGroupId = new Map()
    for (const child of liveChildren) {
      const groupChildren = childrenByGroupId.get(child.parent_id) || []
      groupChildren.push(child)
      childrenByGroupId.set(child.parent_id, groupChildren)
    }

    for (const sectionType of ['income', 'expense']) {
      for (const draftGroup of snapshot.tree[sectionType] || []) {
        const groupName = String(draftGroup.name || '').trim()
        if (!groupName) continue
        const groupKey = `${sectionType}::${groupName.toLowerCase()}`
        let liveGroup = groupByKey.get(groupKey)
        if (!liveGroup) {
          liveGroup = await api.createCategory({
            name: groupName,
            category_type: sectionType,
          })
          groupByKey.set(groupKey, liveGroup)
          childrenByGroupId.set(liveGroup.id, [])
        }

        const existingChildNames = new Set(
          (childrenByGroupId.get(liveGroup.id) || []).map(child => child.name.trim().toLowerCase()),
        )

        for (const draftChild of draftGroup.children || []) {
          const childName = String(draftChild.name || draftChild.sourceValue || '').trim()
          if (!childName || existingChildNames.has(childName.toLowerCase())) continue
          const createdChild = await api.createCategory({
            name: childName,
            parent_id: liveGroup.id,
          })
          existingChildNames.add(childName.toLowerCase())
          childrenByGroupId.set(liveGroup.id, [...(childrenByGroupId.get(liveGroup.id) || []), createdChild])
        }
      }
    }

    const refreshedCategories = await api.getCategories()
    return {
      refreshedCategories,
      nextDraft: buildPostApplyCategoryWorkspaceDraft(draft, snapshot),
    }
  }

  async function applyCategoryWorkspaceDraft(draft) {
    setLoading(true)
    try {
      const { refreshedCategories, nextDraft } = await commitCategoryWorkspaceDraftToLiveCategories(draft)
      setCategories(refreshedCategories)
      setImportCategoryDraft(nextDraft)
      if (selectedProfile) {
        await persistProfileCategoryWorkspaceDraft(selectedProfile, nextDraft)
      } else {
        persistManualDraftCategoryWorkspaceDraft(nextDraft)
      }
      setShowCategoryWorkspace(false)
    } finally {
      setLoading(false)
    }
  }

  async function applySourceCategoryWorkspaceDraft(draft) {
    if (!sourceWorkspaceProfileId && !sourceWorkspaceBatchId) return
    setLoading(true)
    try {
      const { refreshedCategories, nextDraft } = await commitCategoryWorkspaceDraftToLiveCategories(draft)
      setCategories(refreshedCategories)
      setSourceWorkspaceDraft(nextDraft)
      if (sourceWorkspaceBatchId) {
        const persistedDraft = clonePersistedCategoryWorkspaceDraft(nextDraft)
        await api.saveBatchCategoryWorkspaceDraft(sourceWorkspaceBatchId, persistedDraft).catch(() => { })
        api.listBatches().then(setBatches)
      } else if (sourceWorkspaceProfileId === MANUAL_DATA_SOURCE_VALUE) {
        persistManualDraftCategoryWorkspaceDraft(nextDraft)
      } else {
        await persistProfileCategoryWorkspaceDraft(sourceWorkspaceProfileId, nextDraft)
      }
      setShowCategoryWorkspace(false)
      setSourceWorkspaceProfileId('')
      setSourceWorkspaceBatchId('')
      setSourceWorkspaceSourceValues([])
      setSourceWorkspaceDraft(null)
    } finally {
      setLoading(false)
    }
  }

  function openRejectedRowsViewer({
    source,
    title,
    allowRawViewer = false,
  }) {
    const summary = summarizeImportOutcome(source)
    if (summary.rejectedCount <= 0) return
    setRejectedRowsViewer({
      headers: summary.rejectedHeaders,
      rows: summary.rejectedRows,
      count: summary.rejectedCount,
      title,
      allowRawViewer,
    })
  }

  async function openDuplicateRowsViewer({
    source,
    title,
  }) {
    const summary = summarizeImportOutcome(source)
    if (summary.dedupedCount <= 0) return
    const batchId = source?.batch_id || source?.id || ''
    if (!batchId) return
    const requestId = duplicateViewerRequestRef.current + 1
    duplicateViewerRequestRef.current = requestId
    try {
      const result = await api.getBatchDuplicates(batchId)
      if (duplicateViewerRequestRef.current !== requestId) return
      setDuplicateRowsViewer({
        batchId,
        headers: Array.isArray(result.headers) ? result.headers : [],
        rows: Array.isArray(result.rows) ? result.rows : [],
        count: Number(result.count || summary.dedupedCount) || 0,
        title,
        loading: false,
        error: '',
      })
    } catch (error) {
      if (duplicateViewerRequestRef.current !== requestId) return
      setDuplicateRowsViewer({
        batchId,
        headers: [],
        rows: [],
        count: summary.dedupedCount,
        title,
        loading: false,
        error: error?.message || 'Could not load duplicate rows.',
      })
    }
  }

  async function syncDuplicateImportState(batchId) {
    const refreshedBatches = await api.listBatches()
    setBatches(refreshedBatches)
    const updatedBatch = refreshedBatches.find(item => item.id === batchId) || null
    if (updatedBatch && importResult?.batch_id === batchId) {
      const updatedSummary = summarizeImportOutcome(updatedBatch)
      setImportResult(prev => prev ? {
        ...prev,
        imported: updatedSummary.importedCount,
        deduped: updatedSummary.dedupedCount,
        duplicate_count: updatedSummary.dedupedCount,
        import_summary: updatedBatch.import_summary,
      } : prev)
    }
    if (!updatedBatch) {
      setDuplicateRowsViewer(null)
      return
    }
    const updatedSummary = summarizeImportOutcome(updatedBatch)
    if (updatedSummary.dedupedCount > 0) {
      setDuplicateRowsViewer(prev => prev ? {
        ...prev,
        count: updatedSummary.dedupedCount,
        loading: true,
        error: '',
      } : prev)
      try {
        const result = await api.getBatchDuplicates(batchId)
        setDuplicateRowsViewer(prev => prev ? {
          ...prev,
          headers: Array.isArray(result.headers) ? result.headers : [],
          rows: Array.isArray(result.rows) ? result.rows : [],
          count: Number(result.count || updatedSummary.dedupedCount) || 0,
          loading: false,
          error: '',
        } : prev)
      } catch (error) {
        setDuplicateRowsViewer(prev => prev ? {
          ...prev,
          headers: [],
          rows: [],
          loading: false,
          error: error?.message || 'Could not refresh duplicate rows.',
        } : prev)
      }
    } else {
      setDuplicateRowsViewer(null)
    }
  }

  async function importSelectedDuplicates(batchId, rowNumbers = [], importAll = false) {
    if (!batchId) return
    setDuplicateImporting(true)
    try {
      const result = await api.importBatchDuplicates(batchId, {
        import_all: importAll,
        row_numbers: importAll ? null : rowNumbers,
      })
      await syncDuplicateImportState(batchId)
      if (result.not_importable_count > 0) {
        setNoticeDialog({
          title: 'Some duplicate rows could not be imported',
          description: `${result.not_importable_count} selected duplicate row${result.not_importable_count === 1 ? '' : 's'} could not be imported from this saved batch.`,
        })
      }
    } catch (error) {
      setNoticeDialog({
        title: 'Could not import duplicate rows',
        description: error?.message || 'Please try again.',
      })
    } finally {
      setDuplicateImporting(false)
    }
  }

  function requestDuplicateImportConfirmation(batchId, rowNumbers = [], importAll = false, count = 0) {
    if (!batchId) return
    if (!importAll && (!Array.isArray(rowNumbers) || rowNumbers.length === 0)) return
    setPendingDuplicateImport({
      batchId,
      rowNumbers,
      importAll,
      count: importAll ? Number(count || 0) : rowNumbers.length,
    })
  }

  async function confirmDuplicateImport() {
    if (!pendingDuplicateImport) return
    const current = pendingDuplicateImport
    setPendingDuplicateImport(null)
    await importSelectedDuplicates(current.batchId, current.rowNumbers, current.importAll)
  }

  return (
    <div style={{ width: '100%', maxWidth: IMPORT_CONFIG_MAX_WIDTH }}>
      {noticeDialog ? (
        <AppNoticeDialog
          title={noticeDialog.title}
          description={noticeDialog.description}
          onClose={() => setNoticeDialog(null)}
        />
      ) : null}

      {pendingMappingSourceSwitch ? (
        <AppConfirmDialog
          title="Change data source?"
          description="Current mapping changes on this screen will be replaced."
          confirmLabel="Change data source"
          onConfirm={confirmMappingSourceSwitch}
          onCancel={() => setPendingMappingSourceSwitch(null)}
          width="min(500px, 100%)"
        />
      ) : null}

      {showCategoryWorkspace && (preview || sourceWorkspaceProfileId || sourceWorkspaceBatchId) ? (
        <CategoryImportWorkspace
          sourceValues={sourceWorkspaceProfileId
            ? activeSourceWorkspaceSummary.sourceValues
            : sourceWorkspaceBatchId
              ? sourceWorkspaceSourceValues
              : sourceCategoryValues}
          sourceMeta={sourceWorkspaceProfileId
            ? {
              total_count: activeSourceWorkspaceSummary.totalCount,
              displayed_count: activeSourceWorkspaceSummary.totalCount,
              truncated: false,
              limit: activeSourceWorkspaceSummary.totalCount,
            }
            : sourceWorkspaceBatchId
              ? {
                total_count: sourceWorkspaceSourceValues.length,
                displayed_count: sourceWorkspaceSourceValues.length,
                truncated: false,
                limit: sourceWorkspaceSourceValues.length,
              }
              : sourceCategoryMeta}
          existingCategories={categories}
          initialDraftState={sourceWorkspaceProfileId || sourceWorkspaceBatchId ? sourceWorkspaceDraft : importCategoryDraft}
          onDraftStateChange={sourceWorkspaceProfileId || sourceWorkspaceBatchId ? setSourceWorkspaceDraft : setImportCategoryDraft}
          onApply={sourceWorkspaceProfileId || sourceWorkspaceBatchId ? applySourceCategoryWorkspaceDraft : applyCategoryWorkspaceDraft}
          onClose={sourceWorkspaceProfileId || sourceWorkspaceBatchId ? closeSourceCategoryWorkspace : () => setShowCategoryWorkspace(false)}
          onCategoriesChanged={setCategories}
        />
      ) : null}

      {showRaw && preview && (
        <RawFilePreview
          rawLines={rawViewerLines}
          headerRowIndex={preview.header_row_index ?? 0}
          lineNumberOffset={rawViewerOffset}
          title={rawViewerTitle}
          note={rawViewerNote}
          onClose={() => setShowRaw(false)}
        />
      )}

      {rejectedRowsViewer ? (
        <RejectedRowsDialog
          headers={rejectedRowsViewer.headers}
          rows={rejectedRowsViewer.rows}
          count={rejectedRowsViewer.count}
          title={rejectedRowsViewer.title}
          onClose={() => setRejectedRowsViewer(null)}
          onOpenRawViewer={rejectedRowsViewer.allowRawViewer ? () => {
            setRejectedRowsViewer(null)
            setShowRaw(true)
          } : undefined}
        />
      ) : null}

      {duplicateRowsViewer ? (
        <DuplicateRowsDialog
          headers={duplicateRowsViewer.headers}
          rows={duplicateRowsViewer.rows}
          count={duplicateRowsViewer.count}
          title={duplicateRowsViewer.title}
          loading={!!duplicateRowsViewer.loading}
          error={duplicateRowsViewer.error || ''}
          importing={duplicateImporting}
          onClose={() => setDuplicateRowsViewer(null)}
          onImportSelected={rowNumbers => requestDuplicateImportConfirmation(duplicateRowsViewer.batchId, rowNumbers, false, rowNumbers.length)}
          onImportAll={() => requestDuplicateImportConfirmation(duplicateRowsViewer.batchId, [], true, duplicateRowsViewer.count)}
        />
      ) : null}

      {pendingDuplicateImport ? (
        <DuplicateImportConfirmDialog
          pending={pendingDuplicateImport}
          importing={duplicateImporting}
          onCancel={() => setPendingDuplicateImport(null)}
          onConfirm={confirmDuplicateImport}
        />
      ) : null}

      {compatibleBatchPrompt ? (
        <CompatibleBatchAttachDialog
          prompt={compatibleBatchPrompt}
          attaching={attachingCompatibleBatches}
          onConfirm={attachCompatibleUnknownImports}
          onCancel={() => setCompatibleBatchPrompt(null)}
        />
      ) : null}

      {stage === 'upload' && (
        <>
          <div style={{ width: '100%', display: 'grid', gap: 18 }}>
            {uploadChoiceReady ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <div style={{ fontSize: 13, color: 'var(--muted)' }}>
                  Data source:{' '}
                  {uploadUsesManualDraft ? (
                    <span style={{
                      color: 'var(--muted)',
                      fontWeight: 500,
                      fontStyle: 'italic',
                    }}>
                      temporary draft
                    </span>
                  ) : editingSourceNameKey === getSourceNameEditKey('upload', selectedUploadSource) ? (
                    <TransientTextInput
                      value={sourceNameDraft}
                      onChange={setSourceNameDraft}
                      onCommit={() => saveSourceName(selectedUploadSource)}
                      onCancel={() => {
                        setEditingSourceNameKey('')
                        setSourceNameDraft('')
                      }}
                      restoreOnEscape
                      onBlurCommit={false}
                      placeholder="Data source name"
                      style={{
                        width: 220,
                        maxWidth: '100%',
                        background: 'var(--surface2)',
                        color: 'var(--text)',
                        border: '1px solid var(--accent)',
                        borderRadius: 999,
                        padding: '4px 10px',
                        fontSize: 12,
                        fontWeight: 600,
                        outline: 'none',
                      }}
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        setEditingSourceDescriptionId('')
                        setSourceDescriptionDraft('')
                        setEditingSourceNameKey(getSourceNameEditKey('upload', selectedUploadSource))
                        setSourceNameDraft(uploadSelectionLabel)
                      }}
                      style={{
                        background: 'none',
                        border: 'none',
                        padding: 0,
                        margin: 0,
                        color: 'var(--text)',
                        fontWeight: 600,
                        fontSize: 13,
                        cursor: 'pointer',
                      }}
                      title="Click to rename this data source"
                    >
                      {uploadSelectionLabel}
                    </button>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setSelectedUploadSource('')
                    setShowUploadSourceCreate(false)
                    setUploadSourceDraftName('')
                  }}
                  style={{
                    background: 'color-mix(in srgb, var(--surface2) 82%, var(--surface))',
                    border: '1px solid var(--border)',
                    borderRadius: 999,
                    padding: '3px 9px',
                    fontSize: 11,
                    color: 'var(--muted)',
                    cursor: 'pointer',
                    lineHeight: 1.2,
                  }}
                >
                  Change
                </button>
              </div>
            ) : null}

            <div style={{ width: '100%' }}>
              <div
                ref={dropRef}
                onDragOver={e => { if (uploadChoiceReady) e.preventDefault() }}
                onDrop={handleDrop}
                onClick={() => { if (uploadChoiceReady) fileInputRef.current?.click() }}
                style={{
                  border: `2px dashed ${uploadChoiceReady ? 'var(--border)' : 'color-mix(in srgb, var(--border) 78%, transparent)'}`,
                  borderRadius: 12,
                  padding: '48px 32px',
                  textAlign: 'center',
                  cursor: uploadChoiceReady ? 'pointer' : 'default',
                  background: uploadChoiceReady ? 'var(--surface2)' : 'color-mix(in srgb, var(--surface2) 65%, var(--surface))',
                  marginBottom: 24,
                  opacity: uploadChoiceReady ? 1 : 0.72,
                }}
                onMouseEnter={e => {
                  if (uploadChoiceReady) e.currentTarget.style.borderColor = 'var(--accent)'
                }}
                onMouseLeave={e => {
                  e.currentTarget.style.borderColor = uploadChoiceReady ? 'var(--border)' : 'color-mix(in srgb, var(--border) 78%, transparent)'
                }}
              >
                {!uploadChoiceReady ? (
                  <div style={{ display: 'grid', justifyItems: 'center', gap: 12, width: 'min(760px, 100%)', maxWidth: '100%', margin: '0 auto 28px', textAlign: 'center' }}>
                    <div style={{ display: 'grid', gap: 6, justifyItems: 'center' }}>
                      <div style={{
                        maxWidth: 620,
                        padding: '8px 16px',
                        borderRadius: 16,
                        border: '1px solid color-mix(in srgb, var(--border) 52%, transparent)',
                        background: 'color-mix(in srgb, #000 16%, var(--surface))',
                        fontSize: 13,
                        fontWeight: 500,
                        color: 'color-mix(in srgb, var(--text) 84%, var(--muted))',
                        lineHeight: 1.45,
                      }}>
                        Select a saved data source, create a new one, or press Skip to use a temporary draft.
                      </div>
                    </div>
                    <div style={{
                      display: 'grid',
                      gap: 12,
                      width: '100%',
                      borderRadius: 12,
                      border: '1px solid var(--border)',
                      background: 'var(--surface)',
                      padding: '14px 16px',
                      boxShadow: '0 10px 30px rgba(0,0,0,0.14)',
                    }}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                        Available choices
                      </div>
                      {profiles.length > 0 ? (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, justifyContent: 'center' }}>
                          <DataSourcePill
                            label="Skip"
                            selected={uploadUsesManualDraft}
                            onClick={() => selectUploadSource(MANUAL_DATA_SOURCE_VALUE, { persist: false })}
                            title="Use a temporary draft instead of a saved data source"
                            showMarker={false}
                          />
                          {profiles.map(profile => (
                            <DataSourcePill
                              key={profile.id}
                              label={profile.name}
                              selected={selectedUploadSource === profile.id}
                              onClick={() => selectUploadSource(profile.id)}
                              title="Use this saved data source"
                            />
                          ))}
                          {showUploadSourceCreate ? (
                            <div style={{ display: 'inline-flex', alignItems: 'center' }}>
                              <TransientTextInput
                                value={uploadSourceDraftName}
                                onChange={setUploadSourceDraftName}
                                placeholder="Data source name"
                                onCommit={createUploadDataSource}
                                onCancel={() => {
                                  setShowUploadSourceCreate(false)
                                  setUploadSourceDraftName('')
                                }}
                                restoreOnEscape
                                onBlurCommit={false}
                                style={{
                                  minWidth: 190,
                                  background: 'var(--surface2)',
                                  color: 'var(--text)',
                                  border: '1px solid var(--accent)',
                                  borderRadius: 999,
                                  padding: '8px 14px',
                                  fontSize: 13,
                                  outline: 'none',
                                }}
                              />
                            </div>
                          ) : (
                            <DataSourcePill
                              label="+ New data source"
                              selected={false}
                              onClick={() => setShowUploadSourceCreate(true)}
                              title="Create a saved data source"
                              showMarker={false}
                            />
                          )}
                        </div>
                      ) : (
                        <div style={{ display: 'grid', justifyItems: 'center', gap: 12 }}>
                          <div style={{ width: '100%', textAlign: 'center', fontSize: 13, color: 'var(--muted)' }}>
                            {'<'}<span style={{ fontStyle: 'italic' }}>empty</span>{'>'}
                          </div>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, width: '100%', justifyContent: 'center' }}>
                            <DataSourcePill
                              label="Skip"
                              selected={uploadUsesManualDraft}
                              onClick={() => selectUploadSource(MANUAL_DATA_SOURCE_VALUE, { persist: false })}
                              title="Use a temporary draft instead of a saved data source"
                              showMarker={false}
                            />
                            {showUploadSourceCreate ? (
                              <div style={{ display: 'inline-flex', alignItems: 'center' }}>
                                <TransientTextInput
                                  value={uploadSourceDraftName}
                                  onChange={setUploadSourceDraftName}
                                  placeholder="Data source name"
                                  onCommit={createUploadDataSource}
                                  onCancel={() => {
                                    setShowUploadSourceCreate(false)
                                    setUploadSourceDraftName('')
                                  }}
                                  restoreOnEscape
                                  onBlurCommit={false}
                                  style={{
                                    minWidth: 190,
                                    background: 'var(--surface2)',
                                    color: 'var(--text)',
                                    border: '1px solid var(--accent)',
                                    borderRadius: 999,
                                    padding: '8px 14px',
                                    fontSize: 13,
                                    outline: 'none',
                                  }}
                                />
                              </div>
                            ) : (
                              <DataSourcePill
                                label="+ New data source"
                                selected={false}
                                onClick={() => setShowUploadSourceCreate(true)}
                                title="Create a saved data source"
                                showMarker={false}
                              />
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                ) : null}
                <div style={{ fontSize: 32, marginBottom: 12 }}>{uploadChoiceReady ? '📂' : '🧭'}</div>
                <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 6 }}>
                  {uploadChoiceReady ? 'Drop a CSV file here, or click to browse' : 'Choose a data source or select skip to begin'}
                </div>
                <input
                  ref={fileInputRef}
                  id="csv-file-input"
                  type="file"
                  accept=".csv"
                  style={{ display: 'none' }}
                  onChange={e => {
                    handleFile(e.target.files[0])
                    e.target.value = ''
                  }}
                />
              </div>
            </div>
          </div>
          {loading && <Spinner />}
        </>
      )}

      {stage === 'mapping' && preview && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20, alignItems: 'flex-start' }}>
          {preview.previous_batch && (
            <div style={{ width: IMPORT_CONFIG_MAX_WIDTH, background: 'color-mix(in srgb, #f59e0b 12%, var(--surface2))', border: '1px solid #f59e0b', borderRadius: 8, padding: '12px 16px' }}>
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>⚠️ This file has been previously imported</div>
              <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 8 }}>
                This exact file was imported on{' '}
                {preview.previous_batch?.imported_at?.slice(0, 16).replace('T', ' ')}.
                {colAccount
                  ? ' Accounts listed below were already imported from this file and cannot be imported again. Accounts not listed can still be imported now.'
                  : ' Undo the earlier import first before importing it again.'}
              </div>
              {previousImportAccounts.map(a => (
                <div key={a.account_id} style={{ fontSize: 13, marginBottom: 2 }}>• <strong>{a.account_name}</strong> — {a.row_count} transactions</div>
              ))}
              {colAccount && remainingAccountValues.length === 0 ? (
                <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 10 }}>
                  All accounts in this file were already imported, so there is nothing left to import.
                </div>
              ) : null}
            </div>
          )}

          <Card style={{ width: IMPORT_CONFIG_MAX_WIDTH }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 0, flexWrap: 'wrap', marginBottom: 12 }}>
              <span style={{ fontSize: 14, fontWeight: 600 }}>
                {preview.filename}
                <button
                  type="button"
                  onClick={() => setShowMappingSourceChooser(open => !open)}
                  title="Change data source"
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    marginLeft: 2,
                    padding: '1px 7px',
                    borderRadius: 999,
                    border: '1px solid color-mix(in srgb, var(--border) 88%, transparent)',
                    background: selectedProfile ? 'color-mix(in srgb, var(--accent) 8%, var(--surface2))' : 'color-mix(in srgb, var(--surface2) 88%, var(--surface))',
                    color: selectedProfile ? 'var(--accent2)' : 'var(--muted)',
                    fontSize: 10,
                    fontWeight: selectedProfile ? 600 : 500,
                    lineHeight: 1.15,
                    position: 'relative',
                    top: -7,
                    cursor: 'pointer',
                    verticalAlign: 'super',
                  }}>
                  {selectedProfile ? (profiles.find(p => p.id === selectedProfile)?.name || 'Saved data source') : 'temporary draft'}
                </button>
              </span>
              <span style={{ fontWeight: 400, color: 'var(--muted)', fontSize: 13, marginLeft: 12 }}>
                {preview.total_rows} rows
              </span>
            </div>

            {showMappingSourceChooser ? (
              <div style={{ display: 'grid', gap: 10, marginBottom: 12, padding: '10px 12px', borderRadius: 12, border: '1px solid var(--border)', background: 'color-mix(in srgb, var(--surface2) 52%, var(--surface))' }}>
                <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                  Choose a different data source for this file.
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                  <DataSourcePill
                    label="Temporary draft"
                    selected={!selectedProfile}
                    onClick={() => switchMappingDataSource(MANUAL_DATA_SOURCE_VALUE)}
                    title="Use a temporary draft for this file"
                  />
                  {profiles.map(profile => (
                    <DataSourcePill
                      key={profile.id}
                      label={profile.name}
                      selected={selectedProfile === profile.id}
                      onClick={() => switchMappingDataSource(profile.id)}
                      title="Use this saved data source"
                    />
                  ))}
                </div>
                <div>
                  <button
                    type="button"
                    onClick={returnToUploadSourceChooser}
                    style={{
                      background: 'none',
                      border: 'none',
                      padding: 0,
                      margin: 0,
                      fontSize: 12,
                      color: 'var(--muted)',
                      cursor: 'pointer',
                    }}
                  >
                    Start over
                  </button>
                </div>
              </div>
            ) : null}

            <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 14, paddingBottom: 14, borderBottom: '1px solid var(--border)', flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 0 }} />
              <button onClick={() => setShowRaw(v => !v)} style={{
                background: showRaw ? 'color-mix(in srgb, var(--accent) 12%, var(--surface2))' : 'var(--surface2)',
                border: `1px solid ${showRaw ? 'var(--accent)' : 'var(--border)'}`,
                borderRadius: 6, padding: '5px 10px', fontSize: 12,
                cursor: 'pointer', color: showRaw ? 'var(--accent2)' : 'var(--muted)',
                whiteSpace: 'nowrap', flexShrink: 0,
              }}>
                {showRaw ? '× Close raw file' : '⌗ View raw file'}
              </button>
              <button onClick={() => setShowAdvanced(v => !v)} style={{
                background: 'none', border: 'none', fontSize: 12, cursor: 'pointer',
                color: showAdvanced ? 'var(--accent2)' : 'var(--muted)',
                padding: '5px 4px', whiteSpace: 'nowrap', flexShrink: 0,
              }}>
                {showAdvanced ? '▴ Advanced' : '▾ Advanced'}
              </button>
            </div>

            {!showAdvanced && (preview.header_row_index ?? 0) > 0 && (
              <div style={{
                display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14,
                padding: '7px 12px', borderRadius: 6,
                background: 'color-mix(in srgb, #f59e0b 10%, var(--surface2))',
                border: '1px solid #f59e0b', fontSize: 12,
              }}>
                <span>⚠️</span>
                <span style={{ color: 'var(--muted)', flex: 1 }}>
                  Header detected on line {(preview.header_row_index ?? 0) + 1}.
                  If the column names below look wrong, view the raw file and adjust "Skip header rows" in Advanced.
                </span>
                <button onClick={() => setShowAdvanced(true)} style={{
                  background: 'none', border: 'none', color: 'var(--accent2)',
                  cursor: 'pointer', fontSize: 12, whiteSpace: 'nowrap', flexShrink: 0,
                }}>Advanced ▸</button>
              </div>
            )}

            {showAdvanced && (
              <div style={{
                display: 'flex', gap: 14, marginBottom: 14, flexWrap: 'wrap',
                padding: '10px 14px', background: 'var(--surface2)',
                borderRadius: 8, border: '1px solid var(--border)', alignItems: 'center',
              }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap' }}>
                  Date format
                  <select value={dateFormat} onChange={e => { setDateFormatLocked(true); setDateFormat(e.target.value) }} style={{
                    background: 'var(--surface)', color: 'var(--text)',
                    border: '1px solid var(--border)', borderRadius: 6,
                    padding: '3px 6px', fontSize: 12, cursor: 'pointer',
                  }}>
                    {DATE_FORMATS.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
                  </select>
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap' }}>
                  Amount format
                  <select value={amtConv} onChange={e => setAmtConv(e.target.value)} style={{
                    background: 'var(--surface)', color: 'var(--text)',
                    border: '1px solid var(--border)', borderRadius: 6,
                    padding: '3px 6px', fontSize: 12, cursor: 'pointer',
                  }}>
                    {AMOUNT_CONVENTIONS.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                  </select>
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap' }}>
                  Skip
                  <input type="number" min={0} max={10} value={displayedSkipRows}
                    onChange={e => {
                      const next = parseInt(e.target.value) || 0
                      setSkipRows(Math.max(0, next - detectedHeaderOffset))
                    }}
                    style={{
                      background: 'var(--surface)', color: 'var(--text)',
                      border: '1px solid var(--border)', borderRadius: 6,
                      padding: '3px 6px', fontSize: 12, width: 40, textAlign: 'center',
                    }}
                  />
                  header rows
                </label>
                {detectedHeaderOffset > 0 && (
                  <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                    Includes {detectedHeaderOffset} auto-detected row{detectedHeaderOffset !== 1 ? 's' : ''} before the header.
                  </div>
                )}
              </div>
            )}

            <ImportColumnMappingSection
              fields={[
                {
                  key: 'date',
                  label: 'Date',
                  headers: columnAnalysis.dateCandidates,
                  allHeaders: preview.headers,
                  value: colDate,
                  onChange: handleDateColumnChange,
                  suggestedValue: mappingSuggestions.date,
                  onAcceptSuggestion: handleDateColumnChange,
                  required: true,
                  hint: dateSelectHint,
                  tone: selectedDateAnalysis && !selectedDateAnalysis.guessedFormat && selectedDateAnalysis.sampleCount ? 'danger' : 'muted',
                },
                amtConv === 'two_column'
                  ? {
                    key: 'debit',
                    label: 'Debit column',
                    headers: columnAnalysis.debitCandidates,
                    allHeaders: preview.headers,
                    value: colDebit,
                    onChange: nextValue => {
                      if (nextValue) clearMappingSuggestion('debit')
                      setColDebit(nextValue)
                    },
                    suggestedValue: mappingSuggestions.debit,
                    onAcceptSuggestion: nextValue => {
                      clearMappingSuggestion('debit')
                      setColDebit(nextValue)
                    },
                    required: true,
                    hint: columnAnalysis.debitCandidates.length > 0 && !colDebit ? formatLikelyMatchLabel(columnAnalysis.debitCandidates.length) : '',
                  }
                  : {
                    key: 'amount',
                    label: 'Amount',
                    headers: columnAnalysis.amountCandidates,
                    allHeaders: preview.headers,
                    value: colAmount,
                    onChange: nextValue => {
                      if (nextValue) clearMappingSuggestion('amount')
                      setColAmount(nextValue)
                    },
                    suggestedValue: mappingSuggestions.amount,
                    onAcceptSuggestion: nextValue => {
                      clearMappingSuggestion('amount')
                      setColAmount(nextValue)
                    },
                    required: true,
                    hint: amountSelectHint,
                    tone: selectedAmountAnalysis && selectedAmountAnalysis.sampleCount > 0 && selectedAmountAnalysis.amountMatches === 0 ? 'danger' : 'muted',
                  },
                {
                  key: 'pending',
                  label: 'Pending',
                  headers: columnAnalysis.pendingCandidates,
                  allHeaders: preview.headers,
                  value: colPending,
                  onChange: nextValue => {
                    if (nextValue) clearMappingSuggestion('pending')
                    setColPending(nextValue)
                  },
                  suggestedValue: mappingSuggestions.pending,
                  onAcceptSuggestion: nextValue => {
                    clearMappingSuggestion('pending')
                    setColPending(nextValue)
                  },
                  hint: columnAnalysis.pendingCandidates.length > 0 && !colPending ? formatLikelyMatchLabel(columnAnalysis.pendingCandidates.length) : '',
                },
                amtConv === 'two_column'
                  ? {
                    key: 'credit',
                    label: 'Credit column',
                    headers: columnAnalysis.creditCandidates,
                    allHeaders: preview.headers,
                    value: colCredit,
                    onChange: nextValue => {
                      if (nextValue) clearMappingSuggestion('credit')
                      setColCredit(nextValue)
                    },
                    suggestedValue: mappingSuggestions.credit,
                    onAcceptSuggestion: nextValue => {
                      clearMappingSuggestion('credit')
                      setColCredit(nextValue)
                    },
                    required: true,
                    hint: columnAnalysis.creditCandidates.length > 0 && !colCredit ? formatLikelyMatchLabel(columnAnalysis.creditCandidates.length) : '',
                  }
                  : null,
                amtConv === 'single_unsigned'
                  ? {
                    key: 'direction',
                    label: 'Direction column',
                    headers: columnAnalysis.directionCandidates,
                    allHeaders: preview.headers,
                    value: colDir,
                    onChange: nextValue => {
                      if (nextValue) clearMappingSuggestion('direction')
                      setColDir(nextValue)
                    },
                    suggestedValue: mappingSuggestions.direction,
                    onAcceptSuggestion: nextValue => {
                      clearMappingSuggestion('direction')
                      setColDir(nextValue)
                    },
                    hint: columnAnalysis.directionCandidates.length > 0 && !colDir ? formatLikelyMatchLabel(columnAnalysis.directionCandidates.length) : '',
                  }
                  : null,
                {
                  key: 'description',
                  label: 'Merchant',
                  headers: columnAnalysis.merchantCandidates,
                  allHeaders: preview.headers,
                  value: colDesc,
                  onChange: nextValue => {
                    if (nextValue) clearMappingSuggestion('description')
                    setColDesc(nextValue)
                  },
                  suggestedValue: mappingSuggestions.description,
                  onAcceptSuggestion: nextValue => {
                    clearMappingSuggestion('description')
                    setColDesc(nextValue)
                  },
                  required: true,
                  hint: columnAnalysis.merchantCandidates.length > 0 && !colDesc ? formatLikelyMatchLabel(columnAnalysis.merchantCandidates.length) : '',
                },
                {
                  key: 'category',
                  label: 'Category',
                  headers: columnAnalysis.categoryCandidates,
                  allHeaders: preview.headers,
                  value: colCategory,
                  onChange: handleCategoryColumnChange,
                  suggestedValue: mappingSuggestions.category,
                  onAcceptSuggestion: handleCategoryColumnChange,
                  hint: categorySelectHint,
                  after: colCategory && sourceCategoryValues.length > 0 ? (
                    <div style={{ position: 'absolute', width: 'calc(100% - 28px)', right: 0, top: 'calc(100% + 4px)', display: 'grid', justifyItems: 'end', gap: 6, zIndex: 1 }}>
                      <div style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, maxWidth: '100%' }}>
                        <button
                          type="button"
                          onClick={openCurrentImportCategoryWorkspace}
                          style={{
                            width: 'auto',
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            gap: 10,
                            background: remainingCategoryCount > 0
                              ? 'color-mix(in srgb, var(--accent) 12%, var(--surface2))'
                              : 'color-mix(in srgb, var(--surface2) 80%, var(--surface))',
                            color: remainingCategoryCount > 0 ? 'var(--accent2)' : 'var(--muted)',
                            border: `1px solid ${remainingCategoryCount > 0 ? 'color-mix(in srgb, var(--accent) 34%, var(--border))' : 'var(--border)'}`,
                            borderRadius: 999,
                            padding: '5px 10px',
                            fontSize: 11,
                            fontWeight: 600,
                            cursor: 'pointer',
                            boxShadow: remainingCategoryCount > 0 ? '0 1px 1px rgba(0,0,0,0.04)' : 'none',
                          }}
                        >
                          <span>{currentImportCategoryActionLabel}</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => setShowCategoryImportHelp(prev => !prev)}
                          style={{
                            width: 22,
                            height: 22,
                            borderRadius: 999,
                            border: '1px solid var(--border)',
                            background: 'color-mix(in srgb, var(--surface2) 80%, var(--surface))',
                            color: 'var(--muted)',
                            fontSize: 12,
                            fontWeight: 700,
                            cursor: 'pointer',
                            lineHeight: 1,
                            flexShrink: 0,
                          }}
                          title="Add categories from the file to the list of choices"
                        >
                          ?
                        </button>
                      </div>
                      {showCategoryImportHelp ? (
                        <div style={{
                          padding: '8px 10px',
                          borderRadius: 12,
                          border: '1px solid color-mix(in srgb, var(--accent) 18%, var(--border))',
                          background: 'color-mix(in srgb, var(--surface2) 82%, var(--surface))',
                          color: 'var(--muted)',
                          fontSize: 10.5,
                          lineHeight: 1.45,
                        }}>
                          Useful when the file contains categories you wish to use in this system. It can be ignored if the categories in the file are not meaningful.
                        </div>
                      ) : null}
                      {sourceCategoryMeta?.truncated ? (
                        <div style={{
                          padding: '7px 10px',
                          borderRadius: 12,
                          border: '1px solid color-mix(in srgb, #f59e0b 34%, var(--border))',
                          background: 'color-mix(in srgb, #f59e0b 10%, var(--surface2))',
                          color: 'color-mix(in srgb, #f59e0b 72%, var(--text))',
                          fontSize: 10.5,
                          lineHeight: 1.4,
                        }}>
                          This column has {sourceCategoryMeta.total_count} unique values. Showing the first {sourceCategoryMeta.limit}.
                        </div>
                      ) : null}
                    </div>
                  ) : null,
                },
                {
                  key: 'notes',
                  label: 'Notes',
                  headers: preview.headers,
                  allHeaders: preview.headers,
                  value: colNotes,
                  onChange: nextValue => {
                    if (nextValue) clearMappingSuggestion('notes')
                    setColNotes(nextValue)
                  },
                  suggestedValue: mappingSuggestions.notes,
                  onAcceptSuggestion: nextValue => {
                    clearMappingSuggestion('notes')
                    setColNotes(nextValue)
                  },
                },
              ]}
              accountField={{
                headers: columnAnalysis.accountCandidates,
                allHeaders: preview.headers,
                accounts,
                colAccount,
                accountId,
                singleAccountNew,
                suggestedColumn: mappingSuggestions.account,
                onAcceptSuggestedColumn: nextValue => {
                  clearMappingSuggestion('account')
                  setColAccount(nextValue)
                  setAccountMap({})
                  setAccountId('')
                  setSingleAccountNew({ enabled: false, name: '', type: 'depository' })
                },
                isRequired: !colAccount && !accountId && !singleAccountNew.enabled,
                hint: accountSelectHint,
                onChange: ({ col, acct, createNew }) => {
                  if (col !== undefined) {
                    if (col) clearMappingSuggestion('account')
                    setColAccount(col)
                    setAccountMap({})
                    setAccountId('')
                    setSingleAccountNew({ enabled: false, name: '', type: 'depository' })
                  } else {
                    if (acct || createNew) clearMappingSuggestion('account')
                    setColAccount(null)
                    setAccountMap({})
                    setAccountId(acct)
                    setSingleAccountNew(createNew
                      ? { enabled: true, name: '', type: 'depository' }
                      : { enabled: false, name: '', type: 'depository' })
                  }
                },
              }}
            />
            {!colAccount && singleAccountNew.enabled && (
              <div style={{
                marginTop: -7, marginBottom: 14, marginLeft: 42, padding: '8px 10px',
                background: 'color-mix(in srgb, var(--surface2) 70%, var(--surface))',
                border: '1px solid color-mix(in srgb, var(--border) 55%, transparent)', borderRadius: 999,
                display: 'inline-flex', gap: 8, flexWrap: 'wrap', alignItems: 'center',
                maxWidth: '100%',
                boxShadow: '0 1px 1px rgba(0,0,0,0.04)',
              }}>
                <input
                  value={singleAccountNew.name}
                  onChange={e => setSingleAccountNew(prev => ({ ...prev, name: e.target.value }))}
                  placeholder="New account name"
                  style={{
                    width: 200, maxWidth: '100%', background: 'var(--surface)', color: 'var(--text)',
                    border: `1px solid ${accounts.some(a => a.name.toLowerCase() === singleAccountNew.name.trim().toLowerCase()) ? 'var(--danger)' : 'var(--accent)'}`,
                    borderRadius: 999, padding: '4px 8px', fontSize: 12, outline: 'none',
                  }}
                />
                <select
                  value={singleAccountNew.type}
                  onChange={e => setSingleAccountNew(prev => ({ ...prev, type: e.target.value }))}
                  style={{
                    width: 96,
                    background: 'var(--surface)', color: 'var(--text)',
                    border: '1px solid var(--border)', borderRadius: 999,
                    padding: '4px 8px', fontSize: 11,
                  }}
                >
                  {ACCOUNT_TYPES.map(option => (
                    <option key={option.value} value={option.value}>{option.shortLabel}</option>
                  ))}
                </select>
                {accounts.some(a => a.name.toLowerCase() === singleAccountNew.name.trim().toLowerCase()) && (
                  <div style={{ width: '100%', fontSize: 11, color: 'var(--danger)' }}>
                    Account name already exists. Select it from the list instead.
                  </div>
                )}
              </div>
            )}

            <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13 }}>
                <input type="checkbox" checked={applyCat} onChange={e => setApplyCat(e.target.checked)} />
                Apply categorization rules on import
              </label>
              {!selectedProfile ? (
                <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  {showManualDraftSave ? (
                    <>
                      <TransientTextInput
                        value={manualDraftSaveName}
                        onChange={setManualDraftSaveName}
                        onCommit={() => saveManualDraftAsDataSource({
                          draftRecord: buildCurrentManualDraftRecord(),
                          activateAfterSave: true,
                        })}
                        onCancel={() => {
                          setShowManualDraftSave(false)
                          setManualDraftSaveName('')
                        }}
                        restoreOnEscape
                        onBlurCommit={false}
                        placeholder="Data source name"
                        style={{
                          width: 200,
                          maxWidth: '100%',
                          background: 'var(--surface2)',
                          color: 'var(--text)',
                          border: '1px solid var(--accent)',
                          borderRadius: 999,
                          padding: '5px 12px',
                          fontSize: 12,
                          outline: 'none',
                        }}
                      />
                      <Button
                        small
                        onClick={() => saveManualDraftAsDataSource({
                          draftRecord: buildCurrentManualDraftRecord(),
                          activateAfterSave: true,
                        })}
                        disabled={!manualDraftSaveName.trim() || !canCreateDataSourceFromCurrentMapping() || savingManualDraftSource}
                      >
                        {savingManualDraftSource ? 'Creating…' : 'Create'}
                      </Button>
                      <Button
                        small
                        variant="ghost"
                        onClick={() => {
                          setShowManualDraftSave(false)
                          setManualDraftSaveName('')
                        }}
                      >
                        Cancel
                      </Button>
                    </>
                  ) : (
                    <span title={!canCreateDataSourceFromCurrentMapping() && !loading ? getCreateDataSourceDisabledReason() : ''}>
                      <Button
                        small
                        variant="ghost"
                        onClick={() => openManualDraftSaveEditor(inferFilenamePattern(preview?.filename) || '')}
                        disabled={!canCreateDataSourceFromCurrentMapping() || loading}
                      >
                        Create data source
                      </Button>
                    </span>
                  )}
                </div>
              ) : null}
            </div>
          </Card>

          {colAccount && distinctAccountValues.length > 0 && (
            <Card style={{ padding: 0, overflow: 'hidden', width: IMPORT_CONFIG_MAX_WIDTH }}>
              <div style={{
                display: 'grid', gridTemplateColumns: '1fr 16px 240px 52px',
                padding: '6px 14px', gap: 12,
                fontSize: 11, fontWeight: 600, color: 'var(--muted)',
                borderBottom: '1px solid var(--border)',
                background: 'var(--surface2)',
              }}>
                <span>Account from file</span>
                <span></span>
                <span>Maps To</span>
                <span style={{ textAlign: 'center' }}>Skip</span>
              </div>
              {distinctAccountValues.map(csvVal => {
                const DEFAULT_ENTRY = { accountId: '', createNew: false, newName: csvVal, newType: 'depository', skip: false }
                const m = { ...DEFAULT_ENTRY, ...(accountMap[csvVal] || {}) }
                const update = patch => setAccountMap(prev => ({
                  ...prev,
                  [csvVal]: { ...DEFAULT_ENTRY, ...(prev[csvVal] || {}), ...patch }
                }))
                const alreadyImported = previousImportAccountsByValue.get(csvVal)
                return (
                  <div key={csvVal} style={{
                    display: 'grid', gridTemplateColumns: '1fr 16px 240px 52px',
                    gap: 12, padding: '7px 14px', alignItems: 'center',
                    borderBottom: '1px solid var(--border)',
                    opacity: alreadyImported ? 0.5 : (m.skip ? 0.45 : 1),
                  }}>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={csvVal}>{csvVal}</div>
                      {alreadyImported ? (
                        <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 1 }}>
                          Already imported · {alreadyImported.row_count} rows
                        </div>
                      ) : null}
                    </div>

                    <span style={{ color: 'var(--muted)', textAlign: 'center', fontSize: 11 }}>→</span>

                    {alreadyImported ? (
                      <span style={{ fontSize: 12, color: 'var(--muted)', fontStyle: 'italic' }}>
                        already imported
                      </span>
                    ) : m.skip ? (
                      <span style={{ fontSize: 12, color: 'var(--muted)', fontStyle: 'italic' }}>
                        skipping {Number(accountValueCounts[csvVal] || 0)} transaction{Number(accountValueCounts[csvVal] || 0) === 1 ? '' : 's'}
                      </span>
                    ) : !m.createNew ? (
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center', minWidth: 0 }}>
                        <select
                          value={m.accountId}
                          onChange={e => update({ accountId: e.target.value })}
                          style={{
                            width: 170, maxWidth: '100%', background: 'var(--surface2)', color: 'var(--text)',
                            border: '1px solid var(--border)', borderRadius: 6,
                            padding: '5px 6px', fontSize: 12,
                          }}
                        >
                          <option value="">— Select —</option>
                          {accounts.map(a => (
                            <option key={a.id} value={a.id}>{a.name}{a.mask ? ` ···${a.mask}` : ''}</option>
                          ))}
                        </select>
                        {m.accountId ? (
                          <button
                            onClick={() => update({ accountId: '', createNew: false, newName: csvVal })}
                            style={{
                              flexShrink: 0, background: 'none', border: '1px solid var(--border)',
                              borderRadius: 6, color: 'var(--muted)', cursor: 'pointer',
                              fontSize: 13, width: 28, height: 28, lineHeight: 1, padding: 0,
                            }}
                            aria-label="Clear account mapping"
                          >
                            ×
                          </button>
                        ) : (
                          <button onClick={() => update({ createNew: true, newName: csvVal })} style={{
                            flexShrink: 0, background: 'none', border: '1px solid var(--border)',
                            borderRadius: 6, color: 'var(--accent2)', cursor: 'pointer',
                            fontSize: 11, padding: '4px 7px', whiteSpace: 'nowrap',
                          }}>+New</button>
                        )}
                      </div>
                    ) : (
                      <div style={{ display: 'flex', gap: 4, alignItems: 'center', minWidth: 0, flexWrap: 'nowrap' }}>
                        <div style={{ width: 132, maxWidth: '100%' }}>
                          <input value={m.newName} onChange={e => update({ newName: e.target.value })}
                            placeholder="Name" style={{
                              width: '100%', background: 'var(--surface2)', color: 'var(--text)',
                              border: `1px solid ${accounts.some(a => a.name.toLowerCase() === m.newName.trim().toLowerCase()) ? 'var(--danger)' : 'var(--accent)'}`,
                              borderRadius: 6, padding: '4px 6px', fontSize: 12, outline: 'none',
                            }} />
                          {accounts.some(a => a.name.toLowerCase() === m.newName.trim().toLowerCase()) && (
                            <div style={{ fontSize: 10, color: 'var(--danger)', marginTop: 2 }}>
                              Name already exists — select it instead
                            </div>
                          )}
                        </div>
                        <select value={m.newType} onChange={e => update({ newType: e.target.value })}
                          style={{ width: 76, background: 'var(--surface2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: '4px 5px', fontSize: 11 }}>
                          {ACCOUNT_TYPES.map(option => (
                            <option key={option.value} value={option.value}>{option.shortLabel}</option>
                          ))}
                        </select>
                        <button onClick={() => update({ createNew: false, accountId: '' })}
                          style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 13, padding: '2px', flexShrink: 0 }}>✕</button>
                      </div>
                    )}

                    <div style={{ display: 'flex', justifyContent: 'center' }}>
                      {alreadyImported ? (
                        <span style={{ fontSize: 11, color: 'var(--muted)' }}>—</span>
                      ) : (
                        <input
                          type="checkbox"
                          checked={!!m.skip}
                          onChange={e => update({ skip: e.target.checked })}
                          style={{ width: 15, height: 15, cursor: 'pointer', accentColor: 'var(--accent)' }}
                        />
                      )}
                    </div>
                  </div>
                )
              })}
            </Card>
          )}

          <Card style={{ padding: 0, overflow: 'hidden', width: IMPORT_CONFIG_MAX_WIDTH }}>
            <div style={{ padding: '10px 16px', fontSize: 13, fontWeight: 600, borderBottom: '1px solid var(--border)' }}>
              First {previewRows.length} transactions from file
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: `110px 1fr${colCategory ? ' 140px' : ''}${colAccount ? ' 130px' : ''} 100px`, padding: '7px 16px', fontSize: 11, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em', borderBottom: '1px solid var(--border)' }}>
              <span>Date</span><span>Merchant</span>
              {colCategory && <span>Category</span>}
              {colAccount && <span>Account</span>}
              <span style={{ textAlign: 'right' }}>Amount</span>
            </div>
            {previewRows.length === 0 ? (
              <div style={{ padding: '16px', fontSize: 13, color: 'var(--muted)', textAlign: 'center' }}>Map at least the date and description columns to see a preview</div>
            ) : previewRows.map(r => (
              <div key={r.i} style={{ display: 'grid', gridTemplateColumns: `110px 1fr${colCategory ? ' 140px' : ''}${colAccount ? ' 130px' : ''} 100px`, padding: '8px 16px', fontSize: 13, borderBottom: '1px solid var(--border)' }}>
                <span style={{ color: r.rawDate ? 'var(--text)' : 'var(--muted)', fontSize: 12 }}>{r.rawDate || <span style={{ opacity: 0.4 }}>—</span>}</span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.rawDesc || <span style={{ color: 'var(--muted)', opacity: 0.4 }}>—</span>}</span>
                {colCategory && <span style={{ fontSize: 12, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.rawCat || <span style={{ opacity: 0.4 }}>—</span>}</span>}
                {colAccount && <span style={{ fontSize: 12, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.rawAcct || <span style={{ opacity: 0.4 }}>—</span>}</span>}
                <span style={{ textAlign: 'right', fontWeight: 600, color: r.amount !== null ? getTransactionAmountColor(r.amount) : 'var(--danger)', fontSize: r.amount !== null ? 13 : 11 }}>
                  {r.amount !== null
                    ? formatTransactionAmount(r.amount)
                    : r.rawAmountStr
                      ? <span title={`Can't parse: "${r.rawAmountStr}"`} style={{ opacity: 0.6 }}>?{r.rawAmountStr.slice(0, 10)}</span>
                      : <span style={{ opacity: 0.4 }}>—</span>
                  }
                </span>
              </div>
            ))}
          </Card>

          <div style={{ display: 'flex', gap: 10 }}>
            <span title={!canImport() && !loading ? getImportDisabledReason() : ''}>
              <Button onClick={runImport} disabled={!canImport() || loading}>
                {loading ? 'Importing…' : `Import ${importableRowCount} rows`}
              </Button>
            </span>
            <Button variant="ghost" onClick={resetImport}>Cancel</Button>
          </div>
        </div>
      )}

      {stage === 'category-mapping' && importResult && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 1000,
            background: 'rgba(15, 23, 42, 0.48)',
            padding: 24,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              width: 'min(1120px, 100%)',
              maxHeight: '100%',
              display: 'flex',
              flexDirection: 'column',
              background: 'var(--surface)',
              borderRadius: 16,
              border: '1px solid var(--border)',
              boxShadow: '0 28px 80px rgba(15, 23, 42, 0.28)',
              overflow: 'hidden',
            }}
          >
            <div style={{
              padding: '18px 22px 12px',
              borderBottom: '1px solid var(--border)',
              background: 'linear-gradient(to bottom, var(--surface), color-mix(in srgb, var(--surface2) 65%, var(--surface)))',
            }}>
              <div style={{ display: 'flex', alignItems: 'start', justifyContent: 'space-between', gap: 16 }}>
                <div>
                  <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 6 }}>Map imported categories</div>
                  <div style={{ fontSize: 13, color: 'var(--muted)' }}>
                    Mappings are saved with the data source
                  </div>
                </div>
              </div>
            </div>
            <div style={{ padding: 22, overflow: 'auto', flex: 1 }}>
              <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
                gap: '8px 0',
              }}>
                {categoryMappingRows.map((row, idx) => (
                  <div key={row.rawValue} style={{
                    display: 'grid',
                    gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1.35fr)',
                    gap: 10,
                    alignItems: 'center',
                    padding: '6px 14px 6px 0',
                    borderBottom: '1px solid var(--border)',
                    borderRight: idx % 2 === 0 ? '1px solid var(--border)' : 'none',
                    paddingLeft: idx % 2 === 1 ? 14 : 0,
                  }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={row.rawValue}>
                        {row.rawValue}
                      </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifySelf: 'stretch', minWidth: 0 }}>
                      <button
                        type="button"
                        onClick={() => setCategoryMappingRows(prev => prev.map((item, i) => i === idx ? {
                          ...item,
                          chooserQuery: row.rawValue,
                          chooserToken: (item.chooserToken || 0) + 1,
                        } : item))}
                        style={{
                          flexShrink: 0,
                          background: 'none',
                          border: '1px solid var(--border)',
                          borderRadius: 6,
                          color: 'var(--accent2)',
                          cursor: 'pointer',
                          fontSize: 11,
                          padding: '4px 7px',
                          whiteSpace: 'nowrap',
                        }}
                        title={`Use "${row.rawValue}" in the category chooser`}
                      >
                        Use file text
                      </button>
                      <CategoryPicker
                        value={row.categoryId}
                        categories={categories}
                        onChange={categoryId => setCategoryMappingRows(prev => prev.map((item, i) => i === idx ? { ...item, categoryId } : item))}
                        onAddCategory={cat => setCategories(prev => prev.find(c => c.id === cat.id) ? prev : [...prev, cat])}
                        initialQuery={row.chooserQuery || ''}
                        openToken={row.chooserToken || 0}
                        showSelectedBadge
                        emptyBadgeLabel="not mapped"
                        compact
                        style={{ width: '100%', maxWidth: 280, minWidth: 0 }}
                      />
                      <div style={{ fontSize: 11, color: 'var(--muted)', whiteSpace: 'nowrap', minWidth: 46, textAlign: 'right' }}>
                        {row.rowCount} row{row.rowCount !== 1 ? 's' : ''}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div style={{
              padding: '14px 22px 18px',
              borderTop: '1px solid var(--border)',
              display: 'flex',
              gap: 10,
              justifyContent: 'flex-end',
              background: 'var(--surface)',
            }}>
              <Button variant="ghost" onClick={() => setStage('done')}>Close without mapping</Button>
              <Button onClick={applyImportedCategoryMappings} disabled={loading || !canApplyCategoryMappings()}>
                {loading ? 'Applying…' : 'Apply category mappings'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {stage === 'review-data' && importResult && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 1000,
            background: 'rgba(15, 23, 42, 0.48)',
            padding: 24,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              width: 'min(880px, 100%)',
              display: 'flex',
              flexDirection: 'column',
              background: 'var(--surface)',
              borderRadius: 16,
              border: '1px solid var(--border)',
              boxShadow: '0 28px 80px rgba(15, 23, 42, 0.28)',
              overflow: 'hidden',
            }}
          >
            <div style={{
              padding: '18px 22px 12px',
              borderBottom: '1px solid var(--border)',
              background: 'linear-gradient(to bottom, var(--surface), color-mix(in srgb, var(--surface2) 65%, var(--surface)))',
            }}>
              <div style={{ display: 'flex', alignItems: 'start', justifyContent: 'space-between', gap: 16 }}>
                <div>
                  <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 6 }}>Review imported file tail</div>
                  <div style={{ fontSize: 13, color: 'var(--muted)' }}>
                    The raw file viewer contains the start of what may be a trailer record. If the ending text is expected, choose Continue. If not, choose Cancel and nothing will be imported from the file.
                  </div>
                </div>
              </div>
            </div>
            <div style={{ padding: 22, display: 'grid', gap: 14 }}>
              <div style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
                <Button variant="ghost" onClick={cancelTrailingDataReview} disabled={loading}>
                  Cancel
                </Button>
                <Button onClick={advancePastDataReview} disabled={loading}>
                  Continue
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {stage === 'done' && importResult && (
        <Card>
          {(() => {
            const summary = summarizeImportOutcome(importResult)
            const parts = []
            if (summary.accountSkippedCount > 0) {
              parts.push(
                <span key="skipped-accounts">{summary.accountSkippedCount} from skipped accounts</span>
              )
            }
            if (summary.rejectedCount > 0) {
              parts.push(
                <button
                  key="rejected-rows"
                  type="button"
                  onClick={() => openRejectedRowsViewer({
                    source: importResult,
                    title: 'this import',
                    allowRawViewer: true,
                  })}
                  style={{ background: 'none', border: 'none', padding: 0, color: 'var(--accent2)', textDecoration: 'underline', cursor: 'pointer', fontSize: 'inherit' }}
                >
                  {summary.rejectedCount} rejected row{summary.rejectedCount === 1 ? '' : 's'}
                </button>
              )
            }
            if (summary.zeroAmountCount > 0) {
              parts.push(
                <span key="zero-amount-rows">{summary.zeroAmountCount} zero amount</span>
              )
            }
            if (summary.validationErrorCount > 0) {
              parts.push(
                <span key="validation-errors">{summary.validationErrorCount} validation error{summary.validationErrorCount === 1 ? '' : 's'}</span>
              )
            }
            if (summary.trailingNonTransactionCount > 0) {
              parts.push(
                <span key="non-transaction-rows">{summary.trailingNonTransactionCount} non-transaction rows</span>
              )
            }
            if (summary.otherSkippedCount > 0) {
              parts.push(
                <span key="other-skipped">{summary.otherSkippedCount} other skipped</span>
              )
            }

            return (
              <>
                <div style={{ fontSize: 18, marginBottom: 8 }}>✅ Import complete</div>
                <div style={{ fontSize: 14, color: 'var(--muted)', marginBottom: 4 }}>
                  {summary.importedCount} transactions imported.
                </div>
                {summary.totalRows > 0 ? (
                  <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 8 }}>
                    {summary.totalRows} rows reviewed: {summary.importedCount} imported, {summary.skippedCount} not imported, {summary.dedupedCount} deduped.
                  </div>
                ) : null}
                {summary.dedupedCount > 0 ? (
                  <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 8 }}>
                    <button
                      type="button"
                      onClick={() => openDuplicateRowsViewer({
                        source: importResult,
                        title: 'this import',
                      })}
                      style={{ background: 'none', border: 'none', padding: 0, color: 'var(--accent2)', textDecoration: 'underline', cursor: 'pointer', fontSize: 'inherit' }}
                    >
                      {summary.dedupedCount} duplicate row{summary.dedupedCount === 1 ? '' : 's'}
                    </button>
                    {' '}matched existing FinTrack transactions and were not imported automatically.
                  </div>
                ) : null}
                {summary.skippedCount > 0 ? (
                  <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 8 }}>
                    {summary.skippedCount} rows not imported
                    {parts.length > 0 ? (
                      <>
                        {' ('}
                        {parts.map((part, index) => (
                          <span key={index}>
                            {index > 0 ? ', ' : ''}
                            {part}
                          </span>
                        ))}
                        {')'}
                      </>
                    ) : null}
                    .
                  </div>
                ) : null}
              </>
            )
          })()}
          {categoryMappingSummary && (
            <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 8 }}>
              {categoryMappingSummary.saved_mapping_count} imported categor{categoryMappingSummary.saved_mapping_count === 1 ? 'y mapping was' : 'y mappings were'} saved.
              {categoryMappingSummary.applied_count > 0 && ` ${categoryMappingSummary.applied_count} transaction${categoryMappingSummary.applied_count === 1 ? ' was' : 's were'} updated.`}
              {categoryMappingSummary.categorized_by_rules > 0 && ` ${categoryMappingSummary.categorized_by_rules} remaining transaction${categoryMappingSummary.categorized_by_rules === 1 ? '' : 's'} were categorized by rules.`}
            </div>
          )}
          {importResult.has_imported_categories ? (
            <div style={{
              marginBottom: 16,
              padding: '12px 14px',
              borderRadius: 12,
              background: 'color-mix(in srgb, var(--accent) 7%, var(--surface2))',
              border: '1px solid color-mix(in srgb, var(--accent) 24%, var(--border))',
            }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>
                Rules can be generated from the categorized rows in this import.
              </div>
              <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.55, marginBottom: 10 }}>
                This is most useful for migration imports where the file already has meaningful categories. The review is separate from importing categories into the category tree, and it can be completed later from Recent imports.
              </div>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                {hasCurrentImportCategoryWorkspace ? (
                  <Button
                    small
                    variant={remainingCategoryCount > 0 ? 'primary' : 'ghost'}
                    onClick={() => {
                      if (selectedProfile) openSourceCategoryWorkspace(selectedProfile)
                      else openCurrentImportCategoryWorkspace()
                    }}
                  >
                    {currentImportCategoryActionLabel}
                  </Button>
                ) : null}
                <Button small onClick={() => openRuleSuggestionReview({
                  batchId: importResult.batch_id,
                  profileId: selectedProfile || '',
                })}>
                  Generate rules from imported data
                </Button>
              </div>
            </div>
          ) : null}
          {importResult.new_accounts_without_owner > 0 && (
            <div style={{
              fontSize: 13, marginBottom: 16, padding: '8px 12px',
              background: 'color-mix(in srgb, var(--accent2) 8%, var(--surface2))',
              border: '1px solid color-mix(in srgb, var(--accent2) 30%, var(--border))',
              borderRadius: 8,
            }}>
              {importResult.new_accounts_without_owner} new account{importResult.new_accounts_without_owner > 1 ? 's were' : ' was'} created without an owner.
              {' '}These accounts have no owner assigned — visit{' '}
              <Link to="/accounts" style={{ color: 'var(--accent2)', textDecoration: 'none' }}>
                Accounts
              </Link>
              {' '}to assign one.
            </div>
          )}
          {importResult.errors?.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6, color: 'var(--danger)' }}>{importResult.errors.length} validation error{importResult.errors.length === 1 ? '' : 's'}:</div>
              {importResult.errors.map((e, i) => <div key={i} style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 3 }}>Row {e.row}: {e.reason}</div>)}
            </div>
          )}
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            {importResult?.batch_id ? (
              <Button
                variant="danger"
                onClick={() => handleUndoClick(getUndoTargetForSource(importResult))}
              >
                Undo import
              </Button>
            ) : null}
            <Button onClick={resetImport}>Import another file</Button>
          </div>
        </Card>
      )}

      {stage !== 'mapping' && (
        <>
          <div style={{ marginTop: 28, marginBottom: 6 }}>
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
          </div>
          <Card style={{ padding: 0, overflow: 'hidden', width: '100%' }}>
            {dataSourceRows.length === 0 ? <EmptyState message="No data sources or temporary drafts yet" /> : (
              <>
                {dataSourceRows.map(row => {
                  const isManual = row.kind === 'manual'
                  const isUnknown = row.kind === 'unknown'
                  const isUnsaved = isManual || isUnknown
                  const hasCategoryWorkspace = row.categorySummary.totalCount > 0
                  const categoryActionLabel = getCategoryWorkspaceActionLabel(row.categorySummary.remainingCount)
                  const rowExpanded = !!expandedSourceRows[row.key]
                  const canExpand = row.batches.length > 0
                  const importedFileCountLabel = row.batches.length === 1 ? '1 imported file' : `${row.batches.length} imported files`
                  const sourceRuleProgressLabel = getRuleSuggestionProgressLabel({ rule_suggestion_review: row.ruleSuggestionReview })

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
                                  onBlurCommit={false}
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
                                  onBlurCommit={false}
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
                              <span>{importedFileCountLabel}</span>
                              {row.latestBatch ? (
                                <span style={{ marginLeft: 12 }}>
                                  Last used {row.latestBatch.imported_at.slice(0, 16).replace('T', ' ')}
                                </span>
                              ) : null}
                              {!isUnsaved && row.hasImportedCategories && sourceRuleProgressLabel ? (
                                <span>{sourceRuleProgressLabel}</span>
                              ) : null}
                            </div>
                          </div>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap', flexShrink: 0 }}>
                          {hasCategoryWorkspace && !isUnknown ? (
                            <button
                              type="button"
                              onClick={() => openSourceCategoryWorkspace(isManual ? MANUAL_DATA_SOURCE_VALUE : row.profile.id)}
                              style={{
                                background: row.categorySummary.remainingCount > 0
                                  ? 'color-mix(in srgb, var(--accent) 10%, var(--surface2))'
                                  : 'var(--surface2)',
                                color: row.categorySummary.remainingCount > 0 ? 'var(--accent2)' : 'var(--muted)',
                                border: `1px solid ${row.categorySummary.remainingCount > 0 ? 'color-mix(in srgb, var(--accent) 28%, var(--border))' : 'var(--border)'}`,
                                borderRadius: 6,
                                padding: '4px 10px',
                                fontSize: 12,
                                fontWeight: row.categorySummary.remainingCount > 0 ? 600 : 500,
                                cursor: 'pointer',
                                whiteSpace: 'nowrap',
                              }}
                            >
                              {categoryActionLabel}
                            </button>
                          ) : null}
                          {!isUnsaved && row.hasImportedCategories ? (
                            <button
                              type="button"
                              onClick={() => openRuleSuggestionReview({ profileId: row.profile.id })}
                              style={{
                                background: 'color-mix(in srgb, var(--accent) 10%, var(--surface2))',
                                border: '1px solid color-mix(in srgb, var(--accent) 28%, var(--border))',
                                borderRadius: 6,
                                color: 'var(--accent2)',
                                cursor: 'pointer',
                                fontSize: 12,
                                fontWeight: 600,
                                padding: '4px 10px',
                                whiteSpace: 'nowrap',
                              }}
                            >
                              {getRuleSuggestionActionLabel(row.ruleSuggestionReview)}
                            </button>
                          ) : null}
                          {isManual && row.manualDraftRecord ? (
                            showManualDraftSave ? (
                              <TransientTextInput
                                value={manualDraftSaveName}
                                onChange={setManualDraftSaveName}
                                onCommit={saveManualDraftAsDataSource}
                                onCancel={() => {
                                  setShowManualDraftSave(false)
                                  setManualDraftSaveName('')
                                }}
                                restoreOnEscape
                                onBlurCommit={false}
                                placeholder="Data source name"
                                style={{
                                  width: 180,
                                  maxWidth: '100%',
                                  background: 'var(--surface2)',
                                  color: 'var(--text)',
                                  border: '1px solid var(--accent)',
                                  borderRadius: 999,
                                  padding: '5px 12px',
                                  fontSize: 12,
                                  outline: 'none',
                                }}
                              />
                            ) : (
                              <button
                                type="button"
                                onClick={() => {
                                  const prefix = inferFilenamePattern(manualDraftRecord?.templateFilename || '')
                                  openManualDraftSaveEditor(prefix)
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
                            )
                          ) : null}
                        </div>
                      </div>

                      {canExpand && rowExpanded ? (
                        <div style={{ borderTop: '2px solid color-mix(in srgb, var(--border) 92%, var(--accent))', borderBottom: '1px solid var(--border)', background: 'color-mix(in srgb, var(--surface2) 36%, var(--surface))', boxShadow: 'inset 0 1px 0 color-mix(in srgb, white 5%, transparent)' }}>
                          {row.batches.map(b => {
                            const summary = summarizeImportOutcome(b)
                            return (
                              <div key={b.id}>
                                <div style={{ display: 'grid', gridTemplateColumns: '1fr 160px 90px 260px', padding: '10px 16px 10px 46px', alignItems: 'start', fontSize: 13, borderBottom: (b.accounts?.length || summary.rejectedCount > 0 || summary.dedupedCount > 0) ? 'none' : '1px solid color-mix(in srgb, var(--border) 80%, transparent)' }}>
                                  <div>
                                    <div>{b.filename}</div>
                                    {isUnsaved && b.has_imported_categories && getRuleSuggestionProgressLabel(b) ? (
                                      <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 3 }}>
                                        {getRuleSuggestionProgressLabel(b)}
                                      </div>
                                    ) : null}
                                  </div>
                                  <span style={{ fontSize: 12, color: 'var(--muted)' }}>{b.imported_at.slice(0, 16).replace('T', ' ')}</span>
                                  <span style={{ textAlign: 'center' }}>{b.row_count} rows</span>
                                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-end' }}>
                                    <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                                      {isUnsaved && b.has_imported_categories ? (
                                        <button
                                          type="button"
                                          onClick={() => openRuleSuggestionReview({ batchId: b.id })}
                                          style={{
                                            background: 'color-mix(in srgb, var(--accent) 10%, var(--surface2))',
                                            border: '1px solid color-mix(in srgb, var(--accent) 28%, var(--border))',
                                            borderRadius: 6,
                                            color: 'var(--accent2)',
                                            cursor: 'pointer',
                                            fontSize: 12,
                                            fontWeight: 600,
                                            padding: '3px 8px',
                                          }}
                                        >
                                          {getRuleSuggestionActionLabel(b.rule_suggestion_review)}
                                        </button>
                                      ) : null}
                                      <button onClick={() => handleUndoClick(b)} style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--danger)', cursor: 'pointer', fontSize: 12, padding: '3px 8px' }}>Undo</button>
                                    </div>
                                    {isUnsaved && b.category_workspace_summary ? (
                                      <button
                                        onClick={() => openBatchCategoryWorkspace(b.id)}
                                        style={{
                                          background: b.category_workspace_summary.remaining_count > 0
                                            ? 'color-mix(in srgb, var(--accent) 10%, var(--surface2))'
                                            : 'var(--surface2)',
                                          border: `1px solid ${b.category_workspace_summary.remaining_count > 0 ? 'color-mix(in srgb, var(--accent) 28%, var(--border))' : 'var(--border)'}`,
                                          borderRadius: 6,
                                          color: b.category_workspace_summary.remaining_count > 0 ? 'var(--accent2)' : 'var(--muted)',
                                          cursor: 'pointer',
                                          fontSize: 12,
                                          fontWeight: b.category_workspace_summary.remaining_count > 0 ? 600 : 500,
                                          padding: '3px 8px',
                                          whiteSpace: 'nowrap',
                                        }}
                                      >
                                        {getCategoryWorkspaceActionLabel(b.category_workspace_summary.remaining_count)}
                                      </button>
                                    ) : null}
                                  </div>
                                </div>
                                {(b.accounts?.length > 0 || summary.rejectedCount > 0 || summary.dedupedCount > 0) && (
                                  <div style={{ padding: '4px 16px 10px 58px', borderBottom: '1px solid color-mix(in srgb, var(--border) 80%, transparent)', display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                                    {b.accounts.map((a, i) => {
                                      const label = a.was_skipped ? a.csv_value : a.account_name
                                      const count = Number(a.row_count || 0)
                                      const truncated = label?.length > 22 ? label.slice(0, 20) + '…' : label
                                      return (
                                        <span key={i} title={label} style={{
                                          display: 'inline-flex', alignItems: 'center', gap: 4,
                                          fontSize: 11, padding: '2px 7px', borderRadius: 99,
                                          background: a.was_skipped
                                            ? 'var(--surface2)'
                                            : 'color-mix(in srgb, var(--accent) 10%, var(--surface2))',
                                          color: a.was_skipped ? 'var(--muted)' : 'var(--text)',
                                          border: '1px solid var(--border)',
                                        }}>
                                          <span style={{ color: a.was_skipped ? 'var(--muted)' : 'var(--success)', fontWeight: 600 }}>
                                            {a.was_skipped ? '✕' : '✓'}
                                          </span>
                                          {truncated}
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
                                        {summary.rejectedCount} rejected
                                      </button>
                                    ) : null}
                                    {summary.dedupedCount > 0 ? (
                                      <button
                                        type="button"
                                        onClick={() => openDuplicateRowsViewer({
                                          source: b,
                                          title: b.filename,
                                        })}
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
                                        {summary.dedupedCount} duplicates
                                      </button>
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
      )}

      {showDataSourceManager ? (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 320,
            background: 'rgba(15, 23, 42, 0.42)',
          }}
        >
          {(() => {
            const managerPanelStyle = getFloatingPanelSurfaceStyle({
              active: !dataSourceManagerEditing,
              radius: 16,
            })
            return (
              <div
                ref={dataSourceManagerRef}
                onClick={event => event.stopPropagation()}
                style={{
                  width: 'min(1040px, calc(100vw - 96px))',
                  minHeight: 380,
                  maxHeight: '78vh',
                  position: 'fixed',
                  left: (dataSourceManagerPos || getDataSourceManagerDefaultPosition()).x,
                  top: (dataSourceManagerPos || getDataSourceManagerDefaultPosition()).y,
                  overflow: 'hidden',
                  display: 'grid',
                  gridTemplateRows: 'auto minmax(0, 1fr)',
                  userSelect: dataSourceManagerDragging ? 'none' : 'auto',
                  ...managerPanelStyle,
                }}
              >
                <div
                  onMouseDown={startDataSourceManagerDrag}
                  style={{
                    padding: '16px 20px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 12,
                    borderBottom: '1px solid var(--border)',
                    background: getFloatingPanelHeaderBackground(!dataSourceManagerEditing),
                    cursor: dataSourceManagerEditing ? 'default' : (dataSourceManagerDragging ? 'grabbing' : 'grab'),
                  }}
                >
                  <div>
                    <div style={{ fontSize: 17, fontWeight: 600 }}>Manage data sources</div>
                    <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4 }}>
                      Edit saved CSV data sources without leaving Import / Export.
                      {!dataSourceManagerEditing ? ' Drag to move.' : ''}
                    </div>
                  </div>
                  {!dataSourceManagerEditing ? (
                    <Button
                      variant="ghost"
                      onMouseDown={event => event.stopPropagation()}
                      onClick={closeDataSourceManager}
                    >
                      Close
                    </Button>
                  ) : <div style={{ width: 74 }} />}
                </div>
                <div style={{ overflow: 'auto', background: 'color-mix(in srgb, var(--surface2) 30%, var(--surface))' }}>
                  <ImportProfilesManager
                    embedded
                    onEditingChange={setDataSourceManagerEditing}
                    onDataChange={handleManagerDataChange}
                  />
                </div>
              </div>
            )
          })()}
        </div>
      ) : null}

      {pendingProfileMismatch ? (
        <DataSourceMismatchDialog
          profileName={pendingProfileMismatch.profileName}
          chooserOpen={showProfileMismatchChooser}
          profiles={profiles}
          selectedProfileId={showProfileMismatchChooser ? pendingProfileMismatch.profileId : ''}
          fileHeaderFingerprint={pendingProfileMismatch.previewLike?.header_fingerprint || ''}
          onSelectProfile={handleProfileMismatchSelectSource}
          onSelectTemporaryDraft={() => handleProfileMismatchSelectSource(MANUAL_DATA_SOURCE_VALUE)}
          onCloseChooser={handleProfileMismatchChooserBack}
          onConfirm={handleProfileMismatchConfirm}
          onCancel={handleProfileMismatchCancel}
          onChangeDataSource={handleProfileMismatchChangeDataSource}
        />
      ) : null}

      {undoTarget && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 300, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Card style={{ width: 480, maxHeight: '80vh', overflow: 'auto' }}>
            <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>Undo import: {undoTarget.filename}</div>
            <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 16 }}>This will permanently delete {undoTarget.row_count - (undoTarget.skipped_count || 0) - (undoTarget.deduped_count || 0)} transactions.</div>
            {undoLoading ? <Spinner /> : undoEdited.length > 0 ? (
              <>
                <div style={{ background: 'color-mix(in srgb, var(--danger) 10%, var(--surface2))', border: '1px solid var(--danger)', borderRadius: 8, padding: '10px 14px', marginBottom: 16 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6, color: 'var(--danger)' }}>⚠ {undoEdited.length} transactions were manually edited after import</div>
                  <div style={{ maxHeight: 180, overflowY: 'auto' }}>
                    {undoEdited.map(t => (
                      <div key={t.id} style={{ display: 'grid', gridTemplateColumns: '90px 1fr 80px', fontSize: 12, padding: '4px 0', borderBottom: '1px solid var(--border)' }}>
                        <span style={{ color: 'var(--muted)' }}>{t.date}</span>
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.display_name || t.merchant_name || t.raw_name}</span>
                        <span style={{ textAlign: 'right', color: getTransactionAmountColor(t.amount) }}>{formatTransactionAmount(t.amount)}</span>
                      </div>
                    ))}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 10 }}>
                  <Button variant="danger" onClick={() => confirmUndo(true)}>Delete all anyway</Button>
                  <Button variant="ghost" onClick={() => { setUndoTarget(null); setUndoEdited([]) }}>Cancel</Button>
                </div>
              </>
            ) : (
              <div style={{ display: 'flex', gap: 10 }}>
                <Button variant="danger" onClick={() => confirmUndo(false)}>Delete {undoTarget.row_count - (undoTarget.skipped_count || 0) - (undoTarget.deduped_count || 0)} transactions</Button>
                <Button variant="ghost" onClick={() => setUndoTarget(null)}>Cancel</Button>
              </div>
            )}
          </Card>
        </div>
      )}
    </div>
  )
}

function ExportTab() {
  const { filters } = useFilters()
  const [selectedCols, setSelectedCols] = useState(new Set(DEFAULT_EXPORT_COLS))

  function toggleCol(key) {
    setSelectedCols(prev => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n })
  }

  function downloadCsv() {
    const accountSel = filters.selections.filter(s => s.type === 'account').map(s => s.id)
    const ownerSel = filters.selections.filter(s => s.type === 'owner').map(s => s.id)
    const groupSel = filters.selections.filter(s => s.type === 'group').map(s => s.id)
    const categorySel = filters.selections.filter(s => s.type === 'category').map(s => s.id)
    window.open(api.exportTransactionsCsv({
      columns: [...selectedCols].join(','),
      date_start: filters.date?.start || undefined, date_end: filters.date?.end || undefined,
      account_ids: accountSel.length ? accountSel.join(',') : undefined,
      owner_ids: ownerSel.length ? ownerSel.join(',') : undefined,
      group_ids: groupSel.length ? groupSel.join(',') : undefined,
      category_ids: categorySel.length ? categorySel.join(',') : undefined,
    }), '_blank')
  }

  return (
    <div>
      <SectionTitle>Export transactions to a .csv file</SectionTitle>
      <Card>
        <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 14 }}>Select columns to include:</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginBottom: 16 }}>
          {EXPORT_COLUMNS.map(col => (
            <label key={col.key} style={{ display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer', fontSize: 13 }}>
              <input type="checkbox" checked={selectedCols.has(col.key)} onChange={() => toggleCol(col.key)} />{col.label}
            </label>
          ))}
        </div>
        <div style={{ display: 'grid', gap: 8, justifyItems: 'start' }}>
          <Button onClick={downloadCsv} disabled={selectedCols.size === 0}>Generate File</Button>
          {filters.date || filters.selections.length > 0 ? (
            <div style={{ fontSize: 12, color: 'var(--accent2)' }}>
              Only transactions matching the current filter will be exported.
            </div>
          ) : null}
        </div>
      </Card>
    </div>
  )
}

function BackupRestoreTab() {
  const [backupRecipients, setBackupRecipients] = useState([])
  const [credentialBackupStatus, setCredentialBackupStatus] = useState({ has_credentials: false, credential_count: 0 })
  const [restoreFile, setRestoreFile] = useState(null)
  const [credsFile, setCredsFile] = useState(null)
  const [restoreInspection, setRestoreInspection] = useState(null)
  const [inspectError, setInspectError] = useState('')
  const [inspectingRestore, setInspectingRestore] = useState(false)
  const [privateKeyFile, setPrivateKeyFile] = useState(null)
  const [privateKeyPassphrase, setPrivateKeyPassphrase] = useState('')
  const [restoring, setRestoring] = useState(false)
  const [restoreMsg, setRestoreMsg] = useState(null)
  const [restoreSuccess, setRestoreSuccess] = useState(null)
  const [pendingConfirm, setPendingConfirm] = useState(null)
  const enabledRecipients = backupRecipients.filter(r => r.enabled)
  const hasStoredCredentials = !!credentialBackupStatus?.has_credentials

  useEffect(() => {
    api.getBackupRecipients().then(setBackupRecipients).catch(() => { })
    api.getCredentialsBackupStatus().then(setCredentialBackupStatus).catch(() => { })
  }, [])

  function startDownload(url) {
    window.location.assign(url)
  }

  async function handleRestoreFileChange(file) {
    setRestoreFile(file || null)
    setRestoreInspection(null)
    setInspectError('')
    setPrivateKeyFile(null)
    setPrivateKeyPassphrase('')
    if (!file) return
    setInspectingRestore(true)
    try {
      setRestoreInspection(await api.inspectBackupFile(file))
    } catch (e) {
      setInspectError(e.message || 'Unable to inspect backup file')
    } finally {
      setInspectingRestore(false)
    }
  }

  async function performRestore(file, type) {
    setPendingConfirm(null)
    if (type === 'credentials') {
      setRestoring(true)
      try {
        const r = await api.restoreCredentialsFile(file)
        setRestoreMsg(null)
        setRestoreSuccess(`Restored ${r.restored} credential(s).`)
      }
      catch (e) { setRestoreMsg(`❌ ${e.message}`) }
      setRestoring(false); return
    }
    setRestoring(true)
    try {
      const result = await api.restoreBackupFile(file, privateKeyFile, privateKeyPassphrase)
      const counts = result.restored_counts || {}
      const pieces = [
        `${counts.owners ?? 0} owner${counts.owners === 1 ? '' : 's'}`,
        `${counts.accounts ?? 0} account${counts.accounts === 1 ? '' : 's'}`,
        `${counts.categories ?? 0} categor${counts.categories === 1 ? 'y' : 'ies'}`,
        `${counts.transactions ?? 0} transaction${counts.transactions === 1 ? '' : 's'}`,
      ]
      setRestoreMsg(null)
      setRestoreSuccess(`Restore completed. Loaded ${pieces.join(', ')}.`)
    }
    catch (e) { setRestoreMsg(`❌ ${e.message}`) }
    setRestoring(false)
  }

  function requestRestore(type) {
    if (type === 'credentials') {
      if (!credsFile || restoring) return
      setPendingConfirm({
        type,
        title: 'Restore Plaid credentials?',
        message: 'This will replace the Plaid credentials currently stored in FinTrack.',
        confirmLabel: 'Restore credentials',
        variant: 'warn',
      })
      return
    }
    if (!restoreFile || restoring || inspectingRestore || inspectError || (restoreInspection?.encrypted && !privateKeyFile)) return
    setPendingConfirm({
      type,
      title: 'Replace all data with this backup?',
      message: 'This will replace accounts, categories, rules, import settings, and transactions with the selected backup.',
      confirmLabel: 'Restore data backup',
      variant: 'danger',
    })
  }

  return (
    <div>
      <SectionTitle>Backup</SectionTitle>
      <Card style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Data backup</div>
          <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 10 }}>All categories, rules, owners, accounts, transactions. No Plaid tokens.</div>
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
            <Button variant="ghost" onClick={() => startDownload(api.exportBackup(false))}>Generate backup</Button>
            <Button variant="ghost" disabled={enabledRecipients.length === 0} onClick={() => startDownload(api.exportBackup(true))}>Generate encrypted backup</Button>
          </div>
          {enabledRecipients.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 8 }}>
              Add an enabled backup recipient in Settings to enable encrypted backup creation.
            </div>
          ) : (
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 8 }}>
              Encrypted backups will be readable by: {enabledRecipients.map(r => r.label).join(', ')}.
            </div>
          )}
        </div>
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 16 }}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Credentials backup</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', opacity: hasStoredCredentials ? 1 : 0.58 }}>
            <a
              href={hasStoredCredentials ? api.exportCredentials(false) : undefined}
              download={hasStoredCredentials ? 'fintrack_credentials.zip' : undefined}
              onClick={event => {
                if (!hasStoredCredentials) event.preventDefault()
              }}
            >
              <Button disabled={!hasStoredCredentials}>Generate credentials backup</Button>
            </a>
            <a
              href={hasStoredCredentials && enabledRecipients.length > 0 ? api.exportCredentials(true) : undefined}
              download={hasStoredCredentials && enabledRecipients.length > 0 ? 'fintrack_credentials.encrypted.zip' : undefined}
              onClick={event => {
                if (!hasStoredCredentials || enabledRecipients.length === 0) event.preventDefault()
              }}
            >
              <Button variant="ghost" disabled={!hasStoredCredentials || enabledRecipients.length === 0}>Generate encrypted credentials backup</Button>
            </a>
          </div>
          {!hasStoredCredentials ? (
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 8 }}>
              No stored Plaid credentials exist to back up.
            </div>
          ) : enabledRecipients.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 8 }}>
              Add an enabled backup recipient in Settings to enable encrypted backup creation.
            </div>
          ) : (
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 8 }}>
              Encrypted credentials backups will be readable by: {enabledRecipients.map(r => r.label).join(', ')}.
            </div>
          )}
          {hasStoredCredentials ? (
            <div style={{ display: 'inline-block', fontSize: 13, background: 'color-mix(in srgb, #f59e0b 10%, var(--surface2))', border: '1px solid #f59e0b', borderRadius: 6, padding: '8px 12px', marginTop: 10 }}>
              ⚠️ Plain credentials backups contain Plaid access tokens.
            </div>
          ) : null}
        </div>
      </Card>

      <SectionTitle>Restore</SectionTitle>
      <Card style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        {restoreMsg && (
          <div
            style={{
              padding: '10px 14px',
              borderRadius: 8,
              fontSize: 14,
              background: restoreMsg.startsWith('✅')
                ? 'color-mix(in srgb, var(--success) 12%, var(--surface2))'
                : 'color-mix(in srgb, var(--danger) 12%, var(--surface2))',
              border: `1px solid ${restoreMsg.startsWith('✅') ? 'color-mix(in srgb, var(--success) 35%, var(--border))' : 'color-mix(in srgb, var(--danger) 35%, var(--border))'}`,
              display: 'flex',
              gap: 10,
              alignItems: 'center',
              justifyContent: 'space-between',
              flexWrap: 'wrap',
            }}
          >
            <div>{restoreMsg}</div>
          </div>
        )}
        <div>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Restore from data backup</div>
          <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 10 }}>Replaces all existing data from the selected backup. Plaid credentials are not affected. Encrypted backups require the matching RSA private key file.</div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <input type="file" accept=".json,.zip,application/json,application/zip" onChange={e => handleRestoreFileChange(e.target.files[0])} style={{ fontSize: 13 }} />
          </div>
          {inspectingRestore && (
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 8 }}>
              Inspecting backup file...
            </div>
          )}
          {inspectError && (
            <div style={{ marginTop: 10, fontSize: 13, color: 'var(--danger)' }}>
              {inspectError}
            </div>
          )}
          {restoreInspection && !inspectError && (
            <div style={{
              marginTop: 12,
              padding: '12px 14px',
              borderRadius: 8,
              background: restoreInspection.encrypted
                ? 'color-mix(in srgb, var(--accent2) 10%, var(--surface2))'
                : 'var(--surface2)',
              border: `1px solid ${restoreInspection.encrypted ? 'color-mix(in srgb, var(--accent2) 40%, var(--border))' : 'var(--border)'}`,
              display: 'grid',
              gap: 8,
            }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>
                {restoreInspection.encrypted ? 'Encrypted backup detected' : 'Backup file looks valid'}
              </div>
              <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                {restoreInspection.encrypted
                  ? `${restoreInspection.cipher || 'Encrypted'} backup for ${restoreInspection.recipient_count || 0} recipient${restoreInspection.recipient_count === 1 ? '' : 's'}.`
                  : `Readable ${restoreInspection.container === 'zip' ? 'zipped' : 'plain JSON'} backup file.`}
              </div>
              {restoreInspection.encrypted && Array.isArray(restoreInspection.recipients) && restoreInspection.recipients.length > 0 && (
                <div style={{ display: 'grid', gap: 6 }}>
                  {restoreInspection.recipients.map((recipient, idx) => (
                    <div key={`${recipient.recipient_id || recipient.fingerprint || recipient.label}-${idx}`} style={{ fontSize: 12, color: 'var(--muted)' }}>
                      {recipient.label}
                      {recipient.fingerprint ? ` (${recipient.fingerprint})` : ''}
                    </div>
                  ))}
                </div>
              )}
              {restoreInspection.encrypted && (
                <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                  <input type="file" onChange={e => setPrivateKeyFile(e.target.files[0])} style={{ fontSize: 13 }} />
                  <input
                    type="password"
                    value={privateKeyPassphrase}
                    onChange={e => setPrivateKeyPassphrase(e.target.value)}
                    placeholder="Private key passphrase (optional)"
                    style={{
                      background: 'var(--surface2)', color: 'var(--text)',
                      border: `1px solid ${privateKeyFile ? 'var(--border)' : 'color-mix(in srgb, var(--accent2) 60%, var(--border))'}`, borderRadius: 6,
                      padding: '6px 10px', fontSize: 13, minWidth: 220,
                    }}
                  />
                </div>
              )}
              {restoreInspection.encrypted && !privateKeyFile && (
                <div style={{ fontSize: 12, color: 'var(--accent2)' }}>
                  Select a matching RSA private key file before restoring this backup.
                </div>
              )}
            </div>
          )}
          <div style={{ marginTop: 12, display: 'flex', justifyContent: 'flex-start' }}>
            <Button
              variant="danger"
              disabled={!restoreFile || restoring || inspectingRestore || !!inspectError || (restoreInspection?.encrypted && !privateKeyFile)}
              onClick={() => requestRestore('data')}
            >
              {restoring ? 'Restoring…' : 'Restore data'}
            </Button>
          </div>
        </div>
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 16 }}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Restore Plaid credentials</div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <input type="file" accept=".json,.zip,application/json,application/zip" onChange={e => setCredsFile(e.target.files[0])} style={{ fontSize: 13 }} />
            <Button variant="ghost" disabled={!credsFile || restoring} onClick={() => requestRestore('credentials')}>
              {restoring ? 'Restoring…' : 'Restore credentials'}
            </Button>
          </div>
        </div>
      </Card>

      {pendingConfirm && (
        <div
          onClick={() => setPendingConfirm(null)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(15, 23, 42, 0.45)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 24,
            zIndex: 1000,
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              width: 'min(520px, 100%)',
              background: 'var(--surface)',
              borderRadius: 14,
              border: `1px solid ${pendingConfirm.variant === 'danger' ? 'color-mix(in srgb, var(--danger) 35%, var(--border))' : '#f59e0b'}`,
              boxShadow: '0 24px 60px rgba(15, 23, 42, 0.28)',
              padding: 20,
              display: 'grid',
              gap: 12,
            }}
          >
            <div style={{ fontSize: 16, fontWeight: 600 }}>{pendingConfirm.title}</div>
            <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.5 }}>{pendingConfirm.message}</div>
            <div style={{
              fontSize: 12,
              color: pendingConfirm.variant === 'danger' ? 'var(--danger)' : '#b45309',
              background: pendingConfirm.variant === 'danger'
                ? 'color-mix(in srgb, var(--danger) 10%, var(--surface2))'
                : 'color-mix(in srgb, #f59e0b 10%, var(--surface2))',
              borderRadius: 8,
              padding: '8px 10px',
              textAlign: 'center',
            }}>
              {pendingConfirm.variant === 'danger'
                ? 'This action replaces existing data and cannot be undone.'
                : 'You may need to reconnect accounts if these credentials do not match this FinTrack instance.'}
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
              <Button variant="ghost" onClick={() => setPendingConfirm(null)}>
                Cancel
              </Button>
              <Button
                variant={pendingConfirm.variant === 'danger' ? 'danger' : 'primary'}
                onClick={() => performRestore(pendingConfirm.type === 'credentials' ? credsFile : restoreFile, pendingConfirm.type)}
              >
                {pendingConfirm.confirmLabel}
              </Button>
            </div>
          </div>
        </div>
      )}

      {restoreSuccess && (
        <div
          onClick={() => setRestoreSuccess(null)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(15, 23, 42, 0.38)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 24,
            zIndex: 1000,
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              width: 'min(520px, 100%)',
              background: 'var(--surface)',
              borderRadius: 14,
              border: '1px solid color-mix(in srgb, var(--success) 35%, var(--border))',
              boxShadow: '0 24px 60px rgba(15, 23, 42, 0.24)',
              padding: 20,
              display: 'grid',
              gap: 12,
            }}
          >
            <div style={{ fontSize: 16, fontWeight: 600 }}>Restore completed</div>
            <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.5 }}>{restoreSuccess}</div>
            <div style={{
              fontSize: 12,
              color: 'var(--success)',
              background: 'color-mix(in srgb, var(--success) 10%, var(--surface2))',
              borderRadius: 8,
              padding: '8px 10px',
              textAlign: 'center',
            }}>
              Reload the page to continue.
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <Button small onClick={() => window.location.reload()}>
                Reload now
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default function ImportExport() {
  const [tab, setTab] = useState('import')
  return (
    <div data-browser-context-passthrough="true" style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ padding: '32px 32px 0', flexShrink: 0 }}>
        <PageHeader title="Import / Export" />
      </div>
      <div data-browser-context-passthrough="true" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 32px 32px' }}>
        <div style={{ display: 'flex', marginBottom: 24, borderBottom: '1px solid var(--border)' }}>
          {[['import', 'Import'], ['export', 'Export'], ['backup', 'Backup / Restore']].map(([id, label]) => (
            <button key={id} onClick={() => setTab(id)} style={{ padding: '8px 24px', border: 'none', background: 'none', cursor: 'pointer', fontSize: 14, color: tab === id ? 'var(--text)' : 'var(--muted)', borderBottom: tab === id ? '2px solid var(--accent)' : '2px solid transparent', fontWeight: tab === id ? 500 : 400 }}>{label}</button>
          ))}
        </div>
        {tab === 'import' && <ImportErrorBoundary><ImportTab /></ImportErrorBoundary>}
        {tab === 'export' && <ExportTab />}
        {tab === 'backup' && <BackupRestoreTab />}
      </div>
    </div>
  )
}
