// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * Stale-rule cleanup review panel. Given a `before` date (today minus the chosen window), it lists the
 * active, non-managed rules whose newest applied effect is older than that (or that never applied one),
 * each pre-selected for removal with a checkbox to *keep* it. Confirming moves the selected set to the
 * rules trash (recoverable) — retain-by-default (leave categorizations alone), with an opt-in to also
 * revert them. App-managed (money-movement) rules are excluded server-side, so none appear here.
 */

import { useEffect, useState } from 'react'
import { api } from '../lib/api.js'
import { Button, Spinner } from './ui.jsx'
import FloatingDialog from './FloatingDialog.jsx'
import RuleSummary from './RuleSummary.jsx'
import { formatDate } from '../lib/utils.js'

export default function RuleCleanupDialog({ before, windowLabel, onClose, onDone }) {
  const [candidates, setCandidates] = useState(null)
  const [selected, setSelected] = useState(() => new Set())
  const [reconcile, setReconcile] = useState(false)
  const [working, setWorking] = useState(false)

  useEffect(() => {
    let live = true
    api.getRuleCleanupCandidates(before).then(res => {
      if (!live) return
      setCandidates(res.rules)
      setSelected(new Set(res.rules.map(r => r.id))) // pre-select all for removal
    }).catch(() => { if (live) setCandidates([]) })
    return () => { live = false }
  }, [before])

  function toggle(id) {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function run() {
    if (working || selected.size === 0) return
    setWorking(true)
    try {
      await api.cleanupRules([...selected], { reconcile })
      onDone?.()
    } catch {
      setWorking(false)
    }
  }

  const total = candidates?.length ?? 0

  // Floating, so the rules list behind can be checked while choosing which to keep.
  return (
    <FloatingDialog
      panelKey="ui.ruleCleanup.panel"
      title="Clean up unused rules"
      description={candidates == null
        ? 'Finding rules…'
        : total === 0
          ? `No rules have gone unused for ${windowLabel}.`
          : `${total} rule${total !== 1 ? 's' : ''} haven’t categorized anything in ${windowLabel}. Uncheck any you want to keep.`}
      onClose={onClose}
      width={720}
      bodyPadding="4px 8px"
      bodyStyle={{ gap: 0 }}
      footerAlign="between"
      actions={(
        <>
          {total > 0 ? (
            <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, color: 'var(--muted)', cursor: 'pointer' }}>
              <input type="checkbox" checked={reconcile} onChange={e => setReconcile(e.target.checked)} style={{ accentColor: 'var(--accent)', cursor: 'pointer' }} />
              Also revert their categorizations (otherwise history is left as-is)
            </label>
          ) : <span />}
          <div style={{ display: 'flex', gap: 8 }}>
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            {total > 0 ? (
              <Button
                onClick={run}
                disabled={working || selected.size === 0}
              >
                {working ? 'Trashing…' : `Trash ${selected.size} rule${selected.size !== 1 ? 's' : ''}`}
              </Button>
            ) : null}
          </div>
        </>
      )}
    >
          {candidates == null ? (
            <div style={{ padding: 24 }}><Spinner /></div>
          ) : total === 0 ? null : (
            candidates.map(rule => {
              const checked = selected.has(rule.id)
              return (
                <label
                  key={rule.id}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', cursor: 'pointer',
                    borderBottom: '1px solid color-mix(in srgb, var(--border) 70%, transparent)',
                    background: checked ? 'transparent' : 'color-mix(in srgb, var(--surface2) 55%, var(--surface))',
                    opacity: checked ? 1 : 0.6,
                  }}
                >
                  <input type="checkbox" checked={checked} onChange={() => toggle(rule.id)} style={{ accentColor: 'var(--danger)', cursor: 'pointer' }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    {/* Scope is deliberately not shown: this review asks whether a rule is still wanted,
                        and its owner/account/amount limits say nothing about that. */}
                    <RuleSummary rule={rule} />
                  </div>
                  <span style={{ fontSize: 11, color: 'var(--muted)', whiteSpace: 'nowrap' }}>
                    {rule.last_effect_date ? `used ${formatDate(rule.last_effect_date)}` : 'never used'}
                  </span>
                </label>
              )
            })
          )}
    </FloatingDialog>
  )
}
