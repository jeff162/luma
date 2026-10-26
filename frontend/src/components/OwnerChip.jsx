// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/* eslint-disable react-refresh/only-export-components -- the chip and the short labels it is shown with live together so callers get one import */

/*
 * An owner as a pill: their colour as a dot, then a name. Read-only it says whose something is; given an
 * `onClick` it is a filter pill, `selected` marking the one in force.
 *
 * A row names an owner by **first name** (`ownerChipLabels`) with the full name on hover, because the chip
 * sits ahead of a label that truncates and a full name there would take the room the label needs. Owner
 * names are free text and nothing stops two sharing a first name, so those two keep their full names — a
 * short label that could mean either person would be worse than a long one.
 */
export function ownerChipLabels(owners) {
  const firstName = owner => (owner.name || '').trim().split(/\s+/)[0] || owner.name
  const counts = new Map()
  for (const owner of owners) counts.set(firstName(owner), (counts.get(firstName(owner)) || 0) + 1)
  return new Map(owners.map(owner => [
    owner.id,
    counts.get(firstName(owner)) > 1 ? owner.name : firstName(owner),
  ]))
}

// `swatch={false}` is for a pill that stands for no one in particular — a filter's "Everyone".
export default function OwnerChip({ owner, label = owner.name, selected = false, onClick, swatch = true, disabled = false }) {
  const content = (
    <>
      {swatch ? <span
        aria-hidden="true"
        style={{
          width: 7, height: 7, borderRadius: 999, flexShrink: 0,
          // Unassigned has no colour of its own, so it is drawn hollow rather than borrowing someone's.
          background: owner.color || 'transparent',
          border: owner.color ? 'none' : '1px solid var(--muted)',
          boxSizing: 'border-box',
        }}
      /> : null}
      {label}
    </>
  )
  const style = {
    display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0,
    borderRadius: 999, whiteSpace: 'nowrap', font: 'inherit', lineHeight: 1.3,
  }

  if (!onClick) {
    return (
      <span
        title={owner.name}
        style={{
          ...style, padding: '0 6px', fontSize: 11, fontWeight: 500,
          border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--muted)',
        }}
      >
        {content}
      </span>
    )
  }

  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      disabled={disabled}
      title={label === owner.name ? undefined : owner.name}
      style={{
        ...style, padding: '3px 9px', fontSize: 11.5, cursor: disabled ? 'not-allowed' : 'pointer',
        fontWeight: selected ? 600 : 500,
        border: `1px solid ${selected ? 'color-mix(in srgb, var(--accent) 52%, var(--border))' : 'var(--border)'}`,
        background: selected ? 'color-mix(in srgb, var(--accent) 14%, var(--surface2))' : 'var(--surface2)',
        color: selected ? 'var(--text)' : 'var(--muted)',
      }}
    >
      {content}
    </button>
  )
}
