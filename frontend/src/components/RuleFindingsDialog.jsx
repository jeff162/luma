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
 * **Nested merchant matchers** is not a defect; it is reported because the winner is not always the rule
 * a reader would guess (scope outranks keyword length), and because a pair filing to one category under
 * one scope has a surplus half worth clearing out. **Competing rules that file the same way** is the
 * other half of that thought: a pair from either warning section whose two rules apply the same
 * category, rename and tags is competing over nothing, and belongs out of the warnings entirely.
 *
 * Only the drift section arrives on its own. Three of the other four are an *audit* that changes when a
 * rule is edited — which is why none is badged — and the co-match section also moves when transactions
 * arrive, since it is the one finding read from the ledger rather than from the rules.
 *
 * Every finding names its rules and offers Edit. **Delete is on the nesting half**, which is the reverse
 * of how it first reads. An overlap is a modelling ambiguity: the answer is to refine the conditions
 * until the rules are unambiguous, and deleting one of them picks a side instead of fixing the model. A
 * nesting pair where both rules file to the same category under the same scope has a genuinely surplus
 * half — the narrow rule changes nothing — and removing it is the whole maintenance action. Delete is
 * offered on the **narrow** rule only: deleting the broad one would strand every row the narrow matcher
 * does not reach.
 *
 * What the card must say, because the flag deliberately does not cover it: `narrower_is_redundant` is
 * about the *category*. A rename or a tag carried by only one of the two rules does change hands when
 * the narrow rule goes, so that difference is read off the rules here and stated before the fact.
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

import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api.js'
import { txnMutations } from '../lib/txnMutations.js'
import { Button, OverlayBackdrop, FloatingPanel, FloatingPanelHeader, Spinner, EmptyState } from './ui.jsx'
import RuleSummary from './RuleSummary.jsx'
import { formatCurrency, formatDate } from '../lib/utils.js'

// A finding's contested band, said the way it reads: a range where the two ranges genuinely overlap,
// a single figure where they meet at one value (capping one rule at the other's floor leaves exactly
// that, since both bounds are inclusive).
function overlapBandText(finding) {
  const { overlap_min: low, overlap_max: high } = finding
  if (low === high) return `a charge of exactly ${formatCurrency(low)}`
  return `charges from ${formatCurrency(low)} to ${formatCurrency(high)}`
}

// Edit, plus Delete on the one rule a finding says is surplus. Delete confirms in place and carries the
// same re-evaluate opt-in the rules list offers, defaulted off. Off is the safe reading here rather than
// the useful one: the rows keep the category they have, which is the same category either way, and the
// broad rule's rename and tags reach them on the next categorization pass instead of immediately.
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
        title="Also re-evaluate the transactions this rule categorized, so they fall to the broader rule straight away and pick up its rename and tags. Off leaves them as they are until the next categorization pass."
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

function RulePair({ finding, rules, onEditRule, deletableRuleId, onDelete, busy, winnerNote }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {finding.rule_ids.map(id => {
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
            <div style={{ flex: 1, minWidth: 0 }}>
              <RuleSummary rule={rule} showConditions />
            </div>
            {isWinner ? (
              <span style={{ fontSize: 11, color: 'var(--muted)', whiteSpace: 'nowrap', marginTop: 2 }}>
                {winnerNote}
              </span>
            ) : null}
            <RuleActions
              ruleId={id}
              onEditRule={onEditRule}
              onDelete={deletableRuleId === id ? onDelete : null}
              busy={busy}
            />
          </div>
        )
      })}
    </div>
  )
}

// What a redundant rule still takes with it. `narrower_is_redundant` is about the category only, so a
// rename or a tag carried by just one of the two rules changes hands on removal — stated before the
// fact, because it is invisible in a panel that has just called the rule surplus.
function effectHandoverNote(broader, narrower) {
  const broaderTagIds = new Set((broader.tags || []).map(tag => tag.id))
  const narrowerTagIds = new Set((narrower.tags || []).map(tag => tag.id))
  const gains = []
  const losses = []
  const namedTags = tags => (tags.length === 1 ? `the tag ${tags[0].name}` : `${tags.length} tags`)

  if (broader.clean_name && broader.clean_name !== narrower.clean_name) gains.push(`the rename to “${broader.clean_name}”`)
  const gainedTags = (broader.tags || []).filter(tag => !narrowerTagIds.has(tag.id))
  if (gainedTags.length) gains.push(namedTags(gainedTags))

  if (narrower.clean_name && narrower.clean_name !== broader.clean_name) losses.push(`its rename to “${narrower.clean_name}”`)
  const lostTags = (narrower.tags || []).filter(tag => !broaderTagIds.has(tag.id))
  if (lostTags.length) losses.push(namedTags(lostTags))

  if (!gains.length && !losses.length) return null
  const clauses = []
  if (gains.length) clauses.push(`pick up ${gains.join(' and ')}`)
  if (losses.length) clauses.push(`lose ${losses.join(' and ')}`)
  return `The category stays the same, but those transactions would ${clauses.join(', and ')}.`
}

const isOverlapKind = kind => kind === 'amount_overlap' || kind === 'amount_overlap_benign'
const isCoMatchKind = kind => kind === 'matcher_co_match' || kind === 'matcher_co_match_benign'

// A co-match card leads with the evidence, because the evidence *is* the finding: these two rules are
// only in competition if a real transaction matches both, and showing it is also how the user judges
// whether the pair is worth untangling.
function coMatchNote(finding) {
  const amount = formatCurrency(Math.abs(finding.amount))
  const when = formatDate(finding.txn_date)
  const also = finding.txn_count > 1
    ? ` and ${finding.txn_count - 1} other${finding.txn_count === 2 ? '' : 's'}`
    : ''
  return `Both rules match “${finding.txn_name}” — ${amount} on ${when}${also}.`
}

// Why this nesting pair is worth its line — never the generic restatement of the section header, which
// at real density repeats itself down the whole panel and says nothing card to card.
function nestingNote(finding, broader, narrower) {
  if (finding.narrower_is_redundant) {
    return `Both file to ${broader.category_name} under the same scope, so the narrower rule changes nothing.`
  }
  if (broader.category_name && narrower.category_name && broader.category_name !== narrower.category_name) {
    return `The narrower rule files to ${narrower.category_name} where the broader one files to ${broader.category_name}, so it is doing work of its own.`
  }
  return 'Their scopes differ, so the broader rule does not reach everything the narrower one does.'
}

function FindingCard({ finding, rules, onEditRule, onDelete, onDismiss, onRestore, busy }) {
  const isNesting = finding.kind === 'matcher_nesting'
  const isOverlap = isOverlapKind(finding.kind)
  const isCoMatch = isCoMatchKind(finding.kind)
  // Styling follows severity rather than kind now that both warnings have a benign twin: a pair whose
  // rules file identically is not the thing the red border is for.
  const isWarning = finding.severity === 'warning'
  const broader = rules[finding.rule_ids[0]]
  const narrower = rules[finding.rule_ids[1]]
  // A nesting pair is worth a second sentence only when the winner is the *broader* rule — that is the
  // case a reader gets wrong, because keyword length is not the first thing precedence looks at.
  const winnerIsBroader = isNesting && finding.winner_rule_id === finding.rule_ids[0]
  const handover = isNesting && finding.narrower_is_redundant && broader && narrower
    ? effectHandoverNote(broader, narrower)
    : null
  return (
    <div
      style={{
        padding: '10px 12px', borderRadius: 10, display: 'flex', flexDirection: 'column', gap: 8,
        border: `1px solid ${isWarning ? 'color-mix(in srgb, var(--danger) 26%, var(--border))' : 'var(--border)'}`,
        background: isWarning ? 'color-mix(in srgb, var(--danger) 5%, var(--surface))' : 'var(--surface)',
        // Dismissed cards are shown faded rather than restyled, so the toggle reads as "these are set
        // aside" without turning the acknowledged set into a second design to maintain.
        opacity: finding.dismissed ? 0.6 : 1,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
      <div style={{ fontSize: 12.5, flex: 1, minWidth: 0 }}>
        {isOverlap
          ? <>Both rules claim <strong>{overlapBandText(finding)}</strong>, and neither range is the narrower one.</>
          : isCoMatch
            ? coMatchNote(finding)
            : (broader && narrower ? nestingNote(finding, broader, narrower) : null)}
      </div>
        <DismissAction
          finding={finding}
          onDismiss={onDismiss}
          onRestore={onRestore}
          busy={busy}
          title="Acknowledge this pair — it stops being listed until the situation changes"
        />
      </div>
      <RulePair
        finding={finding}
        rules={rules}
        onEditRule={onEditRule}
        // Nesting only, and only the narrow rule: an overlap is settled by refining conditions rather
        // than by removing a side, and the broad rule's rows are not the narrow rule's to give up.
        deletableRuleId={isNesting && finding.narrower_is_redundant ? finding.rule_ids[1] : null}
        onDelete={onDelete}
        busy={busy}
        winnerNote={isNesting ? 'wins where both match' : 'claims them today'}
      />
      {finding.kind === 'amount_overlap' ? (
        <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>
          Nothing in the rules decides this one — the winner falls out of which range happens to be
          arithmetically smaller. Refining the two rules&rsquo; conditions until they no longer overlap
          settles it for good, and it stays listed until then.
        </div>
      ) : null}
      {finding.kind === 'matcher_co_match' ? (
        <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>
          Neither matcher contains the other, so the longer keyword takes these rows — which decides
          nothing, since one keyword being longer says nothing about which rule the transaction belongs
          to. Narrowing whichever matcher is catching rows it was not meant for settles it.
        </div>
      ) : null}
      {handover ? (
        <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{handover}</div>
      ) : null}
      {winnerIsBroader ? (
        <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>
          Worth a look: the <em>broader</em> rule wins here, because its owner or account scope is
          considered before keyword length.
        </div>
      ) : null}
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
  return (
    <div
      style={{
        padding: '10px 12px', borderRadius: 10, display: 'flex', flexDirection: 'column', gap: 8,
        border: `1px solid ${outside ? 'color-mix(in srgb, var(--warning) 30%, var(--border))' : 'var(--border)'}`,
        background: outside ? 'color-mix(in srgb, var(--warning) 5%, var(--surface))' : 'var(--surface)',
        opacity: finding.dismissed ? 0.6 : 1,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <div style={{ fontSize: 12.5, flex: 1, minWidth: 0 }}>
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
          <div style={{ flex: 1, minWidth: 0 }}>
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

export default function RuleFindingsDialog({ onClose, onEditRule, onRulesChanged }) {
  const [overlaps, setOverlaps] = useState(null)
  const [drift, setDrift] = useState(null)
  const [busy, setBusy] = useState(false)
  const [showDismissed, setShowDismissed] = useState(false)
  const [actionError, setActionError] = useState(null)

  // Two checks, fetched together and kept apart. They answer different questions over different inputs —
  // one pairwise over the rule set, one over the recent ledger — so merging them server-side would have
  // meant one endpoint that recomputes both whenever either is asked for, including for the page badge
  // that only ever needs the cheaper half.
  const load = useCallback(async () => {
    const [overlapResult, driftResult] = await Promise.all([
      api.getRuleOverlaps({ includeDismissed: showDismissed }).catch(() => EMPTY),
      api.getRuleRangeDrift({ includeDismissed: showDismissed }).catch(() => EMPTY),
    ])
    setOverlaps(overlapResult)
    setDrift(driftResult)
  }, [showDismissed])

  useEffect(() => {
    let live = true
    load().catch(() => { if (live) { setOverlaps(EMPTY); setDrift(EMPTY) } })
    return () => { live = false }
  }, [load])

  // Every mutation here re-runs both checks rather than splicing one card out of the list, because each
  // of them can change findings other than the one acted on: a delete dissolves every pair its rule
  // appeared in, widening a range can settle an overlap, and a dismissal changes the counts the header
  // reports. Previous results stay on screen while it re-runs, so the list does not blink back through a
  // spinner.
  //
  // A failed action says so, and the check re-runs anyway, so the panel shows what is actually saved. It
  // used to do neither: a failure left the list as it was with no word that anything had gone wrong, and
  // whatever half of a change had landed only surfaced the next time the panel opened.
  async function withRefresh(action) {
    if (busy) return
    setBusy(true)
    setActionError(null)
    try {
      await action()
    } catch (err) {
      setActionError(`Could not save that change: ${err?.message || 'the request failed.'}`)
    } finally {
      // `load` catches its own failures, so this always settles.
      await load()
      setBusy(false)
    }
  }

  const deleteRule = (ruleId, reconcile) => withRefresh(async () => {
    await api.deleteRule(ruleId, { reconcile })
    onRulesChanged?.()
  })

  // Move the bound out to this charge and re-apply the rule, which is the whole maintenance action the
  // finding exists to offer. One request, so it cannot stop halfway: as a rule update followed by a
  // separate apply, a failure between them could leave the bound moved and the charge unclaimed. The server
  // rounds the bound outwards and preserves hand categorizations (`widen_rule_range`). What happens to
  // the rule's series follows on its own — the row takes the category back, and the detector claims it on
  // its next pass.
  const widenRange = finding => withRefresh(async () => {
    await txnMutations.widenRuleRange(finding.rule_id, finding.bound, Math.abs(Number(finding.amount) || 0))
    onRulesChanged?.()
  })

  // Each family keeps its own dismissal store, so the finding's kind picks the endpoint.
  const isDrift = finding => finding.kind === 'rule_range' || finding.kind === 'rule_range_edge'
  const dismissFinding = finding => withRefresh(() => (isDrift(finding)
    ? api.dismissRuleRangeDrift(finding.key, finding.kind)
    : api.dismissRuleOverlap(finding.key, finding.kind)))
  const restoreFinding = finding => withRefresh(() => (isDrift(finding)
    ? api.restoreRuleRangeDrift(finding.key)
    : api.restoreRuleOverlap(finding.key)))

  const loading = overlaps == null || drift == null
  const overlapFindings = overlaps?.findings || []
  const driftFindings = drift?.findings || []
  const nothingListed = !overlapFindings.length && !driftFindings.length
  // The header counts the *open* set from each server's own tally, never the rendered rows: with the
  // toggle on, counting what is on screen would report acknowledged findings as work still to do.
  const openDrift = drift?.count || 0
  const openOverlaps = (overlaps?.counts?.amount_overlap || 0) + (overlaps?.counts?.matcher_co_match || 0)
  // The informational tally is everything listed for knowledge rather than for action: nesting pairs,
  // and the competing pairs whose two rules turn out to do the same thing.
  const openNesting = (overlaps?.counts?.matcher_nesting || 0)
    + (overlaps?.counts?.amount_overlap_benign || 0)
    + (overlaps?.counts?.matcher_co_match_benign || 0)
  const dismissedCount = (overlaps?.dismissed_count || 0) + (drift?.dismissed_count || 0)

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
    <OverlayBackdrop zIndex={1400} tint="rgba(15, 23, 42, 0.42)">
      <FloatingPanel style={{ width: 'min(760px, 100%)', maxHeight: '82vh', display: 'flex', flexDirection: 'column' }}>
        <FloatingPanelHeader style={{ padding: '16px 20px 14px' }}>
          <div>
            <div style={{ fontSize: 17, fontWeight: 600 }}>Rule checkup</div>
            <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 2 }}>{summary()}</div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 22, padding: '0 4px', lineHeight: 1 }}>×</button>
        </FloatingPanelHeader>

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
              <Section
                title="Amount ranges that overlap"
                blurb="Both rules can claim the same charge, and the app has no principled way to choose between them. Refine their conditions until only one applies — these cannot be dismissed because it is arbitrary which rule will win."
                findings={overlapFindings.filter(f => f.kind === 'amount_overlap')}
                renderCard={finding => (
                  <FindingCard
                    key={finding.key}
                    finding={finding}
                    rules={overlaps.rules}
                    onEditRule={onEditRule}
                    onDismiss={dismissFinding}
                    onRestore={restoreFinding}
                    busy={busy}
                  />
                )}
              />
              <Section
                title="Rules that match the same transaction"
                blurb="Two rules catching different parts of one merchant name. The longer keyword wins, which settles nothing — length only means “more specific” when one matcher sits inside the other, and these do not. Narrow whichever one is reaching too far."
                findings={overlapFindings.filter(f => f.kind === 'matcher_co_match')}
                renderCard={finding => (
                  <FindingCard
                    key={finding.key}
                    finding={finding}
                    rules={overlaps.rules}
                    onEditRule={onEditRule}
                    onDismiss={dismissFinding}
                    onRestore={restoreFinding}
                    busy={busy}
                  />
                )}
              />
              <Section
                title="Merchant matchers that nest"
                blurb="Nothing is wrong with these — they are listed so it is clear which rule takes the transactions they share. Where both file to the same category, the narrower rule is surplus and can be removed."
                findings={overlapFindings.filter(f => f.kind === 'matcher_nesting')}
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
              {/* Last, and deliberately not among the warnings above: these pairs compete over an
                  outcome that is the same either way, so they are listed in case the match is an
                  accident rather than because anything needs doing. */}
              <Section
                title="Competing rules that file the same way"
                blurb="These pairs contend for the same transactions, but both rules apply the same category, rename and tags — so whichever wins, the result is identical. Listed in case that agreement is a coincidence rather than the intent; dismiss one and it returns if the two ever stop matching."
                findings={overlapFindings.filter(f => f.kind === 'amount_overlap_benign' || f.kind === 'matcher_co_match_benign')}
                renderCard={finding => (
                  <FindingCard
                    key={finding.key}
                    finding={finding}
                    rules={overlaps.rules}
                    onEditRule={onEditRule}
                    onDismiss={dismissFinding}
                    onRestore={restoreFinding}
                    busy={busy}
                  />
                )}
              />
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
      </FloatingPanel>
    </OverlayBackdrop>
  )
}
