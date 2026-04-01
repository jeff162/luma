/**
 * ImportExport.jsx — CSV import/export and backup/restore
 *
 * IMPORT FLOW:
 *   1. Drop/click to upload CSV → raw file preview shown immediately.
 *   2. Server returns headers, 10 sample rows, all distinct column values,
 *      detected profile, previous batch info + account history, config snapshot.
 *   3. User maps columns (pre-filled from profile or config snapshot).
 *   4. Duplicate-account warning shown if file was previously imported.
 *   5. Multi-account CSVs: each CSV account value maps to a FinTrack account,
 *      new account, or skip. Skip checkbox excludes all rows for that value.
 *   6. Preview table updates live as columns are mapped.
 *   7. Import → batch record with config_snapshot + per-account counts.
 *   8. Recent imports list with per-account breakdown and undo.
 */

import React, { useState, useEffect, useRef, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../lib/api.js'
import { refreshTaskBadge } from '../App.jsx'
import { useFilters } from '../lib/FilterContext.jsx'
import { Card, PageHeader, Button, Spinner, EmptyState } from '../components/ui.jsx'
import CategoryPicker from '../components/CategoryPicker.jsx'
import ImportCategoryMappingWorkspace from '../components/ImportCategoryMappingWorkspace.jsx'
import { cloneImportCategoryMappingSnapshot, createImportCategoryMappingDraftState } from '../lib/importCategoryMappingState.js'
import { formatCurrency } from '../lib/utils.js'

const AMOUNT_CONVENTIONS = [
  { value: 'single_signed',   label: 'Single column — negative = debit (Chase, most banks)' },
  { value: 'single_unsigned', label: 'Single column — always positive, direction column' },
  { value: 'two_column',      label: 'Two columns — separate debit and credit' },
]
const DATE_FORMATS = [
  { value: '%m/%d/%Y',  label: 'MM/DD/YYYY  (e.g. 01/31/2024)' },
  { value: '%Y-%m-%d',  label: 'YYYY-MM-DD  (e.g. 2024-01-31)' },
  { value: '%Y/%m/%d',  label: 'YYYY/MM/DD  (e.g. 2024/01/31)' },
  { value: '%d/%m/%Y',  label: 'DD/MM/YYYY  (e.g. 31/01/2024)' },
  { value: '%m-%d-%Y',  label: 'MM-DD-YYYY  (e.g. 01-31-2024)' },
  { value: '%d-%m-%Y',  label: 'DD-MM-YYYY  (e.g. 31-01-2024)' },
  { value: '%b %d, %Y', label: 'Mon DD, YYYY  (e.g. Jan 31, 2024)' },
  { value: '%b-%d-%Y', label: 'MMM-DD-YYYY  (e.g. Mar-23-2026)' },
]
const EXPORT_COLUMNS = [
  { key: 'date',          label: 'Date' },
  { key: 'merchant_name', label: 'Merchant' },
  { key: 'raw_name',      label: 'Raw description' },
  { key: 'amount',        label: 'Amount' },
  { key: 'account',       label: 'Account' },
  { key: 'category',      label: 'Category' },
  { key: 'group',         label: 'Group' },
  { key: 'owner',         label: 'Owner' },
  { key: 'notes',         label: 'Notes' },
  { key: 'is_pending',    label: 'Pending' },
  { key: 'overridden',    label: 'Manually categorized' },
  { key: 'import_batch',  label: 'Import batch ID' },
]
const DEFAULT_EXPORT_COLS = ['date', 'merchant_name', 'amount', 'account', 'category']
const IMPORT_CONFIG_MAX_WIDTH = 'min(900px, 100%)'

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
    <div style={{ position: 'fixed', inset: 0, zIndex: 1200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, background: 'rgba(15, 23, 42, 0.34)', backdropFilter: 'blur(2px)' }}>
      <div style={{ width: 'min(620px, 100%)', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, boxShadow: '0 20px 48px rgba(0,0,0,0.26)', overflow: 'hidden' }}>
        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)', background: 'var(--surface2)' }}>
          <div style={{ fontSize: 16, fontWeight: 600 }}>Apply category changes?</div>
          <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4 }}>
            Importing this mapping will remove {summary.delete_count} existing categor{summary.delete_count === 1 ? 'y' : 'ies'} from the live category list.
          </div>
        </div>
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
        <div style={{ padding: '14px 20px', borderTop: '1px solid var(--border)', background: 'var(--surface2)', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button onClick={onCancel} style={{ background: 'transparent', color: 'var(--muted)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 14px', fontSize: 13, cursor: 'pointer' }}>
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={!canConfirm || saving}
            style={{
              background: canConfirm && !saving ? 'color-mix(in srgb, var(--accent) 88%, #ffffff 12%)' : 'var(--surface)',
              color: canConfirm && !saving ? '#fff' : 'var(--muted)',
              border: canConfirm && !saving ? 'none' : '1px solid var(--border)',
              borderRadius: 8,
              padding: '8px 16px',
              fontSize: 13,
              fontWeight: 500,
              cursor: !canConfirm || saving ? 'not-allowed' : 'pointer',
              opacity: !canConfirm || saving ? 0.6 : 1,
            }}
          >
            {saving ? 'Applying…' : 'Apply changes'}
          </button>
        </div>
      </div>
    </div>
  )
}

function SectionTitle({ children }) {
  return <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 6, marginTop: 28 }}>{children}</div>
}

function deriveImportSourceHints(previewLike) {
  const filename = previewLike?.filename || ''
  const filenamePattern = filename.replace(/[_\-\d.]+\.(csv)$/i, '').trim().toLowerCase()
  return {
    headerFingerprint: previewLike?.header_fingerprint || '',
    filenamePattern,
  }
}

function getImportDraftStorageKey(instanceId, subjectId) {
  return instanceId && subjectId ? `fintrack.importDraft.v2.${instanceId}.${subjectId}` : null
}

function loadSavedImportDraft(previewLike, instanceId, subjectId) {
  const storageKey = getImportDraftStorageKey(instanceId, subjectId)
  if (!storageKey) return null
  try {
    const raw = window.localStorage.getItem(storageKey)
    if (!raw) return null
    const saved = JSON.parse(raw)
    const { headerFingerprint } = deriveImportSourceHints(previewLike)
    if (!saved?.snapshot) return null
    if (saved.headerFingerprint && headerFingerprint && saved.headerFingerprint !== headerFingerprint) return null
    return saved.snapshot
  } catch {
    return null
  }
}

function saveImportDraft(previewLike, snapshot, instanceId, subjectId) {
  const storageKey = getImportDraftStorageKey(instanceId, subjectId)
  if (!storageKey) return
  try {
    const { headerFingerprint, filenamePattern } = deriveImportSourceHints(previewLike)
    window.localStorage.setItem(storageKey, JSON.stringify({
      headerFingerprint,
      filenamePattern,
      snapshot,
    }))
  } catch {}
}

function clearSavedImportDraft(instanceId, subjectId) {
  const storageKey = getImportDraftStorageKey(instanceId, subjectId)
  if (!storageKey) return
  try {
    window.localStorage.removeItem(storageKey)
  } catch {}
}

function clonePersistedCategoryWorkspaceDraft(draft) {
  if (!draft?.snapshot) return null
  return {
    snapshot: cloneImportCategoryMappingSnapshot(draft.snapshot),
    undoStack: (draft.undoStack || []).map(cloneImportCategoryMappingSnapshot),
    redoStack: (draft.redoStack || []).map(cloneImportCategoryMappingSnapshot),
    selectionAnchor: draft.selectionAnchor || null,
    selectedBucketCategoryIds: [...(draft.selectedBucketCategoryIds || [])],
    bucketSelectionAnchor: draft.bucketSelectionAnchor || null,
    activeSection: draft.activeSection === 'income' ? 'income' : 'expense',
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

function SelectInput({ value, onChange, options, style }) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef(null)
  const listRef = useRef(null)
  const [openUp, setOpenUp] = useState(false)
  const selectedOption = options.find(o => o.value === value) || options[0] || null

  useEffect(() => {
    if (!open) return
    function handler(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  useEffect(() => {
    if (!open || !listRef.current || !wrapRef.current) return
    const wrapRect = wrapRef.current.getBoundingClientRect()
    const listHeight = listRef.current.offsetHeight
    setOpenUp(wrapRect.bottom + listHeight > window.innerHeight - 8)
  }, [open, options.length])

  return (
    <div ref={wrapRef} style={{ position: 'relative', ...style }}>
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          background: 'var(--surface2)',
          color: 'var(--text)',
          border: '1px solid var(--border)',
          borderRadius: 6,
          padding: '6px 10px',
          fontSize: 13,
          cursor: 'pointer',
          textAlign: 'left',
        }}
      >
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {selectedOption?.label || ''}
        </span>
        <span style={{ fontSize: 10, color: 'var(--muted)', flexShrink: 0 }}>▾</span>
      </button>

      {open && (
        <div
          ref={listRef}
          role="listbox"
          style={{
            position: 'absolute',
            zIndex: 600,
            left: 0,
            right: 0,
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            boxShadow: '0 4px 16px rgba(0,0,0,0.25)',
            maxHeight: 320,
            overflowY: 'auto',
            ...(openUp ? { bottom: 'calc(100% + 4px)' } : { top: 'calc(100% + 4px)' }),
          }}
        >
          {options.map(o => {
            const active = o.value === value
            return (
              <button
                key={o.value}
                type="button"
                role="option"
                aria-selected={active}
                onMouseDown={e => {
                  e.preventDefault()
                  onChange(o.value)
                  setOpen(false)
                }}
                style={{
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '8px 12px',
                  border: 'none',
                  background: active
                    ? 'color-mix(in srgb, var(--accent2) 14%, var(--surface2))'
                    : 'transparent',
                  color: 'var(--text)',
                  cursor: 'pointer',
                  fontSize: 13,
                  textAlign: 'left',
                }}
              >
                <span style={{ flex: 1 }}>{o.label}</span>
                {active && <span style={{ fontSize: 11, color: 'var(--accent2)' }}>✓</span>}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

function normalizeImportHeaderName(header) {
  return String(header || '').trim().toLowerCase()
}

function parseIntegerWithinRange(value, min, max) {
  if (!/^\d{1,4}$/.test(value)) return null
  const parsed = Number(value)
  return parsed >= min && parsed <= max ? parsed : null
}

function getDateCandidatesFromSample(value) {
  const sample = String(value || '').trim()
  if (!sample) return []

  let match = sample.match(/^(\d{4})([/-])(\d{1,2})\2(\d{1,2})$/)
  if (match) {
    const month = parseIntegerWithinRange(match[3], 1, 12)
    const day = parseIntegerWithinRange(match[4], 1, 31)
    if (month && day) {
      return [match[2] === '-' ? '%Y-%m-%d' : '%Y/%m/%d']
    }
  }

  match = sample.match(/^(\d{1,2})([/-])(\d{1,2})\2(\d{4})$/)
  if (match) {
    const first = parseIntegerWithinRange(match[1], 1, 31)
    const second = parseIntegerWithinRange(match[3], 1, 31)
    const sep = match[2]
    if (!first || !second) return []
    const monthFirstFormat = sep === '-' ? '%m-%d-%Y' : '%m/%d/%Y'
    const dayFirstFormat = sep === '-' ? '%d-%m-%Y' : '%d/%m/%Y'
    if (first > 12 && second <= 12) return [dayFirstFormat]
    if (second > 12 && first <= 12) return [monthFirstFormat]
    const candidates = []
    if (first <= 12) candidates.push(monthFirstFormat)
    if (second <= 12) candidates.push(dayFirstFormat)
    return candidates
  }

  if (/^[A-Za-z]{3}\s+\d{1,2},\s*\d{4}$/.test(sample)) return ['%b %d, %Y']
  if (/^[A-Za-z]{3}-\d{1,2}-\d{4}$/.test(sample)) return ['%b-%d-%Y']
  return []
}

function analyzeDateSamples(values) {
  const scores = new Map()
  let matchedCount = 0
  let decisiveCount = 0

  values.forEach(value => {
    const candidates = getDateCandidatesFromSample(value)
    if (!candidates.length) return
    matchedCount += 1
    if (candidates.length === 1) decisiveCount += 1
    candidates.forEach(candidate => scores.set(candidate, (scores.get(candidate) || 0) + 1))
  })

  const rankedFormats = [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([format]) => format)

  return {
    matchedCount,
    decisiveCount,
    rankedFormats,
    guessedFormat: rankedFormats[0] || null,
  }
}

function looksLikeAmountSample(value) {
  const sample = String(value || '').trim()
  if (!sample) return false
  const compact = sample.replace(/\s+/g, '')
  return /^(\(\$?\d[\d,]*(\.\d+)?\)|[+-]?\$?\d[\d,]*(\.\d+)?(?:CR|DR)?)$/i.test(compact)
}

function analyzeAmountSamples(values) {
  const styles = {
    accounting: 0,
    currency: 0,
    trailingCode: 0,
    signed: 0,
    plain: 0,
  }

  values.forEach(value => {
    const sample = String(value || '').trim()
    if (!looksLikeAmountSample(sample)) return
    if (/^\(\$?\d[\d,]*(\.\d+)?\)$/i.test(sample)) styles.accounting += 1
    else if (/(CR|DR)$/i.test(sample)) styles.trailingCode += 1
    else if (/^[+-]/.test(sample)) styles.signed += 1
    else if (sample.includes('$')) styles.currency += 1
    else styles.plain += 1
  })

  const ranked = Object.entries(styles).sort((a, b) => b[1] - a[1])
  const [topStyle, topCount] = ranked[0] || [null, 0]
  const labels = {
    accounting: 'Detected accounting-style negatives.',
    currency: 'Detected currency amounts.',
    trailingCode: 'Detected trailing CR/DR amounts.',
    signed: 'Detected signed amounts.',
    plain: 'Detected plain numeric amounts.',
  }

  return {
    guessedStyle: topCount > 0 ? topStyle : null,
    guessedLabel: topCount > 0 ? labels[topStyle] : null,
  }
}

function looksLikeDirectionSample(value) {
  const normalized = String(value || '').trim().toLowerCase()
  return ['credit', 'debit', 'cr', 'dr', 'deposit', 'withdrawal', 'payment', 'incoming', 'outgoing'].includes(normalized)
}

function looksLikePendingSample(value) {
  const normalized = String(value || '').trim().toLowerCase()
  return ['pending', 'posted', 'cleared', 'complete', 'completed', 'final', 'finalized', 'finalised', 'true', 'false', 'yes', 'no', 'y', 'n', '1', '0', 'p'].includes(normalized)
}

function scoreHeaderName(header, type) {
  const normalized = normalizeImportHeaderName(header)
  if (!normalized) return 0

  const tests = {
    date: ['date', 'posted', 'trans date', 'transaction date', 'post date'],
    amount: ['amount', 'amt', 'value'],
    category: ['category', 'cat', 'classification', 'type'],
    debit: ['debit', 'withdrawal', 'outflow', 'payment', 'charge'],
    credit: ['credit', 'deposit', 'inflow', 'refund'],
    direction: ['type', 'direction', 'dr/cr', 'transaction type'],
    pending: ['pending', 'status', 'posted', 'cleared'],
  }

  return (tests[type] || []).reduce((score, token) => score + (normalized.includes(token) ? 1 : 0), 0)
}

function formatLikelyMatchLabel(count) {
  if (!count) return ''
  return `${count} likely ${count === 1 ? 'match' : 'matches'}`
}

function ColSelect({
  label,
  headers,
  allHeaders = headers,
  value,
  onChange,
  required,
  hint,
  tone = 'muted',
}) {
  const borderColor = required && !value ? 'var(--danger)' : 'var(--border)'
  const hintColor = tone === 'danger' ? 'var(--danger)' : 'var(--muted)'
  const [open, setOpen] = useState(false)
  const wrapRef = useRef(null)
  const listRef = useRef(null)
  const [openUp, setOpenUp] = useState(false)

  useEffect(() => {
    if (!open) return
    function handler(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  useEffect(() => {
    if (!open || !listRef.current || !wrapRef.current) return
    const wrapRect = wrapRef.current.getBoundingClientRect()
    const listHeight = listRef.current.offsetHeight
    setOpenUp(wrapRect.bottom + listHeight > window.innerHeight - 8)
  }, [open, headers.length, allHeaders.length])

  const hasDetectedSuggestions = headers.length > 0 && headers.length < allHeaders.length
  const suggestedHeaders = headers
  const remainingHeaders = allHeaders.filter(h => !suggestedHeaders.includes(h))
  const showSuggestedSection = hasDetectedSuggestions && suggestedHeaders.length > 0
  const directHeaders = showSuggestedSection ? remainingHeaders : suggestedHeaders
  const selectedLabel = value
    ? value
    : <span style={{ color: 'var(--muted)' }}>Not mapped</span>

  const triggerStyle = {
    width: '100%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    background: 'var(--surface2)',
    color: 'var(--text)',
    border: `1px solid ${borderColor}`,
    borderRadius: 6,
    padding: '6px 8px',
    fontSize: 13,
    cursor: 'pointer',
    textAlign: 'left',
  }

  const listStyle = {
    position: 'absolute',
    zIndex: 600,
    left: 0,
    right: 0,
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 8,
    boxShadow: '0 4px 16px rgba(0,0,0,0.25)',
    maxHeight: 320,
    overflowY: 'auto',
    ...(openUp ? { bottom: 'calc(100% + 4px)' } : { top: 'calc(100% + 4px)' }),
  }

  const menuItemStyle = (active, subtle = false) => ({
    width: '100%',
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: subtle ? '7px 12px' : '8px 12px',
    border: 'none',
    background: active
      ? 'color-mix(in srgb, var(--accent2) 14%, var(--surface2))'
      : subtle
        ? 'color-mix(in srgb, var(--surface2) 75%, transparent)'
        : 'transparent',
    color: subtle ? 'var(--muted)' : 'var(--text)',
    cursor: 'pointer',
    fontSize: 13,
    textAlign: 'left',
  })

  const suggestedPillStyle = {
    flexShrink: 0,
    fontSize: 10,
    fontWeight: 700,
    color: 'var(--accent2)',
    background: 'color-mix(in srgb, var(--accent2) 10%, var(--surface2))',
    border: '1px solid color-mix(in srgb, var(--accent2) 35%, var(--border))',
    borderRadius: 999,
    padding: '2px 7px',
    letterSpacing: '0.02em',
    lineHeight: 1.1,
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)' }}>
        {label}{required && <span style={{ color: 'var(--danger)' }}> *</span>}
      </label>
      <div ref={wrapRef} style={{ position: 'relative' }}>
        <button
          type="button"
          onClick={() => setOpen(v => !v)}
          aria-haspopup="listbox"
          aria-expanded={open}
          style={triggerStyle}
        >
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {selectedLabel}
          </span>
          {!value && hint ? (
            <span style={{
              flexShrink: 0,
              fontSize: 11,
              color: hintColor,
              background: 'color-mix(in srgb, var(--surface) 60%, transparent)',
              border: '1px solid var(--border)',
              borderRadius: 999,
              padding: '2px 7px',
            }}>
              {hint}
            </span>
          ) : null}
          <span style={{ fontSize: 10, color: 'var(--muted)', flexShrink: 0 }}>▾</span>
        </button>

        {open && (
          <div ref={listRef} style={listStyle} role="listbox" aria-label={`${label} column options`}>
            <button
              type="button"
              role="option"
              aria-selected={!value}
              style={menuItemStyle(!value)}
              onMouseDown={e => {
                e.preventDefault()
                onChange(null)
                setOpen(false)
              }}
            >
              <span style={{ flex: 1, color: 'var(--muted)' }}>Not mapped</span>
              {!value && <span style={{ fontSize: 11, color: 'var(--accent2)' }}>✓</span>}
            </button>

            {showSuggestedSection && (
              <>
                {suggestedHeaders.map(h => (
                  <button
                    key={h}
                    type="button"
                    role="option"
                    aria-selected={value === h}
                    style={menuItemStyle(value === h)}
                    onMouseDown={e => {
                      e.preventDefault()
                      onChange(h)
                      setOpen(false)
                    }}
                  >
                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {h}
                    </span>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, flexShrink: 0, minWidth: 98 }}>
                      <span style={suggestedPillStyle}>Suggested</span>
                      <span style={{ width: 12, textAlign: 'center', fontSize: 11, color: 'var(--accent2)', visibility: value === h ? 'visible' : 'hidden' }}>✓</span>
                    </div>
                  </button>
                ))}
              </>
            )}

            {directHeaders.length > 0 && (
              <>
                {showSuggestedSection ? (
                  <div
                    style={{
                      height: 1,
                      background: 'var(--border)',
                      margin: '3px 0',
                    }}
                  />
                ) : null}
                {directHeaders.map(h => (
                  <button
                    key={h}
                    type="button"
                    role="option"
                    aria-selected={value === h}
                    style={menuItemStyle(value === h)}
                    onMouseDown={e => {
                      e.preventDefault()
                      onChange(h)
                      setOpen(false)
                    }}
                  >
                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {h}
                    </span>
                    {value === h && <span style={{ fontSize: 11, color: 'var(--accent2)' }}>✓</span>}
                  </button>
                ))}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Raw file preview — draggable floating panel ──────────────────────────────
// Opens fixed-position so the mapping form below stays usable.
// Drag the header bar to reposition. Shows header + 4 data rows prominently,
// rest dimmed. Scrollable if you need to see more.

// ── Raw file preview — draggable + resizable floating panel ──────────────────

function RawFilePreview({ rawLines, headerRowIndex, onClose, lineNumberOffset = 0, title = 'Raw file', note = null }) {
  const [pos,  setPos]  = useState({ x: Math.max(0, window.innerWidth - 560), y: 80 })
  const [size, setSize] = useState({ w: 520, h: 320 })
  const [dragState, setDragState] = useState(null) // null | 'move' | 'resize'
  const startRef = useRef({})

  useEffect(() => {
    if (!dragState) return
    function onMove(e) {
      const dx = e.clientX - startRef.current.mx
      const dy = e.clientY - startRef.current.my
      if (dragState === 'move') {
        setPos({
          x: Math.max(0, Math.min(window.innerWidth  - 200, startRef.current.x + dx)),
          y: Math.max(0, Math.min(window.innerHeight - 60,  startRef.current.y + dy)),
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
    window.addEventListener('mouseup',  onUp)
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
      {/* Drag handle / title bar */}
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

      {/* Scrollable content */}
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
          const isData   = actualLineIndex > headerRowIndex && actualLineIndex <= headerRowIndex + 4
          const dimmed   = !isHeader && !isData && actualLineIndex > headerRowIndex
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

      {/* Resize handle — bottom-right corner */}
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

// ── AccountHandlingPicker ─────────────────────────────────────────────────────
// Custom dropdown that shows different text when closed vs open:
//   Closed (column mode):  "↔ Column  AccountName"
//   Closed (account mode): "AccountName ···mask"
//   Open list:             plain "AccountName" and plain "HeaderName" (no prefix)

function AccountHandlingPicker({ headers, accounts, colAccount, accountId, singleAccountNew, isRequired, onChange }) {
  const [open, setOpen]   = useState(false)
  const wrapRef           = useRef(null)
  const listRef           = useRef(null)
  const [openUp, setOpenUp] = useState(false)

  // Close on outside click
  useEffect(() => {
    if (!open) return
    function handler(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  // Flip upward if list would overflow viewport bottom
  useEffect(() => {
    if (!open || !listRef.current || !wrapRef.current) return
    const wrect = wrapRef.current.getBoundingClientRect()
    const lh    = listRef.current.offsetHeight
    setOpenUp(wrect.bottom + lh > window.innerHeight - 8)
  }, [open])

  // Compute the closed display label
  const selectedAccount = accounts.find(a => a.id === accountId)
  let closedLabel = <span style={{ color: 'var(--muted)' }}>— Select account or column —</span>
  if (colAccount) {
    closedLabel = (
      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: 11, color: 'var(--accent2)', fontWeight: 600, letterSpacing: '0.03em' }}>↔ Column</span>
        <span>{colAccount}</span>
      </span>
    )
  } else if (selectedAccount) {
    closedLabel = (
      <span>{selectedAccount.name}{selectedAccount.mask ? ` ···${selectedAccount.mask}` : ''}</span>
    )
  } else if (singleAccountNew?.enabled) {
    closedLabel = (
      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: 11, color: 'var(--accent2)', fontWeight: 600, letterSpacing: '0.03em' }}>＋ New</span>
        <span>{singleAccountNew.name?.trim() || 'Create new account'}</span>
      </span>
    )
  }

  const triggerStyle = {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    background: 'var(--surface2)', color: 'var(--text)',
    border: `1px solid ${isRequired ? 'var(--danger)' : 'var(--border)'}`,
    borderRadius: 6, padding: '6px 8px', fontSize: 13,
    cursor: 'pointer', userSelect: 'none', gap: 6,
  }

  const groupLabel = {
    padding: '5px 10px 2px', fontSize: 10, fontWeight: 700,
    color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.08em',
    borderTop: '1px solid var(--border)',
  }

  const itemStyle = (active) => ({
    padding: '4px 12px', fontSize: 13, cursor: 'pointer',
    background: active ? 'var(--surface2)' : 'transparent',
    display: 'flex', alignItems: 'center', gap: 8,
  })

  const listStyle = {
    position: 'absolute', zIndex: 600,
    left: 0, right: 0,
    background: 'var(--surface)', border: '1px solid var(--border)',
    borderRadius: 8, boxShadow: '0 4px 16px rgba(0,0,0,0.25)',
    maxHeight: 320, overflowY: 'auto',
    ...(openUp
      ? { bottom: 'calc(100% + 4px)' }
      : { top:    'calc(100% + 4px)' }
    ),
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        Account handling <span style={{ color: 'var(--danger)' }}>*</span>
      </label>
      <div ref={wrapRef} style={{ position: 'relative' }}>
        <div style={triggerStyle} onClick={() => setOpen(v => !v)}>
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {closedLabel}
          </span>
          <span style={{ fontSize: 10, color: 'var(--muted)', flexShrink: 0 }}>▾</span>
        </div>

        {open && (
          <div ref={listRef} style={listStyle}>
            {/* Clear option */}
            <div
              style={itemStyle(!colAccount && !accountId && !singleAccountNew?.enabled)}
              onMouseDown={e => { e.preventDefault(); onChange({ acct: '', createNew: false }); setOpen(false) }}
            >
              <span style={{ color: 'var(--muted)' }}>— Select account or column —</span>
            </div>

            {/* Column options */}
            {headers.length > 0 && (
              <>
                <div style={groupLabel}>Map rows from a column in the file</div>
                {headers.map(h => (
                  <div
                    key={h}
                    style={itemStyle(colAccount === h)}
                    onMouseDown={e => { e.preventDefault(); onChange({ col: h, createNew: false }); setOpen(false) }}
                  >
                    <span style={{ fontSize: 11, color: 'var(--accent2)', fontWeight: 600, flexShrink: 0 }}>↔</span>
                    <span>{h}</span>
                    {colAccount === h && <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--accent2)' }}>✓</span>}
                  </div>
                ))}
              </>
            )}

            {/* Account options */}
            <>
              <div style={{ ...groupLabel, borderTop: '1px solid var(--border)' }}>Assign all rows to one account</div>
              {accounts.map(a => (
                <div
                  key={a.id}
                  style={itemStyle(accountId === a.id)}
                  onMouseDown={e => { e.preventDefault(); onChange({ acct: a.id, createNew: false }); setOpen(false) }}
                >
                  <span style={{ flex: 1 }}>{a.name}{a.mask ? ` ···${a.mask}` : ''}</span>
                  {accountId === a.id && <span style={{ fontSize: 11, color: 'var(--accent2)' }}>✓</span>}
                </div>
              ))}
              <div
                style={itemStyle(!!singleAccountNew?.enabled)}
                onMouseDown={e => { e.preventDefault(); onChange({ acct: '', createNew: true }); setOpen(false) }}
              >
                <span style={{ fontSize: 11, color: 'var(--accent2)', fontWeight: 600, flexShrink: 0 }}>＋</span>
                <span style={{ flex: 1 }}>Create new account…</span>
                {singleAccountNew?.enabled && <span style={{ fontSize: 11, color: 'var(--accent2)' }}>✓</span>}
              </div>
            </>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Error boundary — catches render crashes so the whole page doesn't go black ─

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
  const [dbInstanceId, setDbInstanceId] = useState('')
  const [preferenceSubjectId, setPreferenceSubjectId] = useState('')
  const [stage, setStage]           = useState('upload')
  const [preview, setPreview]       = useState(null)
  const [profiles, setProfiles]     = useState([])
  const [accounts, setAccounts]     = useState([])
  const [categories, setCategories] = useState([])
  const [loading, setLoading]       = useState(false)
  const [batches, setBatches]       = useState([])
  const [undoTarget, setUndoTarget] = useState(null)
  const [undoEdited, setUndoEdited] = useState([])
  const [undoLoading, setUndoLoading] = useState(false)
  const dropRef = useRef(null)

  const [selectedProfile, setSelectedProfile] = useState('')
  const [accountId,  setAccountId]  = useState('')
  const [dateFormat, setDateFormat] = useState('%m/%d/%Y')
  const [amtConv,    setAmtConv]    = useState('single_signed')
  const [skipRows,   setSkipRows]   = useState(0)
  const [applyCat,   setApplyCat]   = useState(true)
  const [colDate,    setColDate]    = useState(null)
  const [colAmount,  setColAmount]  = useState(null)
  const [colDebit,   setColDebit]   = useState(null)
  const [colCredit,  setColCredit]  = useState(null)
  const [colDir,     setColDir]     = useState(null)
  const [colDesc,    setColDesc]    = useState(null)
  const [colCategory,setColCategory]= useState(null)
  const [colNotes,   setColNotes]   = useState(null)
  const [colPending, setColPending] = useState(null)
  const [colAccount, setColAccount] = useState(null)
  const [singleAccountNew, setSingleAccountNew] = useState({ enabled: false, name: '', type: 'depository' })
  const [accountMap, setAccountMap] = useState({})
  const [categoryAssignments, setCategoryAssignments] = useState({})
  const [categoryMappingRows, setCategoryMappingRows] = useState([])
  const [categoryMappingSummary, setCategoryMappingSummary] = useState(null)
  const [showCategoryWorkspace, setShowCategoryWorkspace] = useState(false)
  const [importCategoryDraft, setImportCategoryDraft] = useState(null)
  const [pendingCategoryApply, setPendingCategoryApply] = useState(null)
  const [pendingCategoryReplacementId, setPendingCategoryReplacementId] = useState('')
  const [importResult,      setImportResult]      = useState(null)
  const [dupAccountWarning, setDupAccountWarning] = useState([])
  const [showRaw,           setShowRaw]           = useState(false)
  const [showAdvanced,      setShowAdvanced]      = useState(false)
  const [showSaveProfile,   setShowSaveProfile]   = useState(false)
  const [saveProfileName,   setSaveProfileName]   = useState('')
  const [prevBatchWarn,     setPrevBatchWarn]     = useState(false)
  const [dateFormatLocked,  setDateFormatLocked]  = useState(false)

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
    })
  }, [])

  const distinctAccountValues = useMemo(() => {
    if (!colAccount || !preview?.column_distinct_values) return []
    return preview.column_distinct_values[colAccount] || []
  }, [colAccount, preview])

  const duplicateImportSummary = useMemo(() => {
    if (!dupAccountWarning.length) {
      return {
        imported: [],
        remaining: [],
        allImported: false,
      }
    }

    const importedByCsvValue = new Map(
      dupAccountWarning
        .filter(a => a.csv_value)
        .map(a => [a.csv_value, a])
    )

    const imported = []
    const remaining = []

    if (distinctAccountValues.length > 0) {
      distinctAccountValues.forEach(value => {
        const prior = importedByCsvValue.get(value)
        if (prior) imported.push(prior)
        else remaining.push(value)
      })
    } else {
      imported.push(...dupAccountWarning)
    }

    return {
      imported,
      remaining,
      allImported: distinctAccountValues.length > 0 && remaining.length === 0,
    }
  }, [dupAccountWarning, distinctAccountValues])

  const columnSamples = useMemo(() => {
    if (!preview?.headers?.length || !preview?.rows?.length) return {}
    const rows = preview.rows.slice(skipRows)
    return preview.headers.reduce((acc, header) => {
      acc[header] = rows
        .map(row => String(row?.[header] ?? '').trim())
        .filter(Boolean)
      return acc
    }, {})
  }, [preview, skipRows])

  const columnAnalysis = useMemo(() => {
    if (!preview?.headers?.length) {
      return {
        dateCandidates: [],
        amountCandidates: [],
        categoryCandidates: [],
        debitCandidates: [],
        creditCandidates: [],
        directionCandidates: [],
        pendingCandidates: [],
        dateAnalysisByHeader: {},
        amountAnalysisByHeader: {},
      }
    }

    const analyses = {
      dateCandidates: [],
      amountCandidates: [],
      categoryCandidates: [],
      debitCandidates: [],
      creditCandidates: [],
      directionCandidates: [],
      pendingCandidates: [],
      dateAnalysisByHeader: {},
      amountAnalysisByHeader: {},
    }

    preview.headers.forEach(header => {
      const samples = columnSamples[header] || []
      const sampleCount = samples.length
      const headerBoostDate = scoreHeaderName(header, 'date')
      const dateAnalysis = analyzeDateSamples(samples)
      const dateScore = dateAnalysis.matchedCount + dateAnalysis.decisiveCount + (headerBoostDate * 2)
      analyses.dateAnalysisByHeader[header] = { ...dateAnalysis, sampleCount, score: dateScore }
      if ((sampleCount > 0 && dateAnalysis.matchedCount >= Math.max(2, Math.ceil(sampleCount * 0.6))) || headerBoostDate > 0) {
        analyses.dateCandidates.push({ header, score: dateScore })
      }

      const amountMatches = samples.filter(looksLikeAmountSample).length
      const amountRatio = sampleCount ? amountMatches / sampleCount : 0
      const amountBoost = scoreHeaderName(header, 'amount')
      const amountScore = amountMatches + (amountBoost * 2)
      const amountFormat = analyzeAmountSamples(samples)
      analyses.amountAnalysisByHeader[header] = { sampleCount, amountMatches, amountRatio, score: amountScore, ...amountFormat }
      if ((sampleCount > 0 && amountRatio >= 0.7) || amountBoost > 0) {
        analyses.amountCandidates.push({ header, score: amountScore })
      }

      const categoryBoost = scoreHeaderName(header, 'category')
      if (categoryBoost > 0) {
        analyses.categoryCandidates.push({ header, score: categoryBoost })
      }

      const debitBoost = scoreHeaderName(header, 'debit')
      const debitScore = amountMatches + (debitBoost * 3)
      if ((sampleCount > 0 && amountRatio >= 0.7 && debitBoost > 0) || debitBoost > 0) {
        analyses.debitCandidates.push({ header, score: debitScore })
      }

      const creditBoost = scoreHeaderName(header, 'credit')
      const creditScore = amountMatches + (creditBoost * 3)
      if ((sampleCount > 0 && amountRatio >= 0.7 && creditBoost > 0) || creditBoost > 0) {
        analyses.creditCandidates.push({ header, score: creditScore })
      }

      const directionMatches = samples.filter(looksLikeDirectionSample).length
      const directionRatio = sampleCount ? directionMatches / sampleCount : 0
      const directionBoost = scoreHeaderName(header, 'direction')
      const directionScore = directionMatches + (directionBoost * 2)
      if ((sampleCount > 0 && directionRatio >= 0.6) || directionBoost > 0) {
        analyses.directionCandidates.push({ header, score: directionScore })
      }

      const pendingMatches = samples.filter(looksLikePendingSample).length
      const pendingRatio = sampleCount ? pendingMatches / sampleCount : 0
      const pendingBoost = scoreHeaderName(header, 'pending')
      const pendingScore = pendingMatches + (pendingBoost * 2)
      if ((sampleCount > 0 && pendingRatio >= 0.6) || pendingBoost > 0) {
        analyses.pendingCandidates.push({ header, score: pendingScore })
      }
    })

    for (const key of ['dateCandidates', 'amountCandidates', 'categoryCandidates', 'debitCandidates', 'creditCandidates', 'directionCandidates', 'pendingCandidates']) {
      analyses[key].sort((a, b) => b.score - a.score || a.header.localeCompare(b.header))
      analyses[key] = analyses[key].map(entry => entry.header)
    }

    return analyses
  }, [columnSamples, preview])

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
  const preparedCategoryCount = useMemo(
    () => sourceCategoryValues.filter(value => !!categoryAssignments[value]).length,
    [categoryAssignments, sourceCategoryValues],
  )
  const activeDraftCategoryCount = importCategoryDraft?.snapshot?.sourceOrder?.length
  const processedCategoryCount = importCategoryDraft
    ? Math.max(0, sourceCategoryValues.length - (activeDraftCategoryCount || 0))
    : preparedCategoryCount
  const remainingCategoryCount = importCategoryDraft
    ? Math.max(0, activeDraftCategoryCount || 0)
    : Math.max(0, sourceCategoryValues.length - preparedCategoryCount)
  const pendingDeleteReplacementCategories = useMemo(() => {
    if (!pendingCategoryApply?.draft) return categories
    const deleteIds = new Set(getDraftDeleteTargets(pendingCategoryApply.draft))
    return categories.filter(cat => cat.parent_id && !deleteIds.has(cat.id))
  }, [categories, pendingCategoryApply])

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

  function handleDateColumnChange(nextValue) {
    setDateFormatLocked(false)
    setColDate(nextValue)
  }

  function handleCategoryColumnChange(nextValue) {
    setShowCategoryWorkspace(false)
    setImportCategoryDraft(null)
    setColCategory(nextValue)
  }
  useEffect(() => {
    setAccountMap(prev => {
      const next = { ...prev }
      for (const val of distinctAccountValues) {
        if (!(val in next)) {
          // Check if an existing account name matches this CSV value (case-insensitive)
          const match = accounts.find(a => a.name.toLowerCase() === val.toLowerCase())
          next[val] = {
            accountId:  match ? match.id : '',
            createNew:  false,
            newName:    val,
            newType:    'depository',
            skip:       false,
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
    saveImportDraft(preview, buildImportSnapshot(), dbInstanceId, preferenceSubjectId)
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
          const dRaw = String(row[colDebit]  ?? '').replace(/[,$\s]/g, '').replace(/[()]/g, '-')
          const cRaw = String(row[colCredit] ?? '').replace(/[,$\s]/g, '').replace(/[()]/g, '-')
          const d = parseFloat(dRaw), c = parseFloat(cRaw)
          if (!isNaN(d) && d !== 0) amount = d
          else if (!isNaN(c) && c !== 0) amount = -c
        } else if (colAmount) {
          const cell = row[colAmount]
          rawAmountStr = String(cell ?? '')
          // Handle formats: $1,234.56 / (1234.56) / -1234.56 / 1234.56 CR
          const cleaned = rawAmountStr
            .replace(/[$,\s]/g, '')
            .replace(/\(([0-9.]+)\)/, '-$1')  // (50.00) → -50.00
            .replace(/\s*CR$/i, '')            // trailing CR = credit (positive stored as negative)
          const val = parseFloat(cleaned)
          if (!isNaN(val)) amount = -val
        }
      } catch (_) {}
      return {
        i,
        rawDate:  colDate    ? String(row[colDate]    ?? '').trim() : null,
        rawDesc:  colDesc    ? String(row[colDesc]    ?? '').trim() : null,
        rawCat:   colCategory ? String(row[colCategory] ?? '').trim() : null,
        rawAcct:  colAccount ? String(row[colAccount] ?? '').trim() : null,
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
    if (Object.keys(categoryAssignments).length > 0) cm.category_assignments = categoryAssignments
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

  function resetToManualImportMapping() {
    setSelectedProfile('')
    setShowCategoryWorkspace(false)
    applySnapshot({
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
    })
    setDateFormatLocked(false)
  }

  function resetImportMappingState() {
    setSelectedProfile('')
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
    setAccountMap({})
    setCategoryAssignments({})
    setCategoryMappingRows([])
    setCategoryMappingSummary(null)
    setImportCategoryDraft(null)
    setShowCategoryWorkspace(false)
    setSingleAccountNew({ enabled: false, name: '', type: 'depository' })
  }

  function applyProfile(profileId, options = {}) {
    const { bypassMismatchWarning = false } = options
    const p = profiles.find(x => x.id === profileId)
    if (!p) {
      if (!profileId) resetToManualImportMapping()
      else setSelectedProfile(profileId)
      return
    }
    if (!bypassMismatchWarning && profileHeaderClearlyMismatches(p, preview)) {
      const proceed = window.confirm(
        `This import profile was saved for a different CSV header and may not match this file.\n\nUse "${p.name}" anyway?`
      )
      if (!proceed) return
    }
    setSelectedProfile(profileId)
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
    setCategoryAssignments(cm.category_assignments || {})
    setImportCategoryDraft(clonePersistedCategoryWorkspaceDraft(cm.category_workspace_draft))
    setSingleAccountNew(cm.single_account_new && !existingSingleAccount
      ? { enabled: true, name: cm.single_account_new.name || '', type: cm.single_account_new.type || 'depository' }
      : { enabled: false, name: '', type: 'depository' })
    const newColAccount = cm.account || null
    setAccountMap({})  // always reset before restoring
    setColAccount(newColAccount)

    // Restore saved per-account assignments if present.
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
          // Account was deleted — try to match by the CSV value as a name fallback
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
  }

  async function handleFile(file) {
    if (!file) return
    setLoading(true)
    try {
      resetImportMappingState()
      const result = await api.previewCsv(file)
      setPreview({ ...result, file }); setDupAccountWarning([]); setAccountMap({})
      setSingleAccountNew({ enabled: false, name: '', type: 'depository' })
      setCategoryAssignments({})
      setCategoryMappingRows([])
      setCategoryMappingSummary(null)
      const savedDraft = loadSavedImportDraft(result, dbInstanceId, preferenceSubjectId)
      if (result.suggested_profile_id) {
        applyProfile(result.suggested_profile_id)
      } else if (savedDraft) {
        setSelectedProfile('')
        applySnapshot(savedDraft)
      } else if (result.config_snapshot) {
        applySnapshot({
          ...result.config_snapshot,
          skip_accounts: [],
        })
      }
      const prevImported = (result.previous_batch_accounts || []).filter(a => !a.was_skipped)
      if (prevImported.length > 0) setDupAccountWarning(prevImported)
      // If header wasn't on the first line, open advanced + raw file so user can see why
      if ((result.header_row_index ?? 0) > 0) {
        setShowAdvanced(true)
        setShowRaw(true)
      }
      setStage('mapping')
    } catch (e) {
      const msg = e?.message || e?.detail || 'Unable to parse CSV file.'
      alert('Failed to parse CSV: ' + msg)
    } finally { setLoading(false) }
  }

  function handleDrop(e) { e.preventDefault(); handleFile(e.dataTransfer.files[0]) }

  function getColumnMap() {
    return { date: colDate, amount: colAmount, debit: colDebit, credit: colCredit,
             direction: colDir, description: colDesc, category: colCategory, notes: colNotes, pending: colPending, account: colAccount }
  }

  function canImport() {
    if (!colDate || !colDesc) return false
    if (amtConv === 'two_column' && !(colDebit && colCredit)) return false
    if (amtConv !== 'two_column' && !colAmount) return false
    if (colAccount) {
      return distinctAccountValues.every(v => {
        const m = accountMap[v]; if (!m) return false; if (m.skip) return true
        if (m.createNew) {
          const name = m.newName.trim()
          if (!name) return false
          // Block if name already exists — user should select the existing account instead
          if (accounts.some(a => a.name.toLowerCase() === name.toLowerCase())) return false
          return true
        }
        return !!m.accountId
      })
    }
    if (singleAccountNew.enabled) {
      const name = singleAccountNew.name.trim()
      if (!name) return false
      if (accounts.some(a => a.name.toLowerCase() === name.toLowerCase())) return false
      return true
    }
    return !!accountId
  }

  function getImportDisabledReason() {
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
      for (const value of distinctAccountValues) {
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
      const columnMap = getColumnMap()
      if (Object.keys(categoryAssignments).length > 0) columnMap.category_assignments = categoryAssignments
      const result = await api.runImport(preview.file, {
        profile_id:           selectedProfile || null,
        filename:             preview.filename,
        account_id:           colAccount || singleAccountNew.enabled ? null : accountId,
        single_account_new:   (!colAccount && singleAccountNew.enabled)
          ? { name: singleAccountNew.name.trim(), type: singleAccountNew.type || 'depository' }
          : null,
        account_map:          finalAccountMap,
        skip_accounts:        skipAccounts,
        new_accounts:         newAccounts?.length ? newAccounts : null,
        date_format:          dateFormat,
        amount_convention:    amtConv,
        column_map:           columnMap,
        skip_rows:            skipRows,
        apply_categorization: applyCat,
      })
      setImportResult(result)
      if (result.trailing_non_transaction_suspected || result.invalid_rows_suspected) setShowRaw(true)
      refreshTaskBadge()
      const refreshedAccounts = await api.getAccounts()
      setAccounts(refreshedAccounts)
      api.listBatches().then(setBatches)
      if (selectedProfile) {
        await autoSaveProfile(refreshedAccounts).catch(() => {})
      }
      if (result.batch_id && colCategory) {
        const mappingData = await api.getBatchCategoryMappings(result.batch_id)
        if ((mappingData.values || []).length > 0 && mappingData.values.some(v => !v.saved_category_id)) {
          setCategoryMappingRows((mappingData.values || []).map(v => ({
            rawValue: v.raw_value,
            rowCount: v.row_count,
            categoryId: v.saved_category_id || v.suggested_category_id || '',
            chooserQuery: '',
            chooserToken: 0,
          })))
          setStage(result.trailing_non_transaction_suspected ? 'review-data' : 'done')
        } else {
          setStage(result.trailing_non_transaction_suspected ? 'review-data' : 'done')
        }
      } else {
        setStage(result.trailing_non_transaction_suspected ? 'review-data' : 'done')
      }
    } catch (e) { alert('Import failed: ' + e.message) }
    finally { setLoading(false) }
  }

  // Build the profile body from current mapping state — shared by saveProfile and auto-save
  function buildProfileBody(name) {
    const cm = getColumnMap()
    if (Object.keys(categoryAssignments).length > 0) cm.category_assignments = categoryAssignments
    const categoryWorkspaceDraft = clonePersistedCategoryWorkspaceDraft(importCategoryDraft)
    if (categoryWorkspaceDraft) cm.category_workspace_draft = categoryWorkspaceDraft
    if (!colAccount && singleAccountNew.enabled && singleAccountNew.name.trim()) {
      cm.single_account_new = {
        name: singleAccountNew.name.trim(),
        type: singleAccountNew.type || 'depository',
      }
    }
    if (colAccount && Object.keys(accountMap).length > 0) {
      const assignments = {}, skips = [], newAccts = {}
      for (const [csvVal, m] of Object.entries(accountMap)) {
        if (m.skip) {
          skips.push(csvVal)
        } else if (m.createNew && m.newName?.trim()) {
          newAccts[csvVal] = { name: m.newName.trim(), type: m.newType || 'depository' }
        } else if (m.accountId) {
          assignments[csvVal] = m.accountId
        }
      }
      if (Object.keys(assignments).length > 0) cm.account_assignments = assignments
      if (skips.length > 0)                    cm.account_skips       = skips
      if (Object.keys(newAccts).length > 0)    cm.account_new         = newAccts
    }
    return {
      name:                 name.trim(),
      filename_pattern:     preview.filename.replace(/[_\-\d.]+\.(csv)$/i, '').trim() || null,
      header_fingerprint:   preview.header_fingerprint || null,
      column_map:           cm,
      account_id:           (!colAccount && !singleAccountNew.enabled && accountId) ? accountId : null,
      date_format:          dateFormat,
      amount_convention:    amtConv,
      skip_rows:            skipRows,
      apply_categorization: applyCat,
    }
  }

  async function saveProfile(name) {
    const body = buildProfileBody(name)
    if (selectedProfile) {
      await api.updateImportProfile(selectedProfile, body)
      api.getImportProfiles().then(setProfiles)
    } else {
      const r = await api.createImportProfile(body)
      api.getImportProfiles().then(updated => {
        setProfiles(updated)
        setSelectedProfile(r.id)
      })
    }
    clearSavedImportDraft(dbInstanceId, preferenceSubjectId)
    setShowSaveProfile(false)
    setSaveProfileName('')
  }

  // Silently update the active profile after a successful import so account
  // mappings (including new accounts and skips) are never lost
  async function autoSaveProfile(refreshedAccounts) {
    if (!selectedProfile) return
    const p = profiles.find(x => x.id === selectedProfile)
    if (!p) return
    // Resolve any createNew entries that were just created — match by name
    // in the freshly-fetched accounts list
    const resolvedMap = {}
    for (const [csvVal, m] of Object.entries(accountMap)) {
      if (m.createNew && m.newName?.trim()) {
        const created = refreshedAccounts.find(a => a.name === m.newName.trim())
        resolvedMap[csvVal] = created
          ? { ...m, createNew: false, accountId: created.id }
          : m  // account not found yet, keep as createNew
      } else {
        resolvedMap[csvVal] = m
      }
    }
    // Temporarily update accountMap state with resolved entries
    // so buildProfileBody picks them up
    const savedMap = accountMap
    // Build body using resolved map directly
    const cm = getColumnMap()
    if (Object.keys(categoryAssignments).length > 0) cm.category_assignments = categoryAssignments
    const categoryWorkspaceDraft = clonePersistedCategoryWorkspaceDraft(importCategoryDraft)
    if (categoryWorkspaceDraft) cm.category_workspace_draft = categoryWorkspaceDraft
    if (!colAccount && singleAccountNew.enabled && singleAccountNew.name.trim()) {
      cm.single_account_new = {
        name: singleAccountNew.name.trim(),
        type: singleAccountNew.type || 'depository',
      }
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
    const existingProfileMap = p.column_map || {}
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
      name:                 p.name,
      filename_pattern:     preview.filename.replace(/[_\-\d.]+\.(csv)$/i, '').trim() || null,
      header_fingerprint:   preview.header_fingerprint || null,
      column_map:           cm,
      account_id:           (!colAccount && !singleAccountNew.enabled && accountId) ? accountId : null,
      date_format:          dateFormat,
      amount_convention:    amtConv,
      skip_rows:            skipRows,
      apply_categorization: applyCat,
    }
    await api.updateImportProfile(selectedProfile, body)
    clearSavedImportDraft(dbInstanceId, preferenceSubjectId)
    // Await the profiles refresh so state is up to date before the user
    // can cancel and re-upload — prevents stale profile being applied
    const updated = await api.getImportProfiles()
    setProfiles(updated)
  }

  function resetImport() {
    setStage('upload'); setPreview(null); setImportResult(null)
    setDupAccountWarning([]); setAccountMap({})
    setColPending(null)
    setSingleAccountNew({ enabled: false, name: '', type: 'depository' })
    setCategoryAssignments({}); setCategoryMappingRows([]); setCategoryMappingSummary(null)
    setShowCategoryWorkspace(false)
    setImportCategoryDraft(null)
    setShowRaw(false); setShowAdvanced(false); setShowSaveProfile(false)
    setSaveProfileName(''); setPrevBatchWarn(false)
  }

  async function handleUndoClick(batch) {
    setUndoTarget(batch); setUndoLoading(true)
    setUndoEdited(await api.getBatchEdited(batch.id)); setUndoLoading(false)
  }

  async function confirmUndo(force) {
    await api.undoBatch(undoTarget.id, force)
    setUndoTarget(null); setUndoEdited([]); setDupAccountWarning([]); api.listBatches().then(setBatches)
    refreshTaskBadge()
  }

  function canApplyCategoryMappings() {
    return categoryMappingRows.some(row => !!row.categoryId)
  }

  function getCategoryWorkspaceSnapshot(draft) {
    return draft?.snapshot || draft
  }

  function advancePastDataReview() {
    setStage('done')
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
      alert('Failed to apply imported category mappings: ' + e.message)
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

  function getDraftDeleteTargets(draft) {
    const snapshot = getCategoryWorkspaceSnapshot(draft)
    const retainedIds = getDraftRetainedIds(draft)
    const groups = categories.filter(cat => !cat.parent_id)
    const children = categories.filter(cat => !!cat.parent_id)
    const deleteIds = []
    for (const group of groups) {
      if (!retainedIds.has(group.id)) {
        deleteIds.push(group.id)
      }
    }
    const deletedGroupIds = new Set(deleteIds)
    for (const child of children) {
      if (deletedGroupIds.has(child.parent_id)) continue
      if (!retainedIds.has(child.id)) deleteIds.push(child.id)
    }
    return deleteIds
  }

  async function computeDraftDeleteSummary(deleteIds) {
    if (!deleteIds.length) return null
    const previews = await Promise.all(deleteIds.map(id => api.getCategoryDeletePreview(id)))
    return previews.reduce((acc, preview) => {
      acc.delete_count += 1
      acc.txn_count += preview.txn_count || 0
      acc.rule_count += preview.rule_count || 0
      acc.profile_mapping_count += preview.profile_mapping_count || 0
      acc.batch_mapping_count += preview.batch_mapping_count || 0
      return acc
    }, {
      delete_count: 0,
      txn_count: 0,
      rule_count: 0,
      profile_mapping_count: 0,
      batch_mapping_count: 0,
    })
  }

  async function executeCategoryWorkspaceDraftApply(draft, replacementCategoryId = null) {
    setLoading(true)
    try {
      const snapshot = getCategoryWorkspaceSnapshot(draft)
      const existingById = new Map(categories.map(cat => [cat.id, cat]))
      const deleteIds = getDraftDeleteTargets(draft)
      for (const categoryId of deleteIds) {
        await api.deleteCategory(categoryId, {
          replacement_category_id: replacementCategoryId || null,
        })
      }

      const createdIdMap = {}

      for (const sectionType of ['income', 'expense']) {
        for (const group of snapshot.tree[sectionType] || []) {
          if (group.isNew) {
            const created = await api.createCategory({
              name: group.name,
              category_type: group.categoryType,
            })
            createdIdMap[group.id] = created.id
          } else {
            const existing = existingById.get(group.id)
            if (existing && existing.name !== group.name) {
              await api.updateCategory(group.id, { name: group.name })
            }
          }
        }
      }

      for (const sectionType of ['income', 'expense']) {
        for (const group of snapshot.tree[sectionType] || []) {
          const resolvedGroupId = createdIdMap[group.id] || group.id
          for (const child of group.children || []) {
            if (child.isNew) {
              const created = await api.createCategory({
                name: child.name,
                parent_id: resolvedGroupId,
              })
              createdIdMap[child.id] = created.id
            } else {
              const existing = existingById.get(child.id)
              if (existing && existing.name !== child.name) {
                await api.updateCategory(child.id, { name: child.name })
              }
              if (existing && existing.parent_id !== resolvedGroupId) {
                await api.updateCategory(child.id, { parent_id: resolvedGroupId })
              }
            }
          }
        }
      }

      const nextAssignments = {}
      for (const [rawValue, mapping] of Object.entries(snapshot.mappings || {})) {
        nextAssignments[rawValue] = createdIdMap[mapping.targetId] || mapping.targetId
      }

      setCategoryAssignments(prev => ({ ...prev, ...nextAssignments }))
      const refreshedCategories = await api.getCategories()
      setCategories(refreshedCategories)
      const rebuiltDraft = createImportCategoryMappingDraftState(refreshedCategories, sourceCategoryValues, {
        ...categoryAssignments,
        ...nextAssignments,
      })
      rebuiltDraft.snapshot = {
        ...cloneImportCategoryMappingSnapshot(rebuiltDraft.snapshot),
        sourceOrder: [...(snapshot?.sourceOrder || [])],
        setAsideOrder: [...(snapshot?.setAsideOrder || [])],
        selectedSourceIds: [],
        selectedNodeId: null,
        collapsedGroups: { ...(snapshot?.collapsedGroups || {}) },
      }
      rebuiltDraft.activeSection = draft?.activeSection || 'expense'
      setImportCategoryDraft(rebuiltDraft)
      setShowCategoryWorkspace(false)
      setPendingCategoryApply(null)
      setPendingCategoryReplacementId('')
    } finally {
      setLoading(false)
    }
  }

  async function applyCategoryWorkspaceDraft(draft) {
    const deleteIds = getDraftDeleteTargets(draft)
    const summary = await computeDraftDeleteSummary(deleteIds)
    if (summary?.delete_count && (summary.txn_count || summary.rule_count || summary.profile_mapping_count || summary.batch_mapping_count)) {
      setPendingCategoryApply({ draft, summary })
      setPendingCategoryReplacementId('')
      return
    }
    await executeCategoryWorkspaceDraftApply(draft, null)
  }

  return (
    <div style={{ width: '100%', maxWidth: IMPORT_CONFIG_MAX_WIDTH }}>
      {pendingCategoryApply ? (
        <CategoryWorkspaceApplyDialog
          summary={pendingCategoryApply.summary}
          replacementId={pendingCategoryReplacementId}
          onReplacementChange={setPendingCategoryReplacementId}
          replacementOptions={pendingDeleteReplacementCategories}
          saving={loading}
          onCancel={() => {
            setPendingCategoryApply(null)
            setPendingCategoryReplacementId('')
          }}
          onConfirm={async () => {
            try {
              await executeCategoryWorkspaceDraftApply(
                pendingCategoryApply.draft,
                pendingCategoryReplacementId || null,
              )
            } catch (e) {
              alert('Failed to apply category changes: ' + e.message)
            }
          }}
        />
      ) : null}
      {showCategoryWorkspace && preview ? (
        <ImportCategoryMappingWorkspace
          sourceValues={sourceCategoryValues}
          sourceMeta={sourceCategoryMeta}
          existingCategories={categories}
          initialAssignments={categoryAssignments}
          initialDraftState={importCategoryDraft}
          onDraftStateChange={setImportCategoryDraft}
          onApply={applyCategoryWorkspaceDraft}
          onClose={() => setShowCategoryWorkspace(false)}
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

      {stage === 'upload' && (
        <>
          <div style={{ width: '100%' }}>
            <div ref={dropRef} onDragOver={e => e.preventDefault()} onDrop={handleDrop}
              onClick={() => document.getElementById('csv-file-input').click()}
              style={{ border: '2px dashed var(--border)', borderRadius: 12, padding: '48px 32px', textAlign: 'center', cursor: 'pointer', background: 'var(--surface2)', marginBottom: 24 }}
              onMouseEnter={e => e.currentTarget.style.borderColor = 'var(--accent)'}
              onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--border)'}
            >
              <div style={{ fontSize: 32, marginBottom: 12 }}>📂</div>
              <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 6 }}>Drop a CSV file here, or click to browse</div>
              <div style={{ fontSize: 13, color: 'var(--muted)' }}>Supports CSV exports from any bank. Manage import profiles in Settings.</div>
              <input id="csv-file-input" type="file" accept=".csv" style={{ display: 'none' }} onChange={e => handleFile(e.target.files[0])} />
            </div>
          </div>
          {loading && <Spinner />}
        </>
      )}

      {stage === 'mapping' && preview && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20, alignItems: 'flex-start' }}>
          {dupAccountWarning.length > 0 && (
            <div style={{ width: IMPORT_CONFIG_MAX_WIDTH, background: 'color-mix(in srgb, #f59e0b 12%, var(--surface2))', border: '1px solid #f59e0b', borderRadius: 8, padding: '12px 16px' }}>
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>⚠️ This file has been imported before</div>
              <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 8 }}>
                The following accounts were imported on{' '}
                {preview.previous_batch?.imported_at?.slice(0,16).replace('T',' ')}.
                Duplicate rows (same date, amount, description) will be skipped automatically.
                To replace those transactions, undo the previous import first.
              </div>
              {duplicateImportSummary.imported.map(a => (
                <div key={a.account_id} style={{ fontSize: 13, marginBottom: 2 }}>• <strong>{a.account_name}</strong> — {a.row_count} transactions</div>
              ))}
              {duplicateImportSummary.remaining.length > 0 ? (
                <div style={{ marginTop: 10 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', marginBottom: 4 }}>
                    Not previously imported from this file
                  </div>
                  {duplicateImportSummary.remaining.map(value => (
                    <div key={value} style={{ fontSize: 13, marginBottom: 2 }}>
                      • <strong>{value}</strong>
                    </div>
                  ))}
                </div>
              ) : null}
              {duplicateImportSummary.allImported ? (
                <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 10 }}>
                  All accounts in this file were already imported, so there is nothing left to import.
                </div>
              ) : null}
            </div>
          )}

          {!duplicateImportSummary.allImported ? (
          <Card style={{ width: IMPORT_CONFIG_MAX_WIDTH }}>
            {/* 1. Filename + row count */}
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>
              {preview.filename}
              <span style={{ fontWeight: 400, color: 'var(--muted)', fontSize: 13, marginLeft: 8 }}>
                {preview.total_rows} rows
              </span>
            </div>

            {/* 2. Import profile */}
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 14, paddingBottom: 14, borderBottom: '1px solid var(--border)', flexWrap: 'wrap' }}>
              <span style={{ fontSize: 13, color: 'var(--muted)', whiteSpace: 'nowrap' }}>Import profile:</span>
              <SelectInput value={selectedProfile} onChange={v => { if (v !== selectedProfile) applyProfile(v) }}
                options={[{ value: '', label: '— No profile / manual mapping —' }, ...profiles.map(p => ({ value: p.id, label: p.name }))]}
                style={{ flex: 1, minWidth: 200 }} />
              <Link to="/settings" style={{ fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap', textDecoration: 'none', flexShrink: 0 }}
                title="Edit or delete profiles in Settings">Manage ↗</Link>
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

            {/* Header-not-on-line-1 nudge */}
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

            {/* Advanced section */}
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

            {/* 3. Column mapping — row 1: Date | Amount | Category, row 2: Merchant | Account handling */}
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Column mapping</div>
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
              gap: '24px 30px',
              marginBottom: 14,
            }}>
              {/* Row 1 */}
              <ColSelect
                label="Date"
                headers={columnAnalysis.dateCandidates}
                allHeaders={preview.headers}
                value={colDate}
                onChange={handleDateColumnChange}
                required
                hint={dateSelectHint}
                tone={selectedDateAnalysis && !selectedDateAnalysis.guessedFormat && selectedDateAnalysis.sampleCount ? 'danger' : 'muted'}
              />
              {amtConv === 'two_column' ? (
                <ColSelect
                  label="Debit column"
                  headers={columnAnalysis.debitCandidates}
                  allHeaders={preview.headers}
                  value={colDebit}
                  onChange={setColDebit}
                  required
                  hint={columnAnalysis.debitCandidates.length > 0 && !colDebit ? formatLikelyMatchLabel(columnAnalysis.debitCandidates.length) : ''}
                />
              ) : (
                <ColSelect
                  label="Amount"
                  headers={columnAnalysis.amountCandidates}
                  allHeaders={preview.headers}
                  value={colAmount}
                  onChange={setColAmount}
                  required
                  hint={amountSelectHint}
                  tone={selectedAmountAnalysis && selectedAmountAnalysis.sampleCount > 0 && selectedAmountAnalysis.amountMatches === 0 ? 'danger' : 'muted'}
                />
              )}
              <ColSelect
                label="Pending"
                headers={columnAnalysis.pendingCandidates}
                allHeaders={preview.headers}
                value={colPending}
                onChange={setColPending}
                hint={columnAnalysis.pendingCandidates.length > 0 && !colPending ? formatLikelyMatchLabel(columnAnalysis.pendingCandidates.length) : ''}
              />

              {/* Extra cells for two_column and single_unsigned — push into row 2 start */}
              {amtConv === 'two_column' && (
                <ColSelect
                  label="Credit column"
                  headers={columnAnalysis.creditCandidates}
                  allHeaders={preview.headers}
                  value={colCredit}
                  onChange={setColCredit}
                  required
                  hint={columnAnalysis.creditCandidates.length > 0 && !colCredit ? formatLikelyMatchLabel(columnAnalysis.creditCandidates.length) : ''}
                />
              )}
              {amtConv === 'single_unsigned' && (
                <ColSelect
                  label="Direction column"
                  headers={columnAnalysis.directionCandidates}
                  allHeaders={preview.headers}
                  value={colDir}
                  onChange={setColDir}
                  hint={columnAnalysis.directionCandidates.length > 0 && !colDir ? formatLikelyMatchLabel(columnAnalysis.directionCandidates.length) : ''}
                />
              )}
              <ColSelect label="Merchant" headers={preview.headers} value={colDesc} onChange={setColDesc} required />
              <div style={{ position: 'relative' }}>
                <ColSelect
                  label="Category"
                  headers={columnAnalysis.categoryCandidates}
                  allHeaders={preview.headers}
                  value={colCategory}
                  onChange={handleCategoryColumnChange}
                  hint={categorySelectHint}
                />
                {colCategory && sourceCategoryValues.length > 0 ? (
                  <div style={{ position: 'absolute', width: 'calc(100% - 28px)', right: 0, top: 'calc(100% + 4px)', display: 'grid', justifyItems: remainingCategoryCount > 0 ? 'stretch' : 'end', gap: 6, zIndex: 1 }}>
                    <button
                      type="button"
                      onClick={() => {
                        setImportCategoryDraft(prev => prev || createImportCategoryMappingDraftState(categories, sourceCategoryValues, categoryAssignments))
                        setShowCategoryWorkspace(true)
                      }}
                      style={{
                        width: remainingCategoryCount > 0 ? '100%' : 'auto',
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: remainingCategoryCount > 0 ? 'space-between' : 'center',
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
                      <span>{remainingCategoryCount > 0 ? 'map categories' : 'view category mappings'}</span>
                      {remainingCategoryCount > 0 ? (
                        <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.01em' }}>
                          {remainingCategoryCount} awaiting processing
                        </span>
                      ) : null}
                    </button>
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
                ) : null}
              </div>

              {/* Row 2 (or continues from row 1 overflow) */}
              <ColSelect label="Notes" headers={preview.headers} value={colNotes} onChange={setColNotes} />
              <AccountHandlingPicker
                headers={preview.headers}
                accounts={accounts}
                colAccount={colAccount}
                accountId={accountId}
                singleAccountNew={singleAccountNew}
                isRequired={!colAccount && !accountId && !singleAccountNew.enabled}
                onChange={({ col, acct, createNew }) => {
                  if (col !== undefined) {
                    setColAccount(col)
                    setAccountMap({})
                    setAccountId('')
                    setSingleAccountNew({ enabled: false, name: '', type: 'depository' })
                  } else {
                    setColAccount(null)
                    setAccountMap({})
                    setAccountId(acct)
                    setSingleAccountNew(createNew
                      ? { enabled: true, name: '', type: 'depository' }
                      : { enabled: false, name: '', type: 'depository' })
                  }
                }}
              />
            </div>
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
                  <option value="depository">Checking</option>
                  <option value="credit">Credit</option>
                  <option value="investment">Invest.</option>
                  <option value="loan">Loan</option>
                  <option value="other">Other</option>
                </select>
                {accounts.some(a => a.name.toLowerCase() === singleAccountNew.name.trim().toLowerCase()) && (
                  <div style={{ width: '100%', fontSize: 11, color: 'var(--danger)' }}>
                    Account name already exists. Select it from the list instead.
                  </div>
                )}
              </div>
            )}

            {/* Apply categorization + Save profile */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13 }}>
                <input type="checkbox" checked={applyCat} onChange={e => setApplyCat(e.target.checked)} />
                Apply categorization rules on import
              </label>
              {!selectedProfile && (
                showSaveProfile ? (
                  <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    flexWrap: 'wrap',
                    justifyContent: 'flex-end',
                  }}>
                    <input
                      autoFocus
                      value={saveProfileName}
                      onChange={e => setSaveProfileName(e.target.value)}
                      placeholder="Profile name"
                      onKeyDown={e => {
                        if (e.key === 'Enter' && saveProfileName.trim()) saveProfile(saveProfileName)
                        if (e.key === 'Escape') {
                          setSaveProfileName('')
                          setShowSaveProfile(false)
                        }
                      }}
                      style={{
                        width: 220,
                        maxWidth: '100%',
                        background: 'var(--surface)',
                        color: 'var(--text)',
                        border: '1px solid var(--accent)',
                        borderRadius: 999,
                        padding: '6px 12px',
                        fontSize: 13,
                        outline: 'none',
                      }}
                    />
                    <button
                      onClick={() => saveProfileName.trim() && saveProfile(saveProfileName)}
                      disabled={!saveProfileName.trim()}
                      style={{
                        background: 'var(--accent)',
                        color: '#fff',
                        border: 'none',
                        borderRadius: 999,
                        padding: '6px 14px',
                        fontSize: 12,
                        cursor: saveProfileName.trim() ? 'pointer' : 'not-allowed',
                        opacity: saveProfileName.trim() ? 1 : 0.5,
                        fontWeight: 600,
                      }}
                    >
                      Add
                    </button>
                    <button
                      onClick={() => {
                        setSaveProfileName('')
                        setShowSaveProfile(false)
                      }}
                      style={{
                        background: 'none',
                        border: '1px solid var(--border)',
                        borderRadius: 999,
                        padding: '6px 12px',
                        fontSize: 12,
                        color: 'var(--muted)',
                        cursor: 'pointer',
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => { setSaveProfileName(''); setShowSaveProfile(true) }}
                    style={{
                      background: hasImportWorkToSave ? 'color-mix(in srgb, var(--accent) 16%, var(--surface2))' : 'none',
                      border: `1px solid ${hasImportWorkToSave ? 'var(--accent)' : 'var(--border)'}`,
                      borderRadius: 6, padding: '5px 12px', fontSize: 12,
                      cursor: 'pointer', color: hasImportWorkToSave ? 'var(--accent2)' : 'var(--muted)',
                      fontWeight: hasImportWorkToSave ? 600 : 400,
                      boxShadow: hasImportWorkToSave ? '0 0 0 1px color-mix(in srgb, var(--accent) 18%, transparent)' : 'none',
                    }}
                  >
                    ＋ Create profile
                  </button>
                )
              )}
            </div>
          </Card>
          ) : null}

          {colAccount && distinctAccountValues.length > 0 && (
            <Card style={{ padding: 0, overflow: 'hidden', width: IMPORT_CONFIG_MAX_WIDTH }}>
              {/* Column headers: Input file | → | Maps to | Skip */}
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
                const alreadyImported = dupAccountWarning.find(a => a.csv_value === csvVal)
                return (
                  <div key={csvVal} style={{
                    display: 'grid', gridTemplateColumns: '1fr 16px 240px 52px',
                    gap: 12, padding: '7px 14px', alignItems: 'center',
                    borderBottom: '1px solid var(--border)',
                    opacity: alreadyImported ? 0.5 : (m.skip ? 0.45 : 1),
                  }}>
                    {/* Input file value */}
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={csvVal}>{csvVal}</div>
                      {alreadyImported && (
                        <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 1 }}>
                          Already imported · {alreadyImported.row_count} rows
                        </div>
                      )}
                    </div>

                    <span style={{ color: 'var(--muted)', textAlign: 'center', fontSize: 11 }}>→</span>

                    {/* Maps to */}
                    {alreadyImported ? (
                      <span style={{ fontSize: 12, color: 'var(--muted)', fontStyle: 'italic' }}>
                        already imported
                      </span>
                    ) : m.skip ? (
                      <span style={{ fontSize: 12, color: 'var(--muted)', fontStyle: 'italic' }}>skipped</span>
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
                          <option value="depository">Checking</option>
                          <option value="credit">Credit</option>
                          <option value="investment">Invest.</option>
                          <option value="loan">Loan</option>
                          <option value="other">Other</option>
                        </select>
                        <button onClick={() => update({ createNew: false, accountId: '' })}
                          style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 13, padding: '2px', flexShrink: 0 }}>✕</button>
                      </div>
                    )}

                    {/* Skip checkbox — right edge */}
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
                <span style={{ textAlign: 'right', fontWeight: 600, color: r.amount !== null ? (r.amount < 0 ? 'var(--success)' : 'var(--text)') : 'var(--danger)', fontSize: r.amount !== null ? 13 : 11 }}>
                  {r.amount !== null
                    ? formatCurrency(Math.abs(r.amount))
                    : r.rawAmountStr
                      ? <span title={`Can't parse: "${r.rawAmountStr}"`} style={{ opacity: 0.6 }}>?{r.rawAmountStr.slice(0,10)}</span>
                      : <span style={{ opacity: 0.4 }}>—</span>
                  }
                </span>
              </div>
            ))}
          </Card>

          <div style={{ display: 'flex', gap: 10 }}>
            <span title={!canImport() && !loading ? getImportDisabledReason() : ''}>
              <Button onClick={runImport} disabled={!canImport() || loading}>
                {loading ? 'Importing…' : `Import ${Math.max(0, preview.total_rows - skipRows)} rows`}
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
                    Mappings are saved with the import profile
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
                    This CSV appears to have non-transaction data after the rows that imported. Please inspect the raw file viewer, then confirm whether it looks correct before continuing.
                  </div>
                </div>
              </div>
            </div>
            <div style={{ padding: 22, display: 'grid', gap: 14 }}>
              <div style={{
                fontSize: 13,
                color: 'var(--muted)',
                background: 'color-mix(in srgb, #f59e0b 10%, var(--surface2))',
                border: '1px solid #f59e0b',
                borderRadius: 10,
                padding: '10px 12px',
              }}>
                The raw file viewer is already open on the file tail. If the ending text is expected, choose Continue. If not, close this and undo the import from Recent imports.
              </div>
              <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                <Button variant="ghost" onClick={() => setStage('done')}>
                  Not OK
                </Button>
                <Button onClick={advancePastDataReview}>
                  Continue
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {stage === 'done' && importResult && (
        <Card>
          <div style={{ fontSize: 18, marginBottom: 8 }}>✅ Import complete</div>
          <div style={{ fontSize: 14, color: 'var(--muted)', marginBottom: 4 }}>
            {importResult.imported} transactions imported.
          </div>
          {(importResult.skipped > 0 || importResult.deduped > 0) && (() => {
            const parts = []
            if (importResult.deduped > 0)         parts.push(`${importResult.deduped} duplicate${importResult.deduped !== 1 ? 's' : ''}`)
            if (importResult.account_skipped > 0)  parts.push(`${importResult.account_skipped} from skipped accounts`)
            const nonTransactionRows = importResult.trailing_non_transaction_suspected ? (importResult.trailing_error_count || 0) : 0
            const validationErrors = Math.max(0, importResult.skipped - importResult.account_skipped - nonTransactionRows)
            if (validationErrors > 0)              parts.push(`${validationErrors} validation errors`)
            if (nonTransactionRows > 0)            parts.push(`${nonTransactionRows} non-transaction rows`)
            return (
              <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 8 }}>
                {importResult.skipped + importResult.deduped} rows not imported
                {parts.length > 0 && ` (${parts.join(', ')})`}.
              </div>
            )
          })()}
          {selectedProfile && (
            <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8 }}>
              Profile updated with current account mappings.
            </div>
          )}
          {categoryMappingSummary && (
            <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 8 }}>
              {categoryMappingSummary.saved_mapping_count} imported categor{categoryMappingSummary.saved_mapping_count === 1 ? 'y mapping was' : 'y mappings were'} saved.
              {categoryMappingSummary.applied_count > 0 && ` ${categoryMappingSummary.applied_count} transaction${categoryMappingSummary.applied_count === 1 ? ' was' : 's were'} updated.`}
              {categoryMappingSummary.categorized_by_rules > 0 && ` ${categoryMappingSummary.categorized_by_rules} remaining transaction${categoryMappingSummary.categorized_by_rules === 1 ? '' : 's'} were categorized by rules.`}
            </div>
          )}
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
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6, color: 'var(--danger)' }}>{importResult.errors.length} validation errors:</div>
              {importResult.errors.map((e, i) => <div key={i} style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 3 }}>Row {e.row}: {e.reason}</div>)}
            </div>
          )}
          <Button onClick={resetImport}>Import another file</Button>
        </Card>
      )}

      <SectionTitle>Recent imports</SectionTitle>
      <Card style={{ padding: 0, overflow: 'hidden', width: '100%' }}>
        {batches.length === 0 ? <EmptyState message="No imports yet" /> : (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 160px 70px 70px 80px', padding: '8px 16px', fontSize: 11, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em', borderBottom: '1px solid var(--border)' }}>
              <span>File</span><span>Imported</span><span style={{ textAlign: 'center' }}>Rows</span><span style={{ textAlign: 'center' }}>Skipped</span><span></span>
            </div>
            {batches.map(b => (
              <div key={b.id}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 160px 70px 70px 80px', padding: '10px 16px', alignItems: 'center', fontSize: 13, borderBottom: b.accounts?.length ? 'none' : '1px solid var(--border)' }}>
                  <div>
                    <div>{b.filename}</div>
                    {b.profile_name && <div style={{ fontSize: 11, color: 'var(--muted)' }}>{b.profile_name}</div>}
                  </div>
                  <span style={{ fontSize: 12, color: 'var(--muted)' }}>{b.imported_at.slice(0,16).replace('T',' ')}</span>
                  <span style={{ textAlign: 'center' }}>{b.row_count}</span>
                  <span style={{ textAlign: 'center', color: 'var(--muted)' }}>{b.skipped_count}</span>
                  <button onClick={() => handleUndoClick(b)} style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--danger)', cursor: 'pointer', fontSize: 12, padding: '3px 8px' }}>Undo</button>
                </div>
                {(b.accounts?.length > 0 || b.deduped_count > 0) && (
                  <div style={{ padding: '4px 16px 10px 28px', borderBottom: '1px solid var(--border)', display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
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
                    {b.deduped_count > 0 && (
                      <span title={`${b.deduped_count} duplicate rows skipped`} style={{
                        display: 'inline-flex', alignItems: 'center', gap: 4,
                        fontSize: 11, padding: '2px 7px', borderRadius: 99,
                        background: 'var(--surface2)',
                        color: 'var(--muted)',
                        border: '1px solid var(--border)',
                      }}>
                        <span style={{ fontWeight: 600 }}>⊘</span>
                        {b.deduped_count} dupes
                      </span>
                    )}
                  </div>
                )}
              </div>
            ))}
          </>
        )}
      </Card>

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
                        <span style={{ textAlign: 'right' }}>{formatCurrency(Math.abs(t.amount))}</span>
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
    const accountSel  = filters.selections.filter(s => s.type === 'account').map(s => s.id)
    const ownerSel    = filters.selections.filter(s => s.type === 'owner').map(s => s.id)
    const groupSel    = filters.selections.filter(s => s.type === 'group').map(s => s.id)
    const categorySel = filters.selections.filter(s => s.type === 'category').map(s => s.id)
    window.open(api.exportTransactionsCsv({
      columns: [...selectedCols].join(','),
      date_start:   filters.date?.start || undefined, date_end: filters.date?.end || undefined,
      account_ids:  accountSel.length  ? accountSel.join(',')  : undefined,
      owner_ids:    ownerSel.length    ? ownerSel.join(',')    : undefined,
      group_ids:    groupSel.length    ? groupSel.join(',')    : undefined,
      category_ids: categorySel.length ? categorySel.join(',') : undefined,
    }), '_blank')
  }

  return (
    <div>
      <SectionTitle>Export transactions as CSV</SectionTitle>
      <Card>
        <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 14 }}>Exports transactions matching current filter bar settings. Select columns:</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginBottom: 16 }}>
          {EXPORT_COLUMNS.map(col => (
            <label key={col.key} style={{ display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer', fontSize: 13 }}>
              <input type="checkbox" checked={selectedCols.has(col.key)} onChange={() => toggleCol(col.key)} />{col.label}
            </label>
          ))}
        </div>
        <Button onClick={downloadCsv} disabled={selectedCols.size === 0}>⬇ Download CSV</Button>
        <span style={{ fontSize: 12, marginLeft: 12, color: filters.date || filters.selections.length > 0 ? 'var(--accent2)' : 'var(--muted)' }}>
          {filters.date || filters.selections.length > 0 ? 'Active filters will be applied' : 'All transactions'}
        </span>
      </Card>
    </div>
  )
}

function BackupRestoreTab() {
  const [backupRecipients, setBackupRecipients] = useState([])
  const [restoreFile,  setRestoreFile]  = useState(null)
  const [credsFile,    setCredsFile]    = useState(null)
  const [restoreInspection, setRestoreInspection] = useState(null)
  const [inspectError, setInspectError] = useState('')
  const [inspectingRestore, setInspectingRestore] = useState(false)
  const [privateKeyFile, setPrivateKeyFile] = useState(null)
  const [privateKeyPassphrase, setPrivateKeyPassphrase] = useState('')
  const [restoring,    setRestoring]    = useState(false)
  const [restoreMsg,   setRestoreMsg]   = useState(null)
  const [restoreSuccess, setRestoreSuccess] = useState(null)
  const [pendingConfirm, setPendingConfirm] = useState(null)
  const enabledRecipients = backupRecipients.filter(r => r.enabled)

  useEffect(() => {
    api.getBackupRecipients().then(setBackupRecipients).catch(() => {})
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
            <Button onClick={() => startDownload(api.exportBackup(false))}>Generate backup</Button>
            <Button variant="ghost" disabled={enabledRecipients.length === 0} onClick={() => startDownload(api.exportBackup(true))}>Generate encrypted backup</Button>
          </div>
          {enabledRecipients.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 8 }}>
              Add an enabled backup recipient in Settings to create encrypted backups.
            </div>
          ) : (
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 8 }}>
              Encrypted backups will be readable by: {enabledRecipients.map(r => r.label).join(', ')}.
            </div>
          )}
        </div>
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 16 }}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Credentials backup</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
            <a href={api.exportCredentials()} download="fintrack_credentials.zip"><Button>Generate credentials backup</Button></a>
            <div style={{ display: 'inline-block', fontSize: 13, background: 'color-mix(in srgb, #f59e0b 10%, var(--surface2))', border: '1px solid #f59e0b', borderRadius: 6, padding: '8px 12px' }}>
              ⚠️ Contains Plaid access tokens — treat like a password.
            </div>
          </div>
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
          <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 10 }}>Only needed after restoring to a new machine.</div>
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
