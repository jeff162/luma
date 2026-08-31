// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * The on-demand "which rules compete for the same transactions" check, run from the Rules page.
 *
 * Two sections with opposite intents, and keeping them visually distinct is the point of the layout.
 * **Overlapping amount ranges** is work: both rules can claim a charge and nothing decides which, so
 * the user has to settle it — this panel deliberately proposes no edit, because an overlap is an
 * ambiguity in the rules themselves and a one-click "fix" would dress a coin flip as a decision.
 * **Nested merchant matchers** is not a defect; it is reported because the winner is not always the rule
 * a reader would guess (scope outranks keyword length), and because a pair filing to one category under
 * one scope has a surplus half worth clearing out.
 *
 * Every finding names its rules and offers Edit. **Delete is on the nesting half, not the overlap half**,
 * which is the reverse of how it first reads. An overlap is a modelling ambiguity: the answer is to
 * refine the conditions until the rules are unambiguous, and deleting one of them picks a side instead
 * of fixing the model. A nesting pair where both rules file to the same category under the same scope
 * has a genuinely surplus half — the narrow rule changes nothing — and removing it is the whole
 * maintenance action. Delete is offered on the **narrow** rule only: deleting the broad one would strand
 * every row the narrow matcher does not reach.
 *
 * What the card must say, because the flag deliberately does not cover it: `narrower_is_redundant` is
 * about the *category*. A rename or a tag carried by only one of the two rules does change hands when
 * the narrow rule goes, so that difference is read off the rules here and stated before the fact.
 *
 * The delete carries the rules list's own opt-in to re-evaluate the rule's transactions, so this panel
 * does not quietly pick a different answer to that question than the list does.
 *
 * **Dismissal is what makes the nesting half usable at real density, and it stops there.** Most nesting
 * pairs are deliberate, and a list of thirty that never shrinks is one nobody opens twice — so those can
 * be acknowledged, and the panel then shows only what still wants a decision. An **overlap cannot be
 * dismissed**: it is nondeterminism, not information, so waving it through would leave the ledger
 * categorized by an arithmetic accident while the panel called it settled. The server decides this
 * (`dismissible` on each finding), not the layout here.
 *
 * Dismissed findings are not gone: a *Show dismissed* toggle brings them back, flagged and restorable, so
 * an acknowledgement made in error is visible rather than lost. The counts in the header always describe
 * the open set, so turning the toggle on never makes it look like there is more to do.
 */

import { useEffect, useState } from 'react'
import { api } from '../lib/api.js'
import { Button, OverlayBackdrop, FloatingPanel, FloatingPanelHeader, Spinner, EmptyState } from './ui.jsx'
import RuleSummary from './RuleSummary.jsx'
import { formatCurrency } from '../lib/utils.js'

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
  const isOverlap = finding.kind === 'amount_overlap'
  const broader = rules[finding.rule_ids[0]]
  const narrower = rules[finding.rule_ids[1]]
  // A nesting pair is worth a second sentence only when the winner is the *broader* rule — that is the
  // case a reader gets wrong, because keyword length is not the first thing precedence looks at.
  const winnerIsBroader = !isOverlap && finding.winner_rule_id === finding.rule_ids[0]
  const handover = !isOverlap && finding.narrower_is_redundant && broader && narrower
    ? effectHandoverNote(broader, narrower)
    : null
  return (
    <div
      style={{
        padding: '10px 12px', borderRadius: 10, display: 'flex', flexDirection: 'column', gap: 8,
        border: `1px solid ${isOverlap ? 'color-mix(in srgb, var(--danger) 26%, var(--border))' : 'var(--border)'}`,
        background: isOverlap ? 'color-mix(in srgb, var(--danger) 5%, var(--surface))' : 'var(--surface)',
        // Dismissed cards are shown faded rather than restyled, so the toggle reads as "these are set
        // aside" without turning the acknowledged set into a second design to maintain.
        opacity: finding.dismissed ? 0.6 : 1,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
      <div style={{ fontSize: 12.5, flex: 1, minWidth: 0 }}>
        {isOverlap
          ? <>Both rules claim <strong>{overlapBandText(finding)}</strong>, and neither range is the narrower one.</>
          : (broader && narrower ? nestingNote(finding, broader, narrower) : null)}
      </div>
        {!finding.dismissible ? null : finding.dismissed ? (
          <Button small variant="ghost" disabled={busy} onClick={() => onRestore(finding)}>Restore</Button>
        ) : (
          <Button
            small
            variant="ghost"
            disabled={busy}
            onClick={() => onDismiss(finding)}
            title="Acknowledge this pair — it stops being listed until the situation changes"
          >
            Dismiss
          </Button>
        )}
      </div>
      <RulePair
        finding={finding}
        rules={rules}
        onEditRule={onEditRule}
        // Nesting only, and only the narrow rule: an overlap is settled by refining conditions rather
        // than by removing a side, and the broad rule's rows are not the narrow rule's to give up.
        deletableRuleId={!isOverlap && finding.narrower_is_redundant ? finding.rule_ids[1] : null}
        onDelete={onDelete}
        busy={busy}
        winnerNote={isOverlap ? 'claims them today' : 'wins where both match'}
      />
      {isOverlap ? (
        <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>
          Nothing in the rules decides this one — the winner falls out of which range happens to be
          arithmetically smaller. Refining the two rules&rsquo; conditions until they no longer overlap
          settles it for good, and it stays listed until then.
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

function Section({ title, blurb, findings, rules, onEditRule, onDelete, onDismiss, onRestore, busy }) {
  if (!findings.length) return null
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div>
        <div style={{ fontSize: 13, fontWeight: 600 }}>{title}</div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>{blurb}</div>
      </div>
      {findings.map(finding => (
        <FindingCard
          key={finding.key}
          finding={finding}
          rules={rules}
          onEditRule={onEditRule}
          onDelete={onDelete}
          onDismiss={onDismiss}
          onRestore={onRestore}
          busy={busy}
        />
      ))}
    </div>
  )
}

const EMPTY = { count: 0, counts: {}, dismissed_count: 0, findings: [], rules: {} }

export default function RuleOverlapsDialog({ onClose, onEditRule, onRulesChanged }) {
  const [data, setData] = useState(null)
  const [busy, setBusy] = useState(false)
  const [showDismissed, setShowDismissed] = useState(false)

  useEffect(() => {
    let live = true
    api.getRuleOverlaps({ includeDismissed: showDismissed })
      .then(res => { if (live) setData(res) })
      .catch(() => { if (live) setData(EMPTY) })
    return () => { live = false }
  }, [showDismissed])

  // Every mutation here re-runs the whole check rather than splicing one card out of the list, because
  // each of them can change findings other than the one acted on: a delete dissolves every pair its rule
  // appeared in, and a dismissal changes the counts the header reports. Previous results stay on screen
  // while it re-runs, so the list does not blink back through a spinner.
  async function withRefresh(action) {
    if (busy) return
    setBusy(true)
    try {
      await action()
      setData(await api.getRuleOverlaps({ includeDismissed: showDismissed }))
    } finally {
      setBusy(false)
    }
  }

  const deleteRule = (ruleId, reconcile) => withRefresh(async () => {
    await api.deleteRule(ruleId, { reconcile })
    onRulesChanged?.()
  })
  const dismissFinding = finding => withRefresh(() => api.dismissRuleOverlap(finding.key, finding.kind))
  const restoreFinding = finding => withRefresh(() => api.restoreRuleOverlap(finding.key))

  const findings = data?.findings || []
  const overlaps = findings.filter(f => f.kind === 'amount_overlap')
  const nesting = findings.filter(f => f.kind === 'matcher_nesting')
  // The header counts the *open* set from the server's own tally, never the rendered rows: with the
  // toggle on, counting what is on screen would report acknowledged pairs as work still to do.
  const openOverlaps = data?.counts?.amount_overlap || 0
  const openNesting = data?.counts?.matcher_nesting || 0
  const dismissedCount = data?.dismissed_count || 0

  return (
    <OverlayBackdrop zIndex={1400} tint="rgba(15, 23, 42, 0.42)">
      <FloatingPanel style={{ width: 'min(760px, 100%)', maxHeight: '82vh', display: 'flex', flexDirection: 'column' }}>
        <FloatingPanelHeader style={{ padding: '16px 20px 14px' }}>
          <div>
            <div style={{ fontSize: 17, fontWeight: 600 }}>Overlapping rules</div>
            <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 2 }}>
              {data == null
                ? 'Checking rules…'
                : openOverlaps === 0 && openNesting === 0
                  ? (dismissedCount > 0
                    ? `Nothing left to look at — ${dismissedCount} dismissed.`
                    : 'No rules are competing for the same transactions.')
                  : `${openOverlaps} to settle, ${openNesting} for information.`}
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 22, padding: '0 4px', lineHeight: 1 }}>×</button>
        </FloatingPanelHeader>

        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '12px 18px', display: 'flex', flexDirection: 'column', gap: 18 }}>
          {data == null ? (
            <div style={{ padding: 24 }}><Spinner /></div>
          ) : findings.length === 0 ? (
            <EmptyState message={dismissedCount > 0
              ? 'Every pair the check found has been dismissed.'
              : 'Every rule that can match a transaction has a clear winner.'} />
          ) : (
            <>
              <Section
                title="Amount ranges that overlap"
                blurb="Both rules can claim the same charge, and the app has no principled way to choose between them. Refine their conditions until only one applies — these cannot be dismissed, because nothing decides which rule wins."
                findings={overlaps}
                rules={data.rules}
                onEditRule={onEditRule}
                onDismiss={dismissFinding}
                onRestore={restoreFinding}
                busy={busy}
              />
              <Section
                title="Merchant matchers that nest"
                blurb="Nothing is wrong with these — they are listed so it is clear which rule takes the transactions they share. Where both file to the same category, the narrower rule is surplus and can be removed."
                findings={nesting}
                rules={data.rules}
                onEditRule={onEditRule}
                onDelete={deleteRule}
                onDismiss={dismissFinding}
                onRestore={restoreFinding}
                busy={busy}
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
