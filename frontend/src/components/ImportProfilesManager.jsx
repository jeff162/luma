// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: GPL-3.0-or-later

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { api } from '../lib/api.js'
import {
  analyzeImportColumns,
  DEFAULT_IMPORT_DATE_FORMAT,
  formatLikelyMatchLabel,
  inferImportFileCharacteristicsFromPreview,
  inferUnambiguousImportMappingFromPreview,
} from '../lib/importColumnInference.js'
import { useUserPreference } from '../lib/UserPreferencesContext.jsx'
import {
  IMPORT_DEFAULT_CATEGORY_USAGE_MODE_PREF_KEY,
  IMPORT_CATEGORY_USAGE_MODE_ALL,
  IMPORT_CATEGORY_USAGE_MODE_PER_SOURCE,
  normalizeImportCategoryUsageMode,
} from '../lib/appConfig.js'
import { Card, Button, Spinner, getFloatingPanelSurfaceStyle, getFloatingPanelHeaderBackground, OverlayBackdrop, FloatingPanel, AppNoticeDialog } from './ui.jsx'
import ImportColumnMappingSection from './ImportColumnMappingSection.jsx'
import TransientTextInput from './TransientTextInput.jsx'

const AMOUNT_CONVENTIONS = [
  { value: 'single_signed', label: 'Single column — negative = debit' },
  { value: 'single_unsigned', label: 'Single column + a debit/credit type column' },
  { value: 'two_column', label: 'Two columns — separate debit / credit' },
]

const DATE_FORMATS = [
  { value: '%m/%d/%Y', label: 'MM/DD/YYYY' },
  { value: '%Y-%m-%d', label: 'YYYY-MM-DD' },
  { value: '%Y/%m/%d', label: 'YYYY/MM/DD' },
  { value: '%d/%m/%Y', label: 'DD/MM/YYYY' },
  { value: '%m-%d-%Y', label: 'MM-DD-YYYY' },
  { value: '%d-%m-%Y', label: 'DD-MM-YYYY' },
  { value: '%b %d, %Y', label: 'Mon DD, YYYY' },
  { value: '%b-%d-%Y', label: 'MMM-DD-YYYY' },
]

const ADD_PANEL_WIDTH = 900

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
    account: '',
  }
}

function formatTemplateHeaderList(headerFingerprint) {
  return String(headerFingerprint || '')
    .split('|')
    .map(value => value.trim())
    .filter(Boolean)
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
  onHeaderMouseDown = null,
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
  const [accountId, setAccountId] = useState(profile?.account_id || '')
  const [dateFormat, setDateFormat] = useState(profile?.date_format || DEFAULT_IMPORT_DATE_FORMAT)
  const [amtConv, setAmtConv] = useState(profile?.amount_convention || 'single_signed')
  const [skipRows] = useState(profile?.skip_rows ?? 0)
  const [applyCat, setApplyCat] = useState(profile?.apply_categorization !== false)
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
  const [colAccount, setColAccount] = useState(cm.account || '')
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
  const canSave = !!(
    name.trim() &&
    colDate.trim() &&
    colDesc.trim() &&
    (amtConv === 'two_column' ? colDebit.trim() && colCredit.trim() : colAmount.trim()) &&
    (colAccount.trim() || accountId)
  )
  const accountSelectHint = columnAnalysis.accountCandidates.length > 0 && !colAccount && !accountId
    ? formatLikelyMatchLabel(columnAnalysis.accountCandidates.length)
    : ''
  const savedTemplateHeaders = formatTemplateHeaderList(profile?.header_fingerprint)
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
    const existingImportedCategorySettings = profile?.column_map?.imported_category_settings
    const column_map = {
      date: colDate,
      description: colDesc,
      ...(amtConv === 'two_column'
        ? { debit: colDebit, credit: colCredit }
        : { amount: colAmount }),
      ...(amtConv === 'single_unsigned' && colDir ? { direction: colDir } : {}),
      ...(colPending ? { pending: colPending } : {}),
      ...(colCategory ? { category: colCategory } : {}),
      ...(colNotes ? { notes: colNotes } : {}),
      ...(colAccount ? { account: colAccount } : {}),
      ...(existingImportedCategorySettings ? { imported_category_settings: existingImportedCategorySettings } : {}),
    }
    onSave(
      {
        name: name.trim(),
        filename_pattern: filePattern.trim() || null,
        header_fingerprint: headerFp.trim() || null,
        template_filename: templateFileName.trim() || null,
        template_file_hash: templateFileHash.trim() || null,
        column_map, account_id: accountId || null,
        date_format: dateFormat, amount_convention: amtConv,
        skip_rows: parseInt(skipRows) || 0,
        apply_categorization: applyCat,
        use_imported_categories: useImportedCategories,
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
        cursor: floating && onHeaderMouseDown ? headerCursor : 'default',
        userSelect: floating && onHeaderMouseDown ? 'none' : 'auto',
      }}
        onMouseDown={floating ? onHeaderMouseDown : undefined}
      >
        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--muted)' }}>
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
          <input
            ref={sampleFileInputRef}
            type="file"
            accept=".csv,text/csv"
            onChange={e => {
              const file = e.target.files?.[0]
              e.target.value = ''
              if (file) handleSampleFile(file)
            }}
            style={{ display: 'none' }}
          />
          <Button
            small
            variant="ghost"
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
          background: 'color-mix(in srgb, #f59e0b 10%, var(--surface2))',
          border: '1px solid color-mix(in srgb, #f59e0b 34%, var(--border))',
          borderRadius: 8,
        }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'color-mix(in srgb, #f59e0b 72%, var(--text))' }}>
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
          <input id={`${fid}-name`} value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Main Checking" style={inputStyle} />
        </div>
        <div>
          <label htmlFor={`${fid}-pattern`} style={{ fontSize: 11, color: 'var(--muted)', display: 'block', marginBottom: 3 }}>
            Filename pattern (auto-detect)
          </label>
          <input id={`${fid}-pattern`} value={filePattern} onChange={e => setFilePattern(e.target.value)} placeholder="e.g. statement" style={inputStyle} />
        </div>
        <div>
          <label htmlFor={`${fid}-header`} style={{ fontSize: 11, color: 'var(--muted)', display: 'block', marginBottom: 3 }}>
            Header fingerprint (auto-detect)
          </label>
          <input id={`${fid}-header`} value={headerFp} onChange={e => setHeaderFp(e.target.value)} placeholder="Paste header row from CSV" style={inputStyle} />
        </div>
        <div>
          <label htmlFor={`${fid}-dateformat`} style={{ fontSize: 11, color: 'var(--muted)', display: 'block', marginBottom: 3 }}>Date format</label>
          <select id={`${fid}-dateformat`} value={dateFormat} onChange={e => setDateFormat(e.target.value)} style={selStyle}>
            {DATE_FORMATS.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor={`${fid}-amtconv`} style={{ fontSize: 11, color: 'var(--muted)', display: 'block', marginBottom: 3 }}>Amount convention</label>
          <select id={`${fid}-amtconv`} value={amtConv} onChange={e => setAmtConv(e.target.value)} style={selStyle}>
            {AMOUNT_CONVENTIONS.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
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
          },
        ]}
        accountField={{
          headers: columnAnalysis.accountCandidates,
          allHeaders: sampleHeaders,
          accounts,
          colAccount,
          accountId,
          singleAccountNew: { enabled: false, name: '', type: 'depository' },
          suggestedColumn: mappingSuggestions.account,
          onAcceptSuggestedColumn: nextValue => {
            clearMappingSuggestion('account')
            setColAccount(nextValue)
            setAccountId('')
          },
          isRequired: !colAccount && !accountId,
          hint: accountSelectHint,
          allowCreateNew: false,
          onChange: ({ col, acct }) => {
            if (col !== undefined) {
              if (col) clearMappingSuggestion('account')
              setColAccount(col || '')
              setAccountId('')
            } else {
              if (acct) clearMappingSuggestion('account')
              setColAccount('')
              setAccountId(acct || '')
            }
          },
        }}
      />

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
          <input type="checkbox" checked={applyCat} onChange={e => setApplyCat(e.target.checked)} />
          Apply categorization rules by default
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
          <input type="checkbox" checked={useImportedCategories} onChange={e => setUseImportedCategories(e.target.checked)} />
          Trusted imports from this data source can apply their existing categories, add missing categories under Unassigned, and suggest rules
        </label>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <Button small onClick={handleSave} disabled={!canSave}>
            {isNew ? 'Create data source' : 'Save changes'}
          </Button>
          <Button small variant="ghost" onClick={onCancel}>Cancel</Button>
        </div>
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
} = {}) {
  // This manager keeps saved data-source administration inside Import / Export:
  // the list stays embedded in the page, while add/edit happens in a floating
  // form so users can manage recurring CSV sources without leaving the workflow.
  const rootRef = useRef(null)
  const formPanelRef = useRef(null)
  const formPanelDragStartRef = useRef(null)
  const [profiles, setProfiles] = useState([])
  const [accounts, setAccounts] = useState([])
  const [batches, setBatches] = useState([])
  const [loading, setLoading] = useState(true)
  const [showAdd, setShowAdd] = useState(false)
  const [formPanelPos, setFormPanelPos] = useState(null)
  const [formPanelDragging, setFormPanelDragging] = useState(false)
  const [editId, setEditId] = useState(null)
  const [editingNameId, setEditingNameId] = useState(null)
  const [nameDraft, setNameDraft] = useState('')
  const [pendingDeleteProfile, setPendingDeleteProfile] = useState(null)
  const [deletingProfileId, setDeletingProfileId] = useState('')
  const [noticeDialog, setNoticeDialog] = useState(null)
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
    const desiredY = Math.max(72, Math.round(window.innerHeight * 0.28))
    return clampFormPanelPosition({ x: desiredX, y: desiredY }, size)
  }, [])

  const refreshManagerData = useCallback(async () => {
    const [p, a, b] = await Promise.all([api.getImportProfiles(), api.getAccounts(), api.listBatches()])
    setProfiles(p)
    setAccounts(a)
    setBatches(b)
    onDataChange?.({ profiles: p, accounts: a, batches: b })
  }, [onDataChange])

  useEffect(() => {
    refreshManagerData().finally(() => setLoading(false))
  }, [refreshManagerData])

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
    window.addEventListener('mousemove', handleMove)
    window.addEventListener('mouseup', handleUp)
    return () => {
      window.removeEventListener('mousemove', handleMove)
      window.removeEventListener('mouseup', handleUp)
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
    event.preventDefault()
  }

  async function handleSave(data, meta = {}) {
    try {
      if (editId) {
        await api.updateImportProfile(editId, data)
        setEditId(null)
      } else {
        const created = await api.createImportProfile(data)
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

  function formatLastUsed(value) {
    if (!value) return 'Never used'
    const parsed = new Date(value)
    if (Number.isNaN(parsed.getTime())) return value
    return parsed.toLocaleString([], {
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
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
            inset: 0,
            zIndex: 360,
            background: 'rgba(15, 23, 42, 0.18)',
          }}
        >
          <div
            ref={formPanelRef}
            onClick={event => event.stopPropagation()}
            style={{
              width: `min(${ADD_PANEL_WIDTH}px, calc(100vw - 96px))`,
              maxHeight: 'calc(100vh - 72px)',
              overflow: 'auto',
              position: 'fixed',
              left: (formPanelPos || getDefaultFormPanelPosition()).x,
              top: (formPanelPos || getDefaultFormPanelPosition()).y,
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
              onHeaderMouseDown={startFormPanelDrag}
              headerCursor={formPanelDragging ? 'grabbing' : 'grab'}
            />
          </div>
        </div>
      ) : null}

      {loading ? <Spinner /> : profiles.length === 0 && !showAdd ? (
        <div style={{ padding: '20px 16px', textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>
          <div>
            {'<'}<span style={{ fontStyle: 'italic' }}>empty</span>{'>'}
          </div>
          <button
            onClick={() => setShowAdd(true)}
            style={{
              marginTop: 10,
              background: 'var(--accent)', color: '#fff',
              border: 'none', borderRadius: 6, padding: '5px 12px', fontSize: 13, cursor: 'pointer',
            }}
          >
            + Create first data source
          </button>
        </div>
      ) : (
        <>
          {profiles.map(profile => (
            <div key={profile.id}>
              <div
                  style={{
                    display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 170px 170px 100px',
                    padding: '10px 16px', alignItems: 'center', fontSize: 13,
                    borderBottom: '1px solid var(--border)',
                  }}
                >
                {(() => {
                  const stats = profileImportStats.get(profile.id) || { fileCount: 0, rowCount: 0, lastUsed: '' }
                  return (
                    <>
                      <div>
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
                            onBlurCommit={false}
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
                            }}
                            title="Click to rename this data source"
                          >
                            {profile.name}
                          </button>
                        )}
                        <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
                          {profile.filename_pattern ? <span>📁 {profile.filename_pattern} · </span> : null}
                          {profile.account_name ? <span>🏦 {profile.account_name}</span> : null}
                        </div>
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
                      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                        <button
                          onClick={() => setEditId(profile.id)}
                          style={{
                            background: 'none', border: '1px solid var(--border)',
                            borderRadius: 6, color: 'var(--muted)', cursor: 'pointer',
                            fontSize: 12, padding: '3px 8px',
                          }}
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => setPendingDeleteProfile(profile)}
                          style={{
                            background: 'none', border: 'none',
                            color: 'var(--danger)', cursor: 'pointer', fontSize: 14, padding: '2px 6px',
                          }}
                        >
                          ×
                        </button>
                      </div>
                    </>
                  )
                })()}
              </div>
            </div>
          ))}
          {!showAdd ? (
            <div
              onClick={() => setShowAdd(true)}
              style={{
                padding: '10px 16px', textAlign: 'center', cursor: 'pointer',
                fontSize: 13, color: 'var(--muted)', borderTop: '1px solid var(--border)',
              }}
            >
              + New data source
            </div>
          ) : null}
        </>
      )}

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
              <Button variant="ghost" onClick={() => setPendingDeleteProfile(null)} disabled={!!deletingProfileId}>
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
