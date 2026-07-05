// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/* eslint-disable react-refresh/only-export-components -- RuleForm + amountConditionSummary helper used to describe a rule's amount clause in the rules list */

import { forwardRef, useCallback, useMemo, useState, useEffect, useImperativeHandle, useLayoutEffect, useRef, useId } from 'react'
import { api } from '../lib/api.js'
import CategoryPicker from './CategoryPicker.jsx'
import {
  Button,
  DialogActions,
  FloatingPanel,
  FloatingPanelHeader,
  OverlayBackdrop,
  SectionEyebrow,
  getFormControlStyle,
} from './ui.jsx'
import TagPickerWithCreate from './TagPickerWithCreate.jsx'
import { useTags } from '../lib/useTags.js'
import PillGridTable from './PillGridTable.jsx'
import { CategoryCell, MerchantCell, TransactionAmountCell } from './TransactionRow.jsx'
import { formatDate } from '../lib/utils.js'
import { useUserPreference } from '../lib/UserPreferencesContext.jsx'
import { OriginFieldList } from './OriginFields.jsx'
import { getTxnMerchantOriginRows } from '../lib/importSourceFields.js'
import FeatureExplainer from '../help/FeatureExplainer.jsx'

const RULE_PREVIEW_COLUMNS_PREF_KEY = 'ui.rules.affectedTransactions.columns'

const RULE_PREVIEW_DEFAULT_COLUMNS = [
  { key: 'date', label: 'Date', width: 96, minWidth: 82 },
  { key: 'merchant', label: 'Merchant', width: 260, minWidth: 150 },
  { key: 'category', label: 'Category', width: 150, minWidth: 110 },
  { key: 'account', label: 'Account', width: 140, minWidth: 110 },
  { key: 'amount', label: 'Amount', width: 108, minWidth: 88, align: 'end' },
]

function normalizeRulePreviewColumnConfig(savedColumns, defaultColumns) {
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

const sectionHeadStyle = {
  fontSize: 11, fontWeight: 700, color: 'var(--accent2)',
  letterSpacing: '0.03em',
  marginBottom: 12,
}

// Cadence choices for a rule-backed recurring series (mirrors the Recurring page labels).
const RULE_CADENCE_OPTIONS = [
  ['weekly', 'Weekly'], ['biweekly', 'Every 2 weeks'], ['monthly', 'Monthly'],
  ['quarterly', 'Quarterly'], ['semiannual', 'Every 6 months'], ['annual', 'Annually'],
]

export function amountConditionSummary(low, lowOp, high, highOp, side) {
  const parts = []
  if (side && side !== 'both') parts.push(side === 'debit' ? 'debit' : 'credit')
  if (low != null && high != null && low === high) {
    parts.push(`= $${low}`)
  } else {
    if (low != null) parts.push(`${lowOp ?? '>='} $${low}`)
    if (high != null) parts.push(`${highOp ?? '<='} $${high}`)
  }
  return parts.length ? parts.join(', ') : null
}

function getCategoryDisplayLabel(categories, categoryId) {
  if (!categoryId) return null
  const leaves = categories.filter(category => category.parent_id)
  const groupsById = new Map(categories.filter(category => !category.parent_id).map(group => [group.id, group]))
  const selected = leaves.find(category => String(category.id) === String(categoryId))
  if (!selected) return null
  const normalizedName = String(selected.name || '').trim().toLowerCase()
  const duplicateCount = leaves.filter(category => String(category.name || '').trim().toLowerCase() === normalizedName).length
  if (duplicateCount <= 1) return selected.name
  const group = groupsById.get(selected.parent_id)
  return group?.name ? `${group.name}: ${selected.name}` : selected.name
}

function NumberInput({ value, onChange, placeholder, width = 88, name = '', ariaLabel = '' }) {
  return (
    <input
      type="number" min="0" step="0.01"
      name={name || undefined}
      aria-label={ariaLabel || undefined}
      value={value ?? ''}
      onChange={e => onChange(e.target.value === '' ? null : parseFloat(e.target.value))}
      placeholder={placeholder}
      style={{
        width,
        ...getFormControlStyle({ size: 'md' }),
      }}
    />
  )
}

function OpSelect({ value, onChange, options, name = '', ariaLabel = '' }) {
  return (
    <select
      name={name || undefined}
      aria-label={ariaLabel || undefined}
      value={value}
      onChange={e => onChange(e.target.value)}
      style={{
        ...getFormControlStyle({ size: 'md', clickable: true }),
        padding: '6px 6px',
      }}
    >
      {options.map(o => <option key={o} value={o}>{o}</option>)}
    </select>
  )
}

function SegButton({ active, onClick, children }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '4px 10px', fontSize: 12, cursor: 'pointer',
        border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
        background: active ? 'var(--accent)' : 'transparent',
        color: active ? '#fff' : 'var(--muted)',
        fontWeight: active ? 500 : 400,
        borderRadius: 6,
      }}
    >{children}</button>
  )
}

function AmountCondition({ low, lowOp, high, highOp, side, onChange }) {
  const isEquals = low != null && high != null && low === high
  function setLow(v) { onChange({ low: v, lowOp, high, highOp, side }) }
  function setLowOp(op) { onChange({ low, lowOp: op, high, highOp, side }) }
  function setHigh(v) { onChange({ low, lowOp, high: v, highOp, side }) }
  function setHighOp(op) { onChange({ low, lowOp, high, highOp: op, side }) }
  function setSide(s) { onChange({ low, lowOp, high, highOp, side: s }) }

  function setEquals(v) { onChange({ low: v, lowOp: '>=', high: v, highOp: '<=', side }) }

  function toggleEquals() {
    if (isEquals) {
      onChange({ low, lowOp: '>=', high: null, highOp: '<=', side })
    } else {
      const v = low ?? high ?? 0
      onChange({ low: v, lowOp: '>=', high: v, highOp: '<=', side })
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 12, color: 'var(--muted)', minWidth: 68 }}>Applies to</span>
        <div style={{ display: 'flex', gap: 4 }}>
          <SegButton active={side === 'both'} onClick={() => setSide('both')}>Both</SegButton>
          <SegButton active={side === 'debit'} onClick={() => setSide('debit')}>Debits</SegButton>
          <SegButton active={side === 'credit'} onClick={() => setSide('credit')}>Credits</SegButton>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 12, color: 'var(--muted)', minWidth: 68 }}>Mode</span>
        <div style={{ display: 'flex', gap: 4 }}>
          <SegButton active={!isEquals} onClick={() => isEquals && toggleEquals()}>Range</SegButton>
          <SegButton active={isEquals} onClick={() => !isEquals && toggleEquals()}>Equals</SegButton>
        </div>
      </div>

      {isEquals ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 12, color: 'var(--muted)', minWidth: 68 }}>Amount =</span>
          <span style={{ fontSize: 13, color: 'var(--muted)' }}>$</span>
          <NumberInput value={low} onChange={setEquals} placeholder="0.00" name="rule-amount-equals" ariaLabel="Rule amount equals" />
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 12, color: 'var(--muted)', minWidth: 68 }}>
              {low != null ? 'Lower' : <span style={{ opacity: 0.5 }}>Lower</span>}
            </span>
            <OpSelect value={lowOp ?? '>='} onChange={setLowOp} options={['>=', '>']} name="rule-amount-lower-operator" ariaLabel="Rule lower amount operator" />
            <span style={{ fontSize: 13, color: 'var(--muted)' }}>$</span>
            <NumberInput value={low} onChange={setLow} placeholder="no lower limit" width={110} name="rule-amount-lower-bound" ariaLabel="Rule lower amount" />
            {low != null && (
              <button onClick={() => setLow(null)} style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: '0 2px' }}>×</button>
            )}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 12, color: 'var(--muted)', minWidth: 68 }}>
              {high != null ? 'Upper' : <span style={{ opacity: 0.5 }}>Upper</span>}
            </span>
            <OpSelect value={highOp ?? '<='} onChange={setHighOp} options={['<=', '<']} name="rule-amount-upper-operator" ariaLabel="Rule upper amount operator" />
            <span style={{ fontSize: 13, color: 'var(--muted)' }}>$</span>
            <NumberInput value={high} onChange={setHigh} placeholder="no upper limit" width={110} name="rule-amount-upper-bound" ariaLabel="Rule upper amount" />
            {high != null && (
              <button onClick={() => setHigh(null)} style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: '0 2px' }}>×</button>
            )}
          </div>
        </div>
      )}

      <div style={{ fontSize: 11, color: 'var(--muted)' }}>
        Amount ranges use absolute value, and the debit/credit toggle applies the sign separately.
      </div>
    </div>
  )
}

function ConditionChip({ label, summary, active, expanded = true, onActivate, onClear, children, containerRef, triggerRef }) {
  if (!active) {
    return (
      <button
        ref={triggerRef}
        onClick={onActivate}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 5,
          padding: '5px 10px', borderRadius: 20, fontSize: 12,
          border: '1px dashed var(--border)', background: 'transparent',
          color: 'var(--muted)', cursor: 'pointer', transition: 'all 0.1s',
        }}
        onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--accent)'; e.currentTarget.style.color = 'var(--accent2)' }}
        onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.color = 'var(--muted)' }}
      >
        <span style={{ fontSize: 11 }}>＋</span> {label}
      </button>
    )
  }
  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      style={{ border: '1px solid var(--accent)', borderRadius: 10, background: 'color-mix(in srgb, var(--accent) 5%, var(--surface))', overflow: 'hidden', outline: 'none' }}
    >
      <div
        role="button"
        tabIndex={0}
        onClick={onActivate}
        onKeyDown={event => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            onActivate?.()
          }
        }}
        style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '6px 10px', border: 'none', borderBottom: expanded ? '1px solid var(--border)' : 'none', background: 'color-mix(in srgb, var(--accent) 8%, var(--surface2))', textAlign: 'left', cursor: 'pointer' }}
      >
        <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--accent2)', letterSpacing: '0.03em', whiteSpace: 'nowrap' }}>{label}</span>
        {summary && <span style={{ fontSize: 12, color: 'var(--muted)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{summary}</span>}
        <button type="button" onClick={event => { event.stopPropagation(); onClear() }} title={`Remove ${label}`} style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: '0 2px', flexShrink: 0 }}>×</button>
      </div>
      {expanded ? <div style={{ padding: '10px 12px' }}>{children}</div> : null}
    </div>
  )
}

/*
 * Scroll model mirrors the duplicate-rows dialog: a single outer scroll container owns both axes and the
 * pill header stays visible via position:sticky. A nested vertical scroll on the table body would consume
 * width from the grid's last column and clip the Amount cell when the scrollbar appears, so new column
 * previews or similar modals should keep this shape rather than wrapping a fillHeight table.
 */
function RulePreviewDetail({ transactions, categories, onClose }) {
  const [savedColumns, setSavedColumns] = useUserPreference(RULE_PREVIEW_COLUMNS_PREF_KEY, [])
  const [columns, setColumns] = useState(() => normalizeRulePreviewColumnConfig(savedColumns, RULE_PREVIEW_DEFAULT_COLUMNS))

  useEffect(() => {
    setColumns(normalizeRulePreviewColumnConfig(savedColumns, RULE_PREVIEW_DEFAULT_COLUMNS))
  }, [savedColumns])

  function handleColumnsChange(nextColumns) {
    setColumns(nextColumns)
    setSavedColumns(nextColumns.map(col => ({ key: col.key, width: col.width }))).catch(() => { })
  }

  function renderCell(columnKey, txn) {
    switch (columnKey) {
      case 'date':
        return <span style={{ color: 'var(--muted)', fontSize: 12 }}>{formatDate(txn.date)}</span>
      case 'merchant':
        return <MerchantCell txn={txn} />
      case 'category':
        return <CategoryCell txn={txn} categories={categories} />
      case 'account':
        return (
          <span
            title={`${txn.account_name}${txn.account_mask ? ` ···${txn.account_mask}` : ''}`}
            style={{
              color: 'var(--muted)',
              fontSize: 12,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {txn.account_name}{txn.account_mask ? ` ···${txn.account_mask}` : ''}
          </span>
        )
      case 'amount':
        return <TransactionAmountCell txn={txn} />
      default:
        return null
    }
  }

  const pillColumns = useMemo(
    () => columns.map(col => ({
      ...col,
      draggable: true,
      resizable: true,
      title: `Drag middle to move ${col.label}`,
    })),
    [columns],
  )

  return (
    <OverlayBackdrop zIndex={1400} tint="rgba(15, 23, 42, 0.42)">
      <FloatingPanel style={{ width: 'min(960px, 100%)', maxHeight: '80vh', display: 'flex', flexDirection: 'column' }}>
        <FloatingPanelHeader style={{ padding: '16px 20px 14px' }}>
          <div>
            <div style={{ fontSize: 17, fontWeight: 600 }}>Transactions Affected by This Rule</div>
            <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 2 }}>
              {transactions.length} transaction{transactions.length !== 1 ? 's' : ''} where applying this rule would make a change
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'none', border: 'none', color: 'var(--muted)',
              cursor: 'pointer', fontSize: 22, padding: '0 4px', lineHeight: 1,
            }}
          >×</button>
        </FloatingPanelHeader>
        <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          {transactions.length === 0 ? (
            <div style={{ margin: 18, padding: '12px 14px', borderRadius: 10, border: '1px solid var(--border)', background: 'color-mix(in srgb, var(--surface2) 36%, var(--surface))', fontSize: 13, color: 'var(--muted)' }}>
              No transactions would be affected.
            </div>
          ) : (
            <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
              <div style={{ padding: '0 18px 18px' }}>
                <PillGridTable
                  columns={pillColumns}
                  onColumnsChange={handleColumnsChange}
                  headerStyle={{
                    padding: '6px 0',
                    background: 'color-mix(in srgb, var(--surface2) 92%, var(--surface))',
                    position: 'sticky',
                    top: 0,
                    zIndex: 2,
                  }}
                  renderBody={({ columns: activeColumns, gridTemplateColumns }) => (
                    <div style={{ fontSize: 13 }}>
                      {transactions.map(txn => (
                        <div
                          key={txn.id}
                          style={{
                            display: 'grid',
                            gridTemplateColumns,
                            padding: '10px 0',
                            alignItems: 'center',
                            borderBottom: '1px solid color-mix(in srgb, var(--border) 72%, transparent)',
                          }}
                        >
                          {activeColumns.map(col => (
                            <div
                              key={col.key}
                              style={{
                                minWidth: 0,
                                padding: '0 9px',
                                ...(col.key === 'amount' ? {} : { overflow: 'hidden' }),
                              }}
                            >
                              {renderCell(col.key, txn)}
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
        <div style={{ padding: '14px 18px', borderTop: '1px solid var(--border)', background: 'color-mix(in srgb, var(--surface2) 66%, var(--surface))', display: 'flex', justifyContent: 'flex-end' }}>
          <Button variant="ghost" onClick={onClose}>Close</Button>
        </div>
      </FloatingPanel>
    </OverlayBackdrop>
  )
}

function MatchCountInline({ keyword, amtLow, amtHigh, amtSide, ownerId, accountId, matchSourceText, onCountChange }) {
  const [count, setCount] = useState(null)
  const [loading, setLoading] = useState(false)
  const debounceRef = useRef(null)

  const hasKeyword = keyword.trim().length >= 2
  const hasAmount = amtLow != null || amtHigh != null
  const canSearch = !matchSourceText && (hasKeyword || hasAmount)

  useEffect(() => {
    if (!canSearch) {
      setCount(null)
      onCountChange(0)
      return
    }
    clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(async () => {
      setLoading(true)
      try {
        const resp = await api.getTransactions({
          limit: 500,
          ...(hasKeyword ? { search: keyword.trim() } : {}),
          ...(ownerId ? { owner_ids: ownerId } : {}),
          ...(accountId ? { account_ids: accountId } : {}),
        })
        const matched = resp.transactions.filter(t => {
          const abs = Math.abs(t.amount)
          if (amtSide === 'debit' && !(t.amount > 0)) return false
          if (amtSide === 'credit' && !(t.amount < 0)) return false
          if (amtLow != null && abs < amtLow) return false
          if (amtHigh != null && abs > amtHigh) return false
          return true
        })
        setCount(matched.length)
        onCountChange(matched.length)
      } catch {
        setCount(null)
        onCountChange(0)
      } finally {
        setLoading(false)
      }
    }, 600)
    return () => clearTimeout(debounceRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyword, amtLow, amtHigh, amtSide, ownerId, accountId, matchSourceText, canSearch])

  if (!canSearch) return null
  if (loading) return <span style={{ fontSize: 12, color: 'var(--muted)' }}>checking matches…</span>
  if (count == null || count === 0) return null
  return (
    <span style={{ fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap' }}>
      {count} matching row{count === 1 ? '' : 's'}
    </span>
  )
}

/*
 * The form is organized around a "read the rule as a sentence" model: the header mirrors the live draft while
 * each chip expands into one condition or action editor. Transaction context can prefill the amount rule, but
 * only once the user opens that section so the form still feels suggestion-driven rather than silently mutated.
 */
const RuleForm = forwardRef(function RuleForm({
  initialValues = {},
  categories,
  owners,
  accounts,
  onSave,
  onCancel,
  saveLabel = 'Save rule',
  transactionData = null,
  // A source row used ONLY to populate the read-only "From the source file" panel — distinct from
  // `transactionData` (which also seeds amount defaults). The suggestion editor passes a single
  // resolved example row here so the panel can show without disturbing the suggestion's amount scope.
  sourceTransaction = null,
  showApplyToExisting = true,
  hideFooter = false,
  hideFooterActions = false,
  hideMatchCount = false,
  onDraftChange,
  onCategoriesChanged,
  onTagCreated,
  mode = 'full',
}, ref) {
  const fieldIdBase = useId()
  const getTransactionAmountState = () => {
    if (!transactionData || transactionData.amount == null) return null
    const absAmount = Math.abs(transactionData.amount)
    return {
      amtLow: absAmount,
      amtLowOp: '>=',
      amtHigh: absAmount,
      amtHighOp: '<=',
      amtSide: transactionData.amount > 0 ? 'debit' : 'credit',
    }
  }

  const getInitialAmountState = () => {
    const initialAmountMin = initialValues.amount_min ?? initialValues.amtMin ?? null
    const initialAmountMax = initialValues.amount_max ?? initialValues.amtMax ?? null
    if (initialAmountMin != null || initialAmountMax != null) {
      return {
        amtLow: initialAmountMin,
        amtLowOp: initialValues.amount_min_op ?? '>=',
        amtHigh: initialAmountMax,
        amtHighOp: initialValues.amount_max_op ?? '<=',
        amtSide: initialValues.debit_credit ?? 'both',
      }
    }
    return {
      amtLow: null,
      amtLowOp: '>=',
      amtHigh: null,
      amtHighOp: '<=',
      amtSide: 'both',
    }
  }

  const transactionDefaults = getTransactionAmountState()
  const initialAmount = getInitialAmountState()

  const [keyword, setKeyword] = useState(initialValues.keyword ?? '')
  const [amtLow, setAmtLow] = useState(initialAmount.amtLow)
  const [amtLowOp, setAmtLowOp] = useState(initialAmount.amtLowOp)
  const [amtHigh, setAmtHigh] = useState(initialAmount.amtHigh)
  const [amtHighOp, setAmtHighOp] = useState(initialAmount.amtHighOp)
  const [amtSide, setAmtSide] = useState(initialAmount.amtSide)
  const [ownerId, setOwnerId] = useState(initialValues.ownerId ?? initialValues.owner_id ?? '')
  const [accountId, setAccountId] = useState(initialValues.accountId ?? initialValues.account_id ?? '')
  // Opt-in: also match the keyword against the row's captured import source text (description + extra
  // evidence fields like "Original Statement"), not just the merchant/raw/display name.
  const [matchSourceText, setMatchSourceText] = useState(!!(initialValues.matchSourceText ?? initialValues.match_source_text ?? false))
  // Rule-backed recurring series: the rule's matches become a recurring series (cadence seeds its rhythm).
  const [isRecurring, setIsRecurring] = useState(!!(initialValues.isRecurring ?? initialValues.is_recurring ?? false))
  const [cadence, setCadence] = useState(initialValues.cadence ?? 'monthly')

  const [kwOpen, setKwOpen] = useState(!!initialValues.keyword)
  const [amtOpen, setAmtOpen] = useState(!!(initialAmount.amtLow != null || initialAmount.amtHigh != null || initialAmount.amtSide !== 'both'))
  const [ownOpen, setOwnOpen] = useState(!!(initialValues.ownerId ?? initialValues.owner_id))
  const [accOpen, setAccOpen] = useState(!!(initialValues.accountId ?? initialValues.account_id))

  const [catId, setCatId] = useState(initialValues.catId ?? '')
  const [cleanName, setCleanName] = useState(initialValues.cleanName ?? '')
  const [renameOpen, setRenameOpen] = useState(!!initialValues.cleanName)
  const [renameExpanded, setRenameExpanded] = useState(!!initialValues.cleanName)
  const [tagIds, setTagIds] = useState(initialValues.tagIds ?? initialValues.tag_ids ?? [])
  const [tagsOpen, setTagsOpen] = useState(!!((initialValues.tagIds ?? initialValues.tag_ids ?? []).length))
  const { tags: availableTags, addTag } = useTags()

  const [, setMatchCount] = useState(0)
  const [applyToExisting, setApplyToExisting] = useState(false)
  const [changeCount, setChangeCount] = useState(0)
  const [changeTransactions, setChangeTransactions] = useState([])
  const [previewDetailOpen, setPreviewDetailOpen] = useState(false)
  const changeDebounceRef = useRef(null)

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const [transactionDefaultsApplied, setTransactionDefaultsApplied] = useState(false)
  const keywordConditionRef = useRef(null)
  const renameConditionRef = useRef(null)
  const renameInputRef = useRef(null)
  const keywordConditionTriggerRef = useRef(null)
  const renameConditionTriggerRef = useRef(null)
  const keywordEditSnapshotRef = useRef({
    value: initialValues.keyword ?? '',
    open: !!initialValues.keyword,
  })
  const renameEditSnapshotRef = useRef({
    value: initialValues.cleanName ?? '',
    open: !!initialValues.cleanName,
  })
  // Keyword and rename Escape-restore to whichever value/open state the edit started from.
  // The read-only source panel's collapsed state is remembered per user so it stays out of the way.
  const [sourcePanelOpen, setSourcePanelOpen] = useUserPreference('ui.ruleForm.sourcePanelOpen', true)

  useEffect(() => {
    // Treat transaction-derived amount data as a starting suggestion; once the user edits the amount condition, stop auto-hydrating it.
    if (
      amtOpen &&
      !transactionDefaultsApplied &&
      transactionDefaults &&
      amtLow == null && amtHigh == null
    ) {
      setAmtLow(transactionDefaults.amtLow)
      setAmtLowOp(transactionDefaults.amtLowOp)
      setAmtHigh(transactionDefaults.amtHigh)
      setAmtHighOp(transactionDefaults.amtHighOp)
      setAmtSide(transactionDefaults.amtSide)
      setTransactionDefaultsApplied(true)
    }
  }, [amtOpen, transactionDefaultsApplied, transactionDefaults, amtLow, amtHigh])


  const selectedTags = availableTags.filter(tag => tagIds.includes(tag.id))
  const matchOnly = mode === 'match-only'
  const hasAction = Boolean(catId || cleanName.trim() || tagIds.length > 0 || isRecurring)
  const canSave = matchOnly ? keyword.trim().length > 0 : (keyword.trim().length > 0 && hasAction)

  useEffect(() => {
    if (matchOnly) {
      clearTimeout(changeDebounceRef.current)
      setChangeCount(0)
      setChangeTransactions([])
      setApplyToExisting(false)
      setPreviewDetailOpen(false)
      return undefined
    }
    const hasKeyword = keyword.trim().length >= 2
    const hasAmount = amtLow != null || amtHigh != null
    if ((!hasKeyword && !hasAmount) || (!matchOnly && !hasAction)) {
      clearTimeout(changeDebounceRef.current)
      setChangeCount(0)
      setChangeTransactions([])
      setApplyToExisting(false)
      setPreviewDetailOpen(false)
      return
    }
    clearTimeout(changeDebounceRef.current)
    changeDebounceRef.current = setTimeout(async () => {
      try {
        const result = await api.previewRule({
          keyword: keyword.trim(),
          category_id: catId || null,
          amount_min: amtLow,
          amount_max: amtHigh,
          debit_credit: amtSide,
          clean_name: cleanName.trim() || null,
          owner_id: ownerId || null,
          account_id: accountId || null,
          tag_ids: tagIds,
          match_source_text: matchSourceText,
        })
        setChangeCount(result.count)
        setChangeTransactions(result.transactions)
        if (result.count === 0) {
          setApplyToExisting(false)
          setPreviewDetailOpen(false)
        }
      } catch {
        setChangeCount(0)
        setChangeTransactions([])
      }
    }, 700)
    return () => clearTimeout(changeDebounceRef.current)
  }, [keyword, amtLow, amtHigh, amtSide, ownerId, accountId, catId, cleanName, tagIds, matchSourceText, hasAction, matchOnly])

  const buildDraftPayload = useCallback(() => ({
    keyword: keyword.trim(),
    category_id: catId || null,
    amount_min: amtLow,
    amount_max: amtHigh,
    debit_credit: amtSide,
    clean_name: cleanName.trim() || null,
    owner_id: ownerId || null,
    account_id: accountId || null,
    tag_ids: tagIds,
    match_source_text: matchSourceText,
    is_recurring: isRecurring,
    cadence: isRecurring ? cadence : null,
    clear_amount_min: amtLow === null,
    clear_amount_max: amtHigh === null,
    clear_clean_name: !cleanName.trim(),
    clear_owner: !ownerId,
    clear_account: !accountId,
    applyToExisting,
  }), [keyword, catId, amtLow, amtHigh, amtSide, cleanName, ownerId, accountId, tagIds, matchSourceText, isRecurring, cadence, applyToExisting])

  const getDraftState = useCallback(() => ({
    data: buildDraftPayload(),
    canSave,
  }), [buildDraftPayload, canSave])

  useLayoutEffect(() => {
    onDraftChange?.({
      data: buildDraftPayload(),
      canSave,
    })
  }, [buildDraftPayload, canSave, onDraftChange])

  useImperativeHandle(ref, () => ({
    getDraftState,
  }), [getDraftState])

  function handleAmtChange({ low, lowOp, high, highOp, side }) {
    setAmtLow(low); setAmtLowOp(lowOp ?? '>=')
    setAmtHigh(high); setAmtHighOp(highOp ?? '<=')
    setAmtSide(side ?? 'both')
  }

  function captureKeywordEditState() {
    keywordEditSnapshotRef.current = {
      value: keyword,
      open: kwOpen,
    }
  }

  function cancelKeywordEdit(target, focusRef = null, closeEditor = false) {
    setKeyword(keywordEditSnapshotRef.current.value)
    setKwOpen(closeEditor ? false : keywordEditSnapshotRef.current.open)
    setTimeout(() => {
      if (closeEditor && keywordConditionTriggerRef.current) {
        keywordConditionTriggerRef.current.focus()
        return
      }
      if (focusRef?.current) {
        focusRef.current.focus()
        return
      }
      target?.focus?.()
      target?.select?.()
    }, 0)
  }

  function captureRenameEditState() {
    renameEditSnapshotRef.current = {
      value: cleanName,
      open: renameOpen,
    }
  }

  function cancelRenameEdit(target, focusRef = null, closeEditor = false) {
    setCleanName(renameEditSnapshotRef.current.value)
    setRenameOpen(closeEditor ? false : renameEditSnapshotRef.current.open)
    setRenameExpanded(closeEditor ? false : renameEditSnapshotRef.current.open)
    setTimeout(() => {
      if (closeEditor && renameConditionTriggerRef.current) {
        renameConditionTriggerRef.current.focus()
        return
      }
      if (focusRef?.current) {
        focusRef.current.focus()
        return
      }
      target?.focus?.()
      target?.select?.()
    }, 0)
  }

  function openRenameEditor() {
    setRenameOpen(true)
    setRenameExpanded(true)
    setTimeout(() => {
      renameInputRef.current?.focus()
      renameInputRef.current?.select()
    }, 0)
  }

  function commitRenameEditor() {
    const nextValue = cleanName.trim()
    setCleanName(nextValue)
    setRenameOpen(Boolean(nextValue))
    setRenameExpanded(false)
    setTimeout(() => {
      if (nextValue) {
        renameConditionRef.current?.focus()
      } else {
        renameInputRef.current?.focus()
      }
    }, 0)
  }

  async function handleSave() {
    if (!canSave) return
    setSaving(true); setError(null)
    try {
      await onSave(buildDraftPayload())
    } catch (e) {
      setError(e.message || 'Failed to save rule')
      setSaving(false)
    }
  }

  const amtSummary = amountConditionSummary(amtLow, amtLowOp, amtHigh, amtHighOp, amtSide)
  const selectedCategoryName = getCategoryDisplayLabel(categories, catId)
  // Read-only action labels for the bottom rule summary (editing happens in the sections above).
  const actionSummaryLabels = [
    catId && selectedCategoryName ? `category: ${selectedCategoryName}` : null,
    renameOpen && cleanName.trim() ? `rename to ${cleanName.trim()}` : null,
    ...selectedTags.map(tag => `tag: ${tag.name}`),
  ].filter(Boolean)
  // The captured source text for this rule's example transaction (when one anchors the form): the raw
  // description + extra evidence fields like "Original Statement". Empty for abstract edits (Rules page)
  // and the aggregate suggestion editor — those have no single source row.
  const sourceRowForPanel = sourceTransaction || transactionData
  const sourceOriginRows = sourceRowForPanel ? getTxnMerchantOriginRows(sourceRowForPanel) : []

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {sourceOriginRows.length > 0 ? (
        <div style={{ padding: '14px 20px', borderBottom: '2px solid var(--border)', background: 'color-mix(in srgb, var(--surface2) 64%, var(--surface))' }}>
          <button
            type="button"
            onClick={() => setSourcePanelOpen(open => !open)}
            style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left' }}
            title={sourcePanelOpen ? 'Hide the source text' : 'Show the source text'}
          >
            <span style={{ ...sectionHeadStyle, marginBottom: 0 }}>From The Source File</span>
            <span aria-hidden="true" style={{ fontSize: 9, color: 'var(--muted)', transform: sourcePanelOpen ? 'rotate(90deg)' : 'none', transition: 'transform 120ms' }}>▶</span>
          </button>
          {sourcePanelOpen ? (
            <div style={{ marginTop: 10 }}>
              <OriginFieldList rows={sourceOriginRows} />
              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 8 }}>
                What the bank reported for this transaction. Turn on &ldquo;match the original / source statement text&rdquo; below to build the rule on this text.
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      <div style={{ padding: '16px 20px', borderBottom: '2px solid var(--border)' }}>
        <div style={sectionHeadStyle}>If The Transaction Matches…</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <ConditionChip
            label="Merchant Name Contains"
            summary={kwOpen && keyword.trim() ? `"${keyword}"` : null}
            active={kwOpen}
            onActivate={() => setKwOpen(true)}
            onClear={() => { setKeyword(''); setKwOpen(false) }}
            containerRef={keywordConditionRef}
            triggerRef={keywordConditionTriggerRef}
          >
            <input
              id={`${fieldIdBase}-keyword`}
              name="rule-keyword"
              aria-label="Rule merchant keyword"
              autoFocus={kwOpen && !initialValues.keyword}
              value={keyword}
              onFocus={captureKeywordEditState}
              onChange={e => setKeyword(e.target.value)}
              onKeyDown={event => {
                if (event.key !== 'Escape') return
                event.stopPropagation()
                event.preventDefault()
                cancelKeywordEdit(event.currentTarget, keywordConditionRef, true)
              }}
              placeholder="e.g. starbucks"
              style={{ width: '100%', boxSizing: 'border-box', ...getFormControlStyle({ size: 'md' }) }}
            />
            <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 5 }}>Case-insensitive substring match</div>
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginTop: 9, cursor: 'pointer' }}>
              <input
                type="checkbox"
                name="rule-match-source-text"
                checked={matchSourceText}
                onChange={e => setMatchSourceText(e.target.checked)}
                style={{ marginTop: 2, accentColor: 'var(--accent)', cursor: 'pointer' }}
              />
              <span style={{ fontSize: 12, lineHeight: 1.35 }}>
                Also match the original / source statement text
                <span style={{ display: 'block', fontSize: 11, color: 'var(--muted)' }}>
                  Searches the imported source detail (e.g. the bank&rsquo;s &ldquo;Original Statement&rdquo;), not just the merchant name.
                </span>
              </span>
            </label>
          </ConditionChip>

          <ConditionChip
            label="Amount"
            summary={amtOpen ? amtSummary : null}
            active={amtOpen}
            onActivate={() => setAmtOpen(true)}
            onClear={() => { setAmtLow(null); setAmtHigh(null); setAmtSide('both'); setAmtOpen(false) }}
          >
            <AmountCondition
              low={amtLow} lowOp={amtLowOp}
              high={amtHigh} highOp={amtHighOp}
              side={amtSide}
              onChange={handleAmtChange}
            />
          </ConditionChip>

          {owners.length > 0 && (
            <ConditionChip
              label="Owner"
              summary={ownOpen ? (owners.find(o => o.id === ownerId)?.name ?? null) : null}
              active={ownOpen}
              onActivate={() => setOwnOpen(true)}
              onClear={() => { setOwnerId(''); setOwnOpen(false) }}
            >
              <select name="rule-owner" aria-label="Rule owner" value={ownerId} onChange={e => setOwnerId(e.target.value)} style={{ width: '100%', ...getFormControlStyle({ size: 'md', clickable: true }) }}>
                <option value="">— Select owner —</option>
                {owners.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
              </select>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 5 }}>Restrict this rule to one owner&apos;s transactions</div>
            </ConditionChip>
          )}

          {accounts.length > 0 && (
            <ConditionChip
              label="Account"
              summary={accOpen ? (accounts.find(a => a.id === accountId)?.name ?? null) : null}
              active={accOpen}
              onActivate={() => setAccOpen(true)}
              onClear={() => { setAccountId(''); setAccOpen(false) }}
            >
              <select name="rule-account" aria-label="Rule account" value={accountId} onChange={e => setAccountId(e.target.value)} style={{ width: '100%', ...getFormControlStyle({ size: 'md', clickable: true }) }}>
                <option value="">— Select account —</option>
                {accounts.map(a => <option key={a.id} value={a.id}>{a.name}{a.mask ? ` ···${a.mask}` : ''}</option>)}
              </select>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 5 }}>Restrict this rule to one account only</div>
            </ConditionChip>
          )}
        </div>
      </div>

      {matchOnly ? null : (
        <div style={{ padding: '16px 20px', borderBottom: '2px solid var(--border)' }}>
          <div style={sectionHeadStyle}>Then These Actions Apply…</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div>
              <SectionEyebrow style={{ letterSpacing: '0.03em', marginBottom: 6 }}>
                Assign Category
              </SectionEyebrow>
              <div style={{ display: 'flex' }}>
                <CategoryPicker
                  value={catId}
                  categories={categories}
                  onChange={setCatId}
                  onCategoryCreated={() => onCategoriesChanged?.()}
                  clearable
                />
              </div>
            </div>
            <ConditionChip
              label="Rename Merchant To"
              summary={renameOpen && cleanName.trim() ? cleanName : null}
              active={renameOpen}
              expanded={renameExpanded}
              onActivate={openRenameEditor}
              onClear={() => { setCleanName(''); setRenameOpen(false); setRenameExpanded(false) }}
              containerRef={renameConditionRef}
              triggerRef={renameConditionTriggerRef}
            >
              <input
                ref={renameInputRef}
                id={`${fieldIdBase}-rename`}
                name="rule-clean-merchant-name"
                aria-label="Rename merchant to"
                value={cleanName}
                onFocus={captureRenameEditState}
                onChange={e => setCleanName(e.target.value)}
                onKeyDown={event => {
                  if (event.key === 'Enter') {
                    event.stopPropagation()
                    event.preventDefault()
                    commitRenameEditor()
                    return
                  }
                  if (event.key === 'Escape') {
                    event.stopPropagation()
                    event.preventDefault()
                    cancelRenameEdit(event.currentTarget, renameConditionRef, true)
                  }
                }}
                placeholder="Clean display name, e.g. Whole Foods"
                style={{ width: '100%', boxSizing: 'border-box', ...getFormControlStyle({ size: 'md' }) }}
              />
              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 5 }}>Sets the display name when this rule fires on future transactions</div>
            </ConditionChip>

            <ConditionChip
              label="Add Tags"
              summary={tagIds.length ? selectedTags.map(tag => tag.name).join(', ') : null}
              active={tagsOpen}
              onActivate={() => setTagsOpen(true)}
              onClear={() => { setTagIds([]); setTagsOpen(false) }}
            >
              {/* Shared picker: existing tags as checkboxes plus an inline "+ New tag" so the user
                doesn't have to leave the rule editor to invent a tag. Rendered inline (relative). */}
              <TagPickerWithCreate
                allTags={availableTags}
                selectedTagIds={new Set(tagIds)}
                onToggleTag={(tag, present) => {
                  setTagIds(current => (
                    present
                      ? (current.includes(tag.id) ? current : [...current, tag.id])
                      : current.filter(id => id !== tag.id)
                  ))
                }}
                onTagCreated={created => {
                  addTag(created)
                  onTagCreated?.(created)
                }}
                onClose={() => { }}
                positioning="relative"
              />
              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 5 }}>
                Matching transactions will gain these tags without replacing tags from other matching rules.
              </div>
            </ConditionChip>

            {/* Rule-backed recurring series: the rule's matches become one series on the Recurring page,
              which is how a subscription/bill whose payee is spelled several ways gets tracked without
              renaming every variant. is_recurring counts as an action on its own. */}
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                <SectionEyebrow style={{ letterSpacing: '0.03em', marginBottom: 0 }}>
                  Recurring Series
                </SectionEyebrow>
                <FeatureExplainer topic="recurring-transactions" placement="bottom-left" />
              </div>
              <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  name="rule-is-recurring"
                  checked={isRecurring}
                  onChange={e => setIsRecurring(e.target.checked)}
                  style={{ marginTop: 2, accentColor: 'var(--accent)', cursor: 'pointer' }}
                />
                <span style={{ fontSize: 12, lineHeight: 1.35 }}>
                  Track this rule&rsquo;s matching transactions as a recurring series
                  <span style={{ display: 'block', fontSize: 11, color: 'var(--muted)' }}>
                    Create a series on the Recurring page out of the matching transactions.
                  </span>
                </span>
              </label>
              {isRecurring ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, fontSize: 12 }}>
                  <span style={{ color: 'var(--muted)' }}>Recurs</span>
                  <select
                    name="rule-recurring-cadence"
                    aria-label="Recurring cadence"
                    value={cadence}
                    onChange={e => setCadence(e.target.value)}
                    style={{ ...getFormControlStyle({ size: 'md', clickable: true }) }}
                  >
                    {RULE_CADENCE_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      )}

      {/* Read-only readout of the rule being built — the edits live in the sections above. Always
          rendered (even when the footer is hidden) so the matching-row count is never lost. */}
      <div style={{ padding: '14px 20px', borderBottom: hideFooter ? 'none' : '2px solid var(--border)' }}>
        <div style={sectionHeadStyle}>{matchOnly ? 'Match Summary' : 'Rule Summary'}</div>
        <div style={{ fontSize: 13, lineHeight: 1.5 }}>
          {keyword.trim() ? (
            <>
              Merchant {matchSourceText ? 'name or source text' : 'name'} contains{' '}
              <strong>&ldquo;{keyword.trim()}&rdquo;</strong>
              {amtSummary ? <span style={{ color: 'var(--muted)' }}> · {amtSummary}</span> : null}
              {ownerId ? <span style={{ color: 'var(--muted)' }}> · owner {owners.find(o => o.id === ownerId)?.name}</span> : null}
              {accountId ? <span style={{ color: 'var(--muted)' }}> · account {accounts.find(a => a.id === accountId)?.name}</span> : null}
            </>
          ) : (
            <span style={{ color: 'var(--muted)' }}>Add a merchant keyword above to define the rule.</span>
          )}
        </div>
        {actionSummaryLabels.length > 0 ? (
          <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 6 }}>
            {actionSummaryLabels.join(' · ')}
          </div>
        ) : null}
        {!hideMatchCount ? (
          <div style={{ marginTop: 8 }}>
            <MatchCountInline
              keyword={keyword}
              amtLow={amtLow}
              amtHigh={amtHigh}
              amtSide={amtSide}
              ownerId={ownerId}
              accountId={accountId}
              matchSourceText={matchSourceText}
              onCountChange={n => { setMatchCount(n); if (n === 0) setApplyToExisting(false) }}
            />
          </div>
        ) : null}
      </div>

      {hideFooter ? null : (
        <div style={{ padding: '12px 20px', background: 'var(--surface2)' }}>
          {showApplyToExisting ? (
            <div style={{ minHeight: 20, display: 'flex', alignItems: 'center', gap: 6, visibility: changeCount > 0 ? 'visible' : 'hidden' }}>
              <label style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontSize: 13,
                cursor: changeCount > 0 ? 'pointer' : 'default',
                userSelect: 'none',
              }}>
                <input name="rule-apply-to-existing" type="checkbox" checked={applyToExisting} onChange={e => setApplyToExisting(e.target.checked)}
                  disabled={changeCount === 0}
                  style={{ width: 15, height: 15, accentColor: 'var(--accent)', cursor: changeCount > 0 ? 'pointer' : 'default' }} />
                Apply this rule now to
              </label>
              <button
                onClick={() => setPreviewDetailOpen(true)}
                style={{
                  background: 'none', border: 'none', padding: 0,
                  color: 'var(--accent)', cursor: 'pointer',
                  fontSize: 13, textDecoration: 'underline', lineHeight: 'inherit',
                }}
              >
                {changeCount} matching existing transaction{changeCount !== 1 ? 's' : ''}
              </button>
            </div>
          ) : null}
          {hideFooterActions ? (
            error ? <div style={{ fontSize: 12, color: 'var(--danger)', marginTop: 10 }}>{error}</div> : null
          ) : (
            <DialogActions
              style={{
                padding: 0,
                borderTop: 'none',
                background: 'transparent',
                alignItems: 'center',
                marginTop: 12,
              }}
              align="end"
            >
              {error && <span style={{ fontSize: 12, color: 'var(--danger)', flex: 1 }}>{error}</span>}
              <div style={{ display: 'flex', gap: 8, marginLeft: 'auto' }}>
                {onCancel && (
                  <Button variant="ghost" onClick={onCancel}>Cancel</Button>
                )}
                <Button onClick={handleSave} disabled={saving || !canSave}>{saving ? 'Saving…' : saveLabel}</Button>
              </div>
            </DialogActions>
          )}
        </div>
      )}
      {previewDetailOpen && changeTransactions.length > 0 && (
        <RulePreviewDetail
          transactions={changeTransactions}
          categories={categories}
          onClose={() => setPreviewDetailOpen(false)}
        />
      )}
    </div>
  )
})

export default RuleForm
