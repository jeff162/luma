// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// The split editor: allocating one transaction's amount across several categories.
//
// A split is a multi-field form, so it follows the explicit-submit half of the inline-edit contract
// (ui-patterns.md → Inline edit commit behavior) rather than committing on blur — a click-away must
// not persist a half-built allocation. The running total is the whole interaction model: Save stays
// unavailable until the amounts account for the transaction exactly, so "is this finished?" is
// answered on screen rather than by a rejected save.
//
// It is laid out as a small ledger — a category column, a right-aligned amount column, and a totals
// block ruled off beneath them — because that is the arithmetic the user is actually doing, and the
// remaining figure has to sit in the same column as the numbers it is derived from to be read as
// their sum.
//
// Validation is deliberately *not* duplicated from the backend. The sum, sign and leaf-only rules live
// in services/txn_splits.py, and a save that violates one comes back as a 400
// whose detail is written for the user — this shows that text. The running total is the one local
// affordance, because it updates per keystroke and is guidance rather than a second rule.
//
// It is a dialog rather than an inline expansion so a single implementation serves the detail panel
// and the row menu, and so it can float over the panel that opened it.

import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api.js'
import { formatSignedMoneyAmount, transactionDirection } from '../lib/moneyDisplay.js'
import { useBusyIndicator, PAINT_GATE_DELAY_MS } from '../lib/useBusyIndicator.js'
import CategoryPicker from './CategoryPicker.jsx'
import { AppDialog, Button, COMPACT_ACTION_BTN_STYLE, Input } from './ui.jsx'

// Money reconciles at the cent, and amounts arrive as text the user is mid-way through typing, so the
// remaining figure is compared against a half-cent rather than zero.
const CENT = 0.005

// One grid definition for the header, every row, and the totals block — the amount column only reads
// as a column if all of them agree on its width.
//
// Column order follows the ledger's: what it was, then how it is classified, then how much. A split
// row is the same object a transaction row is, and the app's own rule is that an object should read
// the same way wherever it appears (collaboration-notes.md → UI And Interaction Preferences). Category
// is fixed width because its picker is a compact badge and slack there is dead space; description
// takes what is left, being the one field whose content has no natural length.
const GRID = 'minmax(0, 1fr) 150px 96px 24px'

// The pre-fill strip's own three tracks — item, its list price, the share derived from it. Shared by
// its heading row and its lines for the same reason GRID is: two right-aligned money columns only read
// as columns if their headings sit exactly above them.
const SUGGESTION_GRID = 'minmax(0, 1fr) 92px 72px'

function toAmount(raw) {
  const value = Number.parseFloat(String(raw).replace(/[^0-9.-]/g, ''))
  return Number.isFinite(value) ? value : 0
}

// A split needs at least two lines to be a split; the backend enforces the same floor.
const MIN_ROWS = 2

function blankRow() {
  return { key: `row-${Math.random().toString(36).slice(2)}`, category_id: null, amount: '', label: '' }
}

const labelStyle = {
  color: 'var(--muted)', fontSize: 11, fontWeight: 600,
  letterSpacing: '0.05em', textTransform: 'uppercase',
}

export default function SplitEditorDialog({ txn, categories, onAddCategory, onClose, onSaved }) {
  const [rows, setRows] = useState(() => Array.from({ length: MIN_ROWS }, blankRow))
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const [suggestion, setSuggestion] = useState(null)
  // Which amount field the remainder action will land in. Set on focus and deliberately *not* cleared
  // on blur: pressing the button blurs the field, so a selection that ended at blur could never be
  // acted on.
  const [selectedKey, setSelectedKey] = useState(null)
  // The amount the remainder action overwrote, so it can be put back. Kept only while that action is
  // still the most recent change to the form: it is the one edit here that replaces a figure the user
  // typed with a computed one, so its prior value is otherwise unrecoverable — but a stash that
  // outlived a later edit would restore a number that no longer relates to anything on screen, which
  // is worse than offering no undo at all. Every mutation below retires it.
  const [remainderUndo, setRemainderUndo] = useState(null)

  const amount = Number(txn?.amount) || 0
  // The whole dialog works in the transaction's own direction: parts are *stored* in it (they all share
  // the transaction's sign), so a deposit split would otherwise have to be typed, totalled and read as a
  // column of negative numbers while the row that opened it reads positive. Every figure below is
  // `× dir`, and `save` multiplies back on the way out — see moneyDisplay's `transactionDirection` for
  // why this is a direction rather than an absolute value.
  const dir = transactionDirection(amount)
  const total = amount * dir
  const allocated = rows.reduce((sum, row) => sum + toAmount(row.amount), 0)
  const remaining = Math.round((total - allocated) * 100) / 100
  const balanced = Math.abs(remaining) < CENT
  const complete = balanced && rows.length >= MIN_ROWS
    && rows.every(r => r.category_id && Math.abs(toAmount(r.amount)) >= CENT)

  // An existing split opens on its own categories; a transaction being split for the first time opens
  // on two empty rows with its current category pre-filled into the first, since that is where the
  // whole amount sits today and is the likeliest thing the user is dividing.
  //
  // The cancel flag is the *only* guard here, deliberately. A "fetch once" ref alongside it deadlocks
  // under StrictMode's mount/unmount/remount: the teardown cancels the first run's closure, the ref
  // makes the second run a no-op, and the surface sits on its loading state forever holding a response
  // it was told to ignore. Letting the remount re-fetch costs one duplicate GET in development, which
  // is the trade StrictMode exists to make. Keyed on the transaction id alone — the category is read
  // only to seed the first row, and re-running on it would discard edits already in progress.
  useEffect(() => {
    if (!txn?.id) return
    let cancelled = false
    setLoading(true)
    Promise.all([api.getSplit(txn.id), api.getSplitSuggestion(txn.id).catch(() => null)])
      .then(([split, proposed]) => {
        if (cancelled) return
        if (split.parts?.length) {
          setRows(split.parts.map((p, i) => ({
            key: `row-${i}-${p.id}`, category_id: p.category_id, amount: String(p.amount * dir),
            label: p.label || '',
          })))
        } else {
          // Opened on as many rows as the order has items, when that is known — an order of three is
          // three lines to categorize, and starting on two both understates the work and costs a click
          // before it can begin. Blank, not pre-filled: putting the amounts in is what `Use items` is
          // for, and doing it unasked would be a suggestion disguised as a confirmed choice.
          const count = Math.max(MIN_ROWS, proposed?.available ? proposed.parts.length : 0)
          const seeded = Array.from({ length: count }, blankRow)
          seeded[0].category_id = txn.category_id ?? null
          setRows(seeded)
        }
        if (proposed?.available) setSuggestion(proposed)
      })
      .catch(err => { if (!cancelled) setError(err?.message || 'Could not load this split.') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- category_id seeds the first row on open only; re-running on it would discard in-progress edits, and dir is a property of the very transaction this is keyed on
  }, [txn?.id])

  // The single edit seam for a row, and therefore the single place the remainder undo is retired.
  // Deliberately not called by the remainder action itself, which owns its own write so that this
  // clear and that stash cannot race.
  const update = useCallback((key, patch) => {
    setRemainderUndo(null)
    setRows(prev => prev.map(r => (r.key === key ? { ...r, ...patch } : r)))
  }, [])

  // Nothing is shown until there is something worth showing. Opening on a bare "Loading…" and then
  // growing — by the row count the order turned out to have, and again by the height of the pre-fill
  // strip — makes the dialog jump twice under the cursor before it can be read. A panel that appears
  // fully formed is the app's standing answer here (see `usePanelReveal` for the floating-panel
  // equivalent), and at these speeds it costs nothing: there is no flicker in a surface that has not
  // painted yet.
  //
  // `useBusyIndicator` bounds the wait at the same ~150ms the rest of the app announces slowness at.
  // Past that the dialog opens on its loading state, because a Split… that appears to do nothing is
  // the worse failure — the same trade the row menu makes before painting.
  const loadSlow = useBusyIndicator(loading, { delayMs: PAINT_GATE_DELAY_MS })
  if (loading && !loadSlow) return null

  // Put whatever is still unallocated into the amount the user picked. This is the last step of almost
  // every split and the one most likely to be got wrong by hand on a total that does not divide evenly
  // — so it lands where the user chose rather than in a row this component picked for them, which on a
  // long split is rarely the one they meant.
  function addRemainderToSelected() {
    if (!selectedKey) return
    const row = rows.find(r => r.key === selectedKey)
    if (!row) return
    const next = (Math.round((toAmount(row.amount) + remaining) * 100) / 100).toFixed(2)
    setRows(prev => prev.map(r => (r.key === selectedKey ? { ...r, amount: next } : r)))
    // Stashed verbatim, not re-formatted: putting back "30" where the user typed "30" is the edit
    // being reversed; normalizing it to "30.00" would be a second change wearing an undo's label.
    setRemainderUndo({ key: selectedKey, amount: row.amount })
  }

  function undoRemainder() {
    if (!remainderUndo) return
    setRows(prev => prev.map(r => (r.key === remainderUndo.key ? { ...r, amount: remainderUndo.amount } : r)))
    setRemainderUndo(null)
  }

  function applySuggestion() {
    // Categories come through where the user's own rules claimed an item, and stay empty where none
    // did — a proposal, never a silent decision: nothing is written until Save, and every row is still
    // editable. This is why the strip says how many were classified rather than presenting the result
    // as finished.
    setSelectedKey(null)
    setRemainderUndo(null)
    setRows(suggestion.parts.map((p, i) => ({
      key: `suggested-${i}`,
      category_id: p.category_id ?? null,
      amount: p.amount == null ? '' : String(p.amount * dir),
      label: p.label || '',
    })))
  }

  async function save() {
    setSaving(true)
    setError(null)
    try {
      const saved = await api.saveSplit(txn.id, rows.map(r => ({
        category_id: r.category_id, amount: toAmount(r.amount) * dir, label: r.label,
      })))
      onSaved?.({ is_split: true, parts: saved.parts })
      onClose()
    } catch (err) {
      setError(err?.message || 'Could not save this split.')
    } finally {
      setSaving(false)
    }
  }

  async function removeSplit() {
    setSaving(true)
    setError(null)
    try {
      await api.deleteSplit(txn.id)
      onSaved?.({ is_split: false, parts: [] })
      onClose()
    } catch (err) {
      setError(err?.message || 'Could not remove this split.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <AppDialog
      title="Split across categories"
      description={txn?.display_name || txn?.merchant_name || undefined}
      width="min(600px, 100%)"
      onClose={onClose}
      actions={(
        // `small` throughout, matching the controls in the body: at this panel width the default
        // button size reads as the heaviest thing on screen, and the footer is not where the weight
        // belongs when the arithmetic above it is the point.
        <>
          {txn?.is_split ? (
            <Button variant="ghost" small onClick={removeSplit} disabled={saving}>Remove split</Button>
          ) : null}
          <Button variant="ghost" small onClick={onClose}>Cancel</Button>
          <Button small onClick={save} disabled={!complete || saving}>Save split</Button>
        </>
      )}
    >
      {loading ? (
        // Reached only past the paint gate, i.e. when the load has genuinely stalled. Sized close to a
        // small finished split so that even this path grows by a little rather than unfolding from a
        // single line — the gate makes it rare, this makes it survivable when it happens.
        <div style={{
          alignItems: 'center', color: 'var(--muted)', display: 'flex', fontSize: 13,
          justifyContent: 'center', minHeight: 240,
        }}>Loading…</div>
      ) : (
        <div style={{ display: 'grid', gap: 14 }}>
          {/* Shows its working. A proposed share is otherwise an unexplained number — seeing each
              item's list price against their total, and the paid amount it is being spread across,
              is what lets the user judge the split rather than take it on faith. It is also where
              the gap between the two figures (tax, shipping, a promo) becomes visible. */}
          {suggestion ? (
            <div style={{
              background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 8,
              display: 'grid', gap: 8, padding: '10px 12px',
            }}>
              <span style={{ color: 'var(--muted)', fontSize: 12, lineHeight: 1.45 }}>
                This order lists {suggestion.parts.length} items totalling{' '}
                {formatSignedMoneyAmount(suggestion.list_total)} at list. Each share below is that
                item&apos;s portion of the {formatSignedMoneyAmount(total)} actually paid.
                {suggestion.categorized > 0 ? (
                  <> Your rules categorize {suggestion.categorized} of them; the rest are left for you.</>
                ) : null}
              </span>
              {/* Two columns of money need saying apart, and the sentence above already names one of
                  them "share" — so the headings tie the prose to the figures rather than introducing
                  new words. Each carries the longer explanation on hover, which keeps the strip short
                  while leaving the difference discoverable. */}
              <div style={{
                display: 'grid', fontSize: 10, gap: 10,
                gridTemplateColumns: SUGGESTION_GRID, ...labelStyle,
              }}>
                <span />
                <span
                  style={{ textAlign: 'right' }}
                  title="What the order listed this item at, before tax, shipping or any discount"
                >List</span>
                <span
                  style={{ textAlign: 'right' }}
                  title="This item's portion of what was actually paid, in proportion to its list price"
                >Share</span>
              </div>
              <div style={{ display: 'grid', gap: 2, maxHeight: 132, overflowY: 'auto' }}>
                {suggestion.parts.map((part, i) => (
                  <div
                    key={`proposed-${i}`}
                    style={{
                      display: 'grid', fontSize: 11, gap: 10,
                      gridTemplateColumns: SUGGESTION_GRID,
                    }}
                  >
                    <span
                      title={part.label}
                      style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                    >{part.label}</span>
                    <span style={{ color: 'var(--muted)', fontVariantNumeric: 'tabular-nums', textAlign: 'right' }}>
                      {part.quantity > 1 ? `${part.quantity} × ` : ''}
                      {formatSignedMoneyAmount(part.unit_price ?? 0)}
                    </span>
                    <span style={{ fontVariantNumeric: 'tabular-nums', textAlign: 'right' }}>
                      {part.amount == null ? '—' : formatSignedMoneyAmount(part.amount * dir)}
                    </span>
                  </div>
                ))}
              </div>
              <div style={{ display: 'flex' }}>
                <Button variant="ghost" small onClick={applySuggestion}>Use items</Button>
              </div>
            </div>
          ) : null}

          <div style={{ display: 'grid', gap: 6 }}>
            <div style={{ display: 'grid', gap: 8, gridTemplateColumns: GRID, padding: '0 2px' }}>
              <span style={labelStyle}>Description</span>
              <span style={labelStyle}>Category</span>
              <span style={{ ...labelStyle, textAlign: 'right' }}>Amount</span>
              <span />
            </div>

            {/* Both fields are named and opt out of autocomplete. Without a name the browser keys its
                saved-value history on the field's `id`, which `Input` derives from `useId` — and those
                are reused across views, so the amount box was offering back whatever had been typed
                into the same `:rN:` elsewhere in the app (a merchant name, a date, an id) as
                suggestions for a split. A name of its own is the key that stops that, and `off` keeps
                the browser from proposing anything here at all: an allocation is arithmetic against
                one transaction, never a value worth reusing. */}
            {rows.map(row => {
              const selected = row.key === selectedKey
              const removable = rows.length > MIN_ROWS
              return (
                <div key={row.key} style={{ alignItems: 'center', display: 'grid', gap: 8, gridTemplateColumns: GRID }}>
                  {/* A marketplace item title can run past 230 characters, so the field shows a
                      readable slice and carries the whole value in its tooltip — and is editable,
                      because cutting one down to something a ledger can show is a thing only the user
                      can do. */}
                  <Input
                    value={row.label}
                    placeholder="Description (optional)"
                    aria-label="Description"
                    name="split-part-description"
                    autoComplete="off"
                    title={row.label || undefined}
                    onChange={value => update(row.key, { label: value })}
                    style={{ fontSize: 12, padding: '5px 8px' }}
                  />
                  <div style={{ minWidth: 0 }}>
                    <CategoryPicker
                      value={row.category_id}
                      categories={categories}
                      compact
                      showSelectedBadge
                      onChange={id => update(row.key, { category_id: id })}
                      onAddCategory={onAddCategory}
                      // The picker portals its dropdown to <body> at 1100 by default, which is *behind*
                      // an AppDialog (1200) — it has to be raised to be visible from inside one.
                      panelZIndex={1300}
                    />
                  </div>
                  <Input
                    value={row.amount}
                    inputMode="decimal"
                    placeholder="0.00"
                    aria-label="Amount"
                    name="split-part-amount"
                    autoComplete="off"
                    onFocus={() => setSelectedKey(row.key)}
                    onChange={value => update(row.key, { amount: value })}
                    style={{
                      borderColor: selected ? 'var(--accent)' : undefined,
                      fontSize: 13,
                      fontVariantNumeric: 'tabular-nums',
                      padding: '6px 8px',
                      textAlign: 'right',
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => {
                      if (!removable) return
                      setRemainderUndo(null)
                      setRows(prev => prev.filter(r => r.key !== row.key))
                    }}
                    aria-label="Remove this category from the split"
                    title={removable ? 'Remove' : 'A split needs at least two categories'}
                    style={{
                      background: 'none', border: 'none', color: 'var(--muted)',
                      cursor: removable ? 'pointer' : 'default', fontSize: 16,
                      lineHeight: 1, opacity: removable ? 1 : 0.3, padding: 0,
                    }}
                  >×</button>
                </div>
              )
            })}
            {/* Sits with the rows it appends to, above the rule — adding a category is part of the
                list, not part of reading the total underneath it. */}
            <div style={{ display: 'flex', paddingTop: 2 }}>
              <Button
                variant="ghost"
                style={COMPACT_ACTION_BTN_STYLE}
                onClick={() => { setRemainderUndo(null); setRows(prev => [...prev, blankRow()]) }}
              >+ Item</Button>
            </div>
          </div>

          {/* Ruled off and sharing the rows' grid, so the running figures line up under the amounts
              they come from and read as their total rather than as loose text. */}
          <div style={{ borderTop: '1px solid var(--border)', display: 'grid', gap: 6, paddingTop: 10 }}>
            <div style={{ display: 'grid', gap: 8, gridTemplateColumns: GRID }}>
              <span style={{ color: 'var(--muted)', fontSize: 13, gridColumn: 'span 2' }}>Transaction</span>
              <span style={{ color: 'var(--muted)', fontSize: 13, fontVariantNumeric: 'tabular-nums', textAlign: 'right' }}>
                {formatSignedMoneyAmount(total)}
              </span>
              <span />
            </div>
            <div style={{ display: 'grid', gap: 8, gridTemplateColumns: GRID }}>
              <span style={{ fontSize: 13, fontWeight: 600, gridColumn: 'span 2' }}>
                {balanced ? 'Fully allocated' : 'Remaining'}
              </span>
              <span style={{
                color: balanced ? 'var(--success)' : 'var(--warning)',
                fontSize: 13, fontWeight: 600, fontVariantNumeric: 'tabular-nums', textAlign: 'right',
              }}>
                {balanced ? '✓' : formatSignedMoneyAmount(remaining)}
              </span>
              <span />
            </div>
          </div>

          {/* Below the rule, only the action on the remainder — right-aligned, under the amount
              column whose figures it settles. Takes the shared compact footprint so it stays a quiet
              helper rather than competing with Save for weight.
              Hidden rather than unmounted once the split balances: the row keeps its height, so
              finishing a split doesn't resize the panel under the cursor. `visibility: hidden` is the
              form that does this honestly — the space is held, but the control leaves the tab order
              and the accessibility tree exactly as an unmounted one would. */}
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            {remainderUndo ? (
              <Button
                variant="ghost"
                style={COMPACT_ACTION_BTN_STYLE}
                onClick={undoRemainder}
                title="Put the previous amount back"
              >Undo</Button>
            ) : (
              <Button
                variant="ghost"
                style={{ ...COMPACT_ACTION_BTN_STYLE, visibility: balanced ? 'hidden' : 'visible' }}
                onClick={addRemainderToSelected}
                disabled={!selectedKey}
                title={selectedKey
                  ? 'Add what is left over to the highlighted amount'
                  : 'Click an amount above to choose where the remainder goes'}
              >Add remainder to selected</Button>
            )}
          </div>

          {error ? <div style={{ color: 'var(--danger)', fontSize: 13 }}>{error}</div> : null}
        </div>
      )}
    </AppDialog>
  )
}
