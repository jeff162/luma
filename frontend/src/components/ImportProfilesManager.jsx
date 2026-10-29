// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { api } from '../lib/api.js'
import {
  analyzeImportColumns,
  computeEvidenceColumnOptions,
  defaultEvidenceColumns,
  forcedEvidenceColumns,
  DEFAULT_DECIMAL_SEPARATOR,
  DEFAULT_IMPORT_DATE_FORMAT,
  formatLikelyMatchLabel,
  inferImportFileCharacteristicsFromPreview,
  inferUnambiguousImportMappingFromPreview,
} from '../lib/importColumnInference.js'
import { useUserPreference } from '../lib/UserPreferencesContext.jsx'
import { formatTimestamp } from '../lib/utils.js'
import {
  accountMappingProblem,
  defaultAccountMapEntry,
  entriesToSourceAccountMap,
  findAccountMatchCandidates,
  findExactAccountNameMatch,
  findLikelyAccountMatch,
  newMappedAccountsFromEntries,
  sourceAccountMapToEntries,
} from '../lib/importExport/importAccountMatching.js'
import { splitHeaderFingerprint } from '../lib/importExport/importDraft.js'
import {
  IMPORT_DEFAULT_CATEGORY_USAGE_MODE_PREF_KEY,
  IMPORT_CATEGORY_USAGE_MODE_ALL,
  IMPORT_CATEGORY_USAGE_MODE_PER_SOURCE,
  normalizeImportCategoryUsageMode,
} from '../lib/appConfig.js'
import {
  AMOUNT_CONVENTIONS,
  DATE_FORMATS,
  DECIMAL_SEPARATORS,
  SOURCE_LIST_MIN_WIDTH,
  SOURCE_ROW_GRID_COLUMNS,
  TRUNCATED_CELL_STYLE,
} from '../lib/importExport/constants.js'
import { Card, Button, Spinner, getFloatingPanelSurfaceStyle, getFloatingPanelHeaderBackground, OverlayBackdrop, FloatingPanel, AppNoticeDialog, IconButton, LinkButton } from './ui.jsx'
import ImportColumnMappingSection from './ImportColumnMappingSection.jsx'
import ImportEvidenceColumnsSection from './ImportEvidenceColumnsSection.jsx'
import AccountMappingGrid from './importExport/AccountMappingGrid.jsx'
import TransientTextInput from './TransientTextInput.jsx'
import FileInput from './FileInput.jsx'
import { PICKER_IDS } from '../lib/filePicker.js'
import WatchedFolderDialog from './importExport/WatchedFolderDialog.jsx'
import WatchPausedPill from './importExport/WatchPausedPill.jsx'
import FeatureExplainer from '../help/FeatureExplainer.jsx'
import { preventPressDefaults } from '../lib/pointerDrag.js'
import { placeAboveKeyboard, useVisibleViewport, visibleLayerBox } from '../lib/visibleViewport.js'

// How many trailing days of an export are treated as still filling in. Most sources lag the thing they
// describe, so the default assumes a lag; 1 — only the export day itself — is the opt-in for a
// first-party export (Amazon, PayPal) that publishes its own records. Mirrors the backend clamp and
// `duplicate_detection.DEFAULT_TERMINAL_WINDOW_DAYS`.
const MIN_SOURCE_LAG_DAYS = 1
const DEFAULT_SOURCE_LAG_DAYS = 7
const MAX_SOURCE_LAG_DAYS = 30

function clampSourceLagDays(value) {
  const days = parseInt(value, 10)
  if (!Number.isFinite(days)) return MIN_SOURCE_LAG_DAYS
  return Math.max(MIN_SOURCE_LAG_DAYS, Math.min(MAX_SOURCE_LAG_DAYS, days))
}

const ADD_PANEL_WIDTH = 900

// The column_map keys this form edits. Everything else in a saved column_map — category assignments,
// imported-category settings — belongs to other flows and must survive an edit here.
// `single_account_new` is listed because the form resolves it: to the existing account of that name,
// or to an account created on save. The per-value account map an import writes back
// (`account_assignments` / `account_skips` / `account_new`) is listed because the form edits it: it is
// how a watched folder's imports are re-pointed, since those never pass through the import screen.
const FORM_OWNED_COLUMN_MAP_KEYS = [
  'date', 'description', 'amount', 'debit', 'credit', 'direction', 'pending', 'currency', 'transaction_id',
  'category', 'notes', 'account', 'evidence_columns', 'single_account_new',
  'account_assignments', 'account_skips', 'account_new',
]

const NO_NEW_ACCOUNT = { enabled: false, name: '', type: 'depository' }

// A source saved from the import screen may say "create this account at the next import" instead of
// naming one. Once that account exists (every import after the first), the source means it; otherwise
// the form carries the request into its own create-on-save editor.
function resolveInitialAccount(profile, accounts) {
  const pending = profile?.column_map?.single_account_new
  if (profile?.account_id || !pending?.name) {
    return { accountId: profile?.account_id || '', newAccount: NO_NEW_ACCOUNT }
  }
  const existing = findExactAccountNameMatch(accounts, pending.name)
  if (existing) return { accountId: existing.id, newAccount: NO_NEW_ACCOUNT }
  return {
    accountId: '',
    newAccount: { enabled: true, name: pending.name, type: pending.type || 'depository' },
  }
}

function getBlankSuggestedColumns() {
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
    currency: '',
    transaction_id: '',
    account: '',
  }
}

function resolveExistingMappedHeader(currentValue, headers) {
  if (!currentValue) return ''
  if (headers.includes(currentValue)) return currentValue

  // Editing a data source should survive harmless header normalization changes
  // such as case-only differences, but it should not silently remap to a
  // different-looking header label.
  const normalizedCurrent = String(currentValue).trim().toLowerCase()
  if (!normalizedCurrent) return ''

  const normalizedMatches = headers.filter(header => String(header).trim().toLowerCase() === normalizedCurrent)
  if (normalizedMatches.length === 1) return normalizedMatches[0]
  return ''
}

function ProfileForm({
  profile,
  accounts,
  knownTemplateHashes = [],
  onSave,
  onCancel,
  onNotice,
  floating = false,
  onHeaderPointerDown = null,
  headerCursor = 'default',
}) {
  // The profile form supports both "create a reusable data source from a sample
  // file" and "refresh an existing data source against a newer template". In
  // both cases we preserve exact known mappings, but any newly inferred single
  // match stays as an explicit suggestion until the user accepts it.
  const isNew = !profile?.id
  const [defaultImportCategoryUsageMode] = useUserPreference(IMPORT_DEFAULT_CATEGORY_USAGE_MODE_PREF_KEY, IMPORT_CATEGORY_USAGE_MODE_PER_SOURCE)
  const floatingPanelStyle = getFloatingPanelSurfaceStyle({ active: true, radius: 18 })
  const sampleFileInputRef = useRef(null)
  const fid = useId()  // base for associating each field's <label htmlFor> with its control id
  const [name, setName] = useState(profile?.name || '')
  const [filePattern, setFilePattern] = useState(profile?.filename_pattern || '')
  const [headerFp, setHeaderFp] = useState(profile?.header_fingerprint || '')
  const [templateFileName, setTemplateFileName] = useState(profile?.template_filename || '')
  const [templateFileHash, setTemplateFileHash] = useState(profile?.template_file_hash || '')
  const [initialAccount] = useState(() => resolveInitialAccount(profile, accounts))
  const [accountId, setAccountId] = useState(initialAccount.accountId)
  const [newAccount, setNewAccount] = useState(initialAccount.newAccount)
  const [dateFormat, setDateFormat] = useState(profile?.date_format || DEFAULT_IMPORT_DATE_FORMAT)
  const [amtConv, setAmtConv] = useState(profile?.amount_convention || 'single_signed')
  const [decimalSeparator, setDecimalSeparator] = useState(profile?.decimal_separator || DEFAULT_DECIMAL_SEPARATOR)
  const [skipRows] = useState(profile?.skip_rows ?? 0)
  const [applyCat, setApplyCat] = useState(profile?.apply_categorization !== false)
  const [enrichFromSource, setEnrichFromSource] = useState(!!profile?.enrich_from_source)
  // Kept as a string so the field can be emptied while typing; normalized on save.
  const [sourceLagDays, setSourceLagDays] = useState(String(profile?.terminal_window_days ?? DEFAULT_SOURCE_LAG_DAYS))
  const [useImportedCategories, setUseImportedCategories] = useState(
    profile?.use_imported_categories != null
      ? !!profile.use_imported_categories
      : normalizeImportCategoryUsageMode(defaultImportCategoryUsageMode) === IMPORT_CATEGORY_USAGE_MODE_ALL
  )
  const [notes] = useState(profile?.notes || '')
  const [samplePreview, setSamplePreview] = useState(null)
  const [sampleFileName, setSampleFileName] = useState('')
  const [sampleLoading, setSampleLoading] = useState(false)
  const cm = profile?.column_map || {}
  const [colDate, setColDate] = useState(cm.date || '')
  const [colAmount, setColAmount] = useState(cm.amount || '')
  const [colDebit, setColDebit] = useState(cm.debit || '')
  const [colCredit, setColCredit] = useState(cm.credit || '')
  const [colDir, setColDir] = useState(cm.direction || '')
  const [colDesc, setColDesc] = useState(cm.description || '')
  const [colCategory, setColCategory] = useState(cm.category || '')
  const [colNotes, setColNotes] = useState(cm.notes || '')
  const [colPending, setColPending] = useState(cm.pending || '')
  const [colCurrency, setColCurrency] = useState(cm.currency || '')
  const [colTransactionId, setColTransactionId] = useState(cm.transaction_id || '')
  const [colAccount, setColAccount] = useState(cm.account || '')
  const [sourceAccountMap, setSourceAccountMap] = useState(() => sourceAccountMapToEntries(cm, accounts))
  // Capture picks (headers), or null = derive the default set. Seeded from the saved profile.
  const [evidenceColumns, setEvidenceColumns] = useState(Array.isArray(cm.evidence_columns) ? cm.evidence_columns : null)
  const [mappingSuggestions, setMappingSuggestions] = useState(getBlankSuggestedColumns())
  const [sampleFile, setSampleFile] = useState(null)

  const inputStyle = {
    background: 'var(--surface)', color: 'var(--text)',
    border: '1px solid var(--border)', borderRadius: 6,
    padding: '6px 10px', fontSize: 13, width: '100%', outline: 'none',
  }
  const selStyle = { ...inputStyle, cursor: 'pointer' }
  const sampleHeaders = samplePreview?.headers || []
  const skipRowsValue = parseInt(skipRows, 10) || 0
  const columnAnalysis = useMemo(
    () => analyzeImportColumns(samplePreview, skipRowsValue),
    [samplePreview, skipRowsValue],
  )
  const mappedHeaders = useMemo(
    () => [colDate, colAmount, colDebit, colCredit, colDir, colDesc, colCategory, colNotes, colPending, colCurrency, colTransactionId, colAccount].filter(Boolean),
    [colDate, colAmount, colDebit, colCredit, colDir, colDesc, colCategory, colNotes, colPending, colCurrency, colTransactionId, colAccount],
  )
  // "Imports from this data source have been categorized" only makes sense with a Category column mapped;
  // clear it if that mapping is removed.
  useEffect(() => {
    if (!colCategory) setUseImportedCategories(false)
  }, [colCategory])
  const evidenceColumnOptions = useMemo(
    () => computeEvidenceColumnOptions(samplePreview, mappedHeaders, skipRowsValue),
    [samplePreview, mappedHeaders, skipRowsValue],
  )
  const resolvedEvidenceColumns = useMemo(() => {
    const optionHeaders = new Set(evidenceColumnOptions.map(option => option.header))
    const base = evidenceColumns == null ? defaultEvidenceColumns(evidenceColumnOptions) : evidenceColumns
    return base.filter(header => optionHeaders.has(header))
  }, [evidenceColumns, evidenceColumnOptions])
  const accountMapRows = useMemo(
    () => Object.keys(sourceAccountMap)
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
      .map(value => {
        const entry = sourceAccountMap[value]
        const problem = accountMappingProblem(entry, accounts)
        // The grid itself says when a new account's name is taken, beside the name.
        const note = problem === 'unmapped'
          ? (entry.missingAccountId ? 'Its account no longer exists' : 'Choose an account or Skip')
          : problem === 'new_type' ? 'Choose a type for the new account'
            : problem === 'new_name' ? 'Name the new account'
              : null
        return {
          key: value,
          label: value,
          entry,
          candidates: findAccountMatchCandidates(accounts, value),
          suggestion: findLikelyAccountMatch(accounts, value),
          details: note ? (
            <div style={{ fontSize: 11, color: 'var(--danger)', marginTop: 1 }}>{note}</div>
          ) : null,
        }
      }),
    [sourceAccountMap, accounts],
  )
  // Every row needs a decision before the source saves, as every row does before an import runs: a
  // value left without one is a file a watched folder would stop on. Only while the grid is shown —
  // a source with no account column keeps the map it has untouched.
  const accountMapComplete = !colAccount ||
    Object.values(sourceAccountMap).every(entry => !accountMappingProblem(entry, accounts))
  // New accounts other rows are creating in this save, offered in every row's picker so several values
  // can share one; the save creates a shared name once.
  const inFlightMapAccounts = useMemo(() => {
    const byName = new Map()
    for (const entry of Object.values(sourceAccountMap)) {
      if (!entry?.createNew || entry?.skip) continue
      const name = String(entry.newName || '').trim()
      if (name && !byName.has(name.toLowerCase())) {
        byName.set(name.toLowerCase(), { value: name, label: `${name} (new)`, type: entry.newType || '' })
      }
    }
    return [...byName.values()]
  }, [sourceAccountMap])
  const newAccountReady = newAccount.enabled && !!newAccount.name.trim() &&
    !findExactAccountNameMatch(accounts, newAccount.name)
  const canSave = !!(
    name.trim() &&
    colDate.trim() &&
    colDesc.trim() &&
    (amtConv === 'two_column' ? colDebit.trim() && colCredit.trim() : colAmount.trim()) &&
    (colAccount.trim() || accountId || newAccountReady) &&
    accountMapComplete
  )
  const accountSelectHint = columnAnalysis.accountCandidates.length > 0 && !colAccount && !accountId && !newAccount.enabled
    ? formatLikelyMatchLabel(columnAnalysis.accountCandidates.length)
    : ''
  const savedTemplateHeaders = splitHeaderFingerprint(profile?.header_fingerprint)
  const selectedTemplateHash = String(samplePreview?.file_content_hash || '').trim()
  const showTemplateHashWarning = !!(
    profile?.id &&
    samplePreview &&
    selectedTemplateHash &&
    knownTemplateHashes.length > 0 &&
    !knownTemplateHashes.includes(selectedTemplateHash)
  )
  function clearMappingSuggestion(field) {
    setMappingSuggestions(prev => prev[field] ? { ...prev, [field]: '' } : prev)
  }

  function applyInferredSuggestions(nextHeaders, inferred, nextAmountConvention) {
    const nextSuggestions = getBlankSuggestedColumns()

    function preserveOrSuggest(currentValue, fieldKey) {
      const preservedValue = resolveExistingMappedHeader(currentValue, nextHeaders)
      if (preservedValue) return preservedValue
      nextSuggestions[fieldKey] = nextHeaders.includes(inferred.columnMap[fieldKey] || '')
        ? (inferred.columnMap[fieldKey] || '')
        : ''
      return ''
    }

    setColDate(preserveOrSuggest(colDate, 'date'))
    setColDesc(preserveOrSuggest(colDesc, 'description'))
    setColCategory(preserveOrSuggest(colCategory, 'category'))
    setColNotes(preserveOrSuggest(colNotes, 'notes'))
    setColPending(preserveOrSuggest(colPending, 'pending'))
    setColCurrency(preserveOrSuggest(colCurrency, 'currency'))
    setColTransactionId(preserveOrSuggest(colTransactionId, 'transaction_id'))
    setColAccount(preserveOrSuggest(colAccount, 'account'))

    if (nextAmountConvention === 'two_column') {
      setColDebit(preserveOrSuggest(colDebit, 'debit'))
      setColCredit(preserveOrSuggest(colCredit, 'credit'))
      setColAmount('')
      setColDir('')
      nextSuggestions.amount = ''
      nextSuggestions.direction = ''
    } else if (nextAmountConvention === 'single_unsigned') {
      setColAmount(preserveOrSuggest(colAmount, 'amount'))
      setColDir(preserveOrSuggest(colDir, 'direction'))
      setColDebit('')
      setColCredit('')
      nextSuggestions.debit = ''
      nextSuggestions.credit = ''
    } else {
      setColAmount(preserveOrSuggest(colAmount, 'amount'))
      setColDebit('')
      setColCredit('')
      setColDir('')
      nextSuggestions.debit = ''
      nextSuggestions.credit = ''
      nextSuggestions.direction = ''
    }

    setMappingSuggestions(nextSuggestions)
  }
  async function handleSampleFile(file) {
    if (!file) return
    setSampleLoading(true)
    try {
      const result = await api.previewCsv(file)
      const skipCount = parseInt(skipRows, 10) || 0
      const inferred = inferUnambiguousImportMappingFromPreview(result, skipCount)
      const inferredCharacteristics = inferImportFileCharacteristicsFromPreview(result, skipCount)
      const nextHeaders = result.headers || []
      const nextAmountConvention = inferredCharacteristics.amountConvention || 'single_signed'
      setSamplePreview(result)
      setSampleFile(file)
      setSampleFileName(result.filename || file.name || '')
      setTemplateFileName(result.filename || file.name || '')
      setTemplateFileHash(result.file_content_hash || '')
      if (!name.trim() && inferred.filenamePattern) setName(inferred.filenamePattern)
      setFilePattern(inferred.filenamePattern || '')
      setHeaderFp(inferred.headerFingerprint || '')
      setDateFormat(inferredCharacteristics.dateFormat || DEFAULT_IMPORT_DATE_FORMAT)
      setAmtConv(nextAmountConvention)
      setDecimalSeparator(inferredCharacteristics.decimalSeparator || DEFAULT_DECIMAL_SEPARATOR)
      applyInferredSuggestions(nextHeaders, inferred, nextAmountConvention)
    } catch (error) {
      onNotice?.({
        title: 'Could not read that CSV file',
        description: error?.message || 'Please choose a different sample file.',
      })
    } finally {
      setSampleLoading(false)
    }
  }

  function handleSave() {
    if (!canSave) return
    const preservedColumnMap = { ...cm }
    for (const key of FORM_OWNED_COLUMN_MAP_KEYS) delete preservedColumnMap[key]
    const column_map = {
      ...preservedColumnMap,
      date: colDate,
      description: colDesc,
      ...(amtConv === 'two_column'
        ? { debit: colDebit, credit: colCredit }
        : { amount: colAmount }),
      ...(amtConv === 'single_unsigned' && colDir ? { direction: colDir } : {}),
      ...(colPending ? { pending: colPending } : {}),
      ...(colCurrency ? { currency: colCurrency } : {}),
      ...(colTransactionId ? { transaction_id: colTransactionId } : {}),
      ...(colCategory ? { category: colCategory } : {}),
      ...(colNotes ? { notes: colNotes } : {}),
      ...(colAccount ? { account: colAccount } : {}),
      // With a sample loaded we can resolve the capture set; without one we can't recompute it, so
      // carry the profile's saved picks forward rather than clobbering them with an empty (no-preview) set.
      ...(samplePreview
        ? { evidence_columns: resolvedEvidenceColumns }
        : (Array.isArray(cm.evidence_columns) ? { evidence_columns: cm.evidence_columns } : {})),
      // With the grid shown, its `+New` rows are created by the save and come back as assignments, so
      // none is stored as pending. Without it, the map is written back as it was read.
      ...entriesToSourceAccountMap(colAccount
        ? Object.fromEntries(Object.entries(sourceAccountMap).filter(([, entry]) => entry.skip || !entry.createNew))
        : sourceAccountMap),
    }
    const creatingAccount = !colAccount && newAccount.enabled
    onSave(
      {
        name: name.trim(),
        filename_pattern: filePattern.trim() || null,
        header_fingerprint: headerFp.trim() || null,
        template_filename: templateFileName.trim() || null,
        template_file_hash: templateFileHash.trim() || null,
        column_map,
        account_id: creatingAccount ? null : (accountId || null),
        new_account: creatingAccount ? { name: newAccount.name.trim(), type: newAccount.type } : null,
        new_mapped_accounts: colAccount ? newMappedAccountsFromEntries(sourceAccountMap) : null,
        date_format: dateFormat, amount_convention: amtConv, decimal_separator: decimalSeparator,
        skip_rows: parseInt(skipRows) || 0,
        apply_categorization: applyCat,
        enrich_from_source: enrichFromSource,
        use_imported_categories: useImportedCategories,
        terminal_window_days: clampSourceLagDays(sourceLagDays),
        notes: notes.trim() || null,
      },
      {
        sampleFile,
        samplePreview,
      },
    )
  }

  return (
    <div style={{
      width: '100%',
      maxWidth: '100%',
      alignSelf: 'stretch',
      margin: 0,
      padding: floating ? '18px' : '16px',
      background: floating ? floatingPanelStyle.background : 'var(--surface2)',
      border: floating ? floatingPanelStyle.border : 'none',
      borderBottom: floating ? '1px solid color-mix(in srgb, var(--accent) 24%, var(--border))' : '1px solid var(--border)',
      borderRadius: floating ? floatingPanelStyle.borderRadius : 0,
      boxShadow: floating ? floatingPanelStyle.boxShadow : 'none',
      overflow: 'visible',
      display: 'flex', flexDirection: 'column', gap: 12,
    }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        margin: floating ? '-18px -18px 4px' : '0 0 4px',
        padding: floating ? '14px 18px 12px' : 0,
        borderBottom: floating ? '1px solid color-mix(in srgb, var(--accent) 18%, var(--border))' : 'none',
        background: floating ? getFloatingPanelHeaderBackground(true) : 'transparent',
        cursor: floating && onHeaderPointerDown ? headerCursor : 'default',
        userSelect: floating && onHeaderPointerDown ? 'none' : 'auto',
        touchAction: floating && onHeaderPointerDown ? 'none' : undefined,
        // Stick to the top of the scrolling panel so the title + close stay reachable when a loaded
        // template grows the body past the viewport.
        position: floating ? 'sticky' : undefined,
        top: floating ? 0 : undefined,
        zIndex: floating ? 3 : undefined,
      }}
        onPointerDown={floating ? onHeaderPointerDown : undefined}
      >
        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--muted)', flex: 1, minWidth: 0 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              minHeight: 26,
              width: '100%',
            }}
          >
            {isNew ? 'Add new data source' : `Edit: ${profile.name}`}
          </div>
        </div>
        {floating && onCancel ? (
          <IconButton
            aria-label="Close"
            title="Close (same as Cancel)"
            onPointerDown={e => e.stopPropagation()}
            onClick={onCancel}
            style={{ flexShrink: 0, fontSize: 18 }}
          >×</IconButton>
        ) : null}
      </div>

      <div style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        padding: '10px 12px',
        background: 'color-mix(in srgb, var(--surface) 42%, transparent)',
        border: '1px solid var(--border)',
        borderRadius: 8,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <FileInput
            ref={sampleFileInputRef}
            pickerId={PICKER_IDS.importProfileSample}
            accept=".csv,text/csv"
            onChange={e => {
              const file = e.target.files?.[0]
              e.target.value = ''
              if (file) handleSampleFile(file)
            }}
            style={{ display: 'none' }}
          />
          <Button
            variant="secondary"
            onClick={() => sampleFileInputRef.current?.click()}
          >
            {samplePreview || isNew ? 'Choose template file' : 'Provide template file'}
          </Button>
          {sampleLoading ? (
            <div style={{ transform: 'scale(0.72)', transformOrigin: 'left center' }}>
              <Spinner />
            </div>
          ) : null}
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>
          {sampleFileName ? (
            <>Using <span style={{ color: 'var(--text)', fontWeight: 600 }}>{sampleFileName}</span> as the template.</>
          ) : isNew ? (
            'Provide a sample .csv file from this data source'
          ) : templateFileName ? (
            <>
              This file was used as a template for this data source: <span style={{ color: 'var(--text)', fontWeight: 600 }}>{templateFileName}</span>. If you locate it, or provide a more recent example, it will be used as a template.
            </>
          ) : (
            'No template file is currently loaded for this data source. If you provide a sample .csv file, it will be used as a template.'
          )}
        </div>
      </div>

      {showTemplateHashWarning ? (
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          padding: '10px 12px',
          background: 'color-mix(in srgb, var(--warning) 10%, var(--surface2))',
          border: '1px solid color-mix(in srgb, var(--warning) 34%, var(--border))',
          borderRadius: 8,
        }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'color-mix(in srgb, var(--warning) 72%, var(--text))' }}>
            This template does not match any of the imported files currently tracked from this data source.
          </div>
          <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>
            This is just a warning in case this is unexpected.
          </div>
          {savedTemplateHeaders.length > 0 ? (
            <div style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.5 }}>
              <span style={{ fontWeight: 600, color: 'var(--text)' }}>Previously saved headers:</span> {savedTemplateHeaders.join(', ')}
            </div>
          ) : null}
          {sampleHeaders.length > 0 ? (
            <div style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.5 }}>
              <span style={{ fontWeight: 600, color: 'var(--text)' }}>Headers in selected template:</span> {sampleHeaders.join(', ')}
            </div>
          ) : null}
        </div>
      ) : null}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <div>
          <label htmlFor={`${fid}-name`} style={{ fontSize: 11, color: 'var(--muted)', display: 'block', marginBottom: 3 }}>
            Data source name *
          </label>
          <input id={`${fid}-name`} name="data-source-name" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Main Checking" style={inputStyle} />
        </div>
        <div>
          <label htmlFor={`${fid}-pattern`} style={{ fontSize: 11, color: 'var(--muted)', display: 'block', marginBottom: 3 }}>
            Filename pattern (auto-detect)
          </label>
          <input id={`${fid}-pattern`} name="data-source-filename-pattern" value={filePattern} onChange={e => setFilePattern(e.target.value)} placeholder="e.g. statement" style={inputStyle} />
        </div>
        <div>
          <label htmlFor={`${fid}-header`} style={{ fontSize: 11, color: 'var(--muted)', display: 'block', marginBottom: 3 }}>
            Header fingerprint (auto-detect)
          </label>
          <input id={`${fid}-header`} name="data-source-header-fingerprint" value={headerFp} onChange={e => setHeaderFp(e.target.value)} placeholder="Paste header row from CSV" style={inputStyle} />
        </div>
        <div>
          <label htmlFor={`${fid}-dateformat`} style={{ fontSize: 11, color: 'var(--muted)', display: 'block', marginBottom: 3 }}>Date format</label>
          <select id={`${fid}-dateformat`} name="data-source-date-format" value={dateFormat} onChange={e => setDateFormat(e.target.value)} style={selStyle}>
            {DATE_FORMATS.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor={`${fid}-amtconv`} style={{ fontSize: 11, color: 'var(--muted)', display: 'inline-flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
            Amount convention
            <FeatureExplainer topic="amount-conventions" placement="bottom-left" />
          </label>
          <select id={`${fid}-amtconv`} name="data-source-amount-convention" value={amtConv} onChange={e => setAmtConv(e.target.value)} style={selStyle}>
            {AMOUNT_CONVENTIONS.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor={`${fid}-decimal`} style={{ fontSize: 11, color: 'var(--muted)', display: 'block', marginBottom: 3 }}>Decimal separator</label>
          <select id={`${fid}-decimal`} name="data-source-decimal-separator" value={decimalSeparator} onChange={e => setDecimalSeparator(e.target.value)} style={selStyle}>
            {DECIMAL_SEPARATORS.map(d => <option key={d.value} value={d.value}>{d.label}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor={`${fid}-sourcelag`} style={{ fontSize: 11, color: 'var(--muted)', display: 'block', marginBottom: 3 }}>
            Days this source lags the bank
          </label>
          <input
            id={`${fid}-sourcelag`}
            name="data-source-lag-days"
            type="number"
            min={MIN_SOURCE_LAG_DAYS}
            max={MAX_SOURCE_LAG_DAYS}
            value={sourceLagDays}
            onChange={e => setSourceLagDays(e.target.value)}
            onBlur={() => setSourceLagDays(String(clampSourceLagDays(sourceLagDays)))}
            style={inputStyle}
          />
          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 3, lineHeight: 1.4 }}>
            An export can be missing recent transactions its own source had not caught up on yet.
            Those trailing days stay open for matching instead of counting as already imported, so a
            later file can still bring them in. Lower this to 1 only for a source that publishes its
            own records and so cannot be behind — a store or payment service, rather than a bank or a
            budgeting app that relays one.
          </div>
        </div>
      </div>

      <ImportColumnMappingSection
        marginBottom={0}
        fields={[
          {
            key: 'date',
            label: 'Date column',
            headers: columnAnalysis.dateCandidates,
            allHeaders: sampleHeaders,
            value: colDate,
            onChange: nextValue => {
              if (nextValue) clearMappingSuggestion('date')
              setColDate(nextValue)
            },
            suggestedValue: mappingSuggestions.date,
            onAcceptSuggestion: nextValue => {
              clearMappingSuggestion('date')
              setColDate(nextValue)
            },
            required: true,
            hint: columnAnalysis.dateCandidates.length > 0 && !colDate ? formatLikelyMatchLabel(columnAnalysis.dateCandidates.length) : '',
            placeholder: 'e.g. Transaction Date',
            inputId: `${fid}-mapping-date`,
          },
          amtConv === 'two_column'
            ? {
              key: 'debit',
              label: 'Debit column',
              headers: columnAnalysis.debitCandidates,
              allHeaders: sampleHeaders,
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
              placeholder: 'e.g. Debit',
              inputId: `${fid}-mapping-debit`,
            }
            : {
              key: 'amount',
              label: 'Amount column',
              headers: columnAnalysis.amountCandidates,
              allHeaders: sampleHeaders,
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
              hint: columnAnalysis.amountCandidates.length > 0 && !colAmount ? formatLikelyMatchLabel(columnAnalysis.amountCandidates.length) : '',
              placeholder: 'e.g. Amount',
              inputId: `${fid}-mapping-amount`,
            },
          {
            key: 'pending',
            label: 'Pending column',
            headers: columnAnalysis.pendingCandidates,
            allHeaders: sampleHeaders,
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
            placeholder: 'e.g. Pending',
            inputId: `${fid}-mapping-pending`,
          },
          {
            key: 'currency',
            label: 'Currency column',
            headers: columnAnalysis.currencyCandidates,
            allHeaders: sampleHeaders,
            value: colCurrency,
            onChange: nextValue => {
              if (nextValue) clearMappingSuggestion('currency')
              setColCurrency(nextValue)
            },
            suggestedValue: mappingSuggestions.currency,
            onAcceptSuggestion: nextValue => {
              clearMappingSuggestion('currency')
              setColCurrency(nextValue)
            },
            hint: columnAnalysis.currencyCandidates.length > 0 && !colCurrency ? formatLikelyMatchLabel(columnAnalysis.currencyCandidates.length) : '',
            placeholder: 'e.g. Currency',
            inputId: `${fid}-mapping-currency`,
          },
          amtConv === 'two_column'
            ? {
              key: 'credit',
              label: 'Credit column',
              headers: columnAnalysis.creditCandidates,
              allHeaders: sampleHeaders,
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
              placeholder: 'e.g. Credit',
              inputId: `${fid}-mapping-credit`,
            }
            : null,
          amtConv === 'single_unsigned'
            ? {
              key: 'direction',
              label: 'Direction column',
              headers: columnAnalysis.directionCandidates,
              allHeaders: sampleHeaders,
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
              placeholder: 'e.g. Type',
              inputId: `${fid}-mapping-direction`,
            }
            : null,
          {
            key: 'description',
            label: 'Merchant column',
            headers: columnAnalysis.merchantCandidates,
            allHeaders: sampleHeaders,
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
            placeholder: 'e.g. Description',
            inputId: `${fid}-mapping-description`,
          },
          {
            key: 'category',
            label: 'Category column',
            headers: columnAnalysis.categoryCandidates,
            allHeaders: sampleHeaders,
            value: colCategory,
            onChange: nextValue => {
              if (nextValue) clearMappingSuggestion('category')
              setColCategory(nextValue)
            },
            suggestedValue: mappingSuggestions.category,
            onAcceptSuggestion: nextValue => {
              clearMappingSuggestion('category')
              setColCategory(nextValue)
            },
            hint: columnAnalysis.categoryCandidates.length > 0 && !colCategory ? formatLikelyMatchLabel(columnAnalysis.categoryCandidates.length) : '',
            placeholder: 'e.g. Category',
            inputId: `${fid}-mapping-category`,
          },
          {
            key: 'notes',
            label: 'Notes column',
            headers: [],
            allHeaders: sampleHeaders,
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
            placeholder: 'optional',
            inputId: `${fid}-mapping-notes`,
            inputName: 'data-source-notes-column',
          },
          {
            key: 'transaction_id',
            label: 'Transaction ID column',
            headers: columnAnalysis.transactionIdCandidates,
            allHeaders: sampleHeaders,
            value: colTransactionId,
            onChange: nextValue => {
              if (nextValue) clearMappingSuggestion('transaction_id')
              setColTransactionId(nextValue)
            },
            suggestedValue: mappingSuggestions.transaction_id,
            onAcceptSuggestion: nextValue => {
              clearMappingSuggestion('transaction_id')
              setColTransactionId(nextValue)
            },
            hint: columnAnalysis.transactionIdCandidates.length > 0 && !colTransactionId ? formatLikelyMatchLabel(columnAnalysis.transactionIdCandidates.length) : '',
            placeholder: 'optional',
            inputId: `${fid}-mapping-transaction-id`,
          },
        ]}
        accountField={{
          headers: columnAnalysis.accountCandidates,
          allHeaders: sampleHeaders,
          accounts,
          colAccount,
          accountId,
          singleAccountNew: newAccount,
          suggestedColumn: mappingSuggestions.account,
          onAcceptSuggestedColumn: nextValue => {
            clearMappingSuggestion('account')
            setColAccount(nextValue)
            setAccountId('')
            setNewAccount(NO_NEW_ACCOUNT)
          },
          isRequired: !colAccount && !accountId && !newAccount.enabled,
          hint: accountSelectHint,
          onChange: ({ col, acct, createNew }) => {
            if (col !== undefined) {
              if (col) clearMappingSuggestion('account')
              setColAccount(col || '')
              setAccountId('')
              setNewAccount(NO_NEW_ACCOUNT)
            } else {
              if (acct || createNew) clearMappingSuggestion('account')
              setColAccount('')
              setAccountId(acct || '')
              setNewAccount(createNew ? { ...NO_NEW_ACCOUNT, enabled: true } : NO_NEW_ACCOUNT)
            }
          },
          onNewAccountChange: setNewAccount,
        }}
      />

      {colAccount && accountMapRows.length > 0 ? (
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Account mappings</div>
          <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 8, maxWidth: 560 }}>
            Where each value in the {colAccount} column imports, as earlier imports left it. A value not
            listed is asked about at its next import, and a watched folder holds its file until then.
          </div>
          <div style={{ border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden', maxWidth: 640 }}>
            <AccountMappingGrid
              sourceHeading="Account from file"
              namePrefix="source-account-map"
              accounts={accounts}
              rows={accountMapRows}
              inFlightOptions={inFlightMapAccounts}
              // Any change answers the row, so a dead account it named is no longer carried.
              onUpdate={(value, patch) => setSourceAccountMap(prev => ({
                ...prev,
                [value]: { ...defaultAccountMapEntry(value), ...(prev[value] || {}), ...patch, missingAccountId: '' },
              }))}
            />
          </div>
        </div>
      ) : null}

      <ImportEvidenceColumnsSection
        options={evidenceColumnOptions}
        checked={resolvedEvidenceColumns}
        forced={forcedEvidenceColumns(samplePreview, evidenceColumnOptions)}
        onChange={setEvidenceColumns}
      />

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
          <input name="profile-apply-categorization-rules" type="checkbox" checked={applyCat} onChange={e => setApplyCat(e.target.checked)} />
          Apply categorization rules by default
        </label>
        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 6, fontSize: 13, cursor: 'pointer' }}>
          <input name="profile-enrich-from-source" type="checkbox" checked={enrichFromSource} onChange={e => setEnrichFromSource(e.target.checked)} style={{ marginTop: 2 }} />
          <span>
            Enrich existing transactions from this source
            <span style={{ display: 'block', fontSize: 11, color: 'var(--muted)' }}>
              When an import matches a transaction already in your ledger, add any extra detail it carries (memos, item titles) to that transaction. Best for sources whose detail is richer than your other imports.
            </span>
          </span>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: colCategory ? 'pointer' : 'not-allowed', opacity: colCategory ? 1 : 0.55 }}>
          <input
            name="profile-use-imported-categories"
            type="checkbox"
            checked={useImportedCategories}
            disabled={!colCategory}
            onChange={e => setUseImportedCategories(e.target.checked)}
          />
          <span>
            Imports from this data source have been categorized
            <span style={{ display: 'block', fontSize: 11, color: 'var(--muted)' }}>
              {colCategory
                ? 'Missing categories are added to the system and suggestions for rules are built from the categorization patterns.'
                : 'Map a Category column above to use this — an import can only carry categories from a category column.'}
            </span>
          </span>
        </label>
      </div>

      <div style={{
        display: 'flex',
        justifyContent: 'flex-end',
        gap: 8,
        // Stick to the bottom of the scrolling panel so Save/Cancel stay visible when a loaded template
        // grows the body; bleeds to the panel edges to match the header.
        position: floating ? 'sticky' : undefined,
        bottom: floating ? 0 : undefined,
        margin: floating ? '4px -18px -18px' : '4px 0 0',
        padding: floating ? '12px 18px' : '10px 0 0',
        borderTop: floating ? '1px solid color-mix(in srgb, var(--accent) 18%, var(--border))' : '1px solid var(--border)',
        background: floating ? getFloatingPanelHeaderBackground(true) : 'transparent',
        borderRadius: floating ? '0 0 18px 18px' : 0,
        zIndex: floating ? 3 : undefined,
      }}>
        <Button variant="secondary" onClick={onCancel}>Cancel</Button>
        <Button onClick={handleSave} disabled={!canSave}>
          {isNew ? 'Create data source' : 'Save changes'}
        </Button>
      </div>
    </div>
  )
}

export default function ImportProfilesManager({
  embedded = false,
  onEditingChange,
  onDataChange,
  initialMode = 'list',
  onProfileCreated,
  hostData = null,
  onReviewMoneyMovement,
  systemRows = null,
} = {}) {
  // This manager keeps saved data-source administration inside Import:
  // the list stays embedded in the page, while add/edit happens in a floating
  // form so users can manage recurring CSV sources without leaving the workflow.
  //
  // `hostData` (`{ profiles, accounts, batches, loading }`) is the host page's own copy of the lists
  // this manager shows. Given one, the manager follows it instead of loading at mount: the list is on
  // screen from the first render, and a write made outside the manager — an import, an undo — shows
  // here without a second fetch. The manager's own writes still publish through `onDataChange`.
  //
  // `systemRows` are rows for sources that are not saved mappings (a marketplace vendor), listed after
  // the saved ones.
  const rootRef = useRef(null)
  const formPanelRef = useRef(null)
  const formPanelDragStartRef = useRef(null)
  const [profiles, setProfiles] = useState(hostData?.profiles || [])
  const [accounts, setAccounts] = useState(hostData?.accounts || [])
  const [batches, setBatches] = useState(hostData?.batches || [])
  const [ownLoading, setOwnLoading] = useState(!hostData)
  const loading = hostData ? !!hostData.loading : ownLoading
  const [showAdd, setShowAdd] = useState(false)
  const [formPanelPos, setFormPanelPos] = useState(null)
  const [formPanelDragging, setFormPanelDragging] = useState(false)
  const [editId, setEditId] = useState(null)
  const [editingNameId, setEditingNameId] = useState(null)
  const [nameDraft, setNameDraft] = useState('')
  const [pendingDeleteProfile, setPendingDeleteProfile] = useState(null)
  const [deletingProfileId, setDeletingProfileId] = useState('')
  const [noticeDialog, setNoticeDialog] = useState(null)
  const [watchProfile, setWatchProfile] = useState(null)
  // Pointing a source at a server folder needs an admin once sign-in protection is on; everything else
  // about a data source does not. Assumed allowed until the status says otherwise, so an admin never
  // sees the refusal flash past on load — the server enforces it either way.
  const [canSetWatchFolder, setCanSetWatchFolder] = useState(true)
  const activeFormKey = showAdd ? 'new' : (editId ? `edit:${editId}` : '')

  function clampFormPanelPosition(pos, size = { width: ADD_PANEL_WIDTH, height: 740 }) {
    if (!pos || typeof window === 'undefined') return pos
    const maxX = Math.max(24, window.innerWidth - (size.width || ADD_PANEL_WIDTH) - 24)
    const maxY = Math.max(24, window.innerHeight - Math.min(size.height || 740, window.innerHeight - 48) - 24)
    return {
      x: Math.max(24, Math.min(maxX, Math.round(pos.x))),
      y: Math.max(24, Math.min(maxY, Math.round(pos.y))),
    }
  }

  const getDefaultFormPanelPosition = useCallback((size = { width: ADD_PANEL_WIDTH, height: 740 }) => {
    if (typeof window === 'undefined') return { x: 96, y: 96 }
    const rect = rootRef.current?.getBoundingClientRect()
    const desiredX = rect
      ? rect.left + Math.max(36, Math.round((rect.width - (size.width || ADD_PANEL_WIDTH)) / 2))
      : Math.round((window.innerWidth - (size.width || ADD_PANEL_WIDTH)) / 2)
    // Open near the top so there's room to grow downward when a template file is loaded (the mapping +
    // capture sections appear); the panel caps its height to the viewport and scrolls internally.
    const desiredY = Math.max(48, Math.round(window.innerHeight * 0.07))
    return clampFormPanelPosition({ x: desiredX, y: desiredY }, size)
  }, [])

  // Every load here publishes into shared state — this panel's list *and*, through `onDataChange`, the
  // import page's data-source card behind it. So a response that resolves after something newer has
  // already published does not merely arrive late, it puts stale rows back on screen.
  //
  // The newer thing is usually a **mutation**: deleting a source republishes the list without it, and a
  // load that was already in flight when the DELETE went out then reinstates the deleted row on the page
  // behind this panel. In development StrictMode makes that collision routine rather than rare, because
  // it runs the mount effect twice and two loads are in flight from the moment the panel opens.
  //
  // `dataGeneration` sequences the two kinds of write against each other: a load claims the current
  // number, a mutation burns it, and a load publishes only if its number is still the newest. A plain
  // `cancelled` flag (the pattern in SplitEditorDialog) would not do — that covers *unmount*, and the
  // problem here is being overtaken while still mounted.
  const dataGeneration = useRef(0)

  function invalidateInFlightLoads() {
    dataGeneration.current += 1
  }

  const refreshManagerData = useCallback(async () => {
    // include_children: a source's single-account mapping keeps pointing at the account it was set to
    // even after that account is merged into a group, so a root-only list would render a live mapping
    // as an empty picker (and invite the user to "fix" it by re-pointing the source). The import
    // mapping grid fetches the same way, for the same reason.
    const generation = ++dataGeneration.current
    const [p, a, b] = await Promise.all([
      api.getImportProfiles(), api.getAccounts({ include_children: true }), api.listBatches(),
    ])
    if (generation !== dataGeneration.current) return
    setProfiles(p)
    setAccounts(a)
    setBatches(b)
    onDataChange?.({ profiles: p, accounts: a, batches: b })
  }, [onDataChange])

  const hosted = !!hostData
  useEffect(() => {
    if (hosted) return
    refreshManagerData().finally(() => setOwnLoading(false))
  }, [hosted, refreshManagerData])

  const hostProfiles = hostData?.profiles
  const hostAccounts = hostData?.accounts
  const hostBatches = hostData?.batches
  useEffect(() => { if (hostProfiles) setProfiles(hostProfiles) }, [hostProfiles])
  useEffect(() => { if (hostAccounts) setAccounts(hostAccounts) }, [hostAccounts])
  useEffect(() => { if (hostBatches) setBatches(hostBatches) }, [hostBatches])

  useEffect(() => {
    api.getAuthStatus()
      .then(status => setCanSetWatchFolder(!status?.auth_enabled || status?.user?.role === 'admin'))
      .catch(() => { })
  }, [])

  useEffect(() => {
    onEditingChange?.(showAdd || !!editId)
  }, [editId, onEditingChange, showAdd])

  useEffect(() => {
    if (initialMode === 'add') {
      setShowAdd(true)
      setEditId(null)
    }
  }, [initialMode])

  useEffect(() => {
    if (!activeFormKey) {
      setFormPanelPos(null)
      return
    }
    setFormPanelPos(getDefaultFormPanelPosition())
  }, [activeFormKey, getDefaultFormPanelPosition])

  useEffect(() => {
    if (!formPanelDragging) return undefined
    function handleMove(event) {
      const start = formPanelDragStartRef.current
      if (!start) return
      setFormPanelPos(clampFormPanelPosition({
        x: start.x + (event.clientX - start.mouseX),
        y: start.y + (event.clientY - start.mouseY),
      }, { width: start.width, height: start.height }))
    }
    function handleUp() {
      setFormPanelDragging(false)
    }
    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', handleUp)
    window.addEventListener('pointercancel', handleUp)
    return () => {
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', handleUp)
      window.removeEventListener('pointercancel', handleUp)
    }
  }, [formPanelDragging])

  useEffect(() => {
    if (!activeFormKey) return undefined
    function handleResize() {
      const rect = formPanelRef.current?.getBoundingClientRect()
      setFormPanelPos(prev => clampFormPanelPosition(prev || getDefaultFormPanelPosition(), {
        width: rect?.width || ADD_PANEL_WIDTH,
        height: rect?.height || 740,
      }))
    }
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [activeFormKey, getDefaultFormPanelPosition])

  function startFormPanelDrag(event) {
    const rect = formPanelRef.current?.getBoundingClientRect()
    if (!rect) return
    formPanelDragStartRef.current = {
      mouseX: event.clientX,
      mouseY: event.clientY,
      x: formPanelPos?.x ?? rect.left,
      y: formPanelPos?.y ?? rect.top,
      width: rect.width,
      height: rect.height,
    }
    setFormPanelDragging(true)
    preventPressDefaults(event)
  }

  async function handleSave(data, meta = {}) {
    try {
      if (editId) {
        await api.updateImportProfile(editId, data)
        setEditId(null)
        invalidateInFlightLoads()
      } else {
        const created = await api.createImportProfile(data)
        invalidateInFlightLoads()
        setShowAdd(false)
        onProfileCreated?.({
          profileId: created?.id || '',
          sampleFile: meta?.sampleFile || null,
          samplePreview: meta?.samplePreview || null,
          body: data,
        })
      }
      await refreshManagerData()
    } catch (error) {
      setNoticeDialog({
        title: editId ? 'Could not save the data source' : 'Could not create the data source',
        description: error?.message || 'Please try again.',
      })
    }
  }

  async function handleDelete(id) {
    setDeletingProfileId(id)
    try {
      await api.deleteImportProfile(id)
      setPendingDeleteProfile(null)
      invalidateInFlightLoads()
      const nextProfiles = profiles.filter(p => p.id !== id)
      const nextBatches = batches.filter(batch => batch.profile_id !== id)
      setProfiles(nextProfiles)
      setBatches(nextBatches)
      onDataChange?.({ profiles: nextProfiles, batches: nextBatches })
    } catch (error) {
      setNoticeDialog({
        title: 'Could not delete the data source',
        description: error?.message || 'Please try again.',
      })
    } finally {
      setDeletingProfileId('')
    }
  }

  async function saveProfileName(profileId) {
    const profile = profiles.find(item => item.id === profileId)
    const nextValue = nameDraft.trim()
    setEditingNameId(null)
    setNameDraft('')
    if (!profile || !nextValue || nextValue === profile.name) return
    invalidateInFlightLoads()
    // Published to the page behind as well, like every other write here — it lists these sources too.
    const renamed = profiles.map(item => (item.id === profileId ? { ...item, name: nextValue } : item))
    setProfiles(renamed)
    onDataChange?.({ profiles: renamed })
    try {
      await api.updateImportProfile(profileId, { name: nextValue })
    } catch (error) {
      refreshManagerData()
      setNoticeDialog({
        title: 'Could not rename the data source',
        description: error?.message || 'Please try again.',
      })
    }
  }

  function formatLastUsed(value) {
    return formatTimestamp(value) || 'Never used'
  }

  const profileImportStats = useMemo(() => {
    const byProfile = new Map()
    profiles.forEach(profile => {
      const profileBatches = batches.filter(batch => batch.profile_id === profile.id)
      const fileCount = profileBatches.length
      const rowCount = profileBatches.reduce((sum, batch) => sum + Number(batch?.row_count || 0), 0)
      const lastUsed = profileBatches
        .map(batch => batch?.imported_at || '')
        .sort((a, b) => String(b).localeCompare(String(a)))[0] || ''
      byProfile.set(profile.id, {
        fileCount,
        rowCount,
        lastUsed,
      })
    })
    return byProfile
  }, [batches, profiles])

  const visibleArea = useVisibleViewport()
  const formPanelPlacement = formPanelPos || getDefaultFormPanelPosition()
  const formPanelKeyboard = placeAboveKeyboard(visibleArea, formPanelPlacement.y)

  const content = (
    <>
      {noticeDialog ? (
        <AppNoticeDialog
          title={noticeDialog.title}
          description={noticeDialog.description}
          onClose={() => setNoticeDialog(null)}
        />
      ) : null}

      {activeFormKey ? (
        <div
          onClick={event => event.stopPropagation()}
          onMouseDown={event => event.stopPropagation()}
          style={{
            position: 'fixed',
            ...visibleLayerBox(visibleArea),
            zIndex: 360,
            background: 'rgba(15, 23, 42, 0.18)',
          }}
        >
          <div
            ref={formPanelRef}
            onClick={event => event.stopPropagation()}
            style={{
              width: `min(${ADD_PANEL_WIDTH}px, calc(100vw - 96px))`,
              // Cap the height relative to where the panel actually sits, so growing after a template is
              // loaded scrolls inside the panel instead of pushing the footer off the bottom of the screen.
              maxHeight: formPanelKeyboard
                ? formPanelKeyboard.maxHeight
                : `calc(100vh - ${formPanelPlacement.y}px - 24px)`,
              overflow: 'auto',
              position: 'fixed',
              left: formPanelPlacement.x,
              // While an on-screen keyboard is open the panel is kept above it (see visibleViewport.js).
              top: formPanelKeyboard?.top ?? formPanelPlacement.y,
              borderRadius: 18,
              userSelect: formPanelDragging ? 'none' : 'auto',
            }}
          >
            <ProfileForm
              profile={showAdd ? null : profiles.find(profile => profile.id === editId)}
              accounts={accounts}
              knownTemplateHashes={showAdd
                ? []
                : batches
                  .filter(batch => batch.profile_id === editId)
                  .map(batch => String(batch.file_content_hash || '').trim())
                  .filter(Boolean)}
              onSave={handleSave}
              onCancel={() => {
                setShowAdd(false)
                setEditId(null)
              }}
              onNotice={setNoticeDialog}
              floating
              onHeaderPointerDown={startFormPanelDrag}
              headerCursor={formPanelDragging ? 'grabbing' : 'grab'}
            />
          </div>
        </div>
      ) : null}

      {loading && profiles.length === 0 ? <Spinner /> : (
        // Below its minimum the four columns stop fitting, so the list holds its width and scrolls
        // sideways inside the card rather than re-flowing. The add/edit panel is `position: fixed`,
        // so this does not clip it.
        <div style={{ overflowX: 'auto' }}>
        <div style={{ minWidth: SOURCE_LIST_MIN_WIDTH }}>
          {profiles.map(profile => (
            <div key={profile.id}>
              <div
                style={{
                  display: 'grid', gridTemplateColumns: SOURCE_ROW_GRID_COLUMNS, columnGap: 12,
                  padding: '10px 16px', alignItems: 'center', fontSize: 13,
                  borderBottom: '1px solid var(--border)',
                }}
              >
                {(() => {
                  const stats = profileImportStats.get(profile.id) || { fileCount: 0, rowCount: 0, lastUsed: '' }
                  return (
                    <>
                      <div style={{ minWidth: 0 }}>
                        {editingNameId === profile.id ? (
                          <TransientTextInput
                            value={nameDraft}
                            onChange={setNameDraft}
                            onCommit={() => saveProfileName(profile.id)}
                            onCancel={() => {
                              setEditingNameId(null)
                              setNameDraft('')
                            }}
                            restoreOnEscape
                            placeholder="Data source name"
                            style={{
                              width: 240,
                              maxWidth: '100%',
                              background: 'var(--surface)',
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
                              setEditingNameId(profile.id)
                              setNameDraft(profile.name || '')
                            }}
                            style={{
                              background: 'none',
                              border: 'none',
                              padding: 0,
                              margin: 0,
                              fontSize: 13,
                              fontWeight: 500,
                              color: 'var(--text)',
                              cursor: 'pointer',
                              textAlign: 'left',
                              maxWidth: '100%',
                              ...TRUNCATED_CELL_STYLE,
                            }}
                            title={`${profile.name} — click to rename this data source`}
                          >
                            {profile.name}
                          </button>
                        )}
                        <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2, ...TRUNCATED_CELL_STYLE }}>
                          {profile.filename_pattern ? <span>📁 {profile.filename_pattern} · </span> : null}
                          {profile.account_name ? <span>🏦 {profile.account_name}</span> : null}
                        </div>
                        {/* Which account each PayPal account's statements go into. Set by the first statement
                            imported for it rather than by anything in the editor, so this is the only place
                            the pairing shows outside the statement import itself. */}
                        {profile.statement_accounts?.length ? (() => {
                          const pairs = profile.statement_accounts
                            .map(pair => `${pair.paypal_account_id} → ${pair.account_name || 'a removed account'}`)
                            .join(' · ')
                          return (
                            <div
                              style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2, ...TRUNCATED_CELL_STYLE }}
                              title={`Statements go into: ${pairs}`}
                            >
                              Statements: <span style={{ color: 'var(--text)' }}>{pairs}</span>
                            </div>
                          )
                        })() : null}
                        {profile.watch_dir ? (
                          // Truncated with the whole path on hover, rather than wrapped: a path broken
                          // across three ragged lines is what made a narrow window unreadable.
                          <div
                            style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2, ...TRUNCATED_CELL_STYLE }}
                            title={profile.watch_notice ? `${profile.watch_dir} · ${profile.watch_notice}` : profile.watch_dir}
                          >
                            {/* The pill leads the line for the same reason the path is truncated rather
                                than wrapped: anything after the path is the first thing clipped. */}
                            {profile.watch_enabled ? '👁 Watching ' : <><WatchPausedPill />{' 👁 '}</>}
                            <span style={{ color: 'var(--text)' }}>{profile.watch_dir}</span>
                            {profile.watch_notice ? <span style={{ color: 'var(--danger)' }}> · {profile.watch_notice}</span> : null}
                          </div>
                        ) : null}
                      </div>
                      <div style={{ display: 'grid', gap: 2 }}>
                        <span style={{ fontSize: 10, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Last used</span>
                        <span style={{ fontSize: 12, color: 'var(--muted)' }}>{formatLastUsed(stats.lastUsed)}</span>
                      </div>
                      <div style={{ display: 'grid', gap: 2 }}>
                        <span style={{ fontSize: 10, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Imported</span>
                        <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                          {stats.fileCount} {stats.fileCount === 1 ? 'file' : 'files'} · {stats.rowCount.toLocaleString()} {stats.rowCount === 1 ? 'row' : 'rows'}
                        </span>
                      </div>
                      {/* The actions column is a fixed width, so a control too wide for it takes a line
                          of its own beneath rather than widening the column for every row. */}
                      <div style={{ display: 'grid', gap: 6, justifyItems: 'end' }}>
                        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', alignItems: 'center' }}>
                        <Button size="compact" variant="quiet" onClick={() => setWatchProfile(profile)}>
                          Folder
                        </Button>
                        <Button size="compact" variant="quiet" onClick={() => setEditId(profile.id)}>
                          Edit
                        </Button>
                        {profile.source_kind ? (
                          <span title="This data source is managed by the system and can't be deleted." style={{ color: 'var(--muted)', fontSize: 14, padding: '2px 6px', cursor: 'default' }}>🔒</span>
                        ) : (
                          <IconButton tone="danger" aria-label={`Delete ${profile.name}`} onClick={() => setPendingDeleteProfile(profile)}>
                            ×
                          </IconButton>
                        )}
                        </div>
                        {/* Muted like its siblings: it is an ordinary row action, and the accent colour
                            made it read as the row's primary one. */}
                        {profile.source_kind === 'source:paypal' && onReviewMoneyMovement ? (
                          <Button
                            size="compact"
                            variant="quiet"
                            onClick={() => onReviewMoneyMovement(profile.id)}
                            title="Review which PayPal transaction types are transfers (deposits, withdrawals, holds…) so they're excluded from spending and income totals"
                            style={{ whiteSpace: 'nowrap' }}
                          >
                            Review transfer classifications
                          </Button>
                        ) : null}
                      </div>
                    </>
                  )
                })()}
              </div>
            </div>
          ))}
          {systemRows}
          {!showAdd ? (
            <LinkButton
              tone="muted"
              onClick={() => setShowAdd(true)}
              style={{ display: 'block', width: '100%', padding: '10px 16px', textAlign: 'center', fontSize: 13 }}
            >
              + New data source
            </LinkButton>
          ) : null}
        </div>
        </div>
      )}

      {watchProfile ? (
        <WatchedFolderDialog
          profile={watchProfile}
          canEdit={canSetWatchFolder}
          onClose={() => setWatchProfile(null)}
          onSaved={refreshManagerData}
        />
      ) : null}

      {pendingDeleteProfile ? (
        <OverlayBackdrop
          onClick={() => {
            if (deletingProfileId) return
            setPendingDeleteProfile(null)
          }}
          zIndex={1000}
          tint="rgba(15, 23, 42, 0.45)"
        >
          <FloatingPanel
            onClick={event => event.stopPropagation()}
            style={{
              width: 'min(480px, 100%)',
              border: '1px solid color-mix(in srgb, var(--danger) 35%, var(--border))',
              padding: 20,
              display: 'grid',
              gap: 12,
            }}
          >
            <div style={{ fontSize: 16, fontWeight: 600 }}>Delete data source?</div>
            <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.5 }}>
              Delete <span style={{ color: 'var(--text)', fontWeight: 600 }}>{pendingDeleteProfile.name}</span> from saved CSV data sources?
            </div>
            <div style={{
              fontSize: 12,
              color: 'var(--danger)',
              background: 'color-mix(in srgb, var(--danger) 10%, var(--surface2))',
              borderRadius: 8,
              padding: '8px 10px',
              textAlign: 'center',
            }}>
              Imported files remain in history, but this saved data source definition will be removed.
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
              <Button variant="secondary" onClick={() => setPendingDeleteProfile(null)} disabled={!!deletingProfileId}>
                Cancel
              </Button>
              <Button variant="danger" onClick={() => handleDelete(pendingDeleteProfile.id)} disabled={!!deletingProfileId}>
                {deletingProfileId ? 'Deleting...' : 'Delete'}
              </Button>
            </div>
          </FloatingPanel>
        </OverlayBackdrop>
      ) : null}
    </>
  )

  if (embedded) {
    return (
      <div ref={rootRef} style={{ padding: 0, overflow: 'visible', position: 'relative' }}>
        {content}
      </div>
    )
  }

  return (
    <div ref={rootRef} style={{ position: 'relative', overflow: 'visible' }}>
      <Card style={{ padding: 0, overflow: 'visible', position: 'relative' }}>
        {content}
      </Card>
    </div>
  )
}
