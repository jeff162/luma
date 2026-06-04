// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: GPL-3.0-or-later

import React, { useCallback, useState, useEffect, useRef, useMemo, lazy, Suspense } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { api } from '../lib/api.js'
import { FilterProvider, useFilters } from '../lib/FilterContext.jsx'
import FilterBar from '../components/FilterBar.jsx'
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
import CategoryImportWorkspace from '../components/CategoryImportWorkspace.jsx'
import ImportColumnMappingSection from '../components/ImportColumnMappingSection.jsx'
import ImportProfilesManager from '../components/ImportProfilesManager.jsx'
import TransientTextInput from '../components/TransientTextInput.jsx'
import PillGridTable from '../components/PillGridTable.jsx'
import { useUnifiedDuplicatesViewer } from '../contexts/UnifiedDuplicatesViewerContext.jsx'
import { cloneCategoryImportSnapshot, createCategoryImportDraftState, findNodeById } from '../lib/categoryImportState.js'
import {
  analyzeImportColumns,
  formatLikelyMatchLabel,
  inferFilenamePattern,
  inferImportFileCharacteristicsFromPreview,
  inferUnambiguousImportMappingFromPreview,
} from '../lib/importColumnInference.js'
import { formatTransactionAmount, getTransactionAmountColor } from '../lib/moneyDisplay.js'
import { useAppSession } from '../lib/AppSessionContext.jsx'
import { useUserPreference } from '../lib/UserPreferencesContext.jsx'
import { ACCOUNT_TYPES } from '../lib/accountTypes.js'
import {
  APP_NAME,
  IMPORT_DEFAULT_CATEGORY_USAGE_MODE_PREF_KEY,
  IMPORT_CATEGORY_USAGE_MODE_PER_SOURCE,
} from '../lib/appConfig.js'
import {
  AMOUNT_CONVENTIONS,
  DATE_FORMATS,
  EXPORT_COLUMNS,
  DEFAULT_EXPORT_COLS,
  IMPORT_CONFIG_MAX_WIDTH,
  MANUAL_DATA_SOURCE_VALUE,
  LAST_IMPORT_DATA_SOURCE_PREF_KEY,
  EXPANDED_IMPORT_SOURCE_ROWS_PREF_KEY,
  DATA_SOURCE_MANAGER_POS_PREF_KEY,
  SYSTEM_CATEGORY_WORKSPACE_DRAFT_PREF_KEY,
  DUPLICATE_ROWS_COLUMNS_PREF_KEY,
  UNASSIGNED_CATEGORY_SYSTEM_KEY,
  IMPORTED_CATEGORY_SCOPE_ALL,
  IMPORTED_CATEGORY_SCOPE_FILTERED,
  IMPORTED_CATEGORY_SETTINGS_KEY,
  IMPORTED_CATEGORY_USAGE_SENTENCE,
  IMPORTED_CATEGORY_FILTER_PILL_LABEL,
  IMPORTED_CATEGORY_FILTER_DIALOG_TITLE,
  IMPORTED_CATEGORY_FILTER_DIALOG_DESCRIPTION,
} from '../lib/importExport/constants.js'
import {
  getBlankImportedCategorySettings,
  getDefaultImportedCategoryUsageEnabled,
  dedupeStringList,
  normalizeImportedCategorySettings,
  extractImportedCategorySettings,
  getFixedAccountCategoryScopeToken,
  getNewAccountCategoryScopeToken,
  summarizeImportedCategorySettings,
} from '../lib/importExport/importedCategorySettings.js'
import {
  guessNewAccountTypeFromName,
  findExactAccountNameMatch,
  getAccountMatchLabel,
  findLikelyAccountMatch,
  buildAccountImportStateSnapshot,
} from '../lib/importExport/importAccountMatching.js'

const ImportBatchDetail = lazy(() => import('../components/ImportBatchDetail.jsx'))

function normalizeDuplicateRowsColumnConfig(savedColumns, defaultColumns) {
  if (!Array.isArray(defaultColumns) || defaultColumns.length === 0) return []

  const defaultByKey = new Map(defaultColumns.map(column => [column.key, column]))
  const seen = new Set()
  const merged = []

  if (Array.isArray(savedColumns)) {
    for (const savedColumn of savedColumns) {
      const key = savedColumn?.key
      if (!defaultByKey.has(key) || seen.has(key)) continue
      const defaultColumn = defaultByKey.get(key)
      const requestedWidth = Number(savedColumn?.width)
      const minWidth = Number(defaultColumn.minWidth || 44)
      merged.push({
        ...defaultColumn,
        width: Number.isFinite(requestedWidth) ? Math.max(minWidth, Math.min(640, requestedWidth)) : defaultColumn.width,
      })
      seen.add(key)
    }
  }

  for (const defaultColumn of defaultColumns) {
    if (seen.has(defaultColumn.key)) continue
    merged.push({ ...defaultColumn })
  }

  return merged
}

function getBlankImportSnapshot() {
  return {
    column_map: {},
    category_assignments: {},
    account_map: {},
    skip_accounts: [],
    account_new: {},
    account_duplicate_compare: {},
    account_id: null,
    single_account_new: null,
    date_format: '%m/%d/%Y',
    amount_convention: 'single_signed',
    skip_rows: 0,
    apply_categorization: true,
    use_imported_categories: false,
    [IMPORTED_CATEGORY_SETTINGS_KEY]: getBlankImportedCategorySettings(),
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

function ImportedCategorySettingsDialog({
  title = IMPORTED_CATEGORY_FILTER_DIALOG_TITLE,
  description = IMPORTED_CATEGORY_FILTER_DIALOG_DESCRIPTION,
  choices = [],
  initialSettings,
  onSave,
  onCancel,
}) {
  const normalizedInitial = useMemo(
    () => normalizeImportedCategorySettings(initialSettings),
    [initialSettings],
  )
  const ownerChoices = useMemo(
    () => choices.filter(choice => choice.kind === 'owner'),
    [choices],
  )
  const accountChoices = useMemo(
    () => choices.filter(choice => choice.kind === 'account'),
    [choices],
  )
  const allOwnerIds = useMemo(
    () => ownerChoices.map(choice => choice.ownerId),
    [ownerChoices],
  )
  const allAccountTokens = useMemo(
    () => accountChoices.map(choice => choice.token),
    [accountChoices],
  )
  const [selectedOwnerIds, setSelectedOwnerIds] = useState(
    normalizedInitial.scope_mode === IMPORTED_CATEGORY_SCOPE_FILTERED
      ? normalizedInitial.owner_ids
      : allOwnerIds,
  )
  const [selectedAccountTokens, setSelectedAccountTokens] = useState(
    normalizedInitial.scope_mode === IMPORTED_CATEGORY_SCOPE_FILTERED
      ? normalizedInitial.unassigned_account_tokens
      : allAccountTokens,
  )

  useEffect(() => {
    const next = normalizeImportedCategorySettings(initialSettings)
    setSelectedOwnerIds(next.scope_mode === IMPORTED_CATEGORY_SCOPE_FILTERED ? next.owner_ids : allOwnerIds)
    setSelectedAccountTokens(next.scope_mode === IMPORTED_CATEGORY_SCOPE_FILTERED ? next.unassigned_account_tokens : allAccountTokens)
  }, [initialSettings, allOwnerIds, allAccountTokens])

  function toggleOwner(ownerId) {
    setSelectedOwnerIds(prev => prev.includes(ownerId)
      ? prev.filter(value => value !== ownerId)
      : [...prev, ownerId]
    )
  }

  function toggleAccount(token) {
    setSelectedAccountTokens(prev => prev.includes(token)
      ? prev.filter(value => value !== token)
      : [...prev, token]
    )
  }

  function handleSave() {
    const normalizedOwnerIds = dedupeStringList(selectedOwnerIds)
    const normalizedAccountTokens = dedupeStringList(selectedAccountTokens)
    const includesAllOwners = normalizedOwnerIds.length === allOwnerIds.length
      && allOwnerIds.every(ownerId => normalizedOwnerIds.includes(ownerId))
    const includesAllAccounts = normalizedAccountTokens.length === allAccountTokens.length
      && allAccountTokens.every(token => normalizedAccountTokens.includes(token))
    const useFilteredScope = !includesAllOwners || !includesAllAccounts
    onSave?.({
      scope_mode: useFilteredScope ? IMPORTED_CATEGORY_SCOPE_FILTERED : IMPORTED_CATEGORY_SCOPE_ALL,
      owner_ids: useFilteredScope ? normalizedOwnerIds : [],
      unassigned_account_tokens: useFilteredScope ? normalizedAccountTokens : [],
    })
  }

  return (
    <OverlayBackdrop zIndex={1200} tint="rgba(15, 23, 42, 0.34)">
      <FloatingPanel style={{ width: 'min(620px, 100%)' }}>
        <FloatingPanelHeader style={{ padding: '16px 20px' }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 600 }}>{title}</div>
            <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4 }}>{description}</div>
          </div>
        </FloatingPanelHeader>
        <div style={{ padding: 20, display: 'grid', gap: 16 }}>
          <div
            style={{
              display: 'grid',
              gap: 12,
              padding: 14,
              borderRadius: 14,
              border: '1px solid var(--border)',
              background: 'color-mix(in srgb, var(--surface2) 72%, var(--surface))',
            }}
          >
            {ownerChoices.length > 0 ? (
              <div style={{ display: 'grid', gap: 8 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Owners</div>
                <div style={{ display: 'grid', gap: 8 }}>
                  {ownerChoices.map(choice => (
                    <label key={choice.key} style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={selectedOwnerIds.includes(choice.ownerId)}
                        onChange={() => toggleOwner(choice.ownerId)}
                      />
                      <span style={{ fontSize: 13 }}>{choice.label}</span>
                      <span style={{ fontSize: 12, color: 'var(--muted)' }}>{choice.rowCount} rows</span>
                    </label>
                  ))}
                </div>
              </div>
            ) : null}
            {accountChoices.length > 0 ? (
              <div style={{ display: 'grid', gap: 8 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', letterSpacing: '0.05em' }}>Accounts to include</div>
                <div style={{ display: 'grid', gap: 8 }}>
                  {accountChoices.map(choice => (
                    <label key={choice.key} style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={selectedAccountTokens.includes(choice.token)}
                        onChange={() => toggleAccount(choice.token)}
                      />
                      <span style={{ fontSize: 13 }}>{choice.label}</span>
                      <span style={{ fontSize: 12, color: 'var(--muted)' }}>{choice.rowCount} rows</span>
                    </label>
                  ))}
                </div>
              </div>
            ) : null}
            {ownerChoices.length === 0 && accountChoices.length === 0 ? (
              <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                No owners or unassigned-account choices are available until the accounts in this import are mapped.
              </div>
            ) : null}
            {ownerChoices.length > 0 || accountChoices.length > 0 ? (
              <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>
                Uncheck anything you want to exclude.
              </div>
            ) : null}
          </div>
        </div>
        <DialogActions>
          <Button variant="ghost" onClick={onCancel}>Cancel</Button>
          <Button onClick={handleSave}>Save</Button>
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

function DataSourcePill({
  label,
  selected,
  onClick,
  muted,
  subtle,
  title,
  showMarker = true,
  likelyMatch = false,
  emphasis = 'normal',
}) {
  const highlighted = emphasis !== 'normal'
  const recommended = emphasis === 'recommended'
  const secondary = emphasis === 'secondary'
  const borderColor = selected
    ? 'color-mix(in srgb, var(--accent) 42%, var(--border))'
    : highlighted
      ? (recommended
        ? 'color-mix(in srgb, var(--accent2) 72%, white 8%)'
        : secondary
          ? 'color-mix(in srgb, var(--accent) 68%, white 6%)'
          : 'color-mix(in srgb, var(--accent) 18%, var(--border))')
      : 'color-mix(in srgb, var(--border) 88%, transparent)'
  const background = selected
    ? 'color-mix(in srgb, var(--accent) 11%, var(--surface2))'
    : highlighted
      ? (recommended
        ? 'linear-gradient(180deg, color-mix(in srgb, var(--accent) 40%, var(--surface2)), color-mix(in srgb, var(--accent) 28%, var(--surface2)))'
        : secondary
          ? 'linear-gradient(180deg, color-mix(in srgb, var(--accent) 34%, var(--surface2)), color-mix(in srgb, var(--accent) 22%, var(--surface2)))'
          : 'color-mix(in srgb, var(--accent) 6%, var(--surface2))')
      : (subtle ? 'transparent' : 'var(--surface2)')
  const color = selected
    ? 'var(--accent2)'
    : highlighted
      ? 'color-mix(in srgb, var(--text) 94%, white 6%)'
      : (muted ? 'var(--muted)' : 'var(--text)')
  const boxShadow = selected
    ? '0 0 0 1px color-mix(in srgb, var(--accent) 12%, transparent)'
    : highlighted
      ? (recommended
        ? '0 1px 0 rgba(255,255,255,0.08), inset 0 1px 0 rgba(255,255,255,0.08), 0 16px 34px rgba(15, 23, 42, 0.28)'
        : secondary
          ? '0 1px 0 rgba(255,255,255,0.07), inset 0 1px 0 rgba(255,255,255,0.06), 0 14px 30px rgba(15, 23, 42, 0.24)'
          : '0 1px 0 rgba(255,255,255,0.03), 0 5px 16px rgba(15, 23, 42, 0.09)')
      : 'none'
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
        border: `1px solid ${borderColor}`,
        background,
        color,
        cursor: 'pointer',
        fontSize: 13,
        fontWeight: selected || highlighted ? 600 : 500,
        boxShadow,
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

function InlineFilterPill({ onClick, disabled = false, title = '' }) {
  return (
    <button
      type="button"
      onClick={event => {
        event.preventDefault()
        event.stopPropagation()
        if (!disabled) onClick?.()
      }}
      disabled={disabled}
      title={title}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: '0 6px',
        borderRadius: 999,
        border: `1px solid ${disabled
          ? 'color-mix(in srgb, var(--border) 82%, transparent)'
          : 'color-mix(in srgb, var(--accent) 28%, var(--border))'}`,
        background: disabled
          ? 'color-mix(in srgb, var(--surface2) 72%, var(--surface))'
          : 'color-mix(in srgb, var(--accent) 10%, var(--surface2))',
        color: disabled ? 'var(--muted)' : 'var(--accent2)',
        fontSize: '0.88em',
        fontWeight: 600,
        lineHeight: '1.15',
        cursor: disabled ? 'not-allowed' : 'pointer',
        whiteSpace: 'nowrap',
        verticalAlign: 'super',
        position: 'relative',
        top: '-0.1em',
      }}
    >
      {IMPORTED_CATEGORY_FILTER_PILL_LABEL}
    </button>
  )
}

function ImportedCategoryUsageInline({ showFilter = false, filterDisabled = false, filterTitle = '', onFilterClick = null }) {
  return (
    <span>
      <span>{IMPORTED_CATEGORY_USAGE_SENTENCE}</span>
      {showFilter ? (
        <>
          {' '}
          <InlineFilterPill
            onClick={onFilterClick}
            disabled={filterDisabled}
            title={filterTitle}
          />
        </>
      ) : null}
    </span>
  )
}

function ActionCountBadge({ count, tone = 'accent' }) {
  if (!count) return null
  const palette = tone === 'warning'
    ? {
      background: 'color-mix(in srgb, #f59e0b 18%, var(--surface))',
      border: '1px solid color-mix(in srgb, #f59e0b 42%, var(--border))',
      color: '#f59e0b',
    }
    : {
      background: 'color-mix(in srgb, var(--accent) 14%, var(--surface))',
      border: '1px solid color-mix(in srgb, var(--accent2) 24%, var(--border))',
      color: 'var(--accent2)',
    }
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      minWidth: 20,
      minHeight: 20,
      padding: '0 6px',
      borderRadius: 999,
      fontSize: 11,
      fontWeight: 700,
      lineHeight: 1,
      ...palette,
    }}>
      {count}
    </span>
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
  // importResult and batch records expose count fields under different shapes.
  // Normalize them here so the undo dialog arithmetic always has real numbers.
  const summary = summarizeImportOutcome(source)
  return {
    ...source,
    id: source.id || source.batch_id || '',
    row_count: summary.totalRows,
    skipped_count: summary.skippedCount,
    deduped_count: summary.dedupedCount,
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
  function renderDuplicateRuleBadge(label) {
    return (
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          padding: '0 6px',
          minHeight: 16,
          borderRadius: 999,
          border: '1px solid color-mix(in srgb, var(--accent2) 18%, var(--border))',
          background: 'color-mix(in srgb, var(--surface2) 76%, var(--surface))',
          color: 'var(--muted)',
          fontSize: 9.5,
          fontWeight: 700,
          letterSpacing: '0.02em',
          textTransform: 'uppercase',
          flexShrink: 0,
        }}
      >
        {label}
      </span>
    )
  }

  const duplicateRuleDefinitions = useMemo(
    () => ({
      exact_match: {
        tag: 'Exact Match',
        description: 'Rows whose stored duplicate hash exactly matches an existing transaction.',
      },
      covered_day: {
        tag: 'Covered Day',
        description: 'Rows that fall on account days already covered by earlier imports, including bounded overlap on the terminal covered day.',
      },
    }),
    [],
  )

  function classifyDuplicateRule(row) {
    const reason = String(row?.reason || '')
    if (reason.startsWith('Matches an existing transaction')) return 'exact_match'
    if (
      reason.startsWith('Falls within the fully covered date range')
      || reason.startsWith('Matches a remaining transaction from the terminal covered day')
    ) {
      return 'covered_day'
    }
    return ''
  }

  const effectiveCount = Math.max(count, rows.length)
  const tableHeaders = headers.length > 0
    ? headers
    : Array.from(new Set(rows.flatMap(row => Object.keys(row?.values || {}))))
  const hasSavedRowValues = tableHeaders.length > 0
  const duplicateDisplayRows = useMemo(
    () => rows.map(row => {
      const matchedTransaction = row?.matched_transaction || null
      const duplicateRuleKey = classifyDuplicateRule(row)
      return {
        ...row,
        duplicateRuleKey,
        duplicateRuleTag: duplicateRuleKey ? duplicateRuleDefinitions[duplicateRuleKey]?.tag || '' : '',
        matchedSummary: matchedTransaction
          ? `${matchedTransaction.date || ''} · ${matchedTransaction.merchant_name || ''} · ${formatTransactionAmount(matchedTransaction.amount)}`
          : (row.reason || `Existing transaction`),
      }
    }),
    [duplicateRuleDefinitions, rows],
  )
  const importableRowNumbers = useMemo(
    () => rows.filter(row => row?.txn_payload).map(row => Number(row.row)).filter(Boolean),
    [rows],
  )
  const importableRowsByRule = useMemo(
    () => Object.fromEntries(
      Object.keys(duplicateRuleDefinitions).map(ruleKey => [
        ruleKey,
        duplicateDisplayRows
          .filter(row => row.duplicateRuleKey === ruleKey && row?.txn_payload)
          .map(row => Number(row.row))
          .filter(Boolean),
      ]),
    ),
    [duplicateDisplayRows, duplicateRuleDefinitions],
  )
  const presentRuleKeys = useMemo(
    () => Object.keys(duplicateRuleDefinitions).filter(ruleKey => importableRowsByRule[ruleKey]?.length > 0),
    [duplicateRuleDefinitions, importableRowsByRule],
  )
  const estimateColumnWidthPx = useMemo(
    () => (values, { header = '', min = 8, max = 22, fallback = 12 } = {}) => {
      const lengths = values
        .map(value => String(value ?? '').trim().length)
        .filter(length => length > 0)
        .sort((a, b) => a - b)
      const percentileLength = lengths.length > 0
        ? lengths[Math.min(lengths.length - 1, Math.floor((lengths.length - 1) * 0.85))]
        : 0
      const target = Math.max(header.length + 1, percentileLength + 1, fallback)
      const clamped = Math.max(min, Math.min(max, target))
      return Math.round(clamped * 8.25)
    },
    [],
  )
  const selectionWidthPx = 40
  const rowWidthPx = 68
  const matchWidthPx = useMemo(
    () => estimateColumnWidthPx(
      duplicateDisplayRows.map(row => row.matchedSummary),
      { header: 'Matches', min: 18, max: 32, fallback: 22 },
    ),
    [duplicateDisplayRows, estimateColumnWidthPx],
  )
  const dataColumnWidths = useMemo(
    () => Object.fromEntries(
      tableHeaders.map(header => [
        header,
        estimateColumnWidthPx(
          duplicateDisplayRows.map(row => row?.values?.[header] ?? ''),
          { header, min: 8, max: 22, fallback: Math.max(10, String(header || '').length + 2) },
        ),
      ]),
    ),
    [duplicateDisplayRows, estimateColumnWidthPx, tableHeaders],
  )
  const defaultColumns = useMemo(
    () => ([
      { key: '__select__', label: '', width: selectionWidthPx, minWidth: selectionWidthPx, align: 'center', resizable: false, draggable: false },
      { key: '__row__', label: 'Row', width: rowWidthPx, minWidth: 52, align: 'start' },
      ...tableHeaders.map(header => ({
        key: `data:${header}`,
        label: header,
        width: dataColumnWidths[header] || 96,
        minWidth: 72,
        align: String(header || '').trim().toLowerCase() === 'amount' ? 'end' : 'start',
      })),
      { key: '__matches__', label: 'Matches', width: matchWidthPx, minWidth: 180, align: 'start' },
    ]),
    [dataColumnWidths, matchWidthPx, tableHeaders],
  )
  const [savedDuplicateColumns, setSavedDuplicateColumns] = useUserPreference(DUPLICATE_ROWS_COLUMNS_PREF_KEY, [])
  const [cols, setCols] = useState(() => normalizeDuplicateRowsColumnConfig(savedDuplicateColumns, defaultColumns))
  const [selectedRows, setSelectedRows] = useState(() => new Set())
  const [ruleStates, setRuleStates] = useState({})
  const [sortState, setSortState] = useState({ key: '__row__', dir: 'asc' })

  useEffect(() => {
    setCols(normalizeDuplicateRowsColumnConfig(savedDuplicateColumns, defaultColumns))
  }, [defaultColumns, savedDuplicateColumns])

  useEffect(() => {
    setSelectedRows(new Set())
    setRuleStates(Object.fromEntries(Object.keys(duplicateRuleDefinitions).map(ruleKey => [ruleKey, true])))
    setSortState({ key: '__row__', dir: 'asc' })
  }, [duplicateRuleDefinitions, importableRowNumbers])

  function toggleSort(columnKey) {
    setSortState(current => (
      current.key === columnKey
        ? { key: columnKey, dir: current.dir === 'asc' ? 'desc' : 'asc' }
        : { key: columnKey, dir: columnKey === '__row__' ? 'asc' : 'asc' }
    ))
  }

  function parseSortableAmount(value) {
    const text = String(value ?? '').trim()
    if (!text) return null
    const negative = text.startsWith('(') && text.endsWith(')')
    const normalized = text.replace(/[$,()]/g, '')
    if (!/^[-+]?\d+(\.\d+)?$/.test(normalized)) return null
    const parsed = Number(normalized)
    if (!Number.isFinite(parsed)) return null
    return negative ? -parsed : parsed
  }

  function parseSortableDate(value) {
    const text = String(value ?? '').trim()
    if (!text) return null
    const parsed = Date.parse(text)
    return Number.isFinite(parsed) ? parsed : null
  }

  const getDuplicateSortValue = useCallback((row, columnKey) => {
    if (columnKey === '__row__') return Number(row.row) || 0
    if (columnKey === '__matches__') return row.matchedSummary || ''
    if (!columnKey.startsWith('data:')) return ''
    const header = columnKey.slice(5)
    const rawValue = row?.values?.[header] ?? ''
    const normalizedHeader = header.trim().toLowerCase()
    if (normalizedHeader === 'amount') {
      return parseSortableAmount(rawValue) ?? String(rawValue)
    }
    if (normalizedHeader === 'date') {
      return parseSortableDate(rawValue) ?? String(rawValue)
    }
    return String(rawValue)
  }, [])

  const sortedDuplicateRows = useMemo(() => {
    const direction = sortState.dir === 'desc' ? -1 : 1
    return [...duplicateDisplayRows].sort((left, right) => {
      const leftValue = getDuplicateSortValue(left, sortState.key)
      const rightValue = getDuplicateSortValue(right, sortState.key)
      if (typeof leftValue === 'number' && typeof rightValue === 'number') {
        if (leftValue === rightValue) return (Number(left.row) || 0) - (Number(right.row) || 0)
        return (leftValue - rightValue) * direction
      }
      const comparison = String(leftValue).localeCompare(String(rightValue), undefined, { numeric: true, sensitivity: 'base' })
      if (comparison === 0) return (Number(left.row) || 0) - (Number(right.row) || 0)
      return comparison * direction
    })
  }, [duplicateDisplayRows, getDuplicateSortValue, sortState])

  const allImportableSelected = importableRowNumbers.length > 0 && importableRowNumbers.every(row => selectedRows.has(row))
  const selectedImportableCount = importableRowNumbers.filter(row => selectedRows.has(row)).length

  function handleColumnUpdate(nextColumns) {
    setCols(nextColumns)
    setSavedDuplicateColumns(nextColumns).catch(() => {})
  }

  function renderGridCell(col, row, rowNumber) {
    if (col.key === '__select__') {
      const importable = !!row?.txn_payload
      return (
        <div style={{ textAlign: 'center' }}>
          {importable ? (
            <input
              type="checkbox"
              checked={selectedRows.has(rowNumber)}
              onChange={event => toggleRowSelection(rowNumber, event.target.checked)}
            />
          ) : (
            <span style={{ color: 'var(--muted)' }}>-</span>
          )}
        </div>
      )
    }
    if (col.key === '__row__') {
      return (
        <div style={{ whiteSpace: 'nowrap', color: 'var(--muted)', fontWeight: 600 }}>
          {row.row}
        </div>
      )
    }
    if (col.key === '__matches__') {
      return (
        <div style={{ display: 'grid', gap: 3 }} title={row.matchedSummary}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
            {row.duplicateRuleTag ? renderDuplicateRuleBadge(row.duplicateRuleTag) : null}
            <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
              {row.matchedSummary}
            </div>
          </div>
          {row.reason && !row.duplicateRuleTag ? (
            <div style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.35 }}>
              {row.reason}
            </div>
          ) : null}
        </div>
      )
    }
    if (col.key.startsWith('data:')) {
      const header = col.key.slice(5)
      const value = String(row?.values?.[header] ?? '')
      return (
        <div title={value} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: col.align === 'end' ? 'right' : 'left' }}>
          {value}
        </div>
      )
    }
    return null
  }

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

  function toggleRuleSelection(ruleKey, keepExcluded) {
    setRuleStates(prev => ({ ...prev, [ruleKey]: keepExcluded }))
    const affectedRows = importableRowsByRule[ruleKey] || []
    setSelectedRows(prev => {
      const next = new Set(prev)
      if (keepExcluded) {
        affectedRows.forEach(rowNumber => next.delete(rowNumber))
      } else {
        affectedRows.forEach(rowNumber => next.add(rowNumber))
      }
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
                <div style={{ minWidth: hasSavedRowValues ? undefined : 380, padding: '0 18px 18px' }}>
                  <PillGridTable
                    columns={cols.map(col => (
                      col.key === '__select__'
                        ? {
                          ...col,
                          align: 'center',
                          sortable: false,
                          draggable: false,
                          resizable: false,
                          cellPadding: '0',
                          render: () => (
                            importableRowNumbers.length > 0 ? (
                              <input
                                type="checkbox"
                                checked={allImportableSelected}
                                onChange={event => toggleAllImportable(event.target.checked)}
                              />
                            ) : null
                          ),
                        }
                        : {
                          ...col,
                          contentPadding: col.key === '__row__' ? '0 7px' : '0 9px',
                          title: col.draggable === false
                            ? col.label
                            : `Click to sort. Drag to move ${col.label || 'column'}`,
                        }
                    ))}
                    onColumnsChange={handleColumnUpdate}
                    sortState={sortState}
                    onSort={toggleSort}
                    headerStyle={{
                      padding: '6px 0',
                      background: 'color-mix(in srgb, var(--surface2) 92%, var(--surface))',
                      position: 'sticky',
                      top: 0,
                      zIndex: 2,
                    }}
                    renderBody={({ columns: activeColumns, gridTemplateColumns }) => (
                      <div style={{ fontSize: 12.5 }}>
                        {sortedDuplicateRows.map((row, index) => {
                          const rowNumber = Number(row.row)
                          return (
                            <div
                              key={`${row.row}:${index}`}
                              style={{
                                display: 'grid',
                                gridTemplateColumns,
                                alignItems: 'center',
                                borderBottom: '1px solid color-mix(in srgb, var(--border) 72%, transparent)',
                              }}
                            >
                              {activeColumns.map(col => (
                                <div
                                  key={`${row.row}:${col.key}`}
                                  style={{
                                    padding: '6px 8px',
                                    minWidth: 0,
                                  }}
                                >
                                  {renderGridCell(col, row, rowNumber)}
                                </div>
                              ))}
                            </div>
                          )
                        })}
                      </div>
                    )}
                  />
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
          <div style={{ display: 'grid', gap: 10, minWidth: 260, flex: '1 1 420px' }}>
            {!loading && !error && presentRuleKeys.length > 0 ? (
              <div style={{ display: 'grid', gap: 8 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', letterSpacing: '0.04em' }}>
                  Exclusion Rules (uncheck to import these rows)
                </div>
                {presentRuleKeys.map(ruleKey => {
                  const ruleDef = duplicateRuleDefinitions[ruleKey]
                  const affectedCount = importableRowsByRule[ruleKey]?.length || 0
                  return (
                    <label key={ruleKey} style={{ display: 'grid', gap: 2, cursor: 'pointer' }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 12.5 }}>
                        <input
                          type="checkbox"
                          checked={ruleStates[ruleKey] !== false}
                          onChange={event => toggleRuleSelection(ruleKey, event.target.checked)}
                        />
                        {renderDuplicateRuleBadge(ruleDef.tag)}
                        <span style={{ color: 'var(--muted)', fontSize: 11.5 }}>
                          {affectedCount} row{affectedCount === 1 ? '' : 's'}
                        </span>
                      </span>
                      <span style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.35, paddingLeft: 24 }}>
                        {ruleDef.description} Uncheck to select those rows for import.
                      </span>
                    </label>
                  )
                })}
              </div>
            ) : null}
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
          </div>
          <Button variant="ghost" onClick={onClose}>Close</Button>
        </div>
      </FloatingPanel>
    </OverlayBackdrop>
  )
}

// `UnifiedDuplicatesDialog` lives at the App level so it can stay open while the user navigates
// between Import/Export, Accounts, Transactions, etc. — see
// `contexts/UnifiedDuplicatesViewerContext.jsx`. Open it via the `useUnifiedDuplicatesViewer`
// hook's `open({batchId, title})`.

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

function PossibleAccountMatchChooserDialog({
  pending,
  onSelect,
  onCancel,
}) {
  const dialogRef = useRef(null)

  useEffect(() => {
    dialogRef.current?.focus()
  }, [])

  if (!pending) return null

  const targetLabel = pending.targetLabel || 'the existing account'

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
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            onCancel?.()
          }
        }}
        style={{
          width: 'min(460px, calc(100% - 48px))',
          border: '1px solid color-mix(in srgb, var(--accent) 28%, var(--border))',
          padding: '18px 18px 16px',
          display: 'grid',
          gap: 12,
          outline: 'none',
        }}
      >
        <div style={{ display: 'grid', gap: 6 }}>
          <div style={{ fontSize: 16, fontWeight: 600 }}>Possible duplicate account?</div>
          <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.6 }}>
            “{pending.csvValue}” looks like it may be the same real-world account as “{targetLabel}”.
          </div>
        </div>
        <div style={{ display: 'grid', gap: 8 }}>
          <Button onClick={() => onSelect?.('map_existing')}>
            Map to existing account
          </Button>
          <Button variant="ghost" onClick={() => onSelect?.('group_with_existing')}>
            Create new account and group with existing
          </Button>
          <Button variant="ghost" onClick={() => onSelect?.('duplicate_compare_only')}>
            Create new account, but use existing account for duplicate detection
          </Button>
          <Button variant="ghost" onClick={() => onSelect?.('keep_separate')}>
            Keep separate
          </Button>
        </div>
        <DialogActions>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        </DialogActions>
      </FloatingPanel>
    </OverlayBackdrop>
  )
}

function deriveImportSourceHints(previewLike) {
  const filename = previewLike?.filename || ''
  const filenamePattern = inferFilenamePattern(filename).trim().toLowerCase()
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
    use_imported_categories: false,
    imported_category_scope_mode: IMPORTED_CATEGORY_SCOPE_ALL,
    imported_category_owner_ids: [],
    imported_category_unassigned_account_tokens: [],
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
  columnMap[IMPORTED_CATEGORY_SETTINGS_KEY] = normalizeImportedCategorySettings(
    extractImportedCategorySettings(snapshot)
  )
  const importedCategorySettings = normalizeImportedCategorySettings(extractImportedCategorySettings(snapshot))
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
    use_imported_categories: !!snapshot.use_imported_categories,
    imported_category_scope_mode: importedCategorySettings.scope_mode,
    imported_category_owner_ids: importedCategorySettings.owner_ids,
    imported_category_unassigned_account_tokens: importedCategorySettings.unassigned_account_tokens,
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

function getSuggestedDataSourceName({ draftRecord = null, previewLike = null } = {}) {
  const savedPattern = String(draftRecord?.filenamePattern || '').trim()
  if (savedPattern) return savedPattern
  return inferFilenamePattern(draftRecord?.templateFilename || previewLike?.filename || '').trim()
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

function sanitizeCategoryWorkspaceSnapshotToSourceValues(snapshot, sourceValues = []) {
  if (!snapshot) return null
  const validValues = new Set(
    (sourceValues || [])
      .map(value => String(value || '').trim())
      .filter(Boolean),
  )
  const shouldKeep = value => validValues.has(String(value || '').trim())
  const nextSnapshot = cloneCategoryImportSnapshot(snapshot)
  nextSnapshot.sourceOrder = (nextSnapshot.sourceOrder || []).filter(shouldKeep)
  nextSnapshot.setAsideOrder = (nextSnapshot.setAsideOrder || []).filter(shouldKeep)
  nextSnapshot.selectedSourceIds = (nextSnapshot.selectedSourceIds || []).filter(shouldKeep)

  for (const sectionType of ['income', 'expense']) {
    nextSnapshot.tree[sectionType] = (nextSnapshot.tree?.[sectionType] || []).map(group => ({
      ...group,
      children: (group.children || []).filter(child => shouldKeep(child?.sourceValue || child?.name)),
    }))
  }

  if (nextSnapshot.selectedNodeId && !findNodeById(nextSnapshot.tree, nextSnapshot.selectedNodeId)) {
    nextSnapshot.selectedNodeId = null
  }
  return nextSnapshot
}

function sanitizeCategoryWorkspaceDraftToSourceValues(draft, sourceValues = []) {
  if (!draft?.snapshot) return null
  const nextDraft = {
    ...draft,
    snapshot: sanitizeCategoryWorkspaceSnapshotToSourceValues(draft.snapshot, sourceValues),
    undoStack: (draft.undoStack || []).map(entry => sanitizeCategoryWorkspaceSnapshotToSourceValues(entry, sourceValues)).filter(Boolean),
    redoStack: (draft.redoStack || []).map(entry => sanitizeCategoryWorkspaceSnapshotToSourceValues(entry, sourceValues)).filter(Boolean),
    selectionAnchor: draft.selectionAnchor || null,
    activeSection: draft.activeSection === 'income' ? 'income' : 'expense',
    leftPanelWidth: draft.leftPanelWidth ?? null,
  }
  return summarizeCategoryWorkspaceDraft(nextDraft).totalCount > 0 ? nextDraft : null
}

function normalizeImportCategoryValue(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ')
}

function profileHeaderClearlyMismatches(profile, previewLike) {
  const profileHeader = String(profile?.header_fingerprint || '').trim()
  const previewHeader = String(previewLike?.header_fingerprint || '').trim()
  return !!profileHeader && !!previewHeader && profileHeader !== previewHeader
}

function RawFilePreview({
  rawLines,
  headerRowIndex,
  onClose,
  lineNumberOffset = 0,
  title = 'Raw file',
  note = null,
  embedded = false,
  embeddedHeight = 320,
}) {
  const [pos, setPos] = useState({ x: Math.max(0, window.innerWidth - 560), y: 80 })
  const [size, setSize] = useState({ w: 520, h: 320 })
  const [dragState, setDragState] = useState(null)
  const startRef = useRef({})

  useEffect(() => {
    if (embedded) return
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
  }, [dragState, embedded])

  function startMove(e) {
    if (embedded) return
    startRef.current = { x: pos.x, y: pos.y, mx: e.clientX, my: e.clientY }
    setDragState('move')
    e.preventDefault()
  }

  function startResize(e) {
    if (embedded) return
    startRef.current = { w: size.w, h: size.h, mx: e.clientX, my: e.clientY }
    setDragState('resize')
    e.preventDefault()
    e.stopPropagation()
  }

  if (!rawLines?.length) return null

  const containerBackground = embedded
    ? 'color-mix(in srgb, var(--surface2) 78%, #0b1220)'
    : 'var(--surface)'
  const containerBorder = embedded
    ? '1px solid color-mix(in srgb, var(--accent2) 18%, var(--border))'
    : '1px solid var(--border)'
  const containerShadow = embedded
    ? 'inset 0 1px 0 rgba(255,255,255,0.05), 0 14px 36px rgba(15, 23, 42, 0.22)'
    : '0 8px 32px rgba(0,0,0,0.35)'
  const headerBackground = embedded
    ? 'linear-gradient(180deg, color-mix(in srgb, var(--surface2) 62%, var(--accent) 8%), color-mix(in srgb, var(--surface2) 88%, #111827))'
    : 'var(--surface2)'
  const noteBackground = embedded
    ? 'color-mix(in srgb, #f59e0b 18%, #1f2937)'
    : 'color-mix(in srgb, #f59e0b 10%, var(--surface2))'
  const noteBorderColor = embedded
    ? 'color-mix(in srgb, #f59e0b 28%, var(--border))'
    : 'var(--border)'

  return (
    <div style={{
      position: embedded ? 'relative' : 'fixed',
      left: embedded ? undefined : pos.x,
      top: embedded ? undefined : pos.y,
      zIndex: embedded ? 'auto' : 1105,
      width: embedded ? '100%' : size.w,
      background: containerBackground,
      border: containerBorder, borderRadius: 10,
      boxShadow: containerShadow,
      display: 'flex', flexDirection: 'column',
      userSelect: dragState ? 'none' : 'auto',
      overflow: 'hidden',
    }}>
      <div onMouseDown={startMove} style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '8px 12px', cursor: embedded ? 'default' : 'grab',
        borderBottom: '1px solid var(--border)',
        background: headerBackground, borderRadius: '10px 10px 0 0', flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {!embedded ? <span style={{ fontSize: 12, color: 'var(--muted)' }}>⠿</span> : null}
          <span style={{ fontSize: 13, fontWeight: 600 }}>{title}</span>
          <span style={{ fontSize: 11, color: 'var(--muted)' }}>
            {headerRowIndex >= 0 ? `header on line ${headerRowIndex + 1}` : ''}
            {!embedded ? (headerRowIndex >= 0 ? ' · drag to move · resize ↘' : 'drag to move · resize ↘') : ''}
          </span>
        </div>
        {onClose ? (
          <button
            onMouseDown={e => e.stopPropagation()}
            onClick={onClose}
            style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: '0 2px' }}
          >×</button>
        ) : null}
      </div>

      {note && (
        <div style={{
          padding: '10px 12px',
          fontSize: 12,
          color: '#f59e0b',
          background: noteBackground,
          borderBottom: `1px solid ${noteBorderColor}`,
          fontWeight: 500,
        }}>
          {note}
        </div>
      )}
      <div style={{
        fontFamily: 'monospace', fontSize: 12,
        overflowY: 'auto', overflowX: 'auto',
        height: embedded ? embeddedHeight : size.h,
        borderRadius: '0 0 10px 10px',
        background: embedded ? 'color-mix(in srgb, #0f172a 82%, var(--surface2))' : 'transparent',
      }}>
        {rawLines.map((line, i) => {
          const actualLineIndex = lineNumberOffset + i
          const isHeader = actualLineIndex === headerRowIndex
          const isData = actualLineIndex > headerRowIndex && actualLineIndex <= headerRowIndex + 4
          const dimmed = !isHeader && !isData && actualLineIndex > headerRowIndex
          return (
            <div key={i} style={{
              display: 'flex', alignItems: 'baseline',
              background: isHeader
                ? 'color-mix(in srgb, var(--accent) 18%, var(--surface2))'
                : embedded
                  ? 'color-mix(in srgb, #111827 88%, transparent)'
                  : 'transparent',
              borderBottom: `1px solid ${embedded ? 'color-mix(in srgb, var(--border) 76%, #0f172a)' : 'var(--border)'}`,
              opacity: dimmed ? (embedded ? 0.62 : 0.25) : 1,
            }}>
              <span style={{
                minWidth: 42,
                padding: '4px 7px',
                textAlign: 'right',
                flexShrink: 0,
                fontSize: 10,
                color: embedded ? 'color-mix(in srgb, var(--muted) 62%, #cbd5e1)' : 'var(--muted)',
                borderRight: `1px solid ${embedded ? 'color-mix(in srgb, var(--border) 76%, #0f172a)' : 'var(--border)'}`,
                background: embedded ? 'color-mix(in srgb, #111827 76%, var(--surface2))' : 'var(--surface2)',
                fontWeight: isHeader ? 600 : 400,
              }}>{actualLineIndex + 1}</span>
              <span style={{
                padding: '4px 10px',
                whiteSpace: 'pre',
                color: embedded ? 'color-mix(in srgb, var(--text) 88%, #e5eefc)' : 'var(--text)',
                fontWeight: isHeader ? 600 : 400,
                textShadow: embedded ? '0 1px 0 rgba(0,0,0,0.28)' : 'none',
              }}>{line || ' '}</span>
              {isHeader && <span style={{ marginLeft: 'auto', padding: '3px 8px', flexShrink: 0, fontSize: 10, color: 'var(--accent2)', fontFamily: 'sans-serif', fontWeight: 600 }}>← header</span>}
            </div>
          )
        })}
      </div>

      {!embedded ? (
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
      ) : null}
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
  const { dbInstanceId, preferenceSubjectId } = useAppSession()
  const [defaultImportCategoryUsageMode] = useUserPreference(IMPORT_DEFAULT_CATEGORY_USAGE_MODE_PREF_KEY, IMPORT_CATEGORY_USAGE_MODE_PER_SOURCE)
  const [lastImportDataSourceId, setLastImportDataSourceId] = useUserPreference(LAST_IMPORT_DATA_SOURCE_PREF_KEY, '')
  const [expandedSourceRows, setExpandedSourceRows] = useUserPreference(EXPANDED_IMPORT_SOURCE_ROWS_PREF_KEY, {})
  const [savedDataSourceManagerPos, setSavedDataSourceManagerPos] = useUserPreference(DATA_SOURCE_MANAGER_POS_PREF_KEY, null)
  const [systemCategoryWorkspaceDraft, setSystemCategoryWorkspaceDraft] = useUserPreference(SYSTEM_CATEGORY_WORKSPACE_DRAFT_PREF_KEY, null)
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
  const [dataSourceManagerInitialMode, setDataSourceManagerInitialMode] = useState('list')
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
  const [useImportedCategories, setUseImportedCategories] = useState(getDefaultImportedCategoryUsageEnabled(defaultImportCategoryUsageMode))
  const [importedCategorySettings, setImportedCategorySettings] = useState(getBlankImportedCategorySettings())
  const [showImportedCategorySettings, setShowImportedCategorySettings] = useState(false)
  const [batchImportedCategorySettingsDialog, setBatchImportedCategorySettingsDialog] = useState(null)
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
  const [pendingAccountMatchChooser, setPendingAccountMatchChooser] = useState(null)
  const [categoryAssignments, setCategoryAssignments] = useState({})
  const [showCategoryWorkspace, setShowCategoryWorkspace] = useState(false)
  const [sourceWorkspaceProfileId, setSourceWorkspaceProfileId] = useState('')
  const [sourceWorkspaceBatchId, setSourceWorkspaceBatchId] = useState('')
  const [sourceWorkspaceDraft, setSourceWorkspaceDraft] = useState(null)
  const [showSystemCategoryWorkspace, setShowSystemCategoryWorkspace] = useState(false)
  // Snapshot the source values when the workspace opens and keep them stable.
  // Recomputing them from the live draft would churn the array identity and
  // retrigger CategoryImportWorkspace sanitization on every draft update.
  const [sourceWorkspaceSourceValues, setSourceWorkspaceSourceValues] = useState([])
  const [importCategoryDraft, setImportCategoryDraft] = useState(null)
  const [importResult, setImportResult] = useState(null)
  const [showRaw, setShowRaw] = useState(false)
  const [rejectedRowsViewer, setRejectedRowsViewer] = useState(null)
  const [duplicateRowsViewer, setDuplicateRowsViewer] = useState(null)
  // Unified duplicates viewer state was lifted to UnifiedDuplicatesViewerContext so the floating
  // report can survive route changes. We hold onto the context handles here to open it and to
  // know when it has reloaded (so the file-card pill counts can be refreshed in step).
  const unifiedDuplicatesViewer = useUnifiedDuplicatesViewer()
  const [batchDetailPanels, setBatchDetailPanels] = useState([])
  const [duplicateImporting, setDuplicateImporting] = useState(false)
  const [pendingDuplicateImport, setPendingDuplicateImport] = useState(null)
  const [pendingProfileMismatch, setPendingProfileMismatch] = useState(null)
  const [showProfileMismatchChooser, setShowProfileMismatchChooser] = useState(false)
  const [pendingMappingSourceSwitch, setPendingMappingSourceSwitch] = useState(null)
  const [noticeDialog, setNoticeDialog] = useState(null)
  // Per-batch "+ New data source from this file" inline name entry (unknown-source cards).
  const [assignNewSourceBatchId, setAssignNewSourceBatchId] = useState('')
  const [assignNewSourceName, setAssignNewSourceName] = useState('')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [dateFormatLocked, setDateFormatLocked] = useState(false)
  const duplicateViewerRequestRef = useRef(0)
  const dataSourceManagerRef = useRef(null)
  const dataSourceManagerDragStartRef = useRef(null)

  useEffect(() => {
    Promise.all([
      api.getImportProfiles(),
      // include_children so a CSV value whose original account has been grouped under
      // another (e.g. "Chase Checking 1234" attached to "Chase") still appears for the
      // exact-name and stem-match lookups below — otherwise the prior mapping silently
      // disappears the moment the user groups accounts on the Accounts page.
      api.getAccounts({ include_children: true }),
      api.getCategories(),
      api.listBatches(),
    ]).then(([p, a, c, b]) => {
      setProfiles(p)
      setAccounts(a)
      setCategories(c)
      setBatches(b)
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
  const showingInitialSourceChooser = !uploadChoiceReady
  const isFirstRunSourceChoice = showingInitialSourceChooser && profiles.length === 0
  const uploadSelectionLabel = activeUploadProfile?.name || (uploadUsesManualDraft ? 'Temporary draft' : '')
  const activeSourceWorkspaceSummary = useMemo(
    () => summarizeCategoryWorkspaceDraft(sourceWorkspaceDraft || clonePersistedCategoryWorkspaceDraft(activeSourceWorkspaceProfile?.column_map?.category_workspace_draft)),
    [activeSourceWorkspaceProfile, sourceWorkspaceDraft],
  )
  const unassignedGroup = useMemo(
    () => categories.find(category => !category.parent_id && category.system_key === UNASSIGNED_CATEGORY_SYSTEM_KEY) || null,
    [categories],
  )
  const unassignedCategories = useMemo(
    () => (unassignedGroup
      ? categories
        .filter(category => category.parent_id === unassignedGroup.id)
        .slice()
        .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' }))
      : []),
    [categories, unassignedGroup],
  )
  const systemCategoryWorkspaceCategories = useMemo(
    () => categories.filter(category => (
      category.id !== unassignedGroup?.id &&
      category.parent_id !== unassignedGroup?.id
    )),
    [categories, unassignedGroup],
  )
  const liveUnassignedCategorySourceValues = useMemo(
    () => unassignedCategories.map(category => category.name).filter(Boolean),
    [unassignedCategories],
  )
  const effectiveSystemCategoryWorkspaceDraft = useMemo(
    () => sanitizeCategoryWorkspaceDraftToSourceValues(systemCategoryWorkspaceDraft, liveUnassignedCategorySourceValues),
    [systemCategoryWorkspaceDraft, liveUnassignedCategorySourceValues],
  )
  const effectiveSystemCategoryWorkspaceSummary = useMemo(
    () => summarizeCategoryWorkspaceDraft(effectiveSystemCategoryWorkspaceDraft),
    [effectiveSystemCategoryWorkspaceDraft],
  )
  const trackedSystemCategoryValueKeys = useMemo(
    () => new Set((effectiveSystemCategoryWorkspaceSummary.sourceValues || []).map(normalizeImportCategoryValue)),
    [effectiveSystemCategoryWorkspaceSummary],
  )
  const untrackedUnassignedCategoryCount = useMemo(
    () => liveUnassignedCategorySourceValues.filter(
      value => !trackedSystemCategoryValueKeys.has(normalizeImportCategoryValue(value))
    ).length,
    [liveUnassignedCategorySourceValues, trackedSystemCategoryValueKeys],
  )
  const pendingSystemCategoryCount = (effectiveSystemCategoryWorkspaceSummary.remainingCount || 0) + untrackedUnassignedCategoryCount
  const totalSystemCategoryWorkspaceCount = (effectiveSystemCategoryWorkspaceSummary.totalCount || 0) + untrackedUnassignedCategoryCount
  const systemCategoryWorkspaceSourceValues = useMemo(
    () => liveUnassignedCategorySourceValues,
    [liveUnassignedCategorySourceValues],
  )
  const hasSystemRuleSuggestionWork = useMemo(
    () => batches.some(batch => batch.use_imported_categories && batch.has_imported_categories),
    [batches],
  )
  const pendingSystemRuleSuggestionCount = useMemo(
    () => batches.reduce((total, batch) => {
      if (!batch.use_imported_categories || !batch.has_imported_categories) return total
      return total + Number(batch.rule_suggestion_review?.pending_count || 0)
    }, 0),
    [batches],
  )

  // Also invoked by the App-level duplicate-detection dialog's drill-through arrow — through
  // the viewer-context drill-through registration in the effect below (when ImportExport is
  // mounted), or via a URL-param fallback (the effect after that) when it isn't.
  function openBatchDetail(batch) {
    if (!batch?.id) return
    // If the panel for this batch is already open, REPLACE its entry with the new payload
    // rather than no-op'ing. The drill-through link from the duplicate-detection dialog can
    // be invoked with different `_dateFilter` values (none, or a covered-range), and silently
    // dropping the second invocation would leave the user staring at the panel with whatever
    // filter the first invocation set — see "transaction register opens with the wrong date
    // range" symptom when both a coverage row and a Shape-2 row in the report point at the
    // same batch.
    setBatchDetailPanels(prev => {
      const existingIndex = prev.findIndex(panel => panel.id === batch.id)
      if (existingIndex === -1) return [...prev, batch]
      const next = [...prev]
      next[existingIndex] = batch
      return next
    })
  }

  function closeBatchDetail(batchId) {
    setBatchDetailPanels(prev => prev.filter(panel => panel.id !== batchId))
  }

  // Register an in-place drill-through handler with the App-level duplicates viewer. While
  // we're mounted, clicking the source-batch link inside the floating dialog opens the batch
  // detail panel here without a URL navigation. When we unmount, the context falls back to
  // navigating to `/import-export?openBatch=…` so the same action still works from any page.
  useEffect(() => {
    return unifiedDuplicatesViewer.registerDrillThroughHandler(({ batchId: targetBatchId, dateStart, dateEnd }) => {
      const sourceBatch = batches.find(b => b.id === targetBatchId)
      if (!sourceBatch) return
      const _dateFilter = (dateStart || dateEnd) ? { dateStart, dateEnd } : undefined
      openBatchDetail({ ...sourceBatch, _dateFilter })
    })
  }, [unifiedDuplicatesViewer, batches])

  // Drill-through fallback: when the user is on another page and clicks the source-batch link,
  // the context navigates here with these query params. Honor them once on arrival, then clean
  // the URL so a later refresh doesn't re-open the panel.
  const location = useLocation()
  useEffect(() => {
    if (!batches.length) return
    const params = new URLSearchParams(location.search)
    const targetBatchId = params.get('openBatch')
    if (!targetBatchId) return
    const sourceBatch = batches.find(b => b.id === targetBatchId)
    if (sourceBatch) {
      const dateStart = params.get('dateStart') || ''
      const dateEnd = params.get('dateEnd') || ''
      const _dateFilter = (dateStart || dateEnd) ? { dateStart, dateEnd } : undefined
      openBatchDetail({ ...sourceBatch, _dateFilter })
    }
    navigate('/import-export', { replace: true })
  }, [location.search, batches, navigate])

  // When the user resolves rows from the floating dialog, the file-card pill counts on this
  // page need to refresh so the displayed numbers stay honest. The context advances
  // `viewer.version` on every reload; we watch that counter (only when mounted) and re-fetch
  // the batch list when it changes.
  const viewerVersion = unifiedDuplicatesViewer.viewer?.version || 0
  useEffect(() => {
    if (viewerVersion === 0) return
    api.listBatches().then(setBatches).catch(() => {})
  }, [viewerVersion])

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
    setDataSourceManagerInitialMode('list')
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

  // Distinct new accounts the user has chosen to create in THIS import (deduped by name). Offered
  // as targets in every other label's picker so several file labels can collapse onto one new
  // account. There is no label-to-label reference — each label independently declares the name —
  // so re-pointing one label never dangles another; the importer merges same-named new accounts.
  const inFlightNewAccounts = useMemo(() => {
    const byName = new Map()
    for (const entry of Object.values(accountMap || {})) {
      if (!entry?.createNew || entry?.skip) continue
      const name = String(entry.newName || '').trim()
      if (name && !byName.has(name.toLowerCase())) {
        byName.set(name.toLowerCase(), { name, type: entry.newType || '' })
      }
    }
    return [...byName.values()]
  }, [accountMap])

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
  const likelyAccountMatchesByValue = useMemo(
    () => Object.fromEntries(
      remainingAccountValues.map(value => [value, findLikelyAccountMatch(accounts, value)]),
    ),
    [remainingAccountValues, accounts],
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

  const importedCategoryChoices = useMemo(() => {
    const ownerChoices = new Map()
    const unassignedChoices = new Map()
    const addOwnerChoice = (ownerId, ownerName, rowCount = 0) => {
      const normalizedId = String(ownerId || '').trim()
      if (!normalizedId) return
      const existing = ownerChoices.get(normalizedId)
      ownerChoices.set(normalizedId, {
        key: `owner:${normalizedId}`,
        kind: 'owner',
        ownerId: normalizedId,
        label: ownerName || 'Unnamed owner',
        rowCount: (existing?.rowCount || 0) + Number(rowCount || 0),
      })
    }
    const addUnassignedChoice = (token, label, rowCount = 0) => {
      const normalizedToken = String(token || '').trim()
      if (!normalizedToken) return
      const existing = unassignedChoices.get(normalizedToken)
      unassignedChoices.set(normalizedToken, {
        key: `account:${normalizedToken}`,
        kind: 'account',
        token: normalizedToken,
        label,
        rowCount: (existing?.rowCount || 0) + Number(rowCount || 0),
      })
    }

    if (colAccount) {
      for (const csvVal of remainingAccountValues) {
        const mapping = accountMap[csvVal]
        if (mapping?.skip) continue
        const rowCount = Number(accountValueCounts[csvVal] || 0)
        if (mapping?.accountId) {
          const account = accounts.find(item => item.id === mapping.accountId)
          if (account?.owner_id) addOwnerChoice(account.owner_id, account.owner_name || account.name, rowCount)
          else addUnassignedChoice(csvVal, account?.name || csvVal, rowCount)
          continue
        }
        if (mapping?.createNew && String(mapping.newName || '').trim()) {
          addUnassignedChoice(csvVal, String(mapping.newName || csvVal).trim(), rowCount)
        }
      }
    } else if (singleAccountNew.enabled && singleAccountNew.name.trim()) {
      addUnassignedChoice(getNewAccountCategoryScopeToken(singleAccountNew.name), singleAccountNew.name.trim(), importableRowCount)
    } else if (accountId) {
      const account = accounts.find(item => item.id === accountId)
      if (account?.owner_id) addOwnerChoice(account.owner_id, account.owner_name || account.name, importableRowCount)
      else addUnassignedChoice(getFixedAccountCategoryScopeToken(accountId), account?.name || 'Selected account', importableRowCount)
    }

    return [
      ...Array.from(ownerChoices.values()).sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' })),
      ...Array.from(unassignedChoices.values()).sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' })),
    ]
  }, [
    accountId,
    accountMap,
    accountValueCounts,
    accounts,
    colAccount,
    importableRowCount,
    remainingAccountValues,
    singleAccountNew,
  ])
  const importedCategorySummary = useMemo(
    () => summarizeImportedCategorySettings(importedCategorySettings, importedCategoryChoices),
    [importedCategoryChoices, importedCategorySettings],
  )

  useEffect(() => {
    setImportedCategorySettings(prev => {
      const normalized = normalizeImportedCategorySettings(prev)
      if (normalized.scope_mode !== IMPORTED_CATEGORY_SCOPE_FILTERED) return prev
      const validOwnerIds = new Set(importedCategoryChoices.filter(choice => choice.kind === 'owner').map(choice => choice.ownerId))
      const validAccountTokens = new Set(importedCategoryChoices.filter(choice => choice.kind === 'account').map(choice => choice.token))
      const nextSettings = {
        ...normalized,
        owner_ids: normalized.owner_ids.filter(ownerId => validOwnerIds.has(ownerId)),
        unassigned_account_tokens: normalized.unassigned_account_tokens.filter(token => validAccountTokens.has(token)),
      }
      return stableSerialize(nextSettings) === stableSerialize(normalized) ? prev : nextSettings
    })
  }, [importedCategoryChoices])

  const dataSourceRows = useMemo(() => {
    const savedSourceRows = profiles.map(profile => {
      const draft = clonePersistedCategoryWorkspaceDraft(profile.column_map?.category_workspace_draft)
      const profileBatches = batches.filter(batch => batch.profile_id === profile.id).sort((a, b) => String(b.imported_at || '').localeCompare(String(a.imported_at || '')))
      const latestBatch = profileBatches[0] || null
      return {
        key: `profile:${profile.id}`,
        kind: 'profile',
        profile,
        draft,
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

  function getCandidateFieldHint(candidateHeaders, currentValue) {
    return candidateHeaders.length > 0 && !currentValue
      ? formatLikelyMatchLabel(candidateHeaders.length)
      : ''
  }

  function buildMappingFieldConfig({
    key,
    label,
    candidateHeaders,
    value,
    setValue,
    required = false,
    hint = undefined,
    tone = 'muted',
    after = null,
    onChange = null,
    onAcceptSuggestion = null,
  }) {
    const defaultOnChange = nextValue => {
      if (nextValue) clearMappingSuggestion(key)
      setValue?.(nextValue)
    }
    const resolvedOnChange = onChange || defaultOnChange
    return {
      key,
      label,
      headers: candidateHeaders,
      allHeaders: preview.headers,
      value,
      onChange: resolvedOnChange,
      suggestedValue: mappingSuggestions[key],
      onAcceptSuggestion: onAcceptSuggestion || resolvedOnChange,
      required,
      hint: hint ?? getCandidateFieldHint(candidateHeaders, value),
      tone,
      after,
    }
  }

  function handleDateColumnChange(nextValue) {
    setDateFormatLocked(false)
    if (nextValue) clearMappingSuggestion('date')
    setColDate(nextValue)
  }

  function handleCategoryColumnChange(nextValue) {
    setShowCategoryWorkspace(false)
    setImportCategoryDraft(null)
    if (nextValue) clearMappingSuggestion('category')
    setColCategory(nextValue)
  }

  useEffect(() => {
    setAccountMap(prev => {
      const next = { ...prev }
      for (const val of distinctAccountValues) {
        const exactMatch = findExactAccountNameMatch(accounts, val)
        if (!(val in next)) {
          next[val] = {
            accountId: exactMatch ? exactMatch.id : '',
            createNew: false,
            newName: val,
            newType: exactMatch?.type || '',
            groupWithAccountId: '',
            duplicateCompareTargetAccountId: '',
            skip: false,
          }
          continue
        }
        const entry = next[val] || {}
        if (
          exactMatch &&
          !entry.skip &&
          !entry.accountId &&
          (!entry.createNew || String(entry.newName || '').trim().toLowerCase() === String(val || '').trim().toLowerCase())
        ) {
          next[val] = {
            ...entry,
            accountId: exactMatch.id,
            createNew: false,
            newName: exactMatch.name || val,
            newType: exactMatch.type || entry.newType || 'depository',
            groupWithAccountId: '',
            duplicateCompareTargetAccountId: '',
            skip: false,
          }
        }
      }
      for (const [csvVal, entry] of Object.entries(next)) {
        const stillExists = entry.accountId
          ? accounts.find(a => a.id === entry.accountId)
          : null
        if (entry.accountId && !stillExists) {
          const byName = findExactAccountNameMatch(accounts, csvVal)
          next[csvVal] = byName
            ? {
              ...entry,
              accountId: byName.id,
              createNew: false,
              newName: byName.name,
              newType: byName.type || entry.newType || 'depository',
              groupWithAccountId: '',
              duplicateCompareTargetAccountId: '',
              skip: false,
            }
            : {
              accountId: '',
              createNew: false,
              newName: csvVal,
              newType: entry.newType || '',
              groupWithAccountId: '',
              duplicateCompareTargetAccountId: '',
              skip: false,
            }
        }
        if (entry.createNew && entry.newName && !accounts.some(a => a.name.toLowerCase() === entry.newName.trim().toLowerCase()) && entry.newName !== csvVal) {
          next[csvVal] = {
            accountId: '',
            createNew: false,
            newName: csvVal,
            newType: entry.newType || '',
            groupWithAccountId: '',
            duplicateCompareTargetAccountId: '',
            skip: false,
          }
        }
        if (entry.duplicateCompareTargetAccountId && !accounts.some(a => a.id === entry.duplicateCompareTargetAccountId)) {
          next[csvVal] = {
            ...next[csvVal],
            duplicateCompareTargetAccountId: '',
          }
        }
        if (entry.groupWithAccountId && !accounts.some(a => a.id === entry.groupWithAccountId)) {
          next[csvVal] = {
            ...next[csvVal],
            groupWithAccountId: '',
          }
        }
      }
      return next
    })
  }, [distinctAccountValues, accounts])

  useEffect(() => {
    if (!pendingAccountMatchChooser) return
    const stillExists = distinctAccountValues.includes(pendingAccountMatchChooser.csvValue)
    const targetStillExists = accounts.some(account => account.id === pendingAccountMatchChooser.targetAccountId)
    if (!stillExists || !targetStillExists) {
      setPendingAccountMatchChooser(null)
    }
  }, [pendingAccountMatchChooser, distinctAccountValues, accounts])

  function openAccountMatchChooser(csvValue, targetAccount) {
    if (!csvValue || !targetAccount?.id) return
    setPendingAccountMatchChooser({
      csvValue,
      targetAccountId: targetAccount.id,
      targetLabel: getAccountMatchLabel(targetAccount) || targetAccount.name || csvValue,
    })
  }

  function applyAccountMatchChoice(choice) {
    const pending = pendingAccountMatchChooser
    if (!pending?.csvValue || !pending?.targetAccountId) return
    const csvValue = pending.csvValue
    const targetAccount = accounts.find(account => account.id === pending.targetAccountId)
    setPendingAccountMatchChooser(null)
    setAccountMap(prev => {
      const defaultEntry = {
        accountId: '',
        createNew: false,
        newName: csvValue,
        newType: targetAccount?.type || guessNewAccountTypeFromName(csvValue),
        groupWithAccountId: '',
        duplicateCompareTargetAccountId: '',
        skip: false,
      }
      const current = { ...defaultEntry, ...(prev[csvValue] || {}) }
      if (choice === 'map_existing' && targetAccount) {
        return {
          ...prev,
          [csvValue]: {
            ...current,
            accountId: targetAccount.id,
            createNew: false,
            newName: targetAccount.name || csvValue,
            newType: targetAccount.type || current.newType || 'depository',
            groupWithAccountId: '',
            duplicateCompareTargetAccountId: '',
            skip: false,
          },
        }
      }
      if (choice === 'group_with_existing' && targetAccount) {
        return {
          ...prev,
          [csvValue]: {
            ...current,
            accountId: '',
            createNew: true,
            newName: current.newName || csvValue,
            newType: current.newType || targetAccount.type || 'depository',
            groupWithAccountId: targetAccount.id,
            duplicateCompareTargetAccountId: '',
            skip: false,
          },
        }
      }
      if (choice === 'duplicate_compare_only' && targetAccount) {
        return {
          ...prev,
          [csvValue]: {
            ...current,
            accountId: '',
            createNew: true,
            newName: current.newName || csvValue,
            newType: current.newType || targetAccount.type || 'depository',
            groupWithAccountId: '',
            duplicateCompareTargetAccountId: targetAccount.id,
            skip: false,
          },
        }
      }
      return {
        ...prev,
        [csvValue]: {
          ...current,
          accountId: '',
          createNew: true,
          newName: current.newName || csvValue,
          newType: current.newType || guessNewAccountTypeFromName(csvValue),
          groupWithAccountId: '',
          duplicateCompareTargetAccountId: '',
          skip: false,
        },
      }
    })
  }

  const hasImportWorkToSave = !!(
    colDate || colAmount || colDebit || colCredit || colDir || colDesc || colCategory || colNotes || colPending ||
    colAccount || accountId || singleAccountNew.enabled || Object.keys(accountMap).length > 0 ||
    Object.keys(categoryAssignments).length > 0 || skipRows > 0 || dateFormat !== '%m/%d/%Y' ||
    amtConv !== 'single_signed' || !applyCat || useImportedCategories ||
    stableSerialize(importedCategorySettings) !== stableSerialize(getBlankImportedCategorySettings())
  )

  useEffect(() => {
    if (!preview || !hasImportWorkToSave || selectedProfile) return
    const savedRecord = saveImportDraft(preview, buildImportSnapshot(), dbInstanceId, preferenceSubjectId)
    setManualDraftRecord(savedRecord || loadSavedImportDraftRecord(dbInstanceId, preferenceSubjectId))
    // buildImportSnapshot is useCallback'd (declared further down in this file)
    // with the exact state deps enumerated here, so its identity invalidates at
    // the same moments this effect would. Listing it here would require moving
    // its declaration above this point — left for a future reorganization pass.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    dbInstanceId, preferenceSubjectId,
    preview, hasImportWorkToSave, selectedProfile, accountId, dateFormat, amtConv, skipRows, applyCat, useImportedCategories, importedCategorySettings,
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
      } catch { }
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
  const headerDetectedBeyondFirstLine = detectedHeaderOffset > 0
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

  const buildImportSnapshot = useCallback(() => {
    // getColumnMap is a hoisted function declaration so it stays callable from
    // here despite this being a useCallback above its source position. We list
    // every column state var explicitly in the deps below so a column-mapping
    // change still invalidates the snapshot.
    const cm = getColumnMap()
    const categoryWorkspaceDraft = clonePersistedCategoryWorkspaceDraft(importCategoryDraft)
    const accountImportState = buildAccountImportStateSnapshot(accountMap)
    if (!colAccount && singleAccountNew.enabled && singleAccountNew.name.trim()) {
      const snapshot = {
        column_map: {
          ...cm,
          single_account_new: { name: singleAccountNew.name.trim(), type: singleAccountNew.type || 'depository' },
          [IMPORTED_CATEGORY_SETTINGS_KEY]: normalizeImportedCategorySettings(importedCategorySettings),
        },
        account_id: null,
        single_account_new: { name: singleAccountNew.name.trim(), type: singleAccountNew.type || 'depository' },
        date_format: dateFormat,
        amount_convention: amtConv,
        skip_rows: skipRows,
        apply_categorization: applyCat,
        use_imported_categories: useImportedCategories && !!colCategory,
        imported_category_scope_mode: normalizeImportedCategorySettings(importedCategorySettings).scope_mode,
        imported_category_owner_ids: normalizeImportedCategorySettings(importedCategorySettings).owner_ids,
        imported_category_unassigned_account_tokens: normalizeImportedCategorySettings(importedCategorySettings).unassigned_account_tokens,
        ...accountImportState,
      }
      if (categoryWorkspaceDraft) snapshot.category_workspace_draft = categoryWorkspaceDraft
      return snapshot
    }
    const normalizedImportedCategorySettings = normalizeImportedCategorySettings(importedCategorySettings)
    const snapshot = {
      column_map: { ...cm, [IMPORTED_CATEGORY_SETTINGS_KEY]: normalizedImportedCategorySettings },
      account_id: (!colAccount && accountId) ? accountId : null,
      date_format: dateFormat,
      amount_convention: amtConv,
      skip_rows: skipRows,
      apply_categorization: applyCat,
      use_imported_categories: useImportedCategories && !!colCategory,
      imported_category_scope_mode: normalizedImportedCategorySettings.scope_mode,
      imported_category_owner_ids: normalizedImportedCategorySettings.owner_ids,
      imported_category_unassigned_account_tokens: normalizedImportedCategorySettings.unassigned_account_tokens,
      ...accountImportState,
    }
    if (categoryWorkspaceDraft) snapshot.category_workspace_draft = categoryWorkspaceDraft
    return snapshot
    // getColumnMap is a hoisted function declaration (further down in this file) that
    // reads exactly the col* state vars listed below, so the effective dependency set
    // is captured. Listing getColumnMap directly would require moving its declaration
    // above this point (or useCallback'ing it, which would TDZ here).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    importCategoryDraft, accountMap, accountId, dateFormat, amtConv, skipRows,
    applyCat, useImportedCategories, importedCategorySettings, singleAccountNew,
    colDate, colAmount, colDebit, colCredit, colDir, colDesc, colCategory, colNotes, colPending, colAccount,
  ])

  function buildCurrentManualDraftRecord(previewLike = preview) {
    if (!previewLike) return null
    return buildDraftRecordFromPreview(previewLike, buildImportSnapshot())
  }

  function openManualDraftSaveEditor(defaultName = '') {
    const normalizedDefaultName = String(defaultName || '').trim()
    setManualDraftSaveName(normalizedDefaultName)
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

  // Move a profileless (unknown-source) imported file under an existing data source. Pure
  // re-grouping — it does not re-import or re-map; the batch keeps its own imported data.
  async function assignUnknownBatchToProfile(batchId, profileId) {
    if (!profileId) return
    try {
      await api.setBatchProfile(batchId, profileId)
      setBatches(await api.listBatches())
    } catch (error) {
      setNoticeDialog({ title: 'Could not assign to data source', description: error?.message || 'Please try again.' })
    }
  }

  // "+ New data source from this file": create a saved data source from the batch's own import
  // mapping (server-side, where the snapshot lives) and link the file to it.
  async function createDataSourceFromUnknownBatch(batch, rawName) {
    const name = (rawName || '').trim()
    if (!name || !batch) return
    try {
      await api.createProfileFromBatch(batch.id, name, inferFilenamePattern(batch.filename || '') || null)
      setAssignNewSourceBatchId('')
      setAssignNewSourceName('')
      const [nextProfiles, nextBatches] = await Promise.all([api.getImportProfiles(), api.listBatches()])
      setProfiles(nextProfiles)
      setBatches(nextBatches)
    } catch (error) {
      setNoticeDialog({ title: 'Could not create data source', description: error?.message || 'Please try again.' })
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
    applySnapshot(getBlankImportSnapshot())
    setMappingSuggestions(getBlankMappingSuggestions())
    setDateFormatLocked(false)
  }

  function resetToSuggestedImportMapping(profileId = '', previewLike = preview) {
    const inferredMapping = inferUnambiguousImportMappingFromPreview(previewLike, 0)
    const inferredCharacteristics = inferImportFileCharacteristicsFromPreview(previewLike, 0)
    setSelectedProfile(profileId || '')
    setShowCategoryWorkspace(false)
    setShowMappingSourceChooser(false)
    setAccountId('')
    setDateFormat(inferredCharacteristics.dateFormat || '%m/%d/%Y')
    setDateFormatLocked(false)
    setAmtConv(inferredCharacteristics.amountConvention || 'single_signed')
    setSkipRows(0)
    setApplyCat(true)
    setUseImportedCategories(getDefaultImportedCategoryUsageEnabled(defaultImportCategoryUsageMode))
    setImportedCategorySettings(getBlankImportedCategorySettings())
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
    setUseImportedCategories(getDefaultImportedCategoryUsageEnabled(defaultImportCategoryUsageMode))
    setImportedCategorySettings(getBlankImportedCategorySettings())
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
    setImportCategoryDraft(null)
    setShowCategoryWorkspace(false)
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
      ? findExactAccountNameMatch(accounts, cm.single_account_new.name)
      : null
    const existingAssignedAccount = p.account_id
      ? accounts.find(a => a.id === p.account_id)
      : null
    setAccountId(existingSingleAccount ? existingSingleAccount.id : (existingAssignedAccount?.id || '')); setDateFormat(p.date_format || '%m/%d/%Y')
    setDateFormatLocked(true)
    setAmtConv(p.amount_convention || 'single_signed'); setSkipRows(p.skip_rows || 0)
    setApplyCat(!!p.apply_categorization)
    setUseImportedCategories(!!p.use_imported_categories)
    setImportedCategorySettings(extractImportedCategorySettings(p))
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
    if (newColAccount && (cm.account_assignments || cm.account_skips || cm.account_new || cm.account_duplicate_compare)) {
      const restored = {}
      const duplicateCompare = cm.account_duplicate_compare || {}
      for (const [csvVal, aid] of Object.entries(cm.account_assignments || {})) {
        const stillExists = accounts.find(a => a.id === aid)
        if (stillExists) {
          restored[csvVal] = { accountId: aid, createNew: false, newName: stillExists.name, newType: stillExists.type || 'depository', groupWithAccountId: '', duplicateCompareTargetAccountId: '', skip: false }
        } else {
          const byName = findExactAccountNameMatch(accounts, csvVal)
          if (byName) {
            restored[csvVal] = { accountId: byName.id, createNew: false, newName: byName.name, newType: byName.type || 'depository', groupWithAccountId: '', duplicateCompareTargetAccountId: '', skip: false }
          } else {
            restored[csvVal] = { accountId: '', createNew: false, newName: csvVal, newType: '', groupWithAccountId: '', duplicateCompareTargetAccountId: '', skip: false }
          }
        }
      }
      for (const csvVal of (cm.account_skips || [])) {
        restored[csvVal] = { accountId: '', createNew: false, newName: csvVal, newType: '', groupWithAccountId: '', duplicateCompareTargetAccountId: '', skip: true }
      }
      for (const [csvVal, info] of Object.entries(cm.account_new || {})) {
        const duplicateCompareTargetAccountId = accounts.some(a => a.id === duplicateCompare[csvVal]) ? duplicateCompare[csvVal] : ''
        const existing = findExactAccountNameMatch(accounts, info.name)
        if (existing) {
          restored[csvVal] = { accountId: existing.id, createNew: false, newName: info.name, newType: info.type, groupWithAccountId: '', duplicateCompareTargetAccountId: '', skip: false }
        } else {
          restored[csvVal] = { accountId: '', createNew: true, newName: info.name || csvVal, newType: info?.type ?? '', groupWithAccountId: '', duplicateCompareTargetAccountId, skip: false }
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

  function applySnapshot(snap, previewLike = preview) {
    if (!snap) return
    const cm = snap.column_map || {}
    const restoredCategoryDraft = clonePersistedCategoryWorkspaceDraft(snap.category_workspace_draft)
    const existingSingleAccount = snap.single_account_new?.name
      ? findExactAccountNameMatch(accounts, snap.single_account_new.name)
      : null
    const existingAssignedAccount = snap.account_id
      ? accounts.find(a => a.id === snap.account_id)
      : null
    setDateFormat(snap.date_format || '%m/%d/%Y'); setDateFormatLocked(true); setAmtConv(snap.amount_convention || 'single_signed')
    setSkipRows(snap.skip_rows || 0); setApplyCat(snap.apply_categorization !== false)
    setUseImportedCategories(!!snap.use_imported_categories)
    setImportedCategorySettings(extractImportedCategorySettings(snap))
    setColDate(cm.date || null); setColAmount(cm.amount || null); setColDebit(cm.debit || null)
    setColCredit(cm.credit || null); setColDir(cm.direction || null)
    setColDesc(cm.description || null); setColCategory(cm.category || null); setColNotes(cm.notes || null); setColPending(cm.pending || null); setColAccount(cm.account || null)
    setMappingSuggestions(buildProfileMappingSuggestions(previewLike, {
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
    if (snap.account_map || snap.skip_accounts || snap.account_new || snap.account_duplicate_compare) {
      const restored = {}
      const skips = new Set(snap.skip_accounts || [])
      const duplicateCompare = snap.account_duplicate_compare || {}
      for (const [val, aid] of Object.entries(snap.account_map || {})) {
        const stillExists = accounts.find(a => a.id === aid)
        if (stillExists) {
          restored[val] = { accountId: aid, createNew: false, newName: stillExists.name, newType: stillExists.type || 'depository', groupWithAccountId: '', duplicateCompareTargetAccountId: '', skip: false }
        } else {
          const byName = findExactAccountNameMatch(accounts, val)
          if (byName) {
            restored[val] = { accountId: byName.id, createNew: false, newName: byName.name, newType: byName.type || 'depository', groupWithAccountId: '', duplicateCompareTargetAccountId: '', skip: false }
          } else {
            restored[val] = { accountId: '', createNew: false, newName: val, newType: '', groupWithAccountId: '', duplicateCompareTargetAccountId: '', skip: false }
          }
        }
      }
      for (const val of skips) {
        restored[val] = { accountId: '', createNew: false, newName: val, newType: '', groupWithAccountId: '', duplicateCompareTargetAccountId: '', skip: true }
      }
      for (const [val, info] of Object.entries(snap.account_new || {})) {
        const duplicateCompareTargetAccountId = accounts.some(a => a.id === duplicateCompare[val]) ? duplicateCompare[val] : ''
        const existing = findExactAccountNameMatch(accounts, info?.name)
        if (existing) {
          restored[val] = { accountId: existing.id, createNew: false, newName: existing.name, newType: existing.type || info?.type || 'depository', groupWithAccountId: '', duplicateCompareTargetAccountId: '', skip: false }
        } else {
          restored[val] = { accountId: '', createNew: true, newName: info?.name || val, newType: info?.type ?? '', groupWithAccountId: '', duplicateCompareTargetAccountId, skip: false }
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

  async function handleFile(file, options = {}) {
    const { sourceIdOverride = selectedUploadSource } = options
    if (!file || !sourceIdOverride) return
    setLoading(true)
    try {
      resetImportMappingState()
      setShowRaw(false)
      setShowAdvanced(false)
      const result = await api.previewCsv(file)
      setPreview({ ...result, file }); setAccountMap({})
      setSingleAccountNew({ enabled: false, name: '', type: 'depository' })
      setCategoryAssignments({})
      const savedDraft = loadSavedImportDraft(result, dbInstanceId, preferenceSubjectId)
      if (sourceIdOverride && sourceIdOverride !== MANUAL_DATA_SOURCE_VALUE) {
        const applied = applyProfile(sourceIdOverride, { previewLike: result, mismatchContext: 'upload' })
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
        applySnapshot(savedDraft, result)
      } else if (result.config_snapshot) {
        setMappingSuggestions(getBlankMappingSuggestions())
        applySnapshot({
          ...result.config_snapshot,
          skip_accounts: [],
        }, result)
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
      // When the header is inferred below the first line, surface the skip-row
      // controls immediately but leave the raw file viewer as an explicit review step.
      if ((result.header_row_index ?? 0) > 0) {
        setShowAdvanced(true)
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
  }, [pendingMappingBaselineCapture, stage, preview, buildImportSnapshot])

  function handleDrop(e) {
    e.preventDefault()
    if (!uploadChoiceReady) return
    handleFile(e.dataTransfer.files[0])
  }

  function getColumnMap() {
    return {
      date: colDate, amount: colAmount, debit: colDebit, credit: colCredit,
      direction: colDir, description: colDesc, category: colCategory, notes: colNotes, pending: colPending, account: colAccount,
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
          if (!mapping.newType) {
            unresolvedCount += 1
            singleMessage = `Choose an account type for "${value}".`
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
          else if (m.createNew) {
            newAccounts.push({
              csv_value: v,
              name: m.newName,
              type: m.newType,
              ...(m.groupWithAccountId ? { group_with_account_id: m.groupWithAccountId } : {}),
              ...(m.duplicateCompareTargetAccountId ? { duplicate_compare_account_id: m.duplicateCompareTargetAccountId } : {}),
            })
          }
          else if (m.accountId) finalAccountMap[v] = m.accountId
        }
      } else if (singleAccountNew.enabled) {
        newAccounts = [{ csv_value: '__single_account__', name: singleAccountNew.name.trim(), type: singleAccountNew.type || 'depository' }]
      }
      // Snapshot before the import so we can tell post-import whether a prior
      // profileless batch will be displaced into the unknown-source row.
      const hadPriorManualBatch = !selectedProfile && batches.some(b => !b.profile_id && !b.unknown_source_fallback)
      const columnMap = getColumnMap()
      const normalizedImportedCategorySettings = normalizeImportedCategorySettings(importedCategorySettings)
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
        use_imported_categories: useImportedCategories && !!colCategory,
        imported_category_scope_mode: normalizedImportedCategorySettings.scope_mode,
        imported_category_owner_ids: normalizedImportedCategorySettings.owner_ids,
        imported_category_unassigned_account_tokens: normalizedImportedCategorySettings.unassigned_account_tokens,
      })
      setImportResult(result)
      if (result.trailing_non_transaction_suspected || result.invalid_rows_suspected) setShowRaw(true)
      const refreshedAccounts = await api.getAccounts({ include_children: true })
      setAccounts(refreshedAccounts)
      let nextImportCategoryDraft = importCategoryDraft
      if (!nextImportCategoryDraft && colCategory && sourceCategoryValues.length > 0) {
        nextImportCategoryDraft = createCategoryImportDraftState(sourceCategoryValues, categories)
        setImportCategoryDraft(nextImportCategoryDraft)
      }
      // Profileless imports still keep their draft snapshot locally so a later
      // manual data source save can preserve the user's mapping work.
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

  async function handleManagerProfileCreated({ profileId, sampleFile } = {}) {
    if (!profileId) return
    selectUploadSource(profileId)
    setShowDataSourceManager(false)
    setDataSourceManagerInitialMode('list')
    if (sampleFile && stage === 'upload' && !preview) {
      await handleFile(sampleFile, { sourceIdOverride: profileId })
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
        newAccts[csvVal] = { name: m.newName.trim(), type: m.newType || '' }
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
      use_imported_categories: useImportedCategories && !!colCategory,
      imported_category_scope_mode: normalizeImportedCategorySettings(importedCategorySettings).scope_mode,
      imported_category_owner_ids: normalizeImportedCategorySettings(importedCategorySettings).owner_ids,
      imported_category_unassigned_account_tokens: normalizeImportedCategorySettings(importedCategorySettings).unassigned_account_tokens,
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
    setCategoryAssignments({})
    setShowCategoryWorkspace(false)
    setImportCategoryDraft(null)
    setImportedCategorySettings(getBlankImportedCategorySettings())
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
      // If no profileless imports remain, drop the local manual draft so the
      // temporary data source state does not linger indefinitely.
      const remainingManual = remainingBatches.filter(b => !b.profile_id)
      if (remainingManual.length === 0) {
        clearSavedImportDraft(dbInstanceId, preferenceSubjectId)
        setManualDraftRecord(null)
      }
    } else {
      // If this was the last batch attached to the profile, clear stale import
      // learning review state that no longer has any backing import history.
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
    if (batchId) {
      navigate(`/import-export/batches/${batchId}/rule-suggestions`)
      return
    }
    navigate('/import-export/rule-suggestions')
  }

  function openSystemCategoryWorkspace() {
    if (totalSystemCategoryWorkspaceCount === 0) {
      setNoticeDialog({
        title: 'No imported categories need a group',
        description: 'All imported categories have already been grouped or set aside.',
      })
      return
    }
    setShowSystemCategoryWorkspace(true)
  }

  async function applySystemCategoryWorkspaceDraft(draft) {
    setLoading(true)
    try {
      const sourceCategoryMap = new Map(
        unassignedCategories.map(category => [
          normalizeImportCategoryValue(category.name),
          category,
        ]),
      )
      const groupKeyToCategory = new Map(
        systemCategoryWorkspaceCategories
          .filter(category => !category.parent_id)
          .map(category => [
            `${category.category_type === 'income' ? 'income' : 'expense'}::${String(category.name || '').trim().toLowerCase()}`,
            category,
          ]),
      )

      for (const sectionType of ['income', 'expense']) {
        for (const draftGroup of draft?.snapshot?.tree?.[sectionType] || []) {
          const groupName = String(draftGroup.name || '').trim()
          if (!groupName) continue
          const groupKey = `${sectionType}::${groupName.toLowerCase()}`
          let liveGroup = groupKeyToCategory.get(groupKey)
          if (!liveGroup) {
            liveGroup = await api.createCategory({
              name: groupName,
              category_type: sectionType,
            })
            groupKeyToCategory.set(groupKey, liveGroup)
          }

          for (const draftChild of draftGroup.children || []) {
            const sourceKey = normalizeImportCategoryValue(draftChild.sourceValue || draftChild.name)
            const liveCategory = sourceCategoryMap.get(sourceKey)
            if (!liveCategory) continue
            const nextName = String(draftChild.name || draftChild.sourceValue || '').trim()
            const patch = {}
            if (liveCategory.parent_id !== liveGroup.id) patch.parent_id = liveGroup.id
            if (nextName && nextName !== liveCategory.name) patch.name = nextName
            if (Object.keys(patch).length > 0) {
              await api.updateCategory(liveCategory.id, patch)
            }
          }
        }
      }

      const refreshedCategories = await api.getCategories()
      const refreshedUnassignedGroup = refreshedCategories.find(category => (
        !category.parent_id && category.system_key === UNASSIGNED_CATEGORY_SYSTEM_KEY
      )) || null
      const refreshedUnassignedSourceValues = refreshedUnassignedGroup
        ? refreshedCategories
          .filter(category => category.parent_id === refreshedUnassignedGroup.id)
          .map(category => category.name)
          .filter(Boolean)
        : []
      const nextSystemDraft = sanitizeCategoryWorkspaceDraftToSourceValues(draft, refreshedUnassignedSourceValues)
      setCategories(refreshedCategories)
      setSystemCategoryWorkspaceDraft(nextSystemDraft)
      setShowSystemCategoryWorkspace(false)
    } catch (error) {
      setNoticeDialog({
        title: 'Could not organize imported categories',
        description: error?.message || 'Please try again.',
      })
    } finally {
      setLoading(false)
    }
  }

  async function updateBatchImportedCategoryUsage(batchId, nextValue) {
    const existingBatch = batches.find(batch => batch.id === batchId)
    const normalizedSettings = normalizeImportedCategorySettings(
      extractImportedCategorySettings(existingBatch || {})
    )
    setBatches(prev => prev.map(batch => (
      batch.id === batchId
        ? { ...batch, use_imported_categories: nextValue }
        : batch
    )))
    try {
      await api.updateBatchImportedCategoryUsage(batchId, {
        use_imported_categories: nextValue,
        imported_category_scope_mode: normalizedSettings.scope_mode,
        imported_category_owner_ids: normalizedSettings.owner_ids,
        imported_category_unassigned_account_tokens: normalizedSettings.unassigned_account_tokens,
      })
      const [nextBatches, nextCategories] = await Promise.all([
        api.listBatches(),
        api.getCategories(),
      ])
      setBatches(nextBatches)
      setCategories(nextCategories)
    } catch (error) {
      setBatches(await api.listBatches())
      setNoticeDialog({
        title: 'Could not update that import',
        description: error?.message || 'Please try again.',
      })
    }
  }

  function buildBatchImportedCategoryChoices(batch) {
    const ownerChoices = new Map()
    const accountChoices = new Map()
    const addOwnerChoice = (ownerId, ownerName, rowCount = 0) => {
      const normalizedId = String(ownerId || '').trim()
      if (!normalizedId) return
      const existing = ownerChoices.get(normalizedId)
      ownerChoices.set(normalizedId, {
        key: `owner:${normalizedId}`,
        kind: 'owner',
        ownerId: normalizedId,
        label: ownerName || 'Unnamed owner',
        rowCount: (existing?.rowCount || 0) + Number(rowCount || 0),
      })
    }
    const addAccountChoice = (token, label, rowCount = 0) => {
      const normalizedToken = String(token || '').trim()
      if (!normalizedToken) return
      const existing = accountChoices.get(normalizedToken)
      accountChoices.set(normalizedToken, {
        key: `account:${normalizedToken}`,
        kind: 'account',
        token: normalizedToken,
        label,
        rowCount: (existing?.rowCount || 0) + Number(rowCount || 0),
      })
    }

    for (const accountEntry of batch?.accounts || []) {
      if (accountEntry?.was_skipped) continue
      const rowCount = Number(accountEntry?.row_count || 0)
      const liveAccount = accounts.find(account => account.id === accountEntry.account_id)
      if (liveAccount?.owner_id) {
        addOwnerChoice(liveAccount.owner_id, liveAccount.owner_name || liveAccount.name, rowCount)
        continue
      }
      const token = accountEntry?.csv_value
        ? String(accountEntry.csv_value)
        : batch?.single_account_new?.name
          ? getNewAccountCategoryScopeToken(batch.single_account_new.name)
          : getFixedAccountCategoryScopeToken(accountEntry.account_id)
      addAccountChoice(token, liveAccount?.name || accountEntry?.account_name || accountEntry?.csv_value || 'Unassigned account', rowCount)
    }

    return [
      ...Array.from(ownerChoices.values()).sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' })),
      ...Array.from(accountChoices.values()).sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' })),
    ]
  }

  function openBatchImportedCategorySettings(batch) {
    setBatchImportedCategorySettingsDialog({
      batchId: batch.id,
      settings: extractImportedCategorySettings(batch),
      choices: buildBatchImportedCategoryChoices(batch),
    })
  }

  async function saveBatchImportedCategorySettings(batchId, settings) {
    const batch = batches.find(item => item.id === batchId)
    if (!batch) return
    const normalizedSettings = normalizeImportedCategorySettings(settings)
    setBatches(prev => prev.map(item => (
      item.id === batchId
        ? {
          ...item,
          imported_category_scope_mode: normalizedSettings.scope_mode,
          imported_category_owner_ids: normalizedSettings.owner_ids,
          imported_category_unassigned_account_tokens: normalizedSettings.unassigned_account_tokens,
        }
        : item
    )))
    try {
      await api.updateBatchImportedCategoryUsage(batchId, {
        use_imported_categories: !!batch.use_imported_categories,
        imported_category_scope_mode: normalizedSettings.scope_mode,
        imported_category_owner_ids: normalizedSettings.owner_ids,
        imported_category_unassigned_account_tokens: normalizedSettings.unassigned_account_tokens,
      })
      const [nextBatches, nextCategories] = await Promise.all([
        api.listBatches(),
        api.getCategories(),
      ])
      setBatches(nextBatches)
      setCategories(nextCategories)
      setBatchImportedCategorySettingsDialog(null)
    } catch (error) {
      setBatches(await api.listBatches())
      setNoticeDialog({
        title: 'Could not update category settings',
        description: error?.message || 'Please try again.',
      })
    }
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

  // Opens the unified duplicate-detection report for a batch. The dialog is rendered at the
  // App level by `UnifiedDuplicatesViewerRenderer` so it persists across route navigation; this
  // thin wrapper just normalizes the file-card payload into the context's `open` contract.
  function openUnifiedDuplicatesViewer({ source, title }) {
    const batchId = source?.batch_id || source?.id || ''
    if (!batchId) return
    unifiedDuplicatesViewer.open({ batchId, title })
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

      {showSystemCategoryWorkspace ? (
        <CategoryImportWorkspace
          sourceValues={systemCategoryWorkspaceSourceValues}
          sourceMeta={{
            total_count: totalSystemCategoryWorkspaceCount,
            displayed_count: systemCategoryWorkspaceSourceValues.length,
            truncated: false,
            limit: systemCategoryWorkspaceSourceValues.length,
          }}
          existingCategories={systemCategoryWorkspaceCategories}
          initialDraftState={effectiveSystemCategoryWorkspaceDraft}
          onDraftStateChange={setSystemCategoryWorkspaceDraft}
          onApply={applySystemCategoryWorkspaceDraft}
          onClose={() => setShowSystemCategoryWorkspace(false)}
          onCategoriesChanged={setCategories}
          title="Group Imported Categories"
          description="Organize imported categories into reporting groups."
          sourceHeading="Unassigned Categories"
          applyLabel="Apply assignments"
          applyPendingLabel="Applying…"
          remainingItemLabelSingular="unassigned category"
          remainingItemLabelPlural="unassigned categories"
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

      {showRaw && preview && stage !== 'review-data' && (
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
                        {profiles.length === 0
                          ? 'Press Skip or add a Data Source to begin'
                          : 'Select a saved data source, create a new one, or press Skip to use a temporary draft.'}
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
                            emphasis={isFirstRunSourceChoice ? 'recommended' : 'normal'}
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
                              emphasis={isFirstRunSourceChoice ? 'secondary' : 'normal'}
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
                              emphasis={isFirstRunSourceChoice ? 'recommended' : 'normal'}
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
                                emphasis={isFirstRunSourceChoice ? 'secondary' : 'normal'}
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
                  {uploadChoiceReady ? 'Drop a CSV file here, or click to browse' : (profiles.length === 0 ? 'Create a data source or select skip to begin' : 'Choose a data source or select skip to begin')}
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

            {headerDetectedBeyondFirstLine && (
              <div style={{
                display: 'grid',
                gap: 12,
                marginBottom: 14,
                padding: '12px 14px',
                borderRadius: 10,
                background: 'color-mix(in srgb, #f59e0b 11%, var(--surface2))',
                border: '1px solid color-mix(in srgb, #f59e0b 48%, var(--border))',
                boxShadow: '0 8px 24px rgba(15, 23, 42, 0.12)',
              }}>
                <div style={{ display: 'grid', gap: 4 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: '#f59e0b' }}>
                      Header located on line {detectedHeaderOffset + 1}
                    </span>
                    <span style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      minHeight: 22,
                      padding: '0 8px',
                      borderRadius: 999,
                      background: 'color-mix(in srgb, #f59e0b 18%, var(--surface))',
                      border: '1px solid color-mix(in srgb, #f59e0b 44%, var(--border))',
                      color: '#f59e0b',
                      fontSize: 11,
                      fontWeight: 600,
                    }}>
                      Skipping {detectedHeaderOffset} row{detectedHeaderOffset === 1 ? '' : 's'} above it
                    </span>
                  </div>
                  <div style={{ fontSize: 12.5, color: 'color-mix(in srgb, var(--muted) 64%, var(--text))', lineHeight: 1.55 }}>
                    The preview below is already using that detected header row. Check that the column names look right. If they do not, review the raw file and adjust <strong style={{ color: 'var(--text)', fontWeight: 600 }}>Skip header rows</strong>.
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <Button
                    small
                    variant="ghost"
                    onClick={() => setShowRaw(v => !v)}
                    style={showRaw
                      ? {
                        background: 'color-mix(in srgb, var(--accent) 12%, var(--surface2))',
                        border: '1px solid color-mix(in srgb, var(--accent2) 24%, var(--border))',
                        color: 'var(--accent2)',
                      }
                      : undefined}
                  >
                    {showRaw ? 'Hide raw file' : 'Review raw file'}
                  </Button>
                  <Button
                    small
                    variant="ghost"
                    onClick={() => setShowAdvanced(v => !v)}
                  >
                    {showAdvanced ? 'Hide header controls' : 'Adjust header controls'}
                  </Button>
                </div>
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
                buildMappingFieldConfig({
                  key: 'date',
                  label: 'Date',
                  candidateHeaders: columnAnalysis.dateCandidates,
                  value: colDate,
                  required: true,
                  hint: dateSelectHint,
                  tone: selectedDateAnalysis && !selectedDateAnalysis.guessedFormat && selectedDateAnalysis.sampleCount ? 'danger' : 'muted',
                  onChange: handleDateColumnChange,
                  onAcceptSuggestion: handleDateColumnChange,
                }),
                amtConv === 'two_column'
                  ? buildMappingFieldConfig({
                    key: 'debit',
                    label: 'Debit column',
                    candidateHeaders: columnAnalysis.debitCandidates,
                    value: colDebit,
                    setValue: setColDebit,
                    required: true,
                  })
                  : buildMappingFieldConfig({
                    key: 'amount',
                    label: 'Amount',
                    candidateHeaders: columnAnalysis.amountCandidates,
                    value: colAmount,
                    setValue: setColAmount,
                    required: true,
                    hint: amountSelectHint,
                    tone: selectedAmountAnalysis && selectedAmountAnalysis.sampleCount > 0 && selectedAmountAnalysis.amountMatches === 0 ? 'danger' : 'muted',
                  }),
                buildMappingFieldConfig({
                  key: 'pending',
                  label: 'Pending',
                  candidateHeaders: columnAnalysis.pendingCandidates,
                  value: colPending,
                  setValue: setColPending,
                }),
                amtConv === 'two_column'
                  ? buildMappingFieldConfig({
                    key: 'credit',
                    label: 'Credit column',
                    candidateHeaders: columnAnalysis.creditCandidates,
                    value: colCredit,
                    setValue: setColCredit,
                    required: true,
                  })
                  : null,
                amtConv === 'single_unsigned'
                  ? buildMappingFieldConfig({
                    key: 'direction',
                    label: 'Debit/credit type column',
                    candidateHeaders: columnAnalysis.directionCandidates,
                    value: colDir,
                    setValue: setColDir,
                    hint: 'The column that says debit/credit (or deposit/withdrawal), e.g. a "Transaction Type" column.',
                  })
                  : null,
                buildMappingFieldConfig({
                  key: 'description',
                  label: 'Merchant',
                  candidateHeaders: columnAnalysis.merchantCandidates,
                  value: colDesc,
                  setValue: setColDesc,
                  required: true,
                }),
                buildMappingFieldConfig({
                  key: 'category',
                  label: 'Category',
                  candidateHeaders: columnAnalysis.categoryCandidates,
                  value: colCategory,
                  hint: categorySelectHint,
                  onChange: handleCategoryColumnChange,
                  onAcceptSuggestion: handleCategoryColumnChange,
                  after: colCategory && sourceCategoryValues.length > 0 ? (
                    <div style={{ position: 'absolute', width: 'calc(100% - 28px)', right: 0, top: 'calc(100% + 4px)', display: 'grid', justifyItems: 'end', gap: 6, zIndex: 1 }}>
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
                }),
                buildMappingFieldConfig({
                  key: 'notes',
                  label: 'Notes',
                  candidateHeaders: columnAnalysis.notesCandidates,
                  value: colNotes,
                  setValue: setColNotes,
                }),
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
                  name="single-new-account-name"
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
                  name="single-new-account-type"
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
                const DEFAULT_ENTRY = {
                  accountId: '',
                  createNew: false,
                  newName: csvVal,
                  newType: '',
                  groupWithAccountId: '',
                  duplicateCompareTargetAccountId: '',
                  skip: false,
                }
                const m = { ...DEFAULT_ENTRY, ...(accountMap[csvVal] || {}) }
                const update = patch => setAccountMap(prev => ({
                  ...prev,
                  [csvVal]: { ...DEFAULT_ENTRY, ...(prev[csvVal] || {}), ...patch }
                }))
                const alreadyImported = previousImportAccountsByValue.get(csvVal)
                const likelyMatch = likelyAccountMatchesByValue[csvVal] || null
                const likelyMatchLabel = getAccountMatchLabel(likelyMatch) || likelyMatch?.name || ''
                const relationshipTargetId = m.groupWithAccountId || m.duplicateCompareTargetAccountId || ''
                const relationshipTarget = relationshipTargetId
                  ? accounts.find(account => account.id === relationshipTargetId)
                  : null
                const relationshipLabel = getAccountMatchLabel(relationshipTarget) || relationshipTarget?.name || ''
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
                      <div style={{ display: 'grid', gap: 6, minWidth: 0 }}>
                        <div style={{ display: 'flex', gap: 6, alignItems: 'center', minWidth: 0 }}>
                          <select
                            name={`account-map-target-${csvVal}`}
                            value={m.accountId}
                            onChange={e => {
                              const v = e.target.value
                              // "__new__:<name>" = share a new account another label is creating in
                              // this import. We don't reference that label — we independently declare
                              // the same name, which the importer merges by name (so changing the
                              // other label later can't dangle this one).
                              if (v.startsWith('__new__:')) {
                                const name = v.slice('__new__:'.length)
                                const sibling = inFlightNewAccounts.find(n => n.name === name)
                                update({
                                  accountId: '',
                                  createNew: true,
                                  newName: name,
                                  newType: sibling?.type || guessNewAccountTypeFromName(csvVal),
                                  groupWithAccountId: '',
                                  duplicateCompareTargetAccountId: '',
                                })
                              } else {
                                update({
                                  accountId: v,
                                  createNew: false,
                                  groupWithAccountId: '',
                                  duplicateCompareTargetAccountId: '',
                                })
                              }
                            }}
                            style={{
                              width: 170, maxWidth: '100%', background: 'var(--surface2)', color: 'var(--text)',
                              border: '1px solid var(--border)', borderRadius: 6,
                              padding: '5px 6px', fontSize: 12,
                            }}
                          >
                            <option value="">— Select —</option>
                            {inFlightNewAccounts.length > 0 ? (
                              <optgroup label="New in this import">
                                {inFlightNewAccounts.map(n => (
                                  <option key={`__new__:${n.name}`} value={`__new__:${n.name}`}>+ {n.name} (new)</option>
                                ))}
                              </optgroup>
                            ) : null}
                            <optgroup label="Existing accounts">
                              {accounts.map(a => (
                                <option key={a.id} value={a.id}>{a.name}{a.mask ? ` ···${a.mask}` : ''}</option>
                              ))}
                            </optgroup>
                          </select>
                          {m.accountId ? (
                            <button
                              onClick={() => update({
                                accountId: '',
                                createNew: false,
                                newName: csvVal,
                                groupWithAccountId: '',
                                duplicateCompareTargetAccountId: '',
                              })}
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
                            <button onClick={() => {
                              if (likelyMatch) {
                                openAccountMatchChooser(csvVal, likelyMatch)
                                return
                              }
                              update({
                                createNew: true,
                                newName: csvVal,
                                newType: guessNewAccountTypeFromName(csvVal),
                                groupWithAccountId: '',
                                duplicateCompareTargetAccountId: '',
                              })
                            }} style={{
                              flexShrink: 0, background: 'none', border: '1px solid var(--border)',
                              borderRadius: 6, color: 'var(--accent2)', cursor: 'pointer',
                              fontSize: 11, padding: '4px 7px', whiteSpace: 'nowrap',
                            }}>+New</button>
                          )}
                        </div>
                        {!m.accountId && likelyMatchLabel ? (
                          <button
                            type="button"
                            onClick={() => update({
                              accountId: likelyMatch.id,
                              createNew: false,
                              newName: likelyMatch.name || csvVal,
                              newType: likelyMatch.type || m.newType || 'depository',
                              groupWithAccountId: '',
                              duplicateCompareTargetAccountId: '',
                              skip: false,
                            })}
                            style={{
                              justifySelf: 'end',
                              maxWidth: '100%',
                              border: '1px solid color-mix(in srgb, var(--accent2) 28%, var(--border))',
                              background: 'color-mix(in srgb, var(--accent2) 10%, var(--surface2))',
                              color: 'var(--accent2)',
                              borderRadius: 999,
                              padding: '4px 9px',
                              fontSize: 11,
                              cursor: 'pointer',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                            title={`Map to ${likelyMatchLabel}`}
                          >
                            Possible match: {likelyMatchLabel}
                          </button>
                        ) : null}
                      </div>
                    ) : (
                      <div style={{ display: 'grid', gap: 6, minWidth: 0 }}>
                        <div style={{ display: 'flex', gap: 4, alignItems: 'center', minWidth: 0, flexWrap: 'nowrap' }}>
                          <div style={{ width: 132, maxWidth: '100%' }}>
                            <input name={`account-new-name-${csvVal}`} value={m.newName} onChange={e => update({ newName: e.target.value })}
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
                          <select name={`account-new-type-${csvVal}`} value={m.newType} onChange={e => update({ newType: e.target.value })}
                            style={{ width: 88, background: 'var(--surface2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: '4px 5px', fontSize: 11 }}>
                            <option value="">— Type —</option>
                            {ACCOUNT_TYPES.map(option => (
                              <option key={option.value} value={option.value}>{option.shortLabel}</option>
                            ))}
                          </select>
                          <button onClick={() => update({
                            createNew: false,
                            accountId: '',
                            groupWithAccountId: '',
                            duplicateCompareTargetAccountId: '',
                          })}
                            style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 13, padding: '2px', flexShrink: 0 }}>✕</button>
                        </div>
                        {relationshipTarget && relationshipLabel ? (
                          <button
                            type="button"
                            onClick={() => openAccountMatchChooser(csvVal, relationshipTarget)}
                            style={{
                              justifySelf: 'start',
                              maxWidth: '100%',
                              border: '1px solid color-mix(in srgb, var(--accent2) 26%, var(--border))',
                              background: 'color-mix(in srgb, var(--accent2) 10%, var(--surface2))',
                              color: 'var(--accent2)',
                              borderRadius: 999,
                              padding: '4px 9px',
                              fontSize: 11,
                              cursor: 'pointer',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                            title={m.groupWithAccountId ? `Change grouping target for ${relationshipLabel}` : `Change duplicate comparison target for ${relationshipLabel}`}
                          >
                            {m.groupWithAccountId ? 'Will group with: ' : 'Checking duplicates against: '}
                            {relationshipLabel}
                          </button>
                        ) : null}
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

          <div style={{ display: 'grid', gap: 8, width: IMPORT_CONFIG_MAX_WIDTH }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13 }}>
              <input type="checkbox" checked={applyCat} onChange={e => setApplyCat(e.target.checked)} />
              Apply categorization rules on import
            </label>
            <div style={{ display: 'grid', gap: 3 }}>
              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  cursor: colCategory ? 'pointer' : 'not-allowed',
                  fontSize: 13,
                  color: colCategory ? 'var(--text)' : 'var(--muted)',
                }}
                title={colCategory ? '' : 'Choose a category column before categories present in the data can be used'}
              >
                <input
                  type="checkbox"
                  checked={useImportedCategories && !!colCategory}
                  disabled={!colCategory}
                  onChange={e => setUseImportedCategories(e.target.checked)}
                />
                <ImportedCategoryUsageInline
                  showFilter={useImportedCategories && colCategory && importedCategoryChoices.length > 1}
                  filterDisabled={!!getMappingDisabledReason()}
                  filterTitle={getMappingDisabledReason()}
                  onFilterClick={() => setShowImportedCategorySettings(true)}
                />
              </label>
              {useImportedCategories && colCategory && normalizeImportedCategorySettings(importedCategorySettings).scope_mode === IMPORTED_CATEGORY_SCOPE_FILTERED ? (
                <div style={{ paddingLeft: 26, fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.35 }}>
                  {importedCategorySummary}
                </div>
              ) : null}
            </div>
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
                      onClick={() => openManualDraftSaveEditor(getSuggestedDataSourceName({
                        draftRecord: manualDraftRecord || buildCurrentManualDraftRecord(),
                        previewLike: preview,
                      }))}
                      disabled={!canCreateDataSourceFromCurrentMapping() || loading}
                    >
                      Create data source
                    </Button>
                  </span>
                )}
              </div>
            ) : null}
          </div>

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

      {stage === 'review-data' && importResult && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 1000,
            background: 'rgba(8, 12, 22, 0.72)',
            backdropFilter: 'blur(4px)',
            padding: 24,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              width: 'min(980px, 100%)',
              display: 'flex',
              flexDirection: 'column',
              background: 'linear-gradient(180deg, color-mix(in srgb, var(--surface) 88%, #0b1220), color-mix(in srgb, var(--surface2) 82%, #0f172a))',
              borderRadius: 16,
              border: '1px solid color-mix(in srgb, var(--accent2) 14%, var(--border))',
              boxShadow: '0 34px 90px rgba(2, 6, 23, 0.52)',
              overflow: 'hidden',
            }}
          >
            <div style={{
              padding: '18px 22px 12px',
              borderBottom: '1px solid var(--border)',
              background: 'linear-gradient(180deg, color-mix(in srgb, var(--surface2) 72%, #0f172a), color-mix(in srgb, var(--surface) 92%, #111827))',
            }}>
              <div style={{ display: 'flex', alignItems: 'start', justifyContent: 'space-between', gap: 16 }}>
                <div>
                  <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 6 }}>Review imported file tail</div>
                  <div style={{ fontSize: 13, color: 'color-mix(in srgb, var(--muted) 56%, #dbe6f7)', lineHeight: 1.55 }}>
                    The raw file viewer contains the start of what may be a trailer record. If the ending text is expected, choose Continue. If not, choose Cancel and nothing will be imported from the file.
                  </div>
                </div>
              </div>
            </div>
            <div style={{ padding: 22, display: 'grid', gap: 16, background: 'color-mix(in srgb, var(--surface) 90%, #0b1220)' }}>
              {preview && rawViewerLines?.length ? (
                <RawFilePreview
                  rawLines={rawViewerLines}
                  headerRowIndex={preview.header_row_index ?? 0}
                  lineNumberOffset={rawViewerOffset}
                  title={rawViewerTitle}
                  note={rawViewerNote}
                  embedded
                  embeddedHeight={300}
                />
              ) : null}
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
                    {' '}matched existing transactions and were not imported automatically.
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
          {importResult.has_imported_categories ? (
            <div style={{
              marginBottom: 16,
              padding: '12px 14px',
              borderRadius: 12,
              background: 'color-mix(in srgb, var(--accent) 7%, var(--surface2))',
              border: '1px solid color-mix(in srgb, var(--accent) 24%, var(--border))',
            }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>
                Categorized rows were imported with this file.
              </div>
              <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.55 }}>
                {useImportedCategories && colCategory
                  ? 'Because categories present in the data were used for this file, missing categories were added under Unassigned, the imported transactions kept those categories, and the file now contributes to system-wide rule suggestions.'
                  : 'Enable categories present in the data from Recent imports if the imported categories should be applied to transactions and used to help suggest rules.'}
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
                variant="ghost"
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
                            )
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
                                          alignItems: 'center',
                                          gap: 6,
                                          fontSize: 11,
                                          color: b.has_imported_categories ? 'var(--text)' : 'var(--muted)',
                                          cursor: b.has_imported_categories ? 'pointer' : 'not-allowed',
                                          lineHeight: 1.45,
                                          flex: '1 1 420px',
                                          minWidth: 0,
                                        }}
                                        title={b.has_imported_categories ? '' : 'This import did not include a category column'}
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
                                        {isUnknown ? (
                                          assignNewSourceBatchId === b.id ? (
                                            <TransientTextInput
                                              value={assignNewSourceName}
                                              onChange={setAssignNewSourceName}
                                              onCommit={() => createDataSourceFromUnknownBatch(b, assignNewSourceName)}
                                              onCancel={() => { setAssignNewSourceBatchId(''); setAssignNewSourceName('') }}
                                              restoreOnEscape
                                              onBlurCommit={false}
                                              placeholder="New data source name"
                                              style={{
                                                width: 180, maxWidth: '100%', background: 'var(--surface2)', color: 'var(--text)',
                                                border: '1px solid var(--accent)', borderRadius: 6, padding: '3px 8px', fontSize: 12, outline: 'none',
                                              }}
                                            />
                                          ) : (
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
                                          )
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
                                      // If the CSV's original account label differs from the account it currently
                                      // resolves to, the user mapped it after the import completed. Surface both
                                      // so the file card matches what the user saw at import time, with the mapped
                                      // destination as a faded suffix.
                                      const showMapping = !a.was_skipped && mappedLabel && csvLabel && mappedLabel !== csvLabel
                                      const truncate = s => (s && s.length > 22 ? s.slice(0, 20) + '…' : s)
                                      const primary = a.was_skipped ? csvLabel : csvLabel
                                      const tooltip = showMapping
                                        ? `${csvLabel} → ${mappedLabel}`
                                        : (a.was_skipped ? csvLabel : (mappedLabel || csvLabel))
                                      return (
                                        <span key={i} title={tooltip} style={{
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
                                          title={
                                            hasSoft
                                              ? `${hard} rejected at import, ${soft} flagged for review`
                                              : `${hard} rejected at import`
                                          }
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
                                          {hasSoft ? '⚠ ' : ''}{total} duplicate{total === 1 ? '' : 's'}
                                          {hasSoft ? ` (${soft} to review)` : ''}
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
                    initialMode={dataSourceManagerInitialMode}
                    onProfileCreated={handleManagerProfileCreated}
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

      {pendingAccountMatchChooser ? (
        <PossibleAccountMatchChooserDialog
          pending={pendingAccountMatchChooser}
          onSelect={applyAccountMatchChoice}
          onCancel={() => setPendingAccountMatchChooser(null)}
        />
      ) : null}

      {showImportedCategorySettings ? (
        <ImportedCategorySettingsDialog
          title={IMPORTED_CATEGORY_FILTER_DIALOG_TITLE}
          description={IMPORTED_CATEGORY_FILTER_DIALOG_DESCRIPTION}
          choices={importedCategoryChoices}
          initialSettings={importedCategorySettings}
          onSave={settings => {
            setImportedCategorySettings(settings)
            setShowImportedCategorySettings(false)
          }}
          onCancel={() => setShowImportedCategorySettings(false)}
        />
      ) : null}

      {batchImportedCategorySettingsDialog ? (
        <ImportedCategorySettingsDialog
          title={IMPORTED_CATEGORY_FILTER_DIALOG_TITLE}
          description={IMPORTED_CATEGORY_FILTER_DIALOG_DESCRIPTION}
          choices={batchImportedCategorySettingsDialog.choices}
          initialSettings={batchImportedCategorySettingsDialog.settings}
          onSave={settings => saveBatchImportedCategorySettings(batchImportedCategorySettingsDialog.batchId, settings)}
          onCancel={() => setBatchImportedCategorySettingsDialog(null)}
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

      <Suspense fallback={batchDetailPanels.length ? (
        <div style={{
          position: 'fixed',
          right: 24,
          bottom: 24,
          zIndex: 220,
          display: 'inline-flex',
          alignItems: 'center',
          gap: 10,
          padding: '10px 14px',
          borderRadius: 12,
          border: '1px solid color-mix(in srgb, var(--accent) 24%, var(--border))',
          background: 'color-mix(in srgb, var(--surface) 94%, var(--surface2))',
          boxShadow: '0 16px 40px rgba(15, 23, 42, 0.24)',
          color: 'var(--text)',
          fontSize: 13,
        }}>
          <Spinner size={14} />
          <span>Loading import details...</span>
        </div>
      ) : null}>
        {batchDetailPanels.map((batch, index) => (
          <ImportBatchDetail
            key={batch.id}
            batch={batch}
            categories={categories}
            onAddCategory={category => setCategories(prev => prev.some(existing => existing.id === category.id) ? prev : [...prev, category])}
            onClose={() => closeBatchDetail(batch.id)}
            forceFloating
            stackIndex={index}
            isTopmost={index === batchDetailPanels.length - 1}
          />
        ))}
      </Suspense>
    </div>
  )
}

function ExportTab() {
  // Export uses a filter scope independent of the app-wide FilterContext: the dashboard/transactions
  // view is "what am I looking at now," while an export is "what slice of history do I want a copy of."
  // A nested FilterProvider with no initial filters keeps the export defaulted to everything and lets
  // the user adjust it without disturbing the chip the rest of the app reads.
  return (
    <FilterProvider>
      <ExportTabContent />
    </FilterProvider>
  )
}

function ExportTabContent() {
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
    const tagSel = filters.selections.filter(s => s.type === 'tag').map(s => s.id)
    window.open(api.exportTransactionsCsv({
      columns: [...selectedCols].join(','),
      date_start: filters.date?.start || undefined, date_end: filters.date?.end || undefined,
      account_ids: accountSel.length ? accountSel.join(',') : undefined,
      owner_ids: ownerSel.length ? ownerSel.join(',') : undefined,
      group_ids: groupSel.length ? groupSel.join(',') : undefined,
      category_ids: categorySel.length ? categorySel.join(',') : undefined,
      tag_ids: tagSel.length ? tagSel.join(',') : undefined,
    }), '_blank')
  }

  return (
    <div>
      <SectionTitle>Export transactions to a .csv file</SectionTitle>
      <Card style={{ marginBottom: 12, padding: 0 }}>
        <FilterBar />
      </Card>
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
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>
            {filters.date || filters.selections.length > 0
              ? 'Only transactions matching the filter above will be exported.'
              : 'No filter set — all transactions will be exported.'}
          </div>
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
        message: `This will replace the Plaid credentials currently stored in ${APP_NAME}.`,
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
                : `You may need to reconnect accounts if these credentials have changed since the backup was created.`}
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
