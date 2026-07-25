// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState, useEffect, useCallback, useId, useRef, useMemo } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { api } from '../lib/api.js'
import { txnMutations } from '../lib/txnMutations.js'
import { Card, PageHeader, Button, Input, Badge, Spinner, EmptyState, AppDialog } from '../components/ui.jsx'
import WindowedRows from '../components/WindowedRows.jsx'
import StarterRulesDialog from '../components/StarterRulesDialog.jsx'
import RuleForm, { amountConditionSummary } from '../components/RuleForm.jsx'
import RulesFilterPopover from '../components/RulesFilterPopover.jsx'
import { ACCOUNT_TYPE_LABEL } from '../lib/accountTypes.js'
import { TagBadge } from '../components/TagUi.jsx'
import { useRecategorize, RecategorizeButton, RecategorizeResultBanner } from '../components/RecategorizeControl.jsx'
import { ActionCountBadge } from '../components/importExport/importPresentational.jsx'
import { countPendingRuleSuggestions, hasRuleSuggestionWork } from '../lib/importExport/ruleSuggestionWork.js'
import {
  RAIL_LETTERS, emptyRulesFacets, activeRulesFacetCount, filterRules,
  buildSectionedRuleItems, presentSectionLetters, ruleSectionLetter, sectionHeaderIndexByLetter,
} from '../lib/rulesFilter.js'

// Search text + facet selections are session-scoped (persist while the app is open, reset on next launch)
// — deliberately independent of the app-wide, cross-page FilterContext. Mirrors the Transactions
// quickFilter's session persistence.
const RULES_SESSION_KEY = 'rules.viewState'
function loadRulesSession() {
  try { return JSON.parse(sessionStorage.getItem(RULES_SESSION_KEY)) || {} } catch { return {} }
}
function saveRulesSession(state) {
  try { sessionStorage.setItem(RULES_SESSION_KEY, JSON.stringify(state)) } catch { /* storage may be unavailable */ }
}

function describeRule(rule, owners, accounts) {
  const parts = []

  if (rule.amount_min != null || rule.amount_max != null || (rule.debit_credit && rule.debit_credit !== 'both')) {
    parts.push(amountConditionSummary(rule.amount_min, '>=', rule.amount_max, '<=', rule.debit_credit || 'both'))
  }

  if (rule.owner_id) {
    const ownerObj = owners.find(o => o.id === rule.owner_id)
    if (ownerObj) parts.push(`owner is ${ownerObj.name}`)
  }

  if (rule.account_id) {
    const accountObj = accounts.find(a => a.id === rule.account_id)
    if (accountObj) {
      const mask = accountObj.mask ? ` •••${accountObj.mask}` : ''
      parts.push(`account is ${accountObj.name}${mask}`)
    }
  }

  if (rule.account_type) {
    parts.push(`account type is ${ACCOUNT_TYPE_LABEL[rule.account_type] ?? rule.account_type}`)
  }

  if (rule.match_source_text) {
    parts.push('matches source text')
  }

  return parts
}

// Two-line rule row: matcher (clauses + conditions) on line 1, actions on line 2. Both lines wrap
// freely and share the same treatment — so a rule with many tags and a truncated keyword can no longer
// read as two mismatched sides (the old table clipped the keyword cell while the action cell wrapped).
function RuleRow({ rule, owners, accounts, onEdit, onDelete }) {
  const [confirmDel,  setConfirmDel]  = useState(false)
  // Opt-in (off by default): also re-evaluate the transactions this rule categorized so they revert
  // instead of retaining the deleted rule's category. Reset whenever the confirm is dismissed.
  const [reconcileDel, setReconcileDel] = useState(false)

  const conditions = describeRule(rule, owners, accounts)
  const clauses = rule.clauses && rule.clauses.length ? rule.clauses : [rule.keyword]
  const hasAction = rule.category_name || rule.clean_name || (rule.tags && rule.tags.length) || rule.is_recurring

  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 12,
      padding: '9px 16px', borderBottom: '1px solid var(--border)',
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        {/* Line 1 — the matcher: AND'd clauses (or single keyword) plus scope conditions. */}
        <div style={{ fontSize: 13, lineHeight: 1.5, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '2px 6px' }}>
          {clauses.map((clause, i) => (
            <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {i > 0 ? <span style={{ color: 'var(--muted)', fontWeight: 400 }}>and</span> : null}
              <span style={{ fontFamily: 'monospace', fontSize: 13, fontWeight: 500 }}>{clause}</span>
            </span>
          ))}
          {conditions.map((c, i) => (
            <span key={i} style={{ color: 'var(--muted)' }}>· {c}</span>
          ))}
        </div>
        {/* Line 2 — the actions this rule applies. */}
        <div style={{ fontSize: 13, lineHeight: 1.5, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '3px 6px', marginTop: 3, color: 'var(--muted)' }}>
          <span style={{ opacity: 0.45 }}>→</span>
          {rule.category_name ? (
            <Badge label={rule.category_name} toneKey={rule.category_id || rule.category_name} />
          ) : null}
          {rule.clean_name ? (
            <span>rename to <span style={{ color: 'var(--text)', fontStyle: 'italic' }}>{rule.clean_name}</span></span>
          ) : null}
          {Array.isArray(rule.tags) && rule.tags.map(tag => (
            <TagBadge key={tag.id} tag={tag} />
          ))}
          {rule.is_recurring ? <span title="Tracked as a recurring series">↻ recurring</span> : null}
          {!hasAction ? <span style={{ fontStyle: 'italic' }}>no action</span> : null}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 4, flexShrink: 0, alignItems: 'center', paddingTop: 1 }}>
        <button
          onClick={() => onEdit(rule.id)}
          style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 12, padding: '2px 6px', borderRadius: 4 }}
          title="Edit rule"
        >✎</button>
        {confirmDel ? (
          <>
            <label
              title="Also re-evaluate the transactions this rule categorized, so they revert (to another matching rule or uncategorized) instead of keeping this rule's category. Off keeps them as they are."
              style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--muted)', cursor: 'pointer', whiteSpace: 'nowrap' }}
            >
              <input type="checkbox" checked={reconcileDel} onChange={e => setReconcileDel(e.target.checked)} />
              revert txns
            </label>
            <button
              onClick={() => { setConfirmDel(false); const r = reconcileDel; setReconcileDel(false); onDelete(rule.id, r) }}
              style={{ background: 'var(--danger)', color: '#fff', border: 'none', borderRadius: 4, padding: '2px 7px', fontSize: 11, cursor: 'pointer', fontWeight: 600 }}
            >Del</button>
            <button
              onClick={() => { setConfirmDel(false); setReconcileDel(false) }}
              style={{ background: 'none', border: '1px solid var(--border)', color: 'var(--muted)', borderRadius: 4, padding: '2px 6px', fontSize: 11, cursor: 'pointer' }}
            >✕</button>
          </>
        ) : (
          <button
            onClick={() => setConfirmDel(true)}
            style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 14, padding: '2px 6px', borderRadius: 4 }}
            title="Delete rule"
          >×</button>
        )}
      </div>
    </div>
  )
}

// A lightweight (non-sticky) alphabetical divider between letter sections. Sticky-in-a-virtualizer is
// deliberately avoided; the A–Z rail's current-letter highlight provides the running orientation.
function SectionHeader({ letter }) {
  return (
    <div style={{
      padding: '5px 16px', fontSize: 11, fontWeight: 700, letterSpacing: '0.05em',
      color: 'var(--accent2)', background: 'color-mix(in srgb, var(--surface2) 55%, var(--surface))',
      borderBottom: '1px solid var(--border)', borderTop: '1px solid var(--border)',
    }}>
      {letter}
    </div>
  )
}

// The A–Z jump strip: a horizontal "Jump to:" row under the search box. Every letter is always shown;
// present letters are active (click to jump), absent ones dim, and the letter currently at the top of the
// viewport is highlighted. It rides in the fixed header region so it stays put while the list scrolls.
function AlphaRail({ present, current, onJump }) {
  return (
    <div style={{
      flexShrink: 0, display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '2px 0',
      padding: '5px 32px', borderBottom: '1px solid var(--border)', background: 'var(--surface)',
      userSelect: 'none',
    }}>
      <span style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 500, marginRight: 6 }}>Jump to:</span>
      {RAIL_LETTERS.map(letter => {
        const active = present.has(letter)
        const isCurrent = current === letter
        return (
          <button
            key={letter}
            type="button"
            disabled={!active}
            onClick={() => onJump(letter)}
            title={active ? `Jump to ${letter}` : undefined}
            style={{
              background: 'none', border: 'none', padding: '1px 5px', lineHeight: 1.2,
              fontSize: 12, fontWeight: isCurrent ? 700 : 500,
              cursor: active ? 'pointer' : 'default',
              color: isCurrent ? 'var(--accent2)'
                : active ? 'var(--muted)'
                : 'color-mix(in srgb, var(--muted) 30%, transparent)',
            }}
          >
            {letter}
          </button>
        )
      })}
    </div>
  )
}

function EditRuleOverlay({ rule, categories, owners, accounts, onSave, onCancel }) {
  const formRef = useRef(null)
  const [draftState, setDraftState] = useState({
    data: null,
    canSave: Boolean(rule?.keyword && (rule?.category_id || rule?.clean_name || rule?.tag_ids?.length)),
  })
  const [working, setWorking] = useState(false)
  const [error, setError] = useState('')
  // Opt-in (off by default): re-evaluate the transactions this rule previously categorized, so rows this
  // edit drops from scope revert instead of retaining the old category.
  const [reconcile, setReconcile] = useState(false)

  if (!rule) return null

  async function handleSave() {
    const currentDraftState = formRef.current?.getDraftState?.() || draftState
    if (!currentDraftState.canSave || working) return
    setWorking(true)
    setError('')
    try {
      await onSave({ ...currentDraftState.data, reconcile })
    } catch (err) {
      setError(err.message || 'Failed to save rule')
      setWorking(false)
    }
  }

  const quietHeaderButtonStyle = {
    background: 'transparent',
    color: 'var(--muted)',
    border: '1px solid var(--border)',
    borderRadius: 8,
    padding: '5px 11px',
    fontSize: 12,
    fontWeight: 500,
    cursor: working ? 'not-allowed' : 'pointer',
    opacity: working ? 0.65 : 1,
  }
  const primaryHeaderButtonStyle = {
    background: draftState.canSave ? 'color-mix(in srgb, var(--accent) 12%, var(--surface))' : 'var(--surface)',
    color: draftState.canSave ? 'var(--accent2)' : 'var(--muted)',
    border: `1px solid ${draftState.canSave ? 'color-mix(in srgb, var(--accent) 40%, var(--border))' : 'var(--border)'}`,
    borderRadius: 8,
    padding: '5px 12px',
    fontSize: 12,
    fontWeight: 600,
    cursor: working || !draftState.canSave ? 'not-allowed' : 'pointer',
    opacity: working ? 0.65 : 1,
  }

  return (
    <div style={{
      position: 'fixed',
      inset: 0,
      zIndex: 120,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '28px 32px',
      background: 'rgba(10, 15, 26, 0.38)',
      backdropFilter: 'blur(2px)',
    }}>
      <Card style={{
        width: 'min(760px, 100%)',
        maxHeight: 'calc(100vh - 160px)',
        padding: 0,
        overflow: 'hidden',
        boxShadow: '0 24px 70px rgba(0,0,0,0.28)',
        border: '1px solid color-mix(in srgb, var(--accent) 18%, var(--border))',
      }}>
        <div style={{
          padding: '12px 20px',
          borderBottom: '1px solid var(--border)',
          background: 'var(--surface2)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
        }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 600 }}>Edit rule</div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
              Update conditions and actions without leaving the rules list
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto', flexShrink: 0 }}>
            <label
              title="Re-evaluate the transactions this rule previously categorized: rows this edit no longer covers revert (to another matching rule or uncategorized) instead of keeping this rule's old category. Off leaves existing categorizations as they are."
              style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--muted)', cursor: working ? 'not-allowed' : 'pointer', marginRight: 4 }}
            >
              <input type="checkbox" checked={reconcile} onChange={e => setReconcile(e.target.checked)} disabled={working} />
              Re-evaluate transactions
            </label>
            <button
              type="button"
              onClick={handleSave}
              disabled={working || !draftState.canSave}
              style={primaryHeaderButtonStyle}
            >
              {working ? 'Saving…' : 'Save changes'}
            </button>
            <button
              type="button"
              onClick={onCancel}
              disabled={working}
              style={quietHeaderButtonStyle}
            >
              Cancel
            </button>
          </div>
        </div>
        <div style={{ maxHeight: 'calc(100vh - 230px)', overflowY: 'auto' }}>
          {error ? (
            <div style={{ padding: '8px 20px 0', fontSize: 12, color: 'var(--danger)' }}>
              {error}
            </div>
          ) : null}
          <RuleForm
            ref={formRef}
            initialValues={{
              keyword: rule.keyword,
              clauses: rule.clauses,
              amount_min: rule.amount_min ?? null,
              amount_max: rule.amount_max ?? null,
              debit_credit: rule.debit_credit || 'both',
              owner_id: rule.owner_id || '',
              account_id: rule.account_id || '',
              account_type: rule.account_type || '',
              catId: rule.category_id,
              cleanName: rule.clean_name || '',
              tagIds: rule.tag_ids || [],
              match_source_text: !!rule.match_source_text,
            }}
            categories={categories}
            owners={owners}
            accounts={accounts}
            onSave={onSave}
            onCancel={onCancel}
            hideFooterActions
            onDraftChange={setDraftState}
          />
        </div>
      </Card>
    </div>
  )
}

export default function Rules() {
  const location = useLocation()
  const navigate = useNavigate()
  const [rules,      setRules]      = useState([])
  const [categories, setCategories] = useState([])
  const [owners,     setOwners]     = useState([])
  const [accounts,   setAccounts]   = useState([])
  // Recent import batches, fetched only to drive the "Generate rules from imported data" entry button's
  // pending-suggestion count and dim state — the review itself lives on the Import / Export route.
  const [batches,    setBatches]    = useState([])
  const [loading,    setLoading]    = useState(true)
  const sessionInit = useRef(loadRulesSession()).current
  const [search,     setSearch]     = useState(sessionInit.search || '')
  const [facets,     setFacets]     = useState(() => ({ ...emptyRulesFacets(), ...(sessionInit.facets || {}) }))
  const [showFilter, setShowFilter] = useState(false)
  const [currentLetter, setCurrentLetter] = useState(null)
  const scrollRef = useRef(null)
  const windowApiRef = useRef(null)
  const searchId = useId()
  const [showAdd,    setShowAdd]    = useState(false)
  const [showStarterRules, setShowStarterRules] = useState(false)
  const [editingRuleId, setEditingRuleId] = useState(null)
  // A pending rule save that collided with an existing same-matcher rule, awaiting the user's choice
  // (merge into it / open it / cancel). Shape: { status, existingRuleId, ruleData, applyToExisting }.
  const [collision, setCollision] = useState(null)
  const [createInitialValues, setCreateInitialValues] = useState({})
  const [createTransactionData, setCreateTransactionData] = useState(null)
  const {
    pendingCount: recategorizePendingCount,
    result: recategorizeResult,
    run: runRecategorize,
    reloadPreview: loadRecategorizePreview,
    dismissResult: dismissRecategorizeResult,
  } = useRecategorize()

  // Load the whole rule set once; search + facet filtering and A–Z sectioning are done client-side (the
  // set is bounded and fully in memory), so keystrokes and facet toggles never re-hit the server, and the
  // rail/count can reflect the full set. The windowed list keeps the DOM cost bounded regardless of size.
  const loadRules = useCallback(() => {
    api.getRules().then(r => { setRules(r); setLoading(false) })
  }, [])
  const loadCategories = useCallback(() => { api.getCategories().then(setCategories) }, [])

  useEffect(() => { loadRules() },      [loadRules])
  useEffect(() => { loadCategories() }, [loadCategories])
  useEffect(() => { api.getOwners().then(setOwners) }, [])
  useEffect(() => { api.getAccounts().then(setAccounts) }, [])
  useEffect(() => { api.listBatches().then(setBatches).catch(() => setBatches([])) }, [])

  // Persist the search + facets for the session (survives navigation, resets on next app launch).
  useEffect(() => { saveRulesSession({ search, facets }) }, [search, facets])

  const importedRuleSuggestionCount = countPendingRuleSuggestions(batches)
  const hasImportedRuleSuggestionWork = hasRuleSuggestionWork(batches)

  // Leaf category ids per parent group, so a selected *group* facet expands to match any rule assigning a
  // leaf under it.
  const leafIdsByGroup = useMemo(() => {
    const map = {}
    for (const c of categories) if (c.parent_id) (map[c.parent_id] ||= []).push(c.id)
    return map
  }, [categories])

  const filteredRules = useMemo(() => {
    // Expand group selections to their leaf ids and union with directly-selected leaves — so the pure
    // matcher only deals with leaf categoryIds while the UI keeps groups and leaves distinct.
    const effectiveCategoryIds = new Set(facets.categoryIds)
    for (const gid of facets.groupIds) for (const lid of (leafIdsByGroup[gid] || [])) effectiveCategoryIds.add(lid)
    return filterRules(rules, search, { ...facets, categoryIds: [...effectiveCategoryIds] })
  }, [rules, search, facets, leafIdsByGroup])
  const sectionItems = useMemo(() => buildSectionedRuleItems(filteredRules), [filteredRules])
  const presentLetters = useMemo(() => presentSectionLetters(filteredRules), [filteredRules])
  const headerIndexByLetter = useMemo(() => sectionHeaderIndexByLetter(sectionItems), [sectionItems])
  const activeFacetCount = activeRulesFacetCount(facets)

  // Facet option lists, drawn only from values actually used by some rule (so the filter never offers a
  // facet that would match nothing). Labels come straight off the rule rows the list endpoint returns;
  // categories are additionally grouped under their parent (from the categories tree) for the picker.
  const facetOptions = useMemo(() => {
    const catName = new Map(), tags = new Map(), owns = new Map(), accts = new Map(), types = new Map()
    const usedCat = new Set()
    for (const r of rules) {
      if (r.category_id) { usedCat.add(r.category_id); if (!catName.has(r.category_id)) catName.set(r.category_id, r.category_name || r.category_id) }
      for (const tag of (r.tags || [])) if (!tags.has(tag.id)) tags.set(tag.id, tag)
      if (r.owner_id && !owns.has(r.owner_id)) owns.set(r.owner_id, r.owner_name || r.owner_id)
      if (r.account_id && !accts.has(r.account_id)) accts.set(r.account_id, r.account_mask ? `${r.account_name} ···${r.account_mask}` : (r.account_name || r.account_id))
      if (r.account_type && !types.has(r.account_type)) types.set(r.account_type, ACCOUNT_TYPE_LABEL[r.account_type] ?? r.account_type)
    }
    const byLabel = (a, b) => a.label.localeCompare(b.label)
    // Group the used leaf categories under their parent group.
    const catById = new Map(categories.map(c => [c.id, c]))
    const groupName = new Map(categories.filter(c => !c.parent_id).map(g => [g.id, g.name]))
    const OTHER = '__other__'
    const leavesByGroup = new Map()
    for (const cid of usedCat) {
      const gid = catById.get(cid)?.parent_id || OTHER
      if (!leavesByGroup.has(gid)) leavesByGroup.set(gid, [])
      leavesByGroup.get(gid).push({ id: cid, label: catName.get(cid) })
    }
    const categoryGroups = [...leavesByGroup.entries()]
      .map(([gid, leaves]) => ({ groupId: gid, groupLabel: gid === OTHER ? 'Other' : (groupName.get(gid) || 'Other'), leaves: leaves.sort(byLabel) }))
      .sort((a, b) => a.groupLabel.localeCompare(b.groupLabel))
    return {
      categories: [...catName].map(([id, label]) => ({ id, label })).sort(byLabel), // flat, for chip labels
      categoryGroups,
      groups: categoryGroups.map(g => ({ id: g.groupId, label: g.groupLabel })),
      tags: [...tags.values()].map(t => ({ id: t.id, label: t.name, color: t.color })).sort(byLabel),
      owners: [...owns].map(([id, label]) => ({ id, label })).sort(byLabel),
      accounts: [...accts].map(([id, label]) => ({ id, label })).sort(byLabel),
      accountTypes: [...types].map(([id, label]) => ({ id, label })).sort(byLabel),
    }
  }, [rules, categories])

  const updateFacet = (key, value) => setFacets(f => ({ ...f, [key]: value }))
  const clearFacets = () => setFacets(emptyRulesFacets())

  const jumpToLetter = useCallback(letter => {
    const idx = headerIndexByLetter[letter]
    if (idx != null) windowApiRef.current?.scrollToIndex(idx, { align: 'start' })
  }, [headerIndexByLetter])

  const handleTopIndexChange = useCallback(idx => {
    const item = sectionItems[idx]
    if (!item) return
    setCurrentLetter(item.type === 'header' ? item.letter : ruleSectionLetter(item.rule))
  }, [sectionItems])

  // Active-facet chips (removable) shown under the toolbar.
  const facetChips = useMemo(() => {
    const chips = []
    const label = (opts, id) => opts.find(o => o.id === id)?.label ?? id
    facets.groupIds.forEach(id => chips.push({ key: `grp:${id}`, text: `Group: ${label(facetOptions.groups, id)}`, remove: () => updateFacet('groupIds', facets.groupIds.filter(x => x !== id)) }))
    facets.categoryIds.forEach(id => chips.push({ key: `cat:${id}`, text: `Category: ${label(facetOptions.categories, id)}`, remove: () => updateFacet('categoryIds', facets.categoryIds.filter(x => x !== id)) }))
    facets.tagIds.forEach(id => chips.push({ key: `tag:${id}`, text: `Tag: ${label(facetOptions.tags, id)}`, remove: () => updateFacet('tagIds', facets.tagIds.filter(x => x !== id)) }))
    facets.ownerIds.forEach(id => chips.push({ key: `own:${id}`, text: `Owner: ${label(facetOptions.owners, id)}`, remove: () => updateFacet('ownerIds', facets.ownerIds.filter(x => x !== id)) }))
    facets.accountIds.forEach(id => chips.push({ key: `acc:${id}`, text: `Account: ${label(facetOptions.accounts, id)}`, remove: () => updateFacet('accountIds', facets.accountIds.filter(x => x !== id)) }))
    facets.accountTypes.forEach(id => chips.push({ key: `typ:${id}`, text: `Type: ${label(facetOptions.accountTypes, id)}`, remove: () => updateFacet('accountTypes', facets.accountTypes.filter(x => x !== id)) }))
    if (facets.recurring) chips.push({ key: 'recurring', text: 'Recurring', remove: () => updateFacet('recurring', false) })
    if (facets.hasRename) chips.push({ key: 'rename', text: 'Has rename', remove: () => updateFacet('hasRename', false) })
    if (facets.matchSourceText) chips.push({ key: 'mst', text: 'Matches source text', remove: () => updateFacet('matchSourceText', false) })
    if (facets.noCategory) chips.push({ key: 'nocat', text: 'No category', remove: () => updateFacet('noCategory', false) })
    return chips
  }, [facets, facetOptions])

  async function handleAdd(data) {
    const { applyToExisting, ...ruleData } = data
    // Default create only classifies a same-matcher collision (it doesn't write). On a collision we
    // ask the user rather than fork a duplicate; the add form stays open behind the dialog so they
    // can cancel and adjust scope instead.
    const created = await api.createRule(ruleData)
    if (created?.status && created.status !== 'created') {
      setCollision({ status: created.status, existingRuleId: created.existing_rule_id, ruleData, applyToExisting })
      return
    }
    if (applyToExisting) await txnMutations.applyRule(created.id)
    closeAddAfterSave()
  }

  function closeAddAfterSave() {
    setShowAdd(false)
    setCreateInitialValues({})
    setCreateTransactionData(null)
    loadRules()
    loadRecategorizePreview()
  }

  async function mergeCollision() {
    const { ruleData, applyToExisting, existingRuleId, fromEdit, editedRuleId } = collision
    if (fromEdit) {
      // Folds this rule's actions into the other rule and deletes this one (backend).
      await api.updateRule(editedRuleId, ruleData, { onExisting: 'merge' })
    } else {
      await api.createRule(ruleData, { onExisting: 'merge' })
    }
    if (applyToExisting && existingRuleId) await txnMutations.applyRule(existingRuleId)
    setCollision(null)
    if (fromEdit) {
      setEditingRuleId(null)
      loadRules()
      loadRecategorizePreview()
    } else {
      closeAddAfterSave()
    }
  }

  function openExistingFromCollision() {
    const id = collision.existingRuleId
    setCollision(null)
    setShowAdd(false)
    setCreateInitialValues({})
    setCreateTransactionData(null)
    setEditingRuleId(id)
  }

  async function handleEditSave(data) {
    // `reconcile` is an overlay-level opt-in (re-evaluate this rule's rows), not a rule field; it applies
    // only to the clean update path, mirroring the backend (a collision merge doesn't reconcile).
    const { applyToExisting, reconcile, ...ruleData } = data
    // An edit can make this rule's matcher collide with another rule. Default update only classifies;
    // we ask before merging (which removes this rule) or surfacing a conflict.
    const result = await api.updateRule(editingRuleId, ruleData, { reconcile })
    if (result?.status && result.status !== 'updated') {
      setCollision({ status: result.status, existingRuleId: result.existing_rule_id, ruleData, applyToExisting, fromEdit: true, editedRuleId: editingRuleId })
      return
    }
    if (applyToExisting) await txnMutations.applyRule(editingRuleId)
    setEditingRuleId(null)
    loadRules()
    loadRecategorizePreview()
  }

  async function handleDelete(id, reconcile = false) {
    await api.deleteRule(id, { reconcile })
    if (editingRuleId === id) setEditingRuleId(null)
    loadRules()
    loadRecategorizePreview()
  }

  const editingRule = editingRuleId ? rules.find(rule => rule.id === editingRuleId) : null
  const showCreateForm = showAdd
  const showAnyEditor = showAdd || !!editingRule
  const addRuleButtonStyle = {
    background: showAnyEditor
      ? 'color-mix(in srgb, var(--surface2) 82%, var(--accent) 6%)'
      : 'color-mix(in srgb, var(--accent) 88%, black 8%)',
    boxShadow: showAnyEditor
      ? '0 8px 18px rgba(0,0,0,0.10)'
      : '0 10px 22px rgba(0,0,0,0.12)',
  }

  function openCreateForm() {
    setEditingRuleId(null)
    setShowAdd(true)
    setCreateInitialValues({})
    setCreateTransactionData(null)
  }

  function openEditForm(id) {
    setShowAdd(false)
    setEditingRuleId(id)
    setCreateInitialValues({})
    setCreateTransactionData(null)
  }

  function closeForm() {
    setShowAdd(false)
    setEditingRuleId(null)
    setCreateInitialValues({})
    setCreateTransactionData(null)
  }

  useEffect(() => {
    const editorState = location.state?.openRuleEditor
    const creatorState = location.state?.openRuleCreator
    if (!editorState && !creatorState) return

    // Other screens deep-link into the rules page with editor state; clear it
    // immediately after consuming it so refresh/back does not reopen stale overlays.
    if (editorState?.ruleId) {
      setShowAdd(false)
      setEditingRuleId(editorState.ruleId)
      setCreateInitialValues({})
      setCreateTransactionData(null)
    } else if (creatorState) {
      setEditingRuleId(null)
      setShowAdd(true)
      setCreateInitialValues(creatorState.initialValues || {})
      setCreateTransactionData(creatorState.transactionData || null)
    }

    navigate(location.pathname, { replace: true, state: null })
  }, [location.pathname, location.state, navigate])

  return (
    <div data-browser-context-passthrough="true" style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>

      <div style={{ padding: '32px 32px 0', flexShrink: 0 }}>
        <PageHeader title="Rules">
          <RecategorizeButton pendingCount={recategorizePendingCount} onRun={runRecategorize} />
          <Button
            small
            variant="ghost"
            onClick={() => navigate('/import-export/rule-suggestions', { state: { backTo: '/rules', backLabel: 'Rules' } })}
            disabled={!hasImportedRuleSuggestionWork}
            title={hasImportedRuleSuggestionWork
              ? 'Review rules suggested from your imported transactions'
              : 'Mark a categorized import as clean to generate rule suggestions'}
            style={hasImportedRuleSuggestionWork
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
              <span>Generate rules from imported data</span>
              <ActionCountBadge count={importedRuleSuggestionCount} />
            </span>
          </Button>
          {/* Empty-state-only, like the Categories starter offer: a head start shown only while there
              are no rules yet. Once any rule exists it's gone (add more via "Add rule"). */}
          {!loading && rules.length === 0 ? (
            <Button
              small
              variant="ghost"
              onClick={() => setShowStarterRules(true)}
              title="Add a curated set of common keyword → category rules"
            >
              Starter rules
            </Button>
          ) : null}
          <Button small onClick={() => (showAnyEditor ? closeForm() : openCreateForm())} style={addRuleButtonStyle}>
            {showAnyEditor ? 'Cancel' : 'Add rule'}
          </Button>
        </PageHeader>
      </div>

      <RecategorizeResultBanner
        result={recategorizeResult}
        onDismiss={dismissRecategorizeResult}
        style={{ margin: '12px 32px 0' }}
      />

      <div style={{
        padding: '8px 32px', flexShrink: 0,
        borderBottom: '1px solid var(--border)',
        background: 'var(--surface)',
        display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '8px 12px',
      }}>
        {/* Visually-hidden but real <label htmlFor> — Chrome's "no label associated" check wants an
            actual label association (a placeholder/aria-label alone doesn't satisfy it). */}
        <label htmlFor={searchId} style={{
          position: 'absolute', width: 1, height: 1, padding: 0, margin: -1,
          overflow: 'hidden', clip: 'rect(0, 0, 0, 0)', whiteSpace: 'nowrap', border: 0,
        }}>
          Search rules by merchant
        </label>
        <Input id={searchId} value={search} onChange={setSearch} placeholder="Search merchant…" style={{ width: 260 }} />

        {/* Structured facet filter — page-local, session-scoped (never touches the app-wide FilterContext). */}
        <div style={{ position: 'relative' }}>
          <Button
            small
            variant="ghost"
            onClick={() => setShowFilter(o => !o)}
            style={activeFacetCount > 0 ? {
              background: 'color-mix(in srgb, var(--accent) 12%, var(--surface2))',
              border: '1px solid color-mix(in srgb, var(--accent2) 30%, var(--border))',
            } : undefined}
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              Filter{activeFacetCount > 0 ? <ActionCountBadge count={activeFacetCount} /> : null}
            </span>
          </Button>
          {showFilter ? (
            <RulesFilterPopover
              facets={facets}
              onChange={setFacets}
              options={facetOptions}
              onClose={() => setShowFilter(false)}
              onClear={clearFacets}
            />
          ) : null}
        </div>

        {facetChips.map(chip => (
          <span
            key={chip.key}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12,
              padding: '3px 6px 3px 9px', borderRadius: 20,
              background: 'color-mix(in srgb, var(--accent) 10%, var(--surface2))',
              border: '1px solid color-mix(in srgb, var(--accent2) 20%, var(--border))',
              color: 'var(--text)',
            }}
          >
            {chip.text}
            <button
              type="button"
              onClick={chip.remove}
              title="Remove filter"
              style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 13, lineHeight: 1, padding: 0 }}
            >×</button>
          </span>
        ))}

        <span style={{ fontSize: 12, color: 'var(--muted)', marginLeft: 'auto' }}>
          {filteredRules.length === rules.length
            ? `${rules.length} rule${rules.length !== 1 ? 's' : ''}`
            : `${filteredRules.length} of ${rules.length} rules`}
        </span>
      </div>

      {/* Horizontal A–Z jump strip, directly under the search box (fixed region, stays put while scrolling). */}
      {!loading && filteredRules.length > 0 ? (
        <AlphaRail present={presentLetters} current={currentLetter} onJump={jumpToLetter} />
      ) : null}

      {/* Create form sits above the list in its own fixed region (its own scroll if tall) so the windowed
          list below owns a clean scroll container — a virtualizer doesn't want unrelated content sharing
          its scrollport. */}
      {showCreateForm ? (
        <div style={{ flexShrink: 0, padding: '12px 32px 0', maxHeight: '58vh', overflowY: 'auto' }}>
          <Card style={{ padding: 0, overflow: 'hidden' }}>
            <div style={{ padding: '12px 20px', borderBottom: '1px solid var(--border)', background: 'var(--surface2)', fontSize: 14, fontWeight: 600 }}>
              New rule
            </div>
            <RuleForm
              initialValues={createInitialValues}
              categories={categories}
              owners={owners}
              accounts={accounts}
              onSave={handleAdd}
              onCancel={closeForm}
              saveLabel="Add rule"
              transactionData={createTransactionData}
            />
          </Card>
        </div>
      ) : null}

      <div ref={scrollRef} data-browser-context-passthrough="true" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 32px 24px' }}>
        {loading ? (
            <div style={{ padding: 24 }}><Spinner /></div>
          ) : rules.length === 0 ? (
            <EmptyState message='No rules yet — click "Add rule" to create one' />
          ) : filteredRules.length === 0 ? (
            <EmptyState message="No rules match your search or filters" />
          ) : (
            <WindowedRows
              scrollRef={scrollRef}
              apiRef={windowApiRef}
              items={sectionItems}
              getItemKey={item => (item.type === 'header' ? `h:${item.letter}` : `r:${item.rule.id}`)}
              estimateSize={52}
              onTopIndexChange={handleTopIndexChange}
              renderRow={item => (
                item.type === 'header'
                  ? <SectionHeader letter={item.letter} />
                  : (
                    <RuleRow
                      rule={item.rule}
                      owners={owners}
                      accounts={accounts}
                      onEdit={openEditForm}
                      onDelete={handleDelete}
                    />
                  )
              )}
            />
          )}
      </div>

      <div style={{ flexShrink: 0, padding: '7px 32px', borderTop: '1px solid var(--border)', background: 'var(--surface)', fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.5 }}>
        Rules are evaluated most-specific first (longer keywords and more conditions win; owner-scoped beats
        global). The list is alphabetical by merchant — use the “Jump to” strip above to skip around.
      </div>

      <EditRuleOverlay
        rule={editingRule}
        categories={categories}
        owners={owners}
        accounts={accounts}
        onSave={handleEditSave}
        onCancel={closeForm}
      />

      {collision ? (
        <AppDialog
          title={collision.fromEdit ? 'This edit matches another rule' : 'A rule for this already exists'}
          description={
            collision.status === 'conflict'
              ? `Another rule matches the same merchant and scope but assigns a different category. Open it to edit, ${collision.fromEdit ? 'delete one of the two,' : ''} or narrow this rule’s scope (owner, account, or amount) so they don’t overlap.`
              : collision.fromEdit
              ? (collision.status === 'duplicate'
                ? 'This rule is now identical to another rule. You can remove this one and keep the other.'
                : 'This edit makes the rule match the same merchant and scope as another rule. Fold your changes into it — this rule will then be removed.')
              : collision.status === 'mergeable'
              ? 'Another rule already matches the same merchant and scope. Your changes can be folded into it instead of creating a second rule.'
              : 'An identical rule already exists, so nothing was created. Open it to review or edit.'
          }
          borderColor={collision.status === 'conflict' ? 'var(--danger)' : 'var(--border)'}
          onClose={() => setCollision(null)}
          actions={(
            <>
              <Button variant="ghost" onClick={() => setCollision(null)}>Cancel</Button>
              <Button variant="ghost" onClick={openExistingFromCollision}>Open the other rule</Button>
              {(collision.status === 'mergeable' || (collision.fromEdit && collision.status === 'duplicate')) ? (
                <Button onClick={mergeCollision}>
                  {collision.fromEdit ? (collision.status === 'duplicate' ? 'Remove this rule' : 'Merge & remove this rule') : 'Add to existing rule'}
                </Button>
              ) : null}
            </>
          )}
        />
      ) : null}

      {showStarterRules ? (
        <StarterRulesDialog
          onClose={() => setShowStarterRules(false)}
          onAdded={() => {
            loadRules()
            loadRecategorizePreview()
          }}
        />
      ) : null}
    </div>
  )
}
