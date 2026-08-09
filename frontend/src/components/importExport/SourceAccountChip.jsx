// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// The "what did each source account contribute?" chip, shared by every surface that reports the outcome of
// one import or sync: the Import/Export history card and the Connections card.
//
// It exists as one component because the two surfaces answer the same question and a user reads them
// minutes apart — a second implementation would drift in exactly the details that matter (which glyph
// means "skipped" vs. "got nothing", whether a zero-row account is shown at all), and those details are
// the whole information content.
//
// Three states, and the third is the point: an account that was NOT skipped but contributed no rows reads
// as its own thing, muted with a minus, so the green check never implies rows loaded when none did. That
// state is what makes an account silently importing nothing visible instead of merely absent.

const TRUNCATE_AT = 22

function truncate(s) {
  return s && s.length > TRUNCATE_AT ? `${s.slice(0, TRUNCATE_AT - 2)}…` : s
}

export function SourceAccountChip({ label, mappedLabel = '', count = null, skipped = false }) {
  const n = Number(count || 0)
  const noNewRows = !skipped && n === 0
  const muted = skipped || noNewRows
  // The source's own label differing from where rows landed means the user mapped it after the fact.
  // Both are shown — the card should match what the source called the account, with the destination as a
  // faded suffix — and this is one form for every source: a connection's label is its provider account
  // name, so "what the source called it → where it went" reads the same for a sync card as for a file.
  const showMapping = !skipped && mappedLabel && label && mappedLabel !== label
  const base = showMapping ? `${label} → ${mappedLabel}` : (skipped ? label : (mappedLabel || label))
  return (
    <span
      title={noNewRows ? `${base} · no new transactions` : base}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        fontSize: 11, padding: '2px 7px', borderRadius: 99,
        background: muted ? 'var(--surface2)' : 'color-mix(in srgb, var(--accent) 10%, var(--surface2))',
        color: muted ? 'var(--muted)' : 'var(--text)',
        border: '1px solid var(--border)',
      }}
    >
      <span style={{ color: muted ? 'var(--muted)' : 'var(--success)', fontWeight: 600 }}>
        {skipped ? '✕' : noNewRows ? '−' : '✓'}
      </span>
      {truncate(label)}
      {showMapping ? (
        <>
          <span style={{ color: 'var(--muted)', opacity: 0.7 }}>→</span>
          <span style={{ color: 'var(--muted)' }}>{truncate(mappedLabel)}</span>
        </>
      ) : null}
      {n > 0 ? <span style={{ color: 'var(--muted)' }}>{n.toLocaleString()}</span> : null}
    </span>
  )
}

// A neutral outcome chip for a count that is not an account — duplicates dropped, rows needing review.
// Same shape as the account chips so a card's outcome row reads as one set rather than two styles.
export function OutcomeChip({ label, count, tone = 'muted', onClick, title }) {
  const color = tone === 'warning' ? 'var(--warning)' : 'var(--muted)'
  const Tag = onClick ? 'button' : 'span'
  return (
    <Tag
      {...(onClick ? { type: 'button', onClick } : {})}
      title={title}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        fontSize: 11, padding: '2px 7px', borderRadius: 99,
        background: `color-mix(in srgb, ${color} 10%, var(--surface2))`,
        color,
        border: '1px solid var(--border)',
        cursor: onClick ? 'pointer' : 'default',
      }}
    >
      {label}
      <span style={{ fontWeight: 600 }}>{Number(count || 0).toLocaleString()}</span>
    </Tag>
  )
}
