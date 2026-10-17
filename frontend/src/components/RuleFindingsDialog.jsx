// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * What is wrong with the rule set, in one panel, run from the Rules page.
 *
 * Five sections with different intents, and keeping them visually distinct is the point of the layout.
 *
 * **Charges outside a rule's range** is the only one that arrives on its own. An amount range is a
 * matching gate, so a bill that grows past the bound stops matching: the row loses the rule's category,
 * and the place in that rule's series the category earned it, with nothing malfunctioning to reveal it.
 * That makes it news — it is what the badge on the control counts — and it is the one finding here with
 * a one-click fix, because a bound has one right answer: take in this charge.
 *
 * **Overlapping amount ranges** and **Rules that match the same transaction** are work of a different
 * kind: both rules can claim a charge and nothing meaningful decides which, so the user has to settle
 * it. This panel deliberately proposes no edit for either, because the ambiguity is in the rules
 * themselves and a one-click "fix" would dress a coin flip as a decision. The two differ only in how the
 * pair reaches that state — one by ranges that overlap, one by two matchers landing in one merchant name
 * — and the second carries the transaction that proves it, since without a real row there is nothing to
 * report.
 *
 * **Nested merchant matchers** is not a defect; it is reported so the outcome is visible, and because a
 * pair whose two rules do the same thing has a surplus half worth clearing out. **Rules where a limit
 * decides** is the case a reader gets wrong: one keyword sits inside the other, but an owner or account
 * limit only the shorter one carries puts it first. **Competing rules that file the same way** is a
 * pair from either warning section whose two rules do the same thing, so it is competing over nothing
 * and belongs out of the warnings entirely.
 *
 * Only the drift section arrives on its own. Three of the other four are an *audit* that changes when a
 * rule is edited — which is why none is badged — and the co-match section also moves when transactions
 * arrive, since it is the one finding read from the ledger rather than from the rules.
 *
 * Every finding names its rules, as #1 (top) and #2, and offers Edit. **Delete is offered only where
 * removing a rule changes nothing** — the server's `removable_rule_id`: a nesting pair's inner rule when
 * both rules do the same thing, or a benign pair's rule whose every transaction the other also matches.
 * An overlap that changes the outcome offers none: the answer is to refine the conditions, and deleting
 * one of the rules picks a side instead of fixing the model.
 *
 * The delete carries the rules list's own opt-in to re-evaluate the rule's transactions, so this panel
 * does not quietly pick a different answer to that question than the list does.
 *
 * **Dismissal is what makes the informational sections usable at real density, and the line it stops at
 * is whether the winner changes anything.** Most nesting pairs are deliberate, and a list of thirty that
 * never shrinks is one nobody opens twice; a range-drift charge can equally be one the rule was never
 * meant to claim; a competing pair whose rules file identically resolves to the same ledger either way.
 * All of those can be acknowledged, one at a time. A **live overlap or co-match cannot be**: its winner
 * is arbitrary rather than undefined — the ordering breaks the tie reproducibly, just not for any reason
 * about these two rules — so waving it through would leave the ledger categorized by an accident while
 * the panel called it settled. The server decides this (`dismissible` on each finding), not the layout
 * here.
 *
 * Dismissed findings are not gone: a *Show dismissed* toggle brings them back, flagged and restorable, so
 * an acknowledgement made in error is visible rather than lost. The counts in the header always describe
 * the open set, so turning the toggle on never makes it look like there is more to do.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../lib/api.js'
import { txnMutations } from '../lib/txnMutations.js'
import { Button, Spinner, EmptyState } from './ui.jsx'
import { DetailPanelShell, useDetailPanelChrome, useRestorablePanelGeometry } from './detailShared.jsx'
import RuleSummary from './RuleSummary.jsx'
import CornerTab from './CornerTab.jsx'
import { formatCurrency, formatDate } from '../lib/utils.js'
import { ACCOUNT_TYPE_LABEL } from '../lib/accountTypes.js'

// A finding's contested band, said the way it reads: a range where the two ranges genuinely overlap,
// a single figure where they meet at one value (capping one rule at the other's floor leaves exactly
// that, since both bounds are inclusive).
function overlapBandText(finding) {
  const { overlap_min: low, overlap_max: high } = finding
  if (low === high) return `a charge of exactly ${formatCurrency(low)}`
  return `charges from ${formatCurrency(low)} to ${formatCurrency(high)}`
}

// Edit, plus Delete on the one rule a finding says is surplus. Delete confirms in place and carries the
// same re-evaluate opt-in the rules list offers, defaulted off: the other rule does the same thing, so
// the rows already read as they would after a re-evaluation.
function RuleActions({ ruleId, onEditRule, onDelete, busy }) {
  const [confirming, setConfirming] = useState(false)
  const [reconcile, setReconcile] = useState(false)

  if (!onDelete) {
    return <Button small variant="ghost" onClick={() => onEditRule(ruleId)}>Edit</Button>
  }
  if (!confirming) {
    return (
      <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
        <Button small variant="ghost" onClick={() => onEditRule(ruleId)}>Edit</Button>
        <Button
          small
          variant="ghost"
          disabled={busy}
          onClick={() => setConfirming(true)}
          title="Move this rule to the rules trash, where it can be restored"
        >
          Delete
        </Button>
      </div>
    )
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
      <label
        title="Also re-evaluate the transactions this rule categorized now. Off leaves them as they are; the other rule takes them on the next categorization pass."
        style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--muted)', cursor: 'pointer', whiteSpace: 'nowrap' }}
      >
        <input type="checkbox" checked={reconcile} onChange={e => setReconcile(e.target.checked)} disabled={busy} />
        re-evaluate its transactions
      </label>
      <Button
        small
        disabled={busy}
        onClick={() => onDelete(ruleId, reconcile)}
        style={{ background: 'var(--danger)', color: '#fff', border: 'none' }}
      >
        Delete rule
      </Button>
      <Button small variant="ghost" disabled={busy} onClick={() => { setConfirming(false); setReconcile(false) }}>
        Cancel
      </Button>
    </div>
  )
}

function RulePair({ finding, rules, onEditRule, onDelete, busy }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {finding.rule_ids.map((id, index) => {
        const rule = rules[id]
        if (!rule) return null
        const isWinner = finding.winner_rule_id === id
        return (
          <div
            key={id}
            style={{
              display: 'flex', alignItems: 'flex-start', gap: 10, padding: '7px 10px', borderRadius: 8,
              background: 'color-mix(in srgb, var(--surface2) 60%, var(--surface))',
              border: '1px solid color-mix(in srgb, var(--border) 70%, transparent)',
              flexWrap: 'wrap',
            }}
          >
            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', marginTop: 1, ...fadedIfDismissed(finding) }}>#{index + 1}</span>
            <div style={{ flex: 1, minWidth: 0, ...fadedIfDismissed(finding) }}>
              <RuleSummary rule={rule} showConditions />
            </div>
            {isWinner ? (
              <span style={{ fontSize: 11, color: 'var(--muted)', whiteSpace: 'nowrap', marginTop: 2, ...fadedIfDismissed(finding) }}>wins</span>
            ) : null}
            <RuleActions
              ruleId={id}
              onEditRule={onEditRule}
              onDelete={finding.removable_rule_id === id ? onDelete : null}
              busy={busy}
            />
          </div>
        )
      })}
    </div>
  )
}

// How two rules' actions differ, as phrases naming each rule by its label ("#1", "#2"); empty when they
// do the same thing. Compares what `rule_overlaps._actions_agree` compares.
function actionDifferences(first, second, [firstLabel, secondLabel]) {
  const parts = []
  if ((first.category_id || null) !== (second.category_id || null)) {
    const files = rule => (rule.category_name ? `files to ${rule.category_name}` : 'sets no category')
    parts.push(`${firstLabel} ${files(first)} where ${secondLabel} ${files(second)}`)
  }
  const renameOf = rule => (rule.clean_name || '').trim()
  if (renameOf(first).toLowerCase() !== renameOf(second).toLowerCase()) {
    const renames = rule => (renameOf(rule) ? `renames to “${renameOf(rule)}”` : 'keeps the name')
    parts.push(`${firstLabel} ${renames(first)} where ${secondLabel} ${renames(second)}`)
  }
  const tagKey = rule => (rule.tag_ids || []).slice().sort().join(',')
  if (tagKey(first) !== tagKey(second)) parts.push(`${firstLabel} and ${secondLabel} add different tags`)
  if (Boolean(first.is_recurring) !== Boolean(second.is_recurring)) {
    parts.push(`only ${first.is_recurring ? firstLabel : secondLabel} tracks a recurring series`)
  }
  return parts
}

const sentence = parts => {
  const text = parts.join('; ')
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`
}

// Dismissed cards fade their content rather than the whole card, so the set-aside text reads as set aside
// while Restore, Edit and the other controls still look as available as they are. A corner tab names the
// state where the eye starts, since a fade alone only hints at it.
const fadedIfDismissed = finding => (finding.dismissed ? { opacity: 0.6 } : null)

function DismissedTab({ finding, borderColor }) {
  if (!finding.dismissed) return null
  return <CornerTab corner="top-left" size="sm" borderColor={borderColor}>Dismissed</CornerTab>
}

// A dismissed card's extra top padding clears its corner tab.
const cardPadding = finding => (finding.dismissed ? '28px 12px 10px' : '10px 12px')

const isOverlapKind = kind => kind === 'amount_overlap' || kind === 'amount_overlap_benign'
const isCoMatchKind = kind => kind === 'matcher_co_match' || kind === 'matcher_co_match_benign'

// A card about a real collision leads with the evidence, because the evidence *is* the finding: these
// rules only compete if a real transaction matches both, and showing it is also how the user judges
// whether the pair is worth untangling.
function evidenceNote(finding) {
  const amount = formatCurrency(Math.abs(finding.amount))
  const when = formatDate(finding.txn_date)
  const also = finding.txn_count > 1
    ? ` and ${finding.txn_count - 1} other${finding.txn_count === 2 ? '' : 's'}`
    : ''
  return `Both rules match “${finding.txn_name}” — ${amount} on ${when}${also}.`
}

function nestingNote(finding, broader, narrower) {
  const differences = actionDifferences(narrower, broader, ['#2', '#1'])
  if (differences.length) return sentence(differences)
  return finding.removable_rule_id
    ? 'Both rules take the same action.'
    : 'Both rules take the same action, but #1 does not take every charge #2 does, so #2 is still needed.'
}

// The limit that put #1 first, named the way the rule's own summary names it.
function decidingLimit(finding, winner) {
  if (finding.deciding_scope === 'owner') return winner.owner_name
  if (finding.deciding_scope === 'account') return winner.account_name
  if (finding.deciding_scope === 'account_type') return ACCOUNT_TYPE_LABEL[winner.account_type] ?? winner.account_type
  return null
}

function scopeSplitNote(finding, winner, other) {
  const limit = decidingLimit(finding, winner)
  const differences = actionDifferences(winner, other, ['#1', '#2'])
  return `${evidenceNote(finding)} #1 is limited to ${limit}, and owner and account limits count before keyword length, so #1 wins where both match. ${sentence(differences)}`
}

// Said only on a pair that offers a Delete, because that is the claim the Delete rests on.
function coverageNote(finding) {
  const index = finding.rule_ids.indexOf(finding.removable_rule_id)
  if (index < 0) return null
  return `#${index + 1} has no transactions outside #${2 - index}’s.`
}

function FindingCard({ finding, rules, onEditRule, onDelete, onDismiss, onRestore, busy }) {
  const first = rules[finding.rule_ids[0]]
  const second = rules[finding.rule_ids[1]]
  // Styling follows severity rather than kind now that both warnings have a benign twin: a pair whose
  // rules file identically is not the thing the red border is for.
  const isWarning = finding.severity === 'warning'
  const isBenign = finding.kind === 'amount_overlap_benign' || finding.kind === 'matcher_co_match_benign'
  let note = null
  if (isOverlapKind(finding.kind)) {
    note = `Both rules claim ${overlapBandText(finding)}, and neither range completely contains the other.`
    if (finding.kind === 'amount_overlap') note += ' Which rule wins is arbitrary. Adjust the ranges so they do not overlap.'
  } else if (isCoMatchKind(finding.kind)) {
    note = evidenceNote(finding)
  } else if (first && second) {
    note = finding.kind === 'matcher_scope_split'
      ? scopeSplitNote(finding, first, second)
      : nestingNote(finding, first, second)
  }
  if (isBenign && finding.removable_rule_id) note = `${note} ${coverageNote(finding)}`
  const borderColor = isWarning ? 'color-mix(in srgb, var(--danger) 26%, var(--border))' : 'var(--border)'
  return (
    <div
      style={{
        position: 'relative', padding: cardPadding(finding), borderRadius: 10,
        display: 'flex', flexDirection: 'column', gap: 8,
        border: `1px solid ${borderColor}`,
        background: isWarning ? 'color-mix(in srgb, var(--danger) 5%, var(--surface))' : 'var(--surface)',
      }}
    >
      <DismissedTab finding={finding} borderColor={borderColor} />
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <div style={{ fontSize: 12.5, flex: 1, minWidth: 0, ...fadedIfDismissed(finding) }}>{note}</div>
        <DismissAction
          finding={finding}
          onDismiss={onDismiss}
          onRestore={onRestore}
          busy={busy}
          title="Acknowledge this pair — it stops being listed until the situation changes"
        />
      </div>
      <RulePair finding={finding} rules={rules} onEditRule={onEditRule} onDelete={onDelete} busy={busy} />
    </div>
  )
}

// The acknowledge control, shared by both card shapes: offered only where the server says the finding
// may be acknowledged, and flipping to the way back once it has been.
function DismissAction({ finding, onDismiss, onRestore, busy, title }) {
  if (!finding.dismissible) return null
  if (finding.dismissed) {
    return <Button small variant="ghost" disabled={busy} onClick={() => onRestore(finding)}>Restore</Button>
  }
  return (
    <Button small variant="ghost" disabled={busy} onClick={() => onDismiss(finding)} title={title}>
      Dismiss
    </Button>
  )
}

// What drifted, by how much, and what it cost — said as one sentence because that is how it reads on the
// card. The two kinds differ in tense rather than in substance: one charge has already fallen out of the
// rule, the next one is about to.
function driftNote(finding) {
  const bound = finding.bound === 'max' ? 'maximum' : 'minimum'
  const limit = formatCurrency(finding.bound === 'max' ? finding.amount_max : finding.amount_min)
  const amount = formatCurrency(Math.abs(finding.amount))
  const when = formatDate(finding.txn_date)
  if (finding.kind === 'rule_range_edge') {
    return `${amount} on ${when} is within ${finding.percent}% of the rule’s ${bound} of ${limit}. The next one may fall outside it.`
  }
  const where = finding.bound === 'max' ? 'above' : 'below'
  const landed = finding.current_category_name
    ? `It is categorized as ${finding.current_category_name} instead.`
    : 'It is uncategorized as a result.'
  return `${amount} on ${when} is ${finding.percent}% ${where} the ${bound} of ${limit}, so the rule did not claim it. ${landed}`
}

/*
 * One charge an amount-gated rule nearly claimed.
 *
 * A different shape from the pair cards above it, because a different thing is wrong: this finding is
 * about one rule and one transaction, so there is no winner to name and nothing to compare. It carries
 * the fix the other sections deliberately do not — **Widen to include** — because a bound genuinely has
 * one right answer here, and the alternative is the rule editor and mental arithmetic.
 *
 * Offered on the outside-the-range kind only. A charge still inside the range is already being claimed;
 * there is nothing yet to take in, and moving the bound out to it would widen the rule on the strength of
 * a charge that never needed it.
 */
function RangeDriftCard({ finding, rules, onEditRule, onWiden, onDismiss, onRestore, busy }) {
  const rule = rules[finding.rule_id]
  const outside = finding.kind === 'rule_range'
  const borderColor = outside ? 'color-mix(in srgb, var(--warning) 30%, var(--border))' : 'var(--border)'
  return (
    <div
      style={{
        position: 'relative', padding: cardPadding(finding), borderRadius: 10,
        display: 'flex', flexDirection: 'column', gap: 8,
        border: `1px solid ${borderColor}`,
        background: outside ? 'color-mix(in srgb, var(--warning) 5%, var(--surface))' : 'var(--surface)',
      }}
    >
      <DismissedTab finding={finding} borderColor={borderColor} />
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <div style={{ fontSize: 12.5, flex: 1, minWidth: 0, ...fadedIfDismissed(finding) }}>
          <div style={{ fontWeight: 620, marginBottom: 2 }}>{finding.txn_name}</div>
          {driftNote(finding)}
          {/* Why it matters beyond one category. Said only where the charge actually fell out: an edge
              charge is still being claimed, so its series is intact. */}
          {outside && finding.series_name ? (
            <> It dropped out of the {finding.series_name} series too.</>
          ) : null}
        </div>
        <DismissAction
          finding={finding}
          onDismiss={onDismiss}
          onRestore={onRestore}
          busy={busy}
          title="Acknowledge this charge — it stops being listed, and the next one still reports"
        />
      </div>
      {rule ? (
        <div
          style={{
            display: 'flex', alignItems: 'flex-start', gap: 10, padding: '7px 10px', borderRadius: 8,
            background: 'color-mix(in srgb, var(--surface2) 60%, var(--surface))',
            border: '1px solid color-mix(in srgb, var(--border) 70%, transparent)',
            flexWrap: 'wrap',
          }}
        >
          <div style={{ flex: 1, minWidth: 0, ...fadedIfDismissed(finding) }}>
            <RuleSummary rule={rule} showConditions />
          </div>
          <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
            {outside ? (
              <Button
                small
                disabled={busy}
                onClick={() => onWiden(finding)}
                title="Move the rule’s limit out to this charge and re-apply the rule"
              >
                Widen to include
              </Button>
            ) : null}
            <Button small variant="ghost" onClick={() => onEditRule(finding.rule_id)}>Edit</Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function Section({ title, blurb, findings, renderCard }) {
  if (!findings.length) return null
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div>
        <div style={{ fontSize: 13, fontWeight: 600 }}>{title}</div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>{blurb}</div>
      </div>
      {findings.map(renderCard)}
    </div>
  )
}

const EMPTY = { count: 0, counts: {}, dismissed_count: 0, findings: [], rules: {} }

// A check's result with one finding's dismissal flipped, the open counts following it. Exact for the
// overlap check, whose findings are fixed by the rules alone; not for range drift, where a dismissal
// frees a place under the per-rule cap for a charge that was not listed.
function withDismissal(result, key, dismissed) {
  const finding = result.findings.find(item => item.key === key)
  if (!finding || Boolean(finding.dismissed) === dismissed) return result
  const delta = dismissed ? -1 : 1
  return {
    ...result,
    findings: result.findings.map(item => (item.key === key ? { ...item, dismissed } : item)),
    counts: { ...result.counts, [finding.kind]: (result.counts[finding.kind] || 0) + delta },
    count: result.count + delta,
    dismissed_count: result.dismissed_count - delta,
  }
}

// A floating panel that moves and resizes, and stays open while a rule it opened is edited, so the two
// windows can sit side by side. `refreshKey` changing says an edit was saved, so the checks run again
// with the current results still showing.
export default function RuleFindingsDialog({ onClose, onEditRule, onRulesChanged, refreshKey = 0 }) {
  const geometry = useRestorablePanelGeometry('ui.rules.checkupPanel', { fallbackWidth: 760, fallbackHeight: 760 })
  const chrome = useDetailPanelChrome(onClose, { forceFloating: true, ...geometry })
  const [overlaps, setOverlaps] = useState(null)
  const [drift, setDrift] = useState(null)
  const [busy, setBusy] = useState(false)
  const [showDismissed, setShowDismissed] = useState(false)
  const [actionError, setActionError] = useState(null)

  // Two checks, fetched together and kept apart. They answer different questions over different inputs —
  // one pairwise over the rule set, one over the recent ledger — so merging them server-side would have
  // meant one endpoint that recomputes both whenever either is asked for, including for the page badge
  // that only ever needs the cheaper half. Both are fetched with their dismissed findings, and *Show
  // dismissed* only filters what is drawn, so the toggle never re-runs the overlap check's ledger scan.
  const loadDrift = useCallback(async () => {
    setDrift(await api.getRuleRangeDrift({ includeDismissed: true }).catch(() => EMPTY))
  }, [])
  const loadOverlaps = useCallback(async () => {
    setOverlaps(await api.getRuleOverlaps({ includeDismissed: true }).catch(() => EMPTY))
  }, [])
  const load = useCallback(() => Promise.all([loadOverlaps(), loadDrift()]), [loadOverlaps, loadDrift])

  useEffect(() => {
    let live = true
    load().catch(() => { if (live) { setOverlaps(EMPTY); setDrift(EMPTY) } })
    return () => { live = false }
  }, [load])

  // A delete or a widened range can change findings other than the one acted on — a delete dissolves
  // every pair its rule appeared in, widening a range can settle an overlap — so those re-run both
  // checks. A dismissal changes only its own finding, so an overlap dismissal is applied to the list in
  // place, sparing the ledger scan; a drift dismissal re-runs the drift check alone, which is cheap and
  // is the only way to see the charge the freed place under the per-rule cap now lists. Previous results
  // stay on screen while a check re-runs, so the list does not blink back through a spinner.
  //
  // A failed action says so, and its checks re-run anyway, so the panel shows what is actually saved.
  async function runAction(action, { reload = load, onSaved = null } = {}) {
    if (busy) return
    setBusy(true)
    setActionError(null)
    let failed = false
    try {
      await action()
      onSaved?.()
    } catch (err) {
      failed = true
      setActionError(`Could not save that change: ${err?.message || 'the request failed.'}`)
    } finally {
      // The loads catch their own failures, so this always settles.
      const refresh = failed ? load : reload
      if (refresh) await refresh()
      setBusy(false)
    }
  }

  // An edit saved from the panel can change any finding, so it re-runs both checks. Skipped on mount,
  // where the effect above has already loaded.
  const seenRefreshKey = useRef(refreshKey)
  useEffect(() => {
    if (seenRefreshKey.current === refreshKey) return
    seenRefreshKey.current = refreshKey
    runAction(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey])

  const deleteRule = (ruleId, reconcile) => runAction(async () => {
    await api.deleteRule(ruleId, { reconcile })
    onRulesChanged?.()
  })

  // Move the bound out to this charge and re-apply the rule, which is the whole maintenance action the
  // finding exists to offer. One request, so it cannot stop halfway: as a rule update followed by a
  // separate apply, a failure between them could leave the bound moved and the charge unclaimed. The server
  // rounds the bound outwards and preserves hand categorizations (`widen_rule_range`). What happens to
  // the rule's series follows on its own — the row takes the category back, and the detector claims it on
  // its next pass.
  const widenRange = finding => runAction(async () => {
    await txnMutations.widenRuleRange(finding.rule_id, finding.bound, Math.abs(Number(finding.amount) || 0))
    onRulesChanged?.()
  })

  // Each family keeps its own dismissal store, so the finding's kind picks the endpoint.
  const isDrift = finding => finding.kind === 'rule_range' || finding.kind === 'rule_range_edge'
  const setOverlapDismissal = (finding, dismissed) => () => setOverlaps(prev => withDismissal(prev, finding.key, dismissed))
  const dismissFinding = finding => (isDrift(finding)
    ? runAction(() => api.dismissRuleRangeDrift(finding.key, finding.kind), { reload: loadDrift })
    : runAction(() => api.dismissRuleOverlap(finding.key, finding.kind), { reload: null, onSaved: setOverlapDismissal(finding, true) }))
  const restoreFinding = finding => (isDrift(finding)
    ? runAction(() => api.restoreRuleRangeDrift(finding.key), { reload: loadDrift })
    : runAction(() => api.restoreRuleOverlap(finding.key), { reload: null, onSaved: setOverlapDismissal(finding, false) }))

  const loading = overlaps == null || drift == null
  const listed = findings => (showDismissed ? findings : findings.filter(finding => !finding.dismissed))
  const overlapFindings = listed(overlaps?.findings || [])
  const driftFindings = listed(drift?.findings || [])
  const nothingListed = !overlapFindings.length && !driftFindings.length
  // The header counts the *open* set from each server's own tally, never the rendered rows: with the
  // toggle on, counting what is on screen would report acknowledged findings as work still to do.
  const openDrift = drift?.count || 0
  const openOverlaps = (overlaps?.counts?.amount_overlap || 0) + (overlaps?.counts?.matcher_co_match || 0)
  // The informational tally is everything listed for knowledge rather than for action: nesting pairs,
  // and the competing pairs whose two rules turn out to do the same thing.
  const openNesting = (overlaps?.counts?.matcher_nesting || 0)
    + (overlaps?.counts?.matcher_scope_split || 0)
    + (overlaps?.counts?.amount_overlap_benign || 0)
    + (overlaps?.counts?.matcher_co_match_benign || 0)
  const dismissedCount = (overlaps?.dismissed_count || 0) + (drift?.dismissed_count || 0)

  // One section of rule-pair cards. Delete is wired for every section; a card offers it only on the
  // rule the server marked removable.
  const pairSection = (title, blurb, kinds) => (
    <Section
      title={title}
      blurb={blurb}
      findings={overlapFindings.filter(f => kinds.includes(f.kind))}
      renderCard={finding => (
        <FindingCard
          key={finding.key}
          finding={finding}
          rules={overlaps.rules}
          onEditRule={onEditRule}
          onDelete={deleteRule}
          onDismiss={dismissFinding}
          onRestore={restoreFinding}
          busy={busy}
        />
      )}
    />
  )


  const summary = () => {
    if (loading) return 'Checking rules…'
    const parts = []
    if (openDrift) parts.push(`${openDrift} charge${openDrift === 1 ? '' : 's'} outside a range`)
    if (openOverlaps) parts.push(`${openOverlaps} to settle`)
    if (openNesting) parts.push(`${openNesting} for information`)
    if (parts.length) return parts.join(' · ')
    return dismissedCount > 0
      ? `Nothing left to look at — ${dismissedCount} dismissed.`
      : 'Nothing needs attention in the rule set.'
  }

  return (
    <DetailPanelShell
      {...chrome}
      onClose={onClose}
      bodyPadding={0}
      header={(
        <div>
          <div style={{ fontSize: 17, fontWeight: 600 }}>Rule checkup</div>
          <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 2 }}>{summary()}</div>
        </div>
      )}
    >
        {actionError ? (
          <div
            role="alert"
            style={{
              margin: '12px 18px 0', padding: '8px 12px', borderRadius: 8, fontSize: 13,
              background: 'color-mix(in srgb, var(--danger) 10%, var(--surface2))',
              border: '1px solid color-mix(in srgb, var(--danger) 40%, var(--border))',
              color: 'var(--danger)',
            }}
          >
            {actionError}
          </div>
        ) : null}

        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '12px 18px', display: 'flex', flexDirection: 'column', gap: 18 }}>
          {loading ? (
            <div style={{ padding: 24 }}><Spinner /></div>
          ) : nothingListed ? (
            <EmptyState message={dismissedCount > 0
              ? 'Everything the checks found has been dismissed.'
              : 'Every rule claims the charges it should, and every rule that can match a transaction has a clear winner.'} />
          ) : (
            <>
              {/* First because it is the only section that arrives on its own: these charges appeared in
                  the ledger, where the two below only change when a rule is edited. */}
              <Section
                title="Charges outside a rule’s range"
                blurb="An amount range decides which transactions a rule claims, so a bill that grows past the limit quietly stops being categorized by that rule. Widening the limit takes the charge back."
                findings={driftFindings}
                renderCard={finding => (
                  <RangeDriftCard
                    key={finding.key}
                    finding={finding}
                    rules={drift.rules}
                    onEditRule={onEditRule}
                    onWiden={widenRange}
                    onDismiss={dismissFinding}
                    onRestore={restoreFinding}
                    busy={busy}
                  />
                )}
              />
              {pairSection(
                'Amount ranges that overlap',
                'Two rules with partially overlapping ranges match a transaction. Adjust the rules so that only one applies.',
                ['amount_overlap'],
              )}
              {pairSection(
                'Rules that match the same transaction',
                'Two rules whose keywords don’t contain each other match the same transaction with different results. Adjust the rules so only one applies.',
                ['matcher_co_match'],
              )}
              {pairSection(
                'Merchant matchers that nest',
                'One rule’s keyword contains the other’s, so the longer one wins where both match. When both take the same action, the longer one can be removed. Edit the rules if that is not the intention.',
                ['matcher_nesting'],
              )}
              {pairSection(
                'Rules where a limit decides',
                'One rule’s keyword contains the other’s, but the shorter one has an owner or account limit the longer one lacks, so it wins where both match. Edit the rules if that is not the intention.',
                ['matcher_scope_split'],
              )}
              {/* Last, and deliberately not among the warnings above: these pairs compete over an
                  outcome that is the same either way, so they are listed in case the match is an
                  accident rather than because anything needs doing. */}
              {pairSection(
                'Competing rules that file the same way',
                'These rules have transactions in common and take the same actions. If neither has transactions outside the common set, one could be removed.',
                ['amount_overlap_benign', 'matcher_co_match_benign'],
              )}
            </>
          )}
        </div>

        <div style={{ padding: '12px 18px', borderTop: '1px solid var(--border)', background: 'color-mix(in srgb, var(--surface2) 66%, var(--surface))', display: 'flex', alignItems: 'center', gap: 12 }}>
          {/* Offered only once there is something to reveal, so the panel does not carry a control that
              would show an empty set — and kept once toggled on, so the way back is where it was. */}
          {dismissedCount > 0 || showDismissed ? (
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--muted)', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={showDismissed}
                onChange={e => setShowDismissed(e.target.checked)}
                disabled={busy}
              />
              Show dismissed{dismissedCount > 0 ? ` (${dismissedCount})` : ''}
            </label>
          ) : null}
          <Button variant="ghost" onClick={onClose} style={{ marginLeft: 'auto' }}>Close</Button>
        </div>
    </DetailPanelShell>
  )
}
