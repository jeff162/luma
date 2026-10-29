// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * FilterBar owns only the local popover UI. The actual filter meaning lives in FilterContext so every page can
 * interpret the same active chips through its own API calls while the user's current slice survives navigation.
 */

import { useState, useRef, useEffect, useLayoutEffect, useMemo } from 'react'
import { format, subDays, subMonths, subYears, startOfMonth, endOfMonth,
         startOfYear, endOfYear } from 'date-fns'
import { useFilters } from '../lib/FilterContext.jsx'
import { api } from '../lib/api.js'
import { EMPTY_AMOUNT_FILTER, amountFilterIsActive } from '../lib/filterParams.js'
import { CategoryMarker, Button, IconButton, LinkButton } from './ui.jsx'
import { AmountCondition, amountConditionSummary } from './RuleForm.jsx'
import { useDismissibleLayer } from '../lib/uiInteractions.js'
import { useAnchoredPopup } from '../lib/anchoredPopup.js'
import { TagGlyph } from './TagUi.jsx'
import { ACCOUNT_TYPES, ACCOUNT_TYPE_LABEL } from '../lib/accountTypes.js'
import { formatDateRange } from '../lib/utils.js'

const fmt   = d => format(d, 'yyyy-MM-dd')
const today = new Date()

const DATE_PRESETS = [
  { label: 'Month to date',   fn: () => ({ start: fmt(startOfMonth(today)), end: fmt(today) }) },
  { label: 'Last month',      fn: () => ({ start: fmt(startOfMonth(subMonths(today,1))), end: fmt(endOfMonth(subMonths(today,1))) }) },
  { label: 'Year to date',    fn: () => ({ start: fmt(startOfYear(today)),  end: fmt(today) }) },
  { label: 'Last year',       fn: () => ({ start: fmt(startOfYear(subYears(today,1))), end: fmt(endOfYear(subYears(today,1))) }) },
  { label: 'Past 12 months',  fn: () => ({ start: fmt(subYears(today, 1)),  end: fmt(today) }) },
  { label: 'Last 30 days',    fn: () => ({ start: fmt(subDays(today, 29)),  end: fmt(today) }) },
  { label: 'Last 60 days',    fn: () => ({ start: fmt(subDays(today, 59)),  end: fmt(today) }) },
  { label: 'Last 90 days',    fn: () => ({ start: fmt(subDays(today, 89)),  end: fmt(today) }) },
  // Explicit all-time: a truthy value with no range, so it *overrides* a page's default period (unlike
  // "unset", which falls back to the default). This is the discoverable form of the old Clear button.
  { label: 'All time',        fn: () => ({ start: null, end: null }) },
]

function dateLabel(date) {
  if (!date) return 'Date'
  return date.preset || formatDateRange(date.start, date.end)
}

const inputStyle = {
  background: 'var(--surface2)', color: 'var(--text)',
  border: '1px solid var(--border)', borderRadius: 6,
  padding: '6px 8px', fontSize: 13, outline: 'none',
}

const rowStyle = {
  display: 'flex', alignItems: 'center', gap: 8,
  padding: '5px 14px', cursor: 'pointer',
}

// Shared selected-row tint used by both the date preset list and the multi-select filter rows.
// The previous `var(--surface2)` shade blended into the popover surface, so we lift it with an
// accent mix for visibility.
const SELECTED_ROW_BG = 'color-mix(in srgb, var(--accent) 22%, var(--surface2))'
// Exclude ("is not") rows/chips read in the danger hue so include vs exclude is legible at a glance.
const EXCLUDED_ROW_BG = 'color-mix(in srgb, var(--danger) 20%, var(--surface2))'

// Every facet except tags can be picked as include (primary row click) or exclude ("is not"). The
// exclude affordance is a single, quiet, always-present `≠` on the row's right edge — persistent so
// the option is discoverable, but visually secondary so it never competes with the primary click.
// A `✓` marks an included row; the `≠` itself turns danger-colored to mark an excluded one.
function RowTrailing({ mode, excludable, onExclude }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
      {mode === 'include' && <span style={{ color: 'var(--accent2)', fontSize: 11 }}>✓</span>}
      {excludable && (
        <IconButton
          size="compact"
          tone={mode === 'exclude' ? 'danger' : undefined}
          onClick={e => { e.stopPropagation(); onExclude() }}
          title={mode === 'exclude' ? 'Excluded (is not) — click to clear' : 'Exclude (is not)'}
          aria-label={mode === 'exclude' ? 'Clear exclusion' : 'Exclude from results'}
        >≠</IconButton>
      )}
    </span>
  )
}

// Synthetic filter targets for transactions with no category at all. The backend's
// `_build_uncategorized_multi_filter` recognizes these special ids in both `group_ids` and
// `category_ids`, so the filter picker can offer them as if they were real entries.
const UNASSIGNED_SYSTEM_KEY = 'unassigned'
const UNCATEGORIZED_EXPENSE_ID = '__uncategorized_expense__'
const UNCATEGORIZED_INCOME_ID = '__uncategorized_income__'
const SYNTHETIC_UNASSIGNED_INCOME_GROUP_ID = '__uncategorized_income_group__'
// Synthetic tag selection for "rows with no effective tag at all"; the backend's
// tag_filter_membership_sql recognizes this id as the untagged bucket. Mirrors the category filter's
// synthetic Uncategorized ids and the owner filter's 'unassigned'.
const UNTAGGED_TAG_ID = '__untagged__'

// A fragment of a payee name as a selection. Keyed case-folded, as the match is, so the same fragment
// typed twice is one chip.
function payeeContainsSelection(fragment) {
  return {
    type: 'payee_contains',
    id: `payee-contains:${fragment.toLowerCase()}`,
    label: `Payee contains “${fragment}”`,
    value: fragment,
  }
}

// Every account of one type as a selection. The id is prefixed so it cannot collide with another chip's.
function accountTypeSelection(type, label) {
  return { type: 'account_type', id: `account-type:${type}`, label: `${label} accounts`, value: type }
}

// Positioned `fixed` rather than inside its trigger's box: a FilterBar may sit inside a dialog, whose panel
// and scrolling body clip anything positioned within them. The browser keeps it under its trigger, the
// element it is mounted in (useAnchoredPopup), so its stacking is unchanged.
function Popover({ children, onClose, style }) {
  const ref = useRef(null)
  const triggerRef = useRef(null)
  useDismissibleLayer({
    open: true,
    onClose,
    refs: [ref],
  })
  // Declared before useAnchoredPopup, so the trigger is known when the hook names it.
  useLayoutEffect(() => {
    triggerRef.current = ref.current?.parentElement ?? null
  }, [])
  const { popupStyle, contentRef } = useAnchoredPopup({ open: true, anchorRef: triggerRef, gap: 6 })
  return (
    <div ref={ref} style={{
      ...popupStyle,
      zIndex: 300,
      background: 'var(--surface)',
      border: '1px solid color-mix(in srgb, var(--border) 50%, var(--muted) 50%)',
      borderRadius: 10, boxShadow: '0 12px 32px rgba(0,0,0,0.4)',
      minWidth: 290, ...style,
    }}>
      <div ref={contentRef}>{children}</div>
    </div>
  )
}

function DatePickerPopover({ onClose }) {
  const { filters, setDate, clearDate, getDate } = useFilters()
  // Highlight the preset matching the *effective* period, so a page's active default reads as selected
  // even before the user has picked anything explicitly.
  const effectivePreset = getDate()?.preset
  const [customStart, setCustomStart] = useState(filters.date?.start || fmt(startOfMonth(today)))
  const [customEnd,   setCustomEnd]   = useState(filters.date?.end   || fmt(today))

  function applyPreset(p) {
    setDate({ ...p.fn(), preset: p.label })
    onClose()
  }

  function applyCustom() {
    const s = customStart < customEnd ? customStart : customEnd
    const e = customStart < customEnd ? customEnd   : customStart
    setDate({ start: s, end: e, preset: null })
    onClose()
  }

  return (
    <Popover onClose={onClose}>
      <div style={{ padding: '4px 0' }}>
        {DATE_PRESETS.map(p => {
          const selected = effectivePreset === p.label
          return (
            <div key={p.label} onClick={() => applyPreset(p)} style={{
              ...rowStyle,
              background: selected ? SELECTED_ROW_BG : 'transparent',
              borderLeft: `3px solid ${selected ? 'var(--accent)' : 'transparent'}`,
              paddingLeft: 11,
              justifyContent: 'space-between',
            }}>
              <span style={{ fontSize: 13, fontWeight: selected ? 600 : 400, color: selected ? 'var(--text)' : 'inherit' }}>{p.label}</span>
              {selected && <span style={{ color: 'var(--accent2)', fontSize: 11 }}>✓</span>}
            </div>
          )
        })}
      </div>
      <div style={{ borderTop: '1px solid var(--border)', padding: '10px 14px' }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', marginBottom: 6,
          textTransform: 'uppercase', letterSpacing: '0.05em' }}>Custom range</div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input
            type="date"
            name="filter-date-start"
            aria-label="Filter start date"
            value={customStart}
            onChange={e => setCustomStart(e.target.value)}
            style={{ flex: 1, minWidth: 0, ...inputStyle, padding: '5px 7px' }}
          />
          <span style={{ color: 'var(--muted)', fontSize: 12 }}>→</span>
          <input
            type="date"
            name="filter-date-end"
            aria-label="Filter end date"
            value={customEnd}
            onChange={e => setCustomEnd(e.target.value)}
            style={{ flex: 1, minWidth: 0, ...inputStyle, padding: '5px 7px' }}
          />
          <Button size="compact" onClick={applyCustom} style={{ flexShrink: 0 }}>Set</Button>
        </div>
      </div>
      {filters.date && (
        <div style={{ borderTop: '1px solid var(--border)', padding: '8px 14px' }}>
          <LinkButton tone="danger" onClick={() => { clearDate(); onClose() }} style={{ fontSize: 13, fontWeight: 500 }}>✕ Clear date filter</LinkButton>
        </div>
      )}
    </Popover>
  )
}

const FILTER_TABS = [
  { id: 'accounts',   label: 'Accounts'   },
  // Groups and Categories are one collapsible tree now — the old standalone Groups tab folded in here.
  { id: 'categories', label: 'Categories' },
  { id: 'tags',       label: 'Tags'       },
  { id: 'owners',     label: 'Owners'     },
  { id: 'payee',      label: 'Payee'      },
  // What a row *is* (has an attachment, is recurring, needs review) rather than what it is filed
  // under. The vocabulary comes from the backend so this tab never keeps its own copy — see
  // services/transaction_attributes.py.
  { id: 'attributes', label: 'Attributes' },
]

function FilterPopover({ onClose }) {
  const { filters, addSelection, addSelections, removeSelection, removeSelections, clearSelections } = useFilters()
  const [tab, setTab]                       = useState('accounts')
  const [categories, setCategories]         = useState([])
  const [accounts, setAccounts]             = useState([])
  const [owners, setOwners]                 = useState([])
  const [tags, setTags]                     = useState([])
  const [attributes, setAttributes]         = useState([])
  const [payeeSearch, setPayeeSearch]       = useState('')
  const [payeeSuggestions, setPayeeSuggestions] = useState([])
  // Category tree UI state (the merged Groups+Categories tab): per-group collapse + a type-to-filter box.
  const [catSearch, setCatSearch]           = useState('')
  const [expandedGroups, setExpandedGroups] = useState(() => new Set())

  useEffect(() => {
    api.getCategories().then(setCategories)
    api.getAccounts().then(setAccounts)
    api.getOwners().then(setOwners)
    api.getTags().then(setTags)
    api.getFilterAttributes().then(setAttributes)
  }, [])

  useEffect(() => {
    const fragment = payeeSearch.trim()
    if (!fragment) { setPayeeSuggestions([]); return }
    // An answer to an earlier keystroke can arrive after a later one's, and must not replace it.
    let stale = false
    api.getPayeeNames(fragment).then(names => {
      if (!stale) setPayeeSuggestions(names.map(name => ({ type: 'payee', id: `payee:${name}`, label: name })))
    })
    return () => { stale = true }
  }, [payeeSearch])

  const payeeFragment = payeeSearch.trim()
  const payeeRows = payeeFragment ? [payeeContainsSelection(payeeFragment), ...payeeSuggestions] : []

  const selectionOf = id => filters.selections.find(s => s.id === id)
  const isSelected = id => !!selectionOf(id)
  const isIncluded = id => selectionOf(id)?.mode === 'include'
  const rowBg = id => {
    const s = selectionOf(id)
    if (!s) return 'transparent'
    return s.mode === 'exclude' ? EXCLUDED_ROW_BG : SELECTED_ROW_BG
  }

  // Primary row click means "include this" (add, or flip an excluded chip to include, or clear an
  // already-included one). The `≠` affordance is the mirror for "exclude this". Both dedupe by id.
  function pickInclude(sel) {
    const s = selectionOf(sel.id)
    if (s && s.mode === 'include') removeSelection(sel.id)
    else addSelection({ ...sel, mode: 'include' })
  }
  function pickExclude(sel) {
    const s = selectionOf(sel.id)
    if (s && s.mode === 'exclude') removeSelection(sel.id)
    else addSelection({ ...sel, mode: 'exclude' })
  }

  function toggleGroupExpanded(groupId) {
    setExpandedGroups(prev => {
      const next = new Set(prev)
      if (next.has(groupId)) next.delete(groupId)
      else next.add(groupId)
      return next
    })
  }

  // The unified category tree behind the merged tab: every real group with its leaves (the Unassigned
  // *expense* group gains the synthetic "Uncategorized" leaf), plus a synthetic Unassigned-*income* group
  // node carrying the "Other Income" leaf — so both group- and leaf-level selection (including the NULL
  // buckets) live in one selectable/collapsible tree instead of two separate tabs.
  const categoryTree = useMemo(() => {
    const grps = categories.filter(c => !c.parent_id)
    const lvs = categories.filter(c => c.parent_id)
    const nodes = grps.map(g => {
      const syntheticLeaf = g.system_key === UNASSIGNED_SYSTEM_KEY
        ? [{ id: UNCATEGORIZED_EXPENSE_ID, name: 'Uncategorized', _synthetic: true }]
        : []
      return {
        groupId: g.id,
        groupName: g.name,
        // A top-level group is income or expense (NULL defaults to expense, matching the backend) — this
        // is what nests each group under the right super-category in the tree.
        categoryType: g.category_type === 'income' ? 'income' : 'expense',
        groupSel: { type: 'group', id: g.id, label: g.name },
        leaves: [...lvs.filter(c => c.parent_id === g.id), ...syntheticLeaf],
      }
    })
    nodes.push({
      groupId: SYNTHETIC_UNASSIGNED_INCOME_GROUP_ID,
      groupName: 'Unassigned (income)',
      categoryType: 'income',
      groupSel: { type: 'group', id: SYNTHETIC_UNASSIGNED_INCOME_GROUP_ID, label: 'Unassigned (income)' },
      leaves: [{ id: UNCATEGORIZED_INCOME_ID, name: 'Other Income', _synthetic: true }],
    })
    return nodes
  }, [categories])

  // Only types some account has, in the order the Accounts page lists them; a stored type that list
  // does not know comes after, under its own value, and accounts with no type at all come last. The
  // column is nullable, and "no type" is not a value the type filter can name.
  const accountsByType = useMemo(() => {
    const known = ACCOUNT_TYPES.map(t => t.value)
    const rank = type => (type == null ? known.length + 1 : known.includes(type) ? known.indexOf(type) : known.length)
    const types = [...new Set(accounts.map(a => a.type ?? null))].sort((x, y) => rank(x) - rank(y))
    return types.map(type => ({
      type,
      label: type == null ? 'No type' : (ACCOUNT_TYPE_LABEL[type] ?? type),
      members: accounts.filter(a => (a.type ?? null) === type),
    }))
  }, [accounts])

  // `muted` when the account's whole type is already included, as a leaf under a selected group is.
  function renderAccountRow(a, muted) {
    const sel = { type: 'account', id: a.id, label: `${a.name}${a.mask ? ` ···${a.mask}` : ''}` }
    return (
      <div key={a.id} onClick={() => pickInclude(sel)} style={{
        ...rowStyle,
        paddingLeft: 'calc(16px + 2ch)',
        background: rowBg(a.id),
        justifyContent: 'space-between',
      }}>
        <div style={{ color: muted ? 'var(--muted)' : undefined }}>
          <div style={{ fontSize: 13 }}>{a.name}</div>
          {a.mask && <div style={{ fontSize: 11, color: 'var(--muted)' }}>···{a.mask}</div>}
        </div>
        <RowTrailing mode={selectionOf(a.id)?.mode} excludable onExclude={() => pickExclude(sel)} />
      </div>
    )
  }

  return (
    <Popover onClose={onClose} style={{ minWidth: 420 }}>
      {/* Tabs size to their own labels rather than to equal `flex: 1` cells. Equal cells put the widest
        labels ("Accounts", "Categories") edge-to-edge in theirs while "Tags" sat in slack, so two of
        them read as one run of text — worse with each tab added. Natural width plus real padding keeps
        the gaps even in the way that matters, which is between the words rather than between the cells. */}
      <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid var(--border)' }}>
        {FILTER_TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            flex: '0 1 auto', padding: '9px 10px', border: 'none', background: 'none',
            fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap',
            color: tab === t.id ? 'var(--text)' : 'var(--muted)',
            borderBottom: tab === t.id ? '2px solid var(--accent)' : '2px solid transparent',
            fontWeight: tab === t.id ? 500 : 400,
          }}>{t.label}</button>
        ))}
      </div>

      <div style={{ maxHeight: 300, overflowY: 'auto', padding: '6px 0' }}>

        {/* Accounts under their type. A type heading selects every account of that type, including
          one added later, which picking its accounts one by one does not. */}
        {tab === 'accounts' && accountsByType.map(({ type, label, members }) => {
          const typeSel = type == null ? null : accountTypeSelection(type, label)
          const typeIncluded = typeSel ? isIncluded(typeSel.id) : false
          return (
            <div key={type ?? ''}>
              <div onClick={typeSel ? () => pickInclude(typeSel) : undefined} style={{
                ...rowStyle,
                padding: '6px 14px 4px 16px',
                cursor: typeSel ? 'pointer' : 'default',
                background: typeSel ? rowBg(typeSel.id) : 'transparent',
                justifyContent: 'space-between',
                borderTop: '1px solid var(--border)',
              }}>
                <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: typeSel ? 'var(--accent2)' : 'var(--muted)' }}>{label}</span>
                {typeSel && <RowTrailing mode={selectionOf(typeSel.id)?.mode} excludable onExclude={() => pickExclude(typeSel)} />}
              </div>
              {members.map(a => renderAccountRow(a, typeIncluded))}
            </div>
          )
        })}

        {tab === 'categories' && (() => {
          const q = catSearch.trim().toLowerCase()
          const nodeVisible = node => !q || node.groupName.toLowerCase().includes(q) || node.leaves.some(l => l.name.toLowerCase().includes(q))

          // One group node: a collapse chevron, a selectable group row, and (when expanded) its leaves.
          const renderNode = node => {
            const groupMatch = node.groupName.toLowerCase().includes(q)
            const shownLeaves = (q && !groupMatch) ? node.leaves.filter(l => l.name.toLowerCase().includes(q)) : node.leaves
            const expanded = q ? true : expandedGroups.has(node.groupId)
            const groupSelected = isSelected(node.groupId)
            return (
              <div key={node.groupId}>
                <div style={{ ...rowStyle, background: rowBg(node.groupId), justifyContent: 'space-between', gap: 6, paddingLeft: 16 }}>
                  <button
                    type="button"
                    onClick={e => { e.stopPropagation(); toggleGroupExpanded(node.groupId) }}
                    aria-label={expanded ? 'Collapse group' : 'Expand group'}
                    title={expanded ? 'Collapse' : 'Expand'}
                    disabled={node.leaves.length === 0}
                    style={{ background: 'none', border: 'none', cursor: node.leaves.length ? 'pointer' : 'default', color: 'var(--muted)', fontSize: 10, width: 14, padding: 0, flexShrink: 0, transform: expanded ? 'rotate(90deg)' : 'none', transition: 'transform 100ms', opacity: node.leaves.length ? 1 : 0.25 }}
                  >▶</button>
                  <div onClick={() => pickInclude(node.groupSel)} style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0, cursor: 'pointer' }}>
                    <CategoryMarker kind="group" />
                    <span style={{ fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{node.groupName}</span>
                  </div>
                  <RowTrailing mode={selectionOf(node.groupId)?.mode} excludable onExclude={() => pickExclude(node.groupSel)} />
                </div>
                {expanded && shownLeaves.map(c => {
                  const sel = { type: 'category', id: c.id, label: c.name }
                  return (
                    <div key={c.id} onClick={() => pickInclude(sel)} style={{ ...rowStyle, paddingLeft: 46, background: rowBg(c.id), justifyContent: 'space-between' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <CategoryMarker kind="category" />
                        <span style={{ fontSize: 13, fontStyle: c._synthetic ? 'italic' : 'normal', color: groupSelected ? 'var(--muted)' : undefined }}>{c.name}</span>
                      </div>
                      <RowTrailing mode={selectionOf(c.id)?.mode} excludable onExclude={() => pickExclude(sel)} />
                    </div>
                  )
                })}
              </div>
            )
          }

          return (
            <div>
              <div style={{ padding: '6px 12px 8px' }}>
                <input
                  name="filter-category-search"
                  value={catSearch}
                  onChange={e => setCatSearch(e.target.value)}
                  placeholder="Filter categories…"
                  aria-label="Filter categories"
                  style={{ ...inputStyle, width: '100%' }}
                />
              </div>

              {/* Two super-categories (income / expense); each group nests under the one its type says.
                  The super-category header itself selects every group of that type (the old super-group
                  select-all), and the ✓/· shows how much of it is selected. */}
              {[{ typeKey: 'income', label: 'Income' }, { typeKey: 'expense', label: 'Expense' }].map(sc => {
                // Membership is *every* group node shown under this super-category — including synthetic
                // ones like Unassigned (income) — so "select all" and its ✓/· indicator stay honest.
                const allTypeNodes = categoryTree.filter(n => n.categoryType === sc.typeKey)
                const visibleNodes = allTypeNodes.filter(nodeVisible)
                if (visibleNodes.length === 0) return null
                const memberIds = allTypeNodes.map(n => n.groupId)
                const allSelected = memberIds.length > 0 && memberIds.every(id => isIncluded(id))
                const someSelected = !allSelected && memberIds.some(id => isIncluded(id))
                return (
                  <div key={sc.typeKey}>
                    <div
                      onClick={() => {
                        if (allSelected) removeSelections(memberIds)
                        else addSelections(allTypeNodes.map(n => n.groupSel))
                      }}
                      title={`Select all ${sc.label.toLowerCase()} groups`}
                      style={{ ...rowStyle, padding: '6px 16px 4px', background: allSelected ? SELECTED_ROW_BG : 'transparent', justifyContent: 'space-between', borderTop: '1px solid var(--border)' }}
                    >
                      <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--accent2)' }}>{sc.label}</span>
                      {allSelected
                        ? <span style={{ color: 'var(--accent2)', fontSize: 11 }}>✓ all</span>
                        : someSelected ? <span style={{ color: 'var(--muted)', fontSize: 11 }}>·</span> : null}
                    </div>
                    {visibleNodes.map(renderNode)}
                  </div>
                )
              })}
            </div>
          )
        })()}

        {tab === 'owners' && (
          owners.length === 0 ? (
            <div style={{ padding: '12px 16px', fontSize: 13, color: 'var(--muted)' }}>
              No owners defined — add them on the Accounts page.
            </div>
          ) : owners.map(o => {
            const sel = { type: 'owner', id: o.id, label: o.name }
            return (
              <div key={o.id} onClick={() => pickInclude(sel)} style={{
                ...rowStyle,
                background: rowBg(o.id),
                justifyContent: 'space-between',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 13 }}>{o.name}</span>
                </div>
                <RowTrailing mode={selectionOf(o.id)?.mode} excludable onExclude={() => pickExclude(sel)} />
              </div>
            )
          })
        )}

        {tab === 'tags' && (() => {
          // The synthetic "Untagged" bucket (rows with no effective tag) leads the list and is always
          // available even before any tags exist — it's a filter over the absence of tags, not a tag.
          const untaggedSel = { type: 'tag', id: UNTAGGED_TAG_ID, label: 'Untagged' }
          return (
            <>
              <div onClick={() => pickInclude(untaggedSel)} style={{
                ...rowStyle,
                background: rowBg(UNTAGGED_TAG_ID),
                justifyContent: 'space-between',
              }}>
                <span style={{ fontSize: 13, fontStyle: 'italic', color: 'var(--muted)' }}>Untagged</span>
                <RowTrailing mode={selectionOf(UNTAGGED_TAG_ID)?.mode} excludable onExclude={() => pickExclude(untaggedSel)} />
              </div>
              {tags.length === 0 ? (
                <div style={{ padding: '12px 16px', fontSize: 13, color: 'var(--muted)' }}>
                  No tags yet — create them under Tags on the Transactions page.
                </div>
              ) : tags.map(tag => {
                const sel = { type: 'tag', id: tag.id, label: tag.name, color: tag.color }
                return (
                  <div key={tag.id} onClick={() => pickInclude(sel)} style={{
                    ...rowStyle,
                    background: rowBg(tag.id),
                    justifyContent: 'space-between',
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <TagGlyph color={tag.color} size={13} />
                      <span style={{ fontSize: 13 }}>{tag.name}</span>
                    </div>
                    <RowTrailing mode={selectionOf(tag.id)?.mode} excludable onExclude={() => pickExclude(sel)} />
                  </div>
                )
              })}
            </>
          )
        })()}

        {tab === 'payee' && (
          <div style={{ padding: '8px 12px' }}>
            <input
              autoFocus
              name="filter-payee-search"
              value={payeeSearch}
              onChange={e => setPayeeSearch(e.target.value)}
              placeholder="Search payee name…"
              aria-label="Search payee name"
              style={{ ...inputStyle, width: '100%', marginBottom: 8 }}
            />
            {/* What was typed is itself a filter, offered ahead of the names it matches: one merchant
              appears under several names, and a fragment covers them all, including the next one. */}
            {payeeRows.map(s => (
              <div key={s.id} onClick={() => { pickInclude(s); setPayeeSearch('') }} style={{
                ...rowStyle, paddingLeft: 0,
                background: rowBg(s.id),
                justifyContent: 'space-between',
              }}>
                <span style={{ fontSize: 13 }}>{s.label}</span>
                <RowTrailing mode={selectionOf(s.id)?.mode} excludable onExclude={() => { pickExclude(s); setPayeeSearch('') }} />
              </div>
            ))}
            {payeeFragment && payeeSuggestions.length === 0 && (
              <div style={{ fontSize: 13, color: 'var(--muted)', padding: '6px 0' }}>No payee names match</div>
            )}
          </div>
        )}

        {tab === 'attributes' && (
          attributes.length === 0 ? (
            <div style={{ padding: '12px 16px', fontSize: 13, color: 'var(--muted)' }}>None.</div>
          ) : (
            // `in_filter_bar` is the backend's call, not a display preference: Uncategorized is part of
            // the vocabulary (the ledger's quick filter and `?only=` links use it) but the Categories
            // tab already offers that bucket, and two identical-looking controls in one popover is a
            // question the user should never have to answer.
            attributes.filter(a => a.in_filter_bar).map(attribute => {
              const sel = { type: 'attribute', id: attribute.key, label: attribute.label }
              return (
                <div key={attribute.key} onClick={() => pickInclude(sel)} title={attribute.description} style={{
                  ...rowStyle,
                  background: rowBg(attribute.key),
                  justifyContent: 'space-between',
                }}>
                  <span style={{ fontSize: 13 }}>{attribute.label}</span>
                  <RowTrailing mode={selectionOf(attribute.key)?.mode} excludable onExclude={() => pickExclude(sel)} />
                </div>
              )
            })
          )
        )}
      </div>

      {filters.selections.length > 0 && (
        <div style={{ borderTop: '1px solid var(--border)', padding: '8px 16px' }}>
          <LinkButton tone="danger" onClick={clearSelections} style={{ fontSize: 13 }}>✕ Clear all filters</LinkButton>
        </div>
      )}
    </Popover>
  )
}

// The chip is the second way to flip a selection's mode (the row `≠` is the first): clicking the chip
// body toggles include↔exclude for any facet. An excluded chip reads in the danger hue with a leading
// `≠` so the two modes are legible in the bar at a glance.
function FilterChip({ sel, onRemove, onFlipMode }) {
  const excluded = sel.mode === 'exclude'
  const accent = excluded ? 'var(--danger)' : 'var(--accent2)'
  return (
    <span
      onClick={() => onFlipMode(sel.id)}
      title={excluded ? 'Excluded (is not) — click to include' : 'Included — click to exclude'}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        padding: '3px 8px', borderRadius: 99, fontSize: 12,
        background: excluded
          ? 'color-mix(in srgb, var(--danger) 12%, var(--surface2))'
          : 'color-mix(in srgb, var(--accent) 12%, var(--surface2))',
        border: `1px solid ${excluded ? 'var(--danger)' : 'var(--accent)'}`,
        color: accent,
        whiteSpace: 'nowrap',
        cursor: 'pointer',
      }}>
      {excluded ? <span style={{ fontWeight: 700 }}>≠</span> : null}
      {sel.type === 'tag' && sel.color ? <TagGlyph color={sel.color} size={12} /> : null}
      {sel.label}
      <IconButton size="compact" aria-label={`Remove ${sel.label}`} onClick={e => { e.stopPropagation(); onRemove(sel.id) }}>×</IconButton>
    </span>
  )
}

// `inapplicable` is a filter the current view ignores (the date on the Dashboard's Trends tab). It must not
// open: a change made there would do nothing here and then surface unannounced on the next view that reads
// it. It is not `disabled`, though, because a disabled button shows no `title`, and the tooltip is the only
// place the reason is given.
// The amount filter's popover: the rule editor's amount condition (Both/Debits/Credits and a range),
// plus a per-bound `>` / `<` that rules do not offer. Edits are a draft until Apply, so dismissing the
// popover leaves the filter in force unchanged.
function AmountPopover({ onClose }) {
  const { filters, setAmount } = useFilters()
  const [draft, setDraft] = useState(() => ({ ...EMPTY_AMOUNT_FILTER, ...filters.amount }))
  const active = amountFilterIsActive(filters.amount)

  function apply() {
    setAmount(draft)
    onClose()
  }
  function clear() {
    setAmount(null)
    onClose()
  }

  return (
    <Popover onClose={onClose} style={{ padding: 14, minWidth: 300 }}>
      <AmountCondition
        low={draft.low} lowOp={draft.lowOp}
        high={draft.high} highOp={draft.highOp}
        side={draft.side}
        onChange={setDraft}
        strictBounds
      />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12,
        borderTop: '1px solid var(--border)', paddingTop: 10 }}>
        <LinkButton tone="danger" onClick={clear} disabled={!active} style={{ fontSize: 13 }}>✕ Clear amount filter</LinkButton>
        <Button onClick={apply}>Apply</Button>
      </div>
    </Popover>
  )
}

function FilterButton({ active, count, children, onClick, inapplicable = false, title }) {
  return (
    <Button
      variant="secondary"
      pressed={active}
      onClick={inapplicable ? undefined : onClick}
      aria-disabled={inapplicable || undefined}
      title={title}
      style={{ display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap', opacity: inapplicable ? 0.45 : 1 }}
    >
      {children}
      {count > 0 && (
        <span style={{
          background: 'var(--accent)', color: '#fff',
          borderRadius: 99, fontSize: 11, fontWeight: 600,
          padding: '1px 6px',
        }}>{count}</span>
      )}
    </Button>
  )
}

export default function FilterBar() {
  const { filters, removeSelection, clearAll, dateApplies, toggleSelectionMode, getDate, dateIsDefault } = useFilters()
  const [showDate,   setShowDate]   = useState(false)
  const [showAmount, setShowAmount] = useState(false)
  const [showFilter, setShowFilter] = useState(false)

  // A view that stops reading the date (the Dashboard's Trends tab) closes an open date picker as well, so
  // it is not left standing under a button that no longer opens it.
  useEffect(() => {
    if (!dateApplies) setShowDate(false)
  }, [dateApplies])

  const effectiveDate = getDate()
  const hasDate       = !!filters.date
  const hasSelections = filters.selections.length > 0
  const amount        = filters.amount
  const hasAmount     = amountFilterIsActive(amount)
  const hasAny        = hasDate || hasSelections || hasAmount

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
      padding: '8px 32px', borderBottom: '1px solid var(--border)',
      background: 'var(--surface)', minHeight: 48,
    }}>
      <div style={{ position: 'relative', flexShrink: 0 }}>
        <FilterButton
          active={hasDate}
          inapplicable={!dateApplies}
          title={dateApplies ? undefined : 'The date filter does not apply to this view.'}
          onClick={() => { setShowDate(v => !v); setShowAmount(false); setShowFilter(false) }}
        >
          📅 {dateIsDefault
            ? <span style={{ color: 'var(--muted)' }}>{effectiveDate.preset || 'Default'} <span style={{ opacity: 0.7 }}>· default</span></span>
            : dateLabel(filters.date)}
        </FilterButton>
        {showDate && <DatePickerPopover onClose={() => setShowDate(false)} />}
      </div>

      <div style={{ position: 'relative', flexShrink: 0 }}>
        <FilterButton
          active={hasAmount}
          onClick={() => { setShowAmount(v => !v); setShowDate(false); setShowFilter(false) }}
        >
          💲 Amount
          {hasAmount && (
            <span style={{ opacity: 0.85 }}>
              · {amountConditionSummary(amount.low, amount.lowOp, amount.high, amount.highOp, amount.side)}
            </span>
          )}
        </FilterButton>
        {showAmount && <AmountPopover onClose={() => setShowAmount(false)} />}
      </div>

      <div style={{ position: 'relative', flexShrink: 0 }}>
        <FilterButton
          active={hasSelections}
          count={hasSelections ? filters.selections.length : 0}
          onClick={() => { setShowFilter(v => !v); setShowDate(false); setShowAmount(false) }}
        >
          🔍 Filter
        </FilterButton>
        {showFilter && <FilterPopover onClose={() => setShowFilter(false)} />}
      </div>

      {filters.selections.map(s => (
        <FilterChip key={s.id} sel={s} onRemove={removeSelection} onFlipMode={toggleSelectionMode} />
      ))}

      {hasAny && (
        <Button size="compact" variant="secondary" onClick={clearAll} style={{ marginLeft: 'auto', flexShrink: 0 }}>Clear all</Button>
      )}
    </div>
  )
}
