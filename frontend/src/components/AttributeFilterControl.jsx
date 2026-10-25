// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * The Transactions ledger's attribute quick filter — the single button that replaced the separate
 * "Uncategorized only" and "Needs review" toggles. An import report (`ImportBatchDetail`) carries the same
 * control, so a file's rows narrow with the same words and the same server predicate as the ledger's.
 *
 * It is deliberately **single-select**, which is what separates it from the FilterBar's Attributes tab.
 * This is the control for finding something quickly ("show me what needs review", "which rows have a
 * receipt"), so picking one attribute must never mean unpicking another first, and the button can be
 * named for what it filters on — the way both buttons it replaces were. Combining an attribute with
 * other conditions is the FilterBar's job, where the same vocabulary is multi-select and takes "is not".
 *
 * The split-button shape preserves the ergonomics of the two toggles it replaces: the body turns the
 * filter on and off while *keeping* the choice, so the ledger can be flipped between filtered and
 * unfiltered without re-picking, and the caret changes which attribute that is. A page-local filter,
 * like the ledger search — it narrows this ledger and never touches the shared FilterBar.
 *
 * **There is no "clear".** A choice that is switched off already shows everything, so clearing would be
 * a second control for a state the body button reaches in one click — and it would leave the button
 * with nothing to name itself after. The page therefore seeds a default choice rather than an empty
 * one; `Only…` is only ever the pre-load state, before the vocabulary has arrived.
 */

import SplitButton from './SplitButton.jsx'

export default function AttributeFilterControl({ attributes, value, active, onChange }) {
  const options = attributes || []
  const selected = options.find(a => a.key === value) || null
  const on = active && !!selected

  // Picking always turns the filter on: reaching into the menu is itself the request to apply it, and
  // landing on a chosen-but-inert filter would read as the control having failed.
  function renderMenu(close) {
    if (options.length === 0) return <div style={{ padding: '6px 10px', fontSize: 13, color: 'var(--muted)' }}>None.</div>
    return options.map(attribute => (
      <div
        key={attribute.key}
        role="menuitemradio"
        aria-checked={attribute.key === value}
        onClick={() => { onChange({ attribute: attribute.key, active: true }); close() }}
        title={attribute.description}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
          padding: '6px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 13,
          background: attribute.key === value ? 'color-mix(in srgb, var(--accent) 22%, var(--surface2))' : 'transparent',
        }}
      >
        <span>{attribute.label}</span>
        {attribute.key === value && <span style={{ color: 'var(--accent2)', fontSize: 11 }}>✓</span>}
      </div>
    ))
  }

  // Until something is picked there is nothing to toggle, so the whole button opens the picker.
  return (
    <SplitButton
      pressed={selected ? on : undefined}
      onClick={selected ? () => onChange({ attribute: value, active: !active }) : undefined}
      title={selected
        ? (on ? `Showing only: ${selected.label} — click to show everything` : `Show only ${selected.label}`)
        : 'Filter the ledger to one kind of transaction'}
      menuLabel={selected ? 'Choose what to filter on' : 'Filter the ledger by attribute'}
      menuMinWidth={260}
      renderMenu={renderMenu}
    >
      {selected ? `${on ? '✕ ' : ''}${selected.label}` : 'Only…'}
    </SplitButton>
  )
}
