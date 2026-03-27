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
import { formatCurrency } from '../lib/utils.js'

const AMOUNT_CONVENTIONS = [
  { value: 'single_signed',   label: 'Single column — negative = debit (Chase, most banks)' },
  { value: 'single_unsigned', label: 'Single column — always positive, direction column' },
  { value: 'two_column',      label: 'Two columns — separate debit and credit' },
]
const DATE_FORMATS = [
  { value: '%m/%d/%Y',  label: 'MM/DD/YYYY  (e.g. 01/31/2024)' },
  { value: '%Y-%m-%d',  label: 'YYYY-MM-DD  (e.g. 2024-01-31)' },
  { value: '%d/%m/%Y',  label: 'DD/MM/YYYY  (e.g. 31/01/2024)' },
  { value: '%m-%d-%Y',  label: 'MM-DD-YYYY  (e.g. 01-31-2024)' },
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

function SectionTitle({ children }) {
  return <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 6, marginTop: 28 }}>{children}</div>
}

function SelectInput({ value, onChange, options, style }) {
  return (
    <select value={value} onChange={e => onChange(e.target.value)} style={{
      background: 'var(--surface2)', color: 'var(--text)',
      border: '1px solid var(--border)', borderRadius: 6,
      padding: '6px 10px', fontSize: 13, cursor: 'pointer', ...style,
    }}>
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  )
}

function ColSelect({ label, headers, value, onChange, required }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        {label}{required && <span style={{ color: 'var(--danger)' }}> *</span>}
      </label>
      <select value={value || ''} onChange={e => onChange(e.target.value || null)} style={{
        background: 'var(--surface2)', color: 'var(--text)',
        border: `1px solid ${required && !value ? 'var(--danger)' : 'var(--border)'}`,
        borderRadius: 6, padding: '6px 8px', fontSize: 13,
      }}>
        <option value="">— not mapped —</option>
        {headers.map(h => <option key={h} value={h}>{h}</option>)}
      </select>
    </div>
  )
}

// ── Raw file preview — draggable floating panel ──────────────────────────────
// Opens fixed-position so the mapping form below stays usable.
// Drag the header bar to reposition. Shows header + 4 data rows prominently,
// rest dimmed. Scrollable if you need to see more.

// ── Raw file preview — draggable + resizable floating panel ──────────────────

function RawFilePreview({ rawLines, headerRowIndex, onClose }) {
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
      position: 'fixed', left: pos.x, top: pos.y, zIndex: 400,
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
          <span style={{ fontSize: 13, fontWeight: 600 }}>Raw file</span>
          <span style={{ fontSize: 11, color: 'var(--muted)' }}>
            header on line {headerRowIndex + 1} · drag to move · resize ↘
          </span>
        </div>
        <button
          onMouseDown={e => e.stopPropagation()}
          onClick={onClose}
          style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: '0 2px' }}
        >×</button>
      </div>

      {/* Scrollable content */}
      <div style={{
        fontFamily: 'monospace', fontSize: 12,
        overflowY: 'auto', overflowX: 'auto',
        height: size.h,
        borderRadius: '0 0 10px 10px',
      }}>
        {rawLines.map((line, i) => {
          const isHeader = i === headerRowIndex
          const isData   = i > headerRowIndex && i <= headerRowIndex + 4
          const dimmed   = !isHeader && !isData && i > headerRowIndex
          return (
            <div key={i} style={{
              display: 'flex', alignItems: 'baseline',
              background: isHeader ? 'color-mix(in srgb, var(--accent) 14%, var(--surface2))' : 'transparent',
              borderBottom: '1px solid var(--border)',
              opacity: dimmed ? 0.25 : 1,
            }}>
              <span style={{ minWidth: 32, padding: '3px 6px', textAlign: 'right', flexShrink: 0, fontSize: 10, color: 'var(--muted)', borderRight: '1px solid var(--border)', background: 'var(--surface2)', fontWeight: isHeader ? 600 : 400 }}>{i + 1}</span>
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

function AccountHandlingPicker({ headers, accounts, colAccount, accountId, isRequired, onChange }) {
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
              style={itemStyle(!colAccount && !accountId)}
              onMouseDown={e => { e.preventDefault(); onChange({ acct: '' }); setOpen(false) }}
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
                    onMouseDown={e => { e.preventDefault(); onChange({ col: h }); setOpen(false) }}
                  >
                    <span style={{ fontSize: 11, color: 'var(--accent2)', fontWeight: 600, flexShrink: 0 }}>↔</span>
                    <span>{h}</span>
                    {colAccount === h && <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--accent2)' }}>✓</span>}
                  </div>
                ))}
              </>
            )}

            {/* Account options */}
            {accounts.length > 0 && (
              <>
                <div style={{ ...groupLabel, borderTop: '1px solid var(--border)' }}>Assign all rows to one account</div>
                {accounts.map(a => (
                  <div
                    key={a.id}
                    style={itemStyle(accountId === a.id)}
                    onMouseDown={e => { e.preventDefault(); onChange({ acct: a.id }); setOpen(false) }}
                  >
                    <span style={{ flex: 1 }}>{a.name}{a.mask ? ` ···${a.mask}` : ''}</span>
                    {accountId === a.id && <span style={{ fontSize: 11, color: 'var(--accent2)' }}>✓</span>}
                  </div>
                ))}
              </>
            )}
          </div>
        )}
      </div>
      {colAccount && (
        <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 1 }}>per-account mapping below ↓</div>
      )}
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
  const [stage, setStage]           = useState('upload')
  const [preview, setPreview]       = useState(null)
  const [profiles, setProfiles]     = useState([])
  const [accounts, setAccounts]     = useState([])
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
  const [colNotes,   setColNotes]   = useState(null)
  const [colAccount, setColAccount] = useState(null)
  const [accountMap, setAccountMap] = useState({})
  const [importResult,      setImportResult]      = useState(null)
  const [dupAccountWarning, setDupAccountWarning] = useState([])
  const [showRaw,           setShowRaw]           = useState(false)
  const [showAdvanced,      setShowAdvanced]      = useState(false)
  const [showSaveProfile,   setShowSaveProfile]   = useState(false)
  const [saveProfileName,   setSaveProfileName]   = useState('')
  const [prevBatchWarn,     setPrevBatchWarn]     = useState(false)

  useEffect(() => {
    api.getImportProfiles().then(setProfiles)
    api.getAccounts().then(setAccounts)
    api.listBatches().then(setBatches)
  }, [])

  const distinctAccountValues = useMemo(() => {
    if (!colAccount || !preview?.column_distinct_values) return []
    return preview.column_distinct_values[colAccount] || []
  }, [colAccount, preview])

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
      return next
    })
  }, [distinctAccountValues, accounts])

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
        rawAcct:  colAccount ? String(row[colAccount] ?? '').trim() : null,
        rawAmountStr,
        amount,
      }
    })
  }
  const previewRows = computePreviewRows()

  function applyProfile(profileId) {
    setSelectedProfile(profileId)
    const p = profiles.find(x => x.id === profileId)
    if (!p) return
    const cm = p.column_map || {}
    setAccountId(p.account_id || ''); setDateFormat(p.date_format || '%m/%d/%Y')
    setAmtConv(p.amount_convention || 'single_signed'); setSkipRows(p.skip_rows || 0)
    setApplyCat(!!p.apply_categorization)
    setColDate(cm.date || null); setColAmount(cm.amount || null); setColDebit(cm.debit || null)
    setColCredit(cm.credit || null); setColDir(cm.direction || null)
    setColDesc(cm.description || null); setColNotes(cm.notes || null)
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
            // No match at all — surface as createNew so user sees it needs attention
            restored[csvVal] = { accountId: '', createNew: true, newName: csvVal, newType: 'depository', skip: false }
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
          restored[csvVal] = { accountId: '', createNew: true, newName: info.name, newType: info.type, skip: false }
        }
      }
      setAccountMap(restored)
    }
  }

  function applySnapshot(snap) {
    if (!snap) return
    const cm = snap.column_map || {}
    setDateFormat(snap.date_format || '%m/%d/%Y'); setAmtConv(snap.amount_convention || 'single_signed')
    setSkipRows(snap.skip_rows || 0); setApplyCat(snap.apply_categorization !== false)
    setColDate(cm.date || null); setColAmount(cm.amount || null); setColDebit(cm.debit || null)
    setColCredit(cm.credit || null); setColDir(cm.direction || null)
    setColDesc(cm.description || null); setColNotes(cm.notes || null); setColAccount(cm.account || null)
    setAccountId(snap.account_id || '')
    if (snap.account_map || snap.skip_accounts) {
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
            restored[val] = { accountId: '', createNew: true, newName: val, newType: 'depository', skip: false }
          }
        }
      }
      for (const val of skips) {
        restored[val] = { accountId: '', createNew: false, newName: val, newType: 'depository', skip: true }
      }
      setAccountMap(restored)
    }
  }

  async function handleFile(file) {
    if (!file) return
    setLoading(true)
    try {
      const result = await api.previewCsv(file)
      setPreview({ ...result, file }); setDupAccountWarning([]); setAccountMap({})
      if (result.suggested_profile_id) applyProfile(result.suggested_profile_id)
      else if (result.config_snapshot) applySnapshot(result.config_snapshot)
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
             direction: colDir, description: colDesc, notes: colNotes, account: colAccount }
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
    return !!accountId
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
      }
      const result = await api.runImport(preview.file, {
        profile_id:           selectedProfile || null,
        filename:             preview.filename,
        account_id:           colAccount ? null : accountId,
        account_map:          finalAccountMap,
        skip_accounts:        skipAccounts,
        new_accounts:         newAccounts?.length ? newAccounts : null,
        date_format:          dateFormat,
        amount_convention:    amtConv,
        column_map:           getColumnMap(),
        skip_rows:            skipRows,
        apply_categorization: applyCat,
      })
      setImportResult(result); setStage('done')
      refreshTaskBadge()
      const refreshedAccounts = await api.getAccounts()
      setAccounts(refreshedAccounts)
      api.listBatches().then(setBatches)
      if (selectedProfile) {
        await autoSaveProfile(refreshedAccounts).catch(() => {})
      }
    } catch (e) { alert('Import failed: ' + e.message) }
    finally { setLoading(false) }
  }

  // Build the profile body from current mapping state — shared by saveProfile and auto-save
  function buildProfileBody(name) {
    const cm = getColumnMap()
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
      account_id:           (!colAccount && accountId) ? accountId : null,
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
    if (Object.keys(assignments).length > 0) cm.account_assignments = assignments
    if (skips.length > 0)                    cm.account_skips       = skips
    if (Object.keys(newAccts).length > 0)    cm.account_new         = newAccts

    const body = {
      name:                 p.name,
      filename_pattern:     preview.filename.replace(/[_\-\d.]+\.(csv)$/i, '').trim() || null,
      header_fingerprint:   preview.header_fingerprint || null,
      column_map:           cm,
      account_id:           (!colAccount && accountId) ? accountId : null,
      date_format:          dateFormat,
      amount_convention:    amtConv,
      skip_rows:            skipRows,
      apply_categorization: applyCat,
    }
    await api.updateImportProfile(selectedProfile, body)
    // Await the profiles refresh so state is up to date before the user
    // can cancel and re-upload — prevents stale profile being applied
    const updated = await api.getImportProfiles()
    setProfiles(updated)
  }

  function resetImport() {
    setStage('upload'); setPreview(null); setImportResult(null)
    setDupAccountWarning([]); setAccountMap({})
    setShowRaw(false); setShowAdvanced(false); setShowSaveProfile(false)
    setSaveProfileName(''); setPrevBatchWarn(false)
  }

  async function handleUndoClick(batch) {
    setUndoTarget(batch); setUndoLoading(true)
    setUndoEdited(await api.getBatchEdited(batch.id)); setUndoLoading(false)
  }

  async function confirmUndo(force) {
    await api.undoBatch(undoTarget.id, force)
    setUndoTarget(null); setUndoEdited([]); api.listBatches().then(setBatches)
    refreshTaskBadge()
  }

  return (
    <div>
      {stage === 'upload' && (
        <>
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
          {loading && <Spinner />}
        </>
      )}

      {stage === 'mapping' && preview && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

          {/* Floating raw file panel (rendered outside flow so it overlaps the form) */}
          {showRaw && (
            <RawFilePreview
              rawLines={preview.raw_lines}
              headerRowIndex={preview.header_row_index ?? 0}
              onClose={() => setShowRaw(false)}
            />
          )}

          {dupAccountWarning.length > 0 && (
            <div style={{ background: 'color-mix(in srgb, #f59e0b 12%, var(--surface2))', border: '1px solid #f59e0b', borderRadius: 8, padding: '12px 16px' }}>
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>⚠️ Accounts already imported from this file</div>
              <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 8 }}>
                The following accounts were imported on{' '}
                {preview.previous_batch?.imported_at?.slice(0,16).replace('T',' ')}.
                Duplicate rows (same date, amount, description) will be skipped automatically.
                To replace those transactions, undo the previous import first.
              </div>
              {dupAccountWarning.map(a => (
                <div key={a.account_id} style={{ fontSize: 13, marginBottom: 2 }}>• <strong>{a.account_name}</strong> — {a.row_count} transactions</div>
              ))}
            </div>
          )}

          <Card>
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
                  <select value={dateFormat} onChange={e => setDateFormat(e.target.value)} style={{
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
                  <input type="number" min={0} max={10} value={skipRows}
                    onChange={e => setSkipRows(parseInt(e.target.value) || 0)}
                    style={{
                      background: 'var(--surface)', color: 'var(--text)',
                      border: '1px solid var(--border)', borderRadius: 6,
                      padding: '3px 6px', fontSize: 12, width: 40, textAlign: 'center',
                    }}
                  />
                  header rows
                </label>
              </div>
            )}

            {/* 3. Column mapping — row 1: Date | Amount | Notes, row 2: Description | Account handling */}
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Column mapping</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 14 }}>
              {/* Row 1 */}
              <ColSelect label="Date"  headers={preview.headers} value={colDate}   onChange={setColDate}   required />
              {amtConv === 'two_column' ? (
                <ColSelect label="Debit column"  headers={preview.headers} value={colDebit}  onChange={setColDebit}  required />
              ) : (
                <ColSelect label="Amount" headers={preview.headers} value={colAmount} onChange={setColAmount} required />
              )}
              <ColSelect label="Notes" headers={preview.headers} value={colNotes} onChange={setColNotes} />

              {/* Extra cells for two_column and single_unsigned — push into row 2 start */}
              {amtConv === 'two_column' && (
                <ColSelect label="Credit column" headers={preview.headers} value={colCredit} onChange={setColCredit} required />
              )}
              {amtConv === 'single_unsigned' && (
                <ColSelect label="Direction column" headers={preview.headers} value={colDir} onChange={setColDir} />
              )}

              {/* Row 2 (or continues from row 1 overflow) */}
              <ColSelect label="Description" headers={preview.headers} value={colDesc} onChange={setColDesc} required />
              <AccountHandlingPicker
                headers={preview.headers}
                accounts={accounts}
                colAccount={colAccount}
                accountId={accountId}
                isRequired={!colAccount && !accountId}
                onChange={({ col, acct }) => {
                  if (col !== undefined) { setColAccount(col); setAccountMap({}); setAccountId('') }
                  else                  { setColAccount(null); setAccountMap({}); setAccountId(acct) }
                }}
              />
            </div>

            {/* Apply categorization + Save profile */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13 }}>
                <input type="checkbox" checked={applyCat} onChange={e => setApplyCat(e.target.checked)} />
                Apply categorization rules on import
              </label>
              {!selectedProfile && (
                <button
                  onClick={() => { setSaveProfileName(''); setShowSaveProfile(v => !v) }}
                  style={{
                    background: 'none', border: '1px solid var(--border)',
                    borderRadius: 6, padding: '5px 12px', fontSize: 12,
                    cursor: 'pointer', color: 'var(--muted)',
                  }}
                >
                  ＋ Create profile
                </button>
              )}
            </div>

            {/* Inline create-profile form — only shown when no profile active */}
            {!selectedProfile && showSaveProfile && (
              <div style={{
                marginTop: 12, padding: '10px 14px',
                background: 'var(--surface2)', borderRadius: 8,
                border: '1px solid var(--border)',
                display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap',
              }}>
                <input
                  autoFocus
                  value={saveProfileName}
                  onChange={e => setSaveProfileName(e.target.value)}
                  placeholder="Profile name (e.g. Chase Checking)"
                  onKeyDown={e => {
                    if (e.key === 'Enter' && saveProfileName.trim()) saveProfile(saveProfileName)
                    if (e.key === 'Escape') setShowSaveProfile(false)
                  }}
                  style={{
                    flex: 1, minWidth: 180, background: 'var(--surface)', color: 'var(--text)',
                    border: '1px solid var(--accent)', borderRadius: 6,
                    padding: '5px 8px', fontSize: 13, outline: 'none',
                  }}
                />
                <button
                  onClick={() => saveProfileName.trim() && saveProfile(saveProfileName)}
                  disabled={!saveProfileName.trim()}
                  style={{
                    background: 'var(--accent)', color: '#fff', border: 'none',
                    borderRadius: 6, padding: '5px 14px', fontSize: 13,
                    cursor: saveProfileName.trim() ? 'pointer' : 'not-allowed',
                    opacity: saveProfileName.trim() ? 1 : 0.5,
                  }}
                >
                  Create
                </button>
                <button onClick={() => setShowSaveProfile(false)} style={{
                  background: 'none', border: 'none', color: 'var(--muted)',
                  cursor: 'pointer', fontSize: 18, padding: '2px 4px', lineHeight: 1,
                }}>×</button>
              </div>
            )}
          </Card>

          {colAccount && distinctAccountValues.length > 0 && (
            <Card style={{ padding: 0, overflow: 'hidden' }}>
              {/* Column headers: Input file | → | Maps to | Skip */}
              <div style={{
                display: 'grid', gridTemplateColumns: '1fr 16px 1fr 40px',
                padding: '6px 14px', gap: 10,
                fontSize: 11, fontWeight: 600, color: 'var(--muted)',
                textTransform: 'uppercase', letterSpacing: '0.05em',
                borderBottom: '1px solid var(--border)',
                background: 'var(--surface2)',
              }}>
                <span>Input file</span>
                <span></span>
                <span>Maps to</span>
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
                    display: 'grid', gridTemplateColumns: '1fr 16px 1fr 40px',
                    gap: 10, padding: '7px 14px', alignItems: 'center',
                    borderBottom: '1px solid var(--border)',
                    opacity: m.skip ? 0.45 : 1,
                  }}>
                    {/* Input file value */}
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={csvVal}>{csvVal}</div>
                      {alreadyImported && (
                        <div style={{ fontSize: 11, color: '#f59e0b', marginTop: 1 }}>⚠ {alreadyImported.row_count} rows already imported</div>
                      )}
                    </div>

                    <span style={{ color: 'var(--muted)', textAlign: 'center', fontSize: 11 }}>→</span>

                    {/* Maps to */}
                    {m.skip ? (
                      <span style={{ fontSize: 12, color: 'var(--muted)', fontStyle: 'italic' }}>skipped</span>
                    ) : !m.createNew ? (
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center', minWidth: 0 }}>
                        <select
                          value={m.accountId}
                          onChange={e => update({ accountId: e.target.value })}
                          style={{
                            flex: 1, minWidth: 0, background: 'var(--surface2)', color: 'var(--text)',
                            border: '1px solid var(--border)', borderRadius: 6,
                            padding: '5px 6px', fontSize: 12,
                          }}
                        >
                          <option value="">— Select —</option>
                          {accounts.map(a => (
                            <option key={a.id} value={a.id}>{a.name}{a.mask ? ` ···${a.mask}` : ''}</option>
                          ))}
                        </select>
                        <button onClick={() => update({ createNew: true })} style={{
                          flexShrink: 0, background: 'none', border: '1px solid var(--border)',
                          borderRadius: 6, color: 'var(--accent2)', cursor: 'pointer',
                          fontSize: 11, padding: '4px 7px', whiteSpace: 'nowrap',
                        }}>+New</button>
                      </div>
                    ) : (
                      <div style={{ display: 'flex', gap: 4, alignItems: 'center', minWidth: 0, flexWrap: 'wrap' }}>
                        <div style={{ flex: 1, minWidth: 60 }}>
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
                          style={{ background: 'var(--surface2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: '4px 5px', fontSize: 11 }}>
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
                      <input
                        type="checkbox"
                        checked={!!m.skip}
                        onChange={e => update({ skip: e.target.checked })}
                        style={{ width: 15, height: 15, cursor: 'pointer', accentColor: 'var(--accent)' }}
                      />
                    </div>
                  </div>
                )
              })}
            </Card>
          )}

          <Card style={{ padding: 0, overflow: 'hidden' }}>
            <div style={{ padding: '10px 16px', fontSize: 13, fontWeight: 600, borderBottom: '1px solid var(--border)' }}>
              Data preview (first {previewRows.length} rows)
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: colAccount ? '110px 1fr 130px 100px' : '110px 1fr 100px', padding: '7px 16px', fontSize: 11, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em', borderBottom: '1px solid var(--border)' }}>
              <span>Date</span><span>Description</span>
              {colAccount && <span>Account</span>}
              <span style={{ textAlign: 'right' }}>Amount</span>
            </div>
            {previewRows.length === 0 ? (
              <div style={{ padding: '16px', fontSize: 13, color: 'var(--muted)', textAlign: 'center' }}>Map at least the date and description columns to see a preview</div>
            ) : previewRows.map(r => (
              <div key={r.i} style={{ display: 'grid', gridTemplateColumns: colAccount ? '110px 1fr 130px 100px' : '110px 1fr 100px', padding: '8px 16px', fontSize: 13, borderBottom: '1px solid var(--border)' }}>
                <span style={{ color: r.rawDate ? 'var(--text)' : 'var(--muted)', fontSize: 12 }}>{r.rawDate || <span style={{ opacity: 0.4 }}>—</span>}</span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.rawDesc || <span style={{ color: 'var(--muted)', opacity: 0.4 }}>—</span>}</span>
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
            <Button onClick={runImport} disabled={!canImport() || loading}>
              {loading ? 'Importing…' : `Import ${Math.max(0, preview.total_rows - skipRows)} rows`}
            </Button>
            <Button variant="ghost" onClick={resetImport}>Cancel</Button>
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
            const otherSkipped = importResult.skipped - importResult.account_skipped
            if (otherSkipped > 0)                  parts.push(`${otherSkipped} invalid rows`)
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
          {importResult.new_accounts_created > 0 && (
            <div style={{
              fontSize: 13, marginBottom: 16, padding: '8px 12px',
              background: 'color-mix(in srgb, var(--accent2) 8%, var(--surface2))',
              border: '1px solid color-mix(in srgb, var(--accent2) 30%, var(--border))',
              borderRadius: 8,
            }}>
              {importResult.new_accounts_created} new account{importResult.new_accounts_created > 1 ? 's were' : ' was'} created.
              {importResult.owner_inferred
                ? ' Owner was inferred from other accounts in this import.'
                : ' These accounts have no owner assigned — visit '}
              {!importResult.owner_inferred && (
                <Link to="/settings" style={{ color: 'var(--accent2)', textDecoration: 'none' }}>
                  Settings → Account ownership
                </Link>
              )}
              {!importResult.owner_inferred && ' to assign one.'}
            </div>
          )}
          {importResult.errors?.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6, color: 'var(--danger)' }}>{importResult.errors.length} rows had errors:</div>
              {importResult.errors.map((e, i) => <div key={i} style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 3 }}>Row {e.row}: {e.reason}</div>)}
            </div>
          )}
          <Button onClick={resetImport}>Import another file</Button>
        </Card>
      )}

      <SectionTitle>Recent imports</SectionTitle>
      <Card style={{ padding: 0, overflow: 'hidden' }}>
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
                          {!a.was_skipped && <span style={{ color: 'var(--muted)' }}>{a.row_count}</span>}
                          {a.was_skipped && a.row_count > 0 && <span style={{ color: 'var(--muted)' }}>{a.row_count}</span>}
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
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.merchant_name}</span>
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
  const [restoreFile,  setRestoreFile]  = useState(null)
  const [credsFile,    setCredsFile]    = useState(null)
  const [restoring,    setRestoring]    = useState(false)
  const [restoreMsg,   setRestoreMsg]   = useState(null)
  const [includeTxns,  setIncludeTxns]  = useState(true)

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

  async function handleRestore(file, type) {
    const text = await file.text()
    let data; try { data = JSON.parse(text) } catch { alert('Invalid JSON'); return }
    if (type === 'credentials') {
      if (!confirm('Replace Plaid credentials?')) return
      setRestoring(true)
      try { const r = await api.restoreCredentials(data); setRestoreMsg(`✅ Restored ${r.restored} credential(s).`) }
      catch (e) { setRestoreMsg(`❌ ${e.message}`) }
      setRestoring(false); return
    }
    if (!confirm('REPLACE all data with this backup? This cannot be undone.')) return
    setRestoring(true)
    try { await api.restoreBackup(data, includeTxns); setRestoreMsg('✅ Restored. Reload the page.') }
    catch (e) { setRestoreMsg(`❌ ${e.message}`) }
    setRestoring(false)
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

      <SectionTitle>Backup</SectionTitle>
      <Card style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Data backup</div>
          <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 10 }}>All categories, rules, owners, accounts, transactions. No Plaid tokens.</div>
          <a href={api.exportBackup()} download="fintrack_backup.json"><Button>⬇ Download data backup</Button></a>
        </div>
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 16 }}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Credentials backup</div>
          <div style={{ fontSize: 13, marginBottom: 10, background: 'color-mix(in srgb, #f59e0b 10%, var(--surface2))', border: '1px solid #f59e0b', borderRadius: 6, padding: '8px 12px' }}>
            ⚠️ Contains Plaid access tokens — treat like a password.
          </div>
          <a href={api.exportCredentials()} download="fintrack_credentials.json"><Button variant="ghost">⬇ Download credentials backup</Button></a>
        </div>
      </Card>

      <SectionTitle>Restore</SectionTitle>
      <Card style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        {restoreMsg && <div style={{ padding: '10px 14px', borderRadius: 8, fontSize: 14, background: restoreMsg.startsWith('✅') ? 'color-mix(in srgb, var(--success) 12%, var(--surface2))' : 'color-mix(in srgb, var(--danger) 12%, var(--surface2))' }}>{restoreMsg}</div>}
        <div>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Restore from data backup</div>
          <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 10 }}>Replaces all existing data. Plaid credentials not affected.</div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginBottom: 10, cursor: 'pointer' }}>
            <input type="checkbox" checked={includeTxns} onChange={e => setIncludeTxns(e.target.checked)} />Include transactions
          </label>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <input type="file" accept=".json" onChange={e => setRestoreFile(e.target.files[0])} style={{ fontSize: 13 }} />
            <Button variant="danger" disabled={!restoreFile || restoring} onClick={() => handleRestore(restoreFile, 'data')}>
              {restoring ? 'Restoring…' : 'Restore data'}
            </Button>
          </div>
        </div>
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 16 }}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Restore Plaid credentials</div>
          <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 10 }}>Only needed after restoring to a new machine.</div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <input type="file" accept=".json" onChange={e => setCredsFile(e.target.files[0])} style={{ fontSize: 13 }} />
            <Button variant="ghost" disabled={!credsFile || restoring} onClick={() => handleRestore(credsFile, 'credentials')}>
              {restoring ? 'Restoring…' : 'Restore credentials'}
            </Button>
          </div>
        </div>
      </Card>
    </div>
  )
}

export default function ImportExport() {
  const [tab, setTab] = useState('import')
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ padding: '32px 32px 0', flexShrink: 0 }}>
        <PageHeader title="Import / Export" />
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 32px 32px' }}>
        <div style={{ display: 'flex', marginBottom: 24, borderBottom: '1px solid var(--border)' }}>
        {[['import', '⬆ Import'], ['export', '⬇ Export']].map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)} style={{ padding: '8px 24px', border: 'none', background: 'none', cursor: 'pointer', fontSize: 14, color: tab === id ? 'var(--text)' : 'var(--muted)', borderBottom: tab === id ? '2px solid var(--accent)' : '2px solid transparent', fontWeight: tab === id ? 500 : 400 }}>{label}</button>
        ))}
        </div>
        {tab === 'import' && <ImportErrorBoundary><ImportTab /></ImportErrorBoundary>}
        {tab === 'export' && <ExportTab />}
      </div>
    </div>
  )
}
