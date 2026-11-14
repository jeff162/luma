// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState, useEffect, useCallback, useId, useRef, useMemo } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { api } from '../lib/api.js'
import { useOwnerLens } from '../lib/OwnerLensContext.jsx'
import { ownerLensAdmits } from '../lib/ownerLens.js'
import { txnMutations } from '../lib/txnMutations.js'
import { Card, PageHeader, Button, IconButton, SearchInput, Badge, Spinner, EmptyState, AppDialog, Tooltip, ROW_HOVER_OPEN_DELAY_MS, VISUALLY_HIDDEN_STYLE, getFormControlStyle, SegmentedToggle } from '../components/ui.jsx'
import FeatureExplainer from '../help/FeatureExplainer.jsx'
import WindowedRows from '../components/WindowedRows.jsx'
import StarterRulesDialog from '../components/StarterRulesDialog.jsx'
import RuleForm, { amountConditionSummary, ruleFormInitialValues } from '../components/RuleForm.jsx'
import RulePreviewDialog from '../components/RulePreviewDialog.jsx'
import { isLowPriority } from '../lib/rulePriority.js'
import RulesFilterPopover from '../components/RulesFilterPopover.jsx'
import RuleDeleteButton from '../components/RuleDeleteButton.jsx'
import { ACCOUNT_TYPE_LABEL } from '../lib/accountTypes.js'
import { TagBadge } from '../components/TagUi.jsx'
import { useDismissibleLayer } from '../lib/uiInteractions.js'
import { useUserPreference } from '../lib/UserPreferencesContext.jsx'
import RuleCleanupDialog from '../components/RuleCleanupDialog.jsx'
import RuleFindingsDialog from '../components/RuleFindingsDialog.jsx'
import { RuleMatcherText } from '../components/RuleSummary.jsx'
import FloatingDialog from '../components/FloatingDialog.jsx'
import { formatRuleMatcher } from '../lib/ruleMatcher.js'
import { formatDate, localIsoDate } from '../lib/utils.js'
import { useRecategorize, RecategorizeButton, RecategorizeResultBanner } from '../components/RecategorizeControl.jsx'
import { ActionCountBadge } from '../components/importExport/importPresentational.jsx'
import {
  RAIL_LETTERS, emptyRulesFacets, activeRulesFacetCount, filterRules,
  buildSectionedRuleItems, presentSectionLetters, ruleSectionLetter, sectionHeaderIndexByLetter,
} from '../lib/rulesFilter.js'
import { sessionStore } from '../lib/browserStorage.js'
import { vh } from '../lib/displaySize.js'

// Search text + facet selections are session-scoped (persist while the app is open, reset on next launch)
// — deliberately independent of the app-wide, cross-page FilterContext. Mirrors the Transactions
// quickFilter's session persistence.
const RULES_SESSION_KEY = 'rules.viewState'
function loadRulesSession() {
  return sessionStore.getJson(RULES_SESSION_KEY) || {}
}
function saveRulesSession(state) {
  sessionStore.setJson(RULES_SESSION_KEY, state)
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
function RuleRow({ rule, owners, accounts, onEdit, onDelete, matchesCache, matchCacheVersion, onOpenReport }) {
  const [confirmDel,  setConfirmDel]  = useState(false)
  // Opt-in (off by default): also re-evaluate the transactions this rule categorized so they revert
  // instead of retaining the deleted rule's category. Reset whenever the confirm is dismissed.
  const [reconcileDel, setReconcileDel] = useState(false)
  const confirmRef = useRef(null)

  // The inline delete-confirm is a transient local edit: dismiss it on an outside click or Escape so it
  // never lingers open (e.g. after opening a different rule's editor). Leaving the page unmounts the row.
  const dismissConfirm = () => { setConfirmDel(false); setReconcileDel(false) }
  useDismissibleLayer({ open: confirmDel, onClose: dismissConfirm, refs: [confirmRef] })

  // Per-rule matcher matches (count + rows), fetched lazily on first hover of the ↗ and cached for the
  // page visit (nothing is fetched for rules you never hover). matchCacheVersion bumps when the cache is
  // cleared (after any rule mutation), so a row drops its stale count and refetches on next hover.
  const [matchState, setMatchState] = useState(() => matchesCache.get(rule.id) || null)
  const [matchLoading, setMatchLoading] = useState(false)
  const hoverTimerRef = useRef(null)
  useEffect(() => {
    setMatchState(matchesCache.get(rule.id) || null)
    setMatchLoading(false)
  }, [matchCacheVersion, rule.id, matchesCache])
  useEffect(() => () => clearTimeout(hoverTimerRef.current), [])

  const fetchMatches = useCallback(() => {
    const cached = matchesCache.get(rule.id)
    if (cached) { setMatchState(cached); return Promise.resolve(cached) }
    setMatchLoading(true)
    return api.getRuleMatches(rule.id)
      .then(res => { matchesCache.set(rule.id, res); setMatchState(res); return res })
      .catch(() => null)
      .finally(() => setMatchLoading(false))
  }, [rule.id, matchesCache])

  function armHoverFetch() {
    if (matchState || matchLoading) return
    clearTimeout(hoverTimerRef.current)
    hoverTimerRef.current = setTimeout(fetchMatches, 200)
  }
  function cancelHoverFetch() { clearTimeout(hoverTimerRef.current) }
  function openReport() {
    if (matchState) { onOpenReport(rule, matchState); return }
    fetchMatches().then(res => { if (res) onOpenReport(rule, res) })
  }
  // While the lazy count is in flight, render no tooltip (empty content → the Tooltip shows nothing) rather
  // than a "Counting…" flash: the box first appears already populated with the result. openDelay (300ms) is
  // longer than the 200ms hover-fetch arm, so a fresh hover's box normally opens straight to the count.
  const matchTip = matchState
    ? `${matchState.count} transaction${matchState.count !== 1 ? 's' : ''} match — click to view`
    : matchLoading
      ? ''
      : 'Show transactions this rule matches'

  const conditions = describeRule(rule, owners, accounts)
  const hasAction = rule.category_name || rule.clean_name || (rule.tags && rule.tags.length) || rule.is_recurring

  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 12,
      padding: '9px 16px', borderBottom: '1px solid var(--border)',
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        {/* Line 1 — the matcher plus scope conditions. */}
        <div style={{ fontSize: 13, lineHeight: 1.5, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '2px 6px' }}>
          <RuleMatcherText rule={rule} />
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
          {isLowPriority(rule) ? <span title="Gives way to normal-priority rules matching the same transaction">low priority</span> : null}
          {!hasAction ? <span style={{ fontStyle: 'italic' }}>no action</span> : null}
          <span
            title="The newest transaction date this rule has categorized"
            style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--muted)', opacity: 0.85, whiteSpace: 'nowrap', paddingLeft: 8 }}
          >
            {rule.last_effect_date ? `used ${formatDate(rule.last_effect_date)}` : 'never used'}
          </span>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 4, flexShrink: 0, alignItems: 'center', paddingTop: 1 }}>
        {/* Hover to count the transactions this rule matches (lazy, cached); click to open the report. */}
        <Tooltip content={matchTip} openDelay={ROW_HOVER_OPEN_DELAY_MS}>
          <IconButton
            size="compact"
            tone="accent"
            onMouseEnter={armHoverFetch}
            onMouseLeave={cancelHoverFetch}
            onFocus={armHoverFetch}
            onClick={openReport}
            aria-label="Show transactions this rule matches"
            title=""
          >↗</IconButton>
        </Tooltip>
        <IconButton size="compact" onClick={() => onEdit(rule.id)} aria-label="Edit rule">✎</IconButton>
        {confirmDel ? (
          <span ref={confirmRef} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <label
              title="Also re-evaluate the transactions this rule categorized, so they revert (to another matching rule or uncategorized) instead of keeping this rule's category. Off keeps them as they are."
              style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--muted)', cursor: 'pointer', whiteSpace: 'nowrap' }}
            >
              <input type="checkbox" checked={reconcileDel} onChange={e => setReconcileDel(e.target.checked)} />
              revert txns
            </label>
            <Button size="compact" onClick={() => { setConfirmDel(false); const r = reconcileDel; setReconcileDel(false); onDelete(rule.id, r) }}>Del</Button>
            <IconButton size="compact" aria-label="Keep this rule" onClick={dismissConfirm}>✕</IconButton>
          </span>
        ) : (
          <IconButton size="compact" onClick={() => setConfirmDel(true)} aria-label="Delete rule">×</IconButton>
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

export function EditRuleOverlay({ rule, categories, owners, accounts, onSave, onDelete, onCancel }) {
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
    } finally {
      // Always clear the saving flag once onSave settles. On success the overlay closes; on a collision
      // it stays open. Previously `working` leaked true (it was only reset on error), which wedged the
      // Save button — visible on reopen because this overlay renders null instead of unmounting.
      setWorking(false)
    }
  }

  // Floating, so it can sit beside the rule checkup that opened it. Until it has a remembered place it
  // opens one step down and right of center, so a checkup opened behind it keeps its header in view.
  return (
    <FloatingDialog
      panelKey="ui.rules.editorPanel"
      width={760}
      height={900}
      stackIndex={1}
      onClose={onCancel}
      bodyPadding={0}
      bodyStyle={{ gap: 0 }}
      footerAlign="between"
      actions={(
        <>
          <label
            title="Re-evaluate the transactions this rule previously categorized: rows this edit no longer covers revert (to another matching rule or uncategorized) instead of keeping this rule's old category. Off leaves existing categorizations as they are."
            style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--muted)', cursor: working ? 'not-allowed' : 'pointer' }}
          >
            <input type="checkbox" checked={reconcile} onChange={e => setReconcile(e.target.checked)} disabled={working} />
            Re-evaluate transactions
          </label>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button variant="secondary" onClick={onCancel} disabled={working}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={working || !draftState.canSave}>
              {working ? 'Saving…' : 'Save changes'}
            </Button>
          </div>
        </>
      )}
      header={(
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 600 }}>Edit rule</div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
              Update conditions and actions without leaving the rules list
            </div>
          </div>
          <RuleDeleteButton onDelete={revert => onDelete(rule.id, revert)} disabled={working} />
        </div>
      )}
    >
          {error ? (
            <div style={{ padding: '8px 20px 0', fontSize: 12, color: 'var(--danger)' }}>
              {error}
            </div>
          ) : null}
          <RuleForm
            ref={formRef}
            initialValues={ruleFormInitialValues(rule)}
            categories={categories}
            owners={owners}
            accounts={accounts}
            onSave={onSave}
            onCancel={onCancel}
            hideFooterActions
            onDraftChange={setDraftState}
          />
    </FloatingDialog>
  )
}

export default function Rules() {
  const location = useLocation()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const [rules,      setRules]      = useState([])
  const [categories, setCategories] = useState([])
  const [owners,     setOwners]     = useState([])
  const [accounts,   setAccounts]   = useState([])
  // Whether any import feeds rule suggestions and how many are pending: the "Generate rules from imported
  // data" button's count and dim state. The review itself lives on the Import route.
  const [ruleSuggestionWork, setRuleSuggestionWork] = useState(null)
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
  // Page-visit cache of per-rule matcher matches (rule_id → { count, transactions }); version bumps to tell
  // rows to drop stale entries after a rule mutation. matchReport is the open matched-rows dialog.
  const matchesCacheRef = useRef(new Map())
  const [matchCacheVersion, setMatchCacheVersion] = useState(0)
  const [matchReport, setMatchReport] = useState(null) // { rule, data }
  // View + stale-rule cleanup. sortMode swaps the A–Z sectioned view for a stalest-first chronological one.
  // The cleanup timeframe is a durable per-user preference; '' = none selected (nothing swept).
  const [sortMode, setSortMode] = useState('alpha') // 'alpha' | 'lastUsed'
  const [cleanupWindow, setCleanupWindow] = useUserPreference('ui.rules.cleanupWindow', '')
  const [cleanupOpen, setCleanupOpen] = useState(false)
  const [findingsOpen, setFindingsOpen] = useState(false)
  // Bumped when a rule edit or delete is saved, so an open checkup re-runs its checks (it stays mounted,
  // hidden, while a rule it opened is edited).
  const [checkupRefreshKey, setCheckupRefreshKey] = useState(0)
  const [rangeDriftCount, setRangeDriftCount] = useState(0)
  const [conflictCount, setConflictCount] = useState(0)
  const checkupCount = rangeDriftCount + conflictCount
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
    // Any reload follows a possible rule/data change, so drop the match-count cache and tell rows to refetch.
    matchesCacheRef.current.clear()
    setMatchCacheVersion(v => v + 1)
    api.getRules().then(r => { setRules(r); setLoading(false) })
  }, [])
  const loadCategories = useCallback(() => { api.getCategories().then(setCategories) }, [])
  // The badge counts what arrives on its own, with no edit by the user: a charge a rule silently stopped
  // claiming (range drift), and a pair of rules an import, sync or categorization caught deciding a
  // transaction arbitrarily (the recorded conflicts). The rest of the overlap check reports on rules as
  // the user wrote them, and much of it is information they can acknowledge; badging that would leave a
  // number sitting there for months over something already decided, which is how a badge stops meaning
  // anything. The whole-ledger scan is also too slow to run on every visit.
  const loadCheckupCounts = useCallback(() => {
    api.getRuleRangeDrift().then(r => setRangeDriftCount(r?.count || 0)).catch(() => setRangeDriftCount(0))
    api.getRuleConflictCount().then(r => setConflictCount(r?.count || 0)).catch(() => setConflictCount(0))
  }, [])

  useEffect(() => { loadRules() },      [loadRules])
  useEffect(() => { loadCheckupCounts() }, [loadCheckupCounts])

  // Landing from a Tasks card (?findings=range-drift or ?findings=conflicts) opens the checkup panel, then
  // strips the param so closing it does not reopen on the next render and a refresh does not reopen it.
  useEffect(() => {
    if (!['range-drift', 'conflicts'].includes(searchParams.get('findings'))) return
    setFindingsOpen(true)
    const next = new URLSearchParams(searchParams); next.delete('findings')
    setSearchParams(next, { replace: true })
  }, [searchParams, setSearchParams])
  useEffect(() => { loadCategories() }, [loadCategories])
  useEffect(() => { api.getOwners().then(setOwners) }, [])
  useEffect(() => { api.getAccounts().then(setAccounts) }, [])
  useEffect(() => { api.getRuleSuggestionWork().then(setRuleSuggestionWork).catch(() => setRuleSuggestionWork(null)) }, [])

  // Persist the search + facets for the session (survives navigation, resets on next app launch).
  useEffect(() => { saveRulesSession({ search, facets }) }, [search, facets])

  const importedRuleSuggestionCount = ruleSuggestionWork?.pending_count || 0
  const hasImportedRuleSuggestionWork = !!ruleSuggestionWork?.has_work

  // Leaf category ids per parent group, so a selected *group* facet expands to match any rule assigning a
  // leaf under it.
  const leafIdsByGroup = useMemo(() => {
    const map = {}
    for (const c of categories) if (c.parent_id) (map[c.parent_id] ||= []).push(c.id)
    return map
  }, [categories])

  // The owner lens shows the rules that reach a lens owner's transactions (`services/rule_owner_reach.py`).
  // The reach is a ledger scan, so it is fetched only while the lens is on, and again whenever the rules
  // reload; until it arrives the list waits rather than showing every rule and then shrinking.
  const { lens: ownerLens } = useOwnerLens()
  const [ownerReach, setOwnerReach] = useState(null)
  const lensOn = !!ownerLens
  useEffect(() => {
    if (!lensOn) { setOwnerReach(null); return undefined }
    let ignore = false
    setOwnerReach(null)
    api.getRuleOwnerReach()
      .then(res => { if (!ignore) setOwnerReach(res?.owners || {}) })
      .catch(() => { if (!ignore) setOwnerReach({}) })
    return () => { ignore = true }
  }, [lensOn, matchCacheVersion])
  const lensLoading = lensOn && !ownerReach
  const lensRules = useMemo(() => (
    ownerLens && ownerReach ? rules.filter(rule => ownerLensAdmits(ownerReach[rule.id], ownerLens)) : rules
  ), [rules, ownerLens, ownerReach])

  const filteredRules = useMemo(() => {
    // Expand group selections to their leaf ids and union with directly-selected leaves — so the pure
    // matcher only deals with leaf categoryIds while the UI keeps groups and leaves distinct.
    const effectiveCategoryIds = new Set(facets.categoryIds)
    for (const gid of facets.groupIds) for (const lid of (leafIdsByGroup[gid] || [])) effectiveCategoryIds.add(lid)
    return filterRules(lensRules, search, { ...facets, categoryIds: [...effectiveCategoryIds] })
  }, [lensRules, search, facets, leafIdsByGroup])
  // Alphabetical → A–Z sections; "Last used" → a flat, stalest-first list (never-used rules on top).
  const sectionItems = useMemo(() => {
    if (sortMode === 'lastUsed') {
      return [...filteredRules]
        .sort((a, b) => (a.last_effect_date || '').localeCompare(b.last_effect_date || '') || a.keyword.localeCompare(b.keyword))
        .map(rule => ({ type: 'rule', rule }))
    }
    return buildSectionedRuleItems(filteredRules)
  }, [filteredRules, sortMode])
  const alphaMode = sortMode === 'alpha'
  const presentLetters = useMemo(() => presentSectionLetters(filteredRules), [filteredRules])
  const headerIndexByLetter = useMemo(() => sectionHeaderIndexByLetter(sectionItems), [sectionItems])
  const activeFacetCount = activeRulesFacetCount(facets)

  // The stale-rule cleanup threshold date (today minus the chosen window), or null when none is selected.
  const cleanupBeforeDate = useMemo(() => {
    if (!cleanupWindow) return null
    const [n, unit] = cleanupWindow.split(':')
    const d = new Date()
    if (unit === 'years') d.setFullYear(d.getFullYear() - Number(n))
    else d.setMonth(d.getMonth() - Number(n))
    return localIsoDate(d)
  }, [cleanupWindow])

  // How many rules the current timeframe would sweep — shown on the cleanup button. null = counting (or no
  // window). Re-fetched when the threshold changes and via cleanupCountKey after a cleanup runs (so the
  // count drops to reflect what was trashed). The ignore guard drops a stale response if the window changes.
  const [cleanupCount, setCleanupCount] = useState(null)
  const [cleanupCountKey, setCleanupCountKey] = useState(0)
  useEffect(() => {
    if (!cleanupBeforeDate) { setCleanupCount(null); return }
    let ignore = false
    setCleanupCount(null)
    api.getRuleCleanupCandidates(cleanupBeforeDate)
      .then(res => { if (!ignore) setCleanupCount(res.count) })
      .catch(() => { if (!ignore) setCleanupCount(null) })
    return () => { ignore = true }
  }, [cleanupBeforeDate, cleanupCountKey])

  // Facet option lists, drawn only from values actually used by some rule (so the filter never offers a
  // facet that would match nothing). Labels come straight off the rule rows the list endpoint returns;
  // categories are additionally grouped under their parent (from the categories tree) for the picker.
  const facetOptions = useMemo(() => {
    const catName = new Map(), tags = new Map(), owns = new Map(), accts = new Map(), types = new Map()
    const usedCat = new Set()
    for (const r of lensRules) {
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
  }, [lensRules, categories])

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
      await txnMutations.updateRule(editedRuleId, ruleData, { onExisting: 'merge' })
    } else {
      await api.createRule(ruleData, { onExisting: 'merge' })
    }
    if (applyToExisting && existingRuleId) await txnMutations.applyRule(existingRuleId)
    setCollision(null)
    if (fromEdit) {
      setEditingRuleId(null)
      setCheckupRefreshKey(key => key + 1)
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
    const result = await txnMutations.updateRule(editingRuleId, ruleData, { reconcile })
    if (result?.status && result.status !== 'updated') {
      setCollision({ status: result.status, existingRuleId: result.existing_rule_id, ruleData, applyToExisting, fromEdit: true, editedRuleId: editingRuleId })
      return
    }
    if (applyToExisting) await txnMutations.applyRule(editingRuleId)
    setEditingRuleId(null)
    setCheckupRefreshKey(key => key + 1)
    loadRules()
    loadRecategorizePreview()
  }

  async function handleDelete(id, reconcile = false) {
    await txnMutations.deleteRule(id, { reconcile })
    if (editingRuleId === id) setEditingRuleId(null)
    setCheckupRefreshKey(key => key + 1)
    loadRules()
    loadRecategorizePreview()
  }

  const editingRule = editingRuleId ? rules.find(rule => rule.id === editingRuleId) : null
  const showCreateForm = showAdd
  const showAnyEditor = showAdd || !!editingRule
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
        <PageHeader title="Rules" help={<FeatureExplainer topic="page-rules" placement="bottom-left" />}>
          <RecategorizeButton
            pendingCount={recategorizePendingCount}
            onRun={async () => { await runRecategorize(); loadRules() }}
          />
          <Tooltip describeTrigger content={hasImportedRuleSuggestionWork
            ? 'Review rules suggested from your imported transactions'
            : 'Mark a categorized import as clean to generate rule suggestions'}>
            <Button
              variant="secondary"
              onClick={() => navigate('/import-export/rule-suggestions', { state: { backTo: '/rules', backLabel: 'Rules' } })}
              disabled={!hasImportedRuleSuggestionWork}
            >
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                <span>Generate rules from imported data</span>
                <ActionCountBadge count={importedRuleSuggestionCount} />
              </span>
            </Button>
          </Tooltip>
          {/* Sits beside "Generate rules" because it is the same shape of thing — analyse the rule set,
              present findings, let the user act — rather than in the toolbar below, which is search,
              filter and sort. Enabled as soon as either check can say anything: a single rule with an
              amount range can have a charge drift out of it, while the overlap half needs a pair to
              compare. The badge counts drifted charges and recorded conflicts (see `loadCheckupCounts`). */}
          <Tooltip describeTrigger content={rules.length < 2 && !checkupCount
            ? 'Nothing to check until there are two rules, or a charge drifts out of one'
            : checkupCount
              ? [
                  rangeDriftCount && `${rangeDriftCount} recent charge${rangeDriftCount === 1 ? '' : 's'} a rule's amount range no longer claims`,
                  conflictCount && `${conflictCount} pair${conflictCount === 1 ? '' : 's'} of rules competing for the same transactions`,
                ].filter(Boolean).join('; ')
              : 'Check for drifted amount ranges and rules that compete for the same transaction'}>
            <Button
              variant="secondary"
              disabled={rules.length < 2 && !checkupCount}
              onClick={() => setFindingsOpen(true)}
            >
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                <span>Rule checkup</span>
                <ActionCountBadge count={checkupCount} tone="warning" />
              </span>
            </Button>
          </Tooltip>
          {/* Empty-state-only, like the Categories starter offer: a head start shown only while there
              are no rules yet. Once any rule exists it's gone (add more via "+New"). */}
          {!loading && rules.length === 0 ? (
            <Button
              variant="secondary"
              onClick={() => setShowStarterRules(true)}
              title="Add a curated set of common keyword → category rules"
            >
              Starter rules
            </Button>
          ) : null}
          {/* "+New" rather than "Add rule": the page is the noun, and repeating it in the button only
              costs header width the controls beside it need. */}
          <Button variant={showAnyEditor ? 'secondary' : 'primary'} onClick={() => (showAnyEditor ? closeForm() : openCreateForm())}>
            {showAnyEditor ? 'Cancel' : '+New'}
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
        <label htmlFor={searchId} style={VISUALLY_HIDDEN_STYLE}>
          Search rules by merchant
        </label>
        <SearchInput id={searchId} value={search} onChange={setSearch} placeholder="Search merchant…" size="regular" wrapperStyle={{ width: 260 }} />

        {/* Structured facet filter — page-local, session-scoped (never touches the app-wide FilterContext). */}
        <div style={{ position: 'relative' }}>
          <Button
            variant="secondary"
            onClick={() => setShowFilter(o => !o)}
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {activeFacetCount > 0 ? <>Filter<ActionCountBadge count={activeFacetCount} /></> : '+Filter'}
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
            <IconButton size="compact" aria-label="Remove filter" onClick={chip.remove}>×</IconButton>
          </span>
        ))}

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          {/* Stale-rule cleanup: pick a window (starts at "—" = off), see the count, review before trashing. */}
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--muted)' }}>
            Unused for
            <select
              value={cleanupWindow}
              onChange={e => setCleanupWindow(e.target.value)}
              aria-label="Clean up rules unused for"
              name="rule-cleanup-window"
              style={{ ...getFormControlStyle({ size: 'compact', clickable: true }) }}
            >
              <option value="">—</option>
              <option value="6:months">6 months</option>
              <option value="1:years">1 year</option>
              <option value="2:years">2 years</option>
              <option value="3:years">3 years</option>
              <option value="5:years">5 years</option>
            </select>
          </label>
          {cleanupBeforeDate ? (
            <Button
              size="compact"
              variant="secondary"
              disabled={cleanupCount === 0}
              onClick={() => setCleanupOpen(true)}
              title="Review and clean out rules that haven't categorized anything recently"
            >
              {cleanupCount === null
                ? 'Counting…'
                : cleanupCount === 0
                  ? 'No rules match this timeframe'
                  : `Select ${cleanupCount} rule${cleanupCount === 1 ? '' : 's'}`}
            </Button>
          ) : null}

          {/* Sort toggle: alphabetical (A–Z sections) vs stalest-first by last-used date.
              One direction each, deliberately — clicking the selected segment again does NOT reverse it.
              "Last used" ascends because that is the order the stale-rule sweep beside it works in, and
              the question a descending list would answer ("which rules are actually doing the work") is
              answered badly by this column and well by the per-rule match count: `last_effect_date` holds
              the matched *transaction's* date, so a rule firing once a month on last week's charge
              outranks one that matched hundreds of rows ending a week earlier. Reverse-on-reclick also
              has no affordance on a segmented control, and would have to apply to A–Z for consistency,
              where Z–A has no use at all. If this is ever wanted, give the segment a visible direction
              caret rather than hiding the behaviour in a second click. */}
          <SegmentedToggle
            size="compact"
            ariaLabel="Sort rules"
            value={sortMode}
            onChange={setSortMode}
            options={[{ value: 'alpha', label: 'A–Z' }, { value: 'lastUsed', label: 'Last used' }]}
          />

          <span style={{ fontSize: 12, color: 'var(--muted)' }}>
            {filteredRules.length === lensRules.length
              ? `${lensRules.length} rule${lensRules.length !== 1 ? 's' : ''}`
              : `${filteredRules.length} of ${lensRules.length} rules`}
          </span>
        </div>
      </div>

      {/* Horizontal A–Z jump strip (alphabetical sort only; the "Last used" order isn't letter-sectioned). */}
      {!loading && !lensLoading && alphaMode && filteredRules.length > 0 ? (
        <AlphaRail present={presentLetters} current={currentLetter} onJump={jumpToLetter} />
      ) : null}

      {/* Create form sits above the list in its own fixed region (its own scroll if tall) so the windowed
          list below owns a clean scroll container — a virtualizer doesn't want unrelated content sharing
          its scrollport. */}
      {showCreateForm ? (
        <div style={{ flexShrink: 0, padding: '12px 32px 0', maxHeight: vh(58), overflowY: 'auto' }}>
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
        {loading || lensLoading ? (
            <div style={{ padding: 24 }}><Spinner /></div>
          ) : rules.length === 0 ? (
            <EmptyState message='No rules yet — click "+New" to create one' />
          ) : lensRules.length === 0 ? (
            <EmptyState message="No rules reach the owners shown" />
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
                      matchesCache={matchesCacheRef.current}
                      matchCacheVersion={matchCacheVersion}
                      onOpenReport={(rule, data) => setMatchReport({ rule, data })}
                    />
                  )
              )}
            />
          )}
      </div>

      <div style={{ flexShrink: 0, padding: '7px 32px', borderTop: '1px solid var(--border)', background: 'var(--surface)', fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.5 }}>
        Rules are evaluated most-specific first (owner- and account-scoped beat global, then longer keywords,
        then narrower amount ranges). The list is alphabetical by merchant — use the “Jump to” strip above to
        skip around.
      </div>

      {/* Mounted only while open, so its local working/error/reconcile state can't leak into the next
          edit session (the component otherwise renders null but stays mounted). */}
      {/* The editor and the checkup float above the page and can be moved freely, but the rules list
          behind them stays out of reach while either is open: a click on another rule's edit control
          would swap the editor's rule and drop unsaved changes. Sits just under the panel stack. */}
      {editingRule || findingsOpen ? (
        <div style={{ position: 'fixed', inset: 0, zIndex: 400, background: 'rgba(10, 15, 26, 0.38)' }} />
      ) : null}

      {editingRule ? (
        <EditRuleOverlay
          // Keyed by rule: "Open the other rule" swaps the rule in place, and the form seeds its fields
          // only when it mounts.
          key={editingRule.id}
          rule={editingRule}
          categories={categories}
          owners={owners}
          accounts={accounts}
          onSave={handleEditSave}
          onDelete={handleDelete}
          onCancel={closeForm}
        />
      ) : null}

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
              <Button variant="secondary" onClick={() => setCollision(null)}>Cancel</Button>
              <Button variant="secondary" onClick={openExistingFromCollision}>Open the other rule</Button>
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

      {cleanupOpen && cleanupBeforeDate ? (
        <RuleCleanupDialog
          before={cleanupBeforeDate}
          windowLabel={{ '6:months': '6 months', '1:years': '1 year', '2:years': '2 years', '3:years': '3 years', '5:years': '5 years' }[cleanupWindow] || ''}
          owners={owners}
          accounts={accounts}
          onClose={() => setCleanupOpen(false)}
          onDone={() => { setCleanupOpen(false); loadRules(); loadRecategorizePreview(); setCleanupCountKey(k => k + 1) }}
        />
      ) : null}

      {findingsOpen ? (
        <RuleFindingsDialog
          // Closing re-reads the badge: widening a range or dismissing a charge inside the panel is
          // exactly what changes it, and a badge still showing the old number reads as a failed action.
          onClose={() => { setFindingsOpen(false); loadCheckupCounts() }}
          // The editor opens as a second floating panel above this one, which stays open with its
          // results so the two can be arranged side by side.
          onEditRule={openEditForm}
          onRulesChanged={() => { loadRules(); loadRecategorizePreview() }}
          refreshKey={checkupRefreshKey}
        />
      ) : null}

      {matchReport ? (
        <RulePreviewDialog
          transactions={matchReport.data.transactions}
          categories={categories}
          title={`Transactions matching “${formatRuleMatcher(matchReport.rule)}”`}
          subtitle={
            matchReport.data.count > matchReport.data.transactions.length
              ? `${matchReport.data.count} matching · showing the ${matchReport.data.transactions.length} most recent`
              : `${matchReport.data.count} matching transaction${matchReport.data.count !== 1 ? 's' : ''}`
          }
          onClose={() => setMatchReport(null)}
        />
      ) : null}
    </div>
  )
}
