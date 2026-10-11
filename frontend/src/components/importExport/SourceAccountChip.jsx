// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// The "what did each source account contribute?" chip, shared by every surface that reports the outcome of
// one import or sync: the Import history card and the Connections card.
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

// A source label that is really a provider's internal account id rather than a name.
//
// A sync falls back to the raw id when its `connection_account` record is missing for an account the row
// nonetheless resolved to (the backend records an advisory when this happens). The stored value cannot be
// rewritten — it is matched against each row's evidence — so the card renders around it instead: the
// account the rows landed in is shown, and the id stays available on hover for anyone who needs it.
//
// Detected by shape rather than by a flag, because a card carries no record of *why* its label reads the
// way it does. Provider ids here are long, unbroken and mixed-case; a real label carries a space or the
// "···1234" mask separator, which is what the two positive checks below are for.
const PROVIDER_ID_MIN_LENGTH = 20

function looksLikeProviderId(label) {
  const value = (label || '').trim()
  if (value.length < PROVIDER_ID_MIN_LENGTH) return false
  if (/[\s·]/.test(value)) return false
  return /[a-z]/.test(value) && /[A-Z0-9]/.test(value)
}

export function SourceAccountChip({ label, mappedLabel = '', count = null, skipped = false }) {
  const n = Number(count || 0)
  const noNewRows = !skipped && n === 0
  const muted = skipped || noNewRows
  // The source's own label differing from where rows landed means the user mapped it after the fact.
  // Both are shown — the card should match what the source called the account, with the destination as a
  // faded suffix — and this is one form for every source: a connection's label is its provider account
  // name, so "what the source called it → where it went" reads the same for a sync card as for a file.
  const opaque = looksLikeProviderId(label)
  const showMapping = !skipped && !opaque && mappedLabel && label && mappedLabel !== label
  // An opaque id tells the reader nothing, so where the rows actually landed takes its place. The id is
  // still the truth about the card and rides the tooltip rather than being discarded.
  // What the chip actually reads as. An opaque id is stood down in favour of where the rows landed; every
  // other case keeps the source's own label, which is the chip's whole point.
  const primaryLabel = opaque && mappedLabel ? mappedLabel : label
  const base = showMapping ? `${label} → ${mappedLabel}` : (skipped ? label : (mappedLabel || label))
  const detail = opaque && mappedLabel ? `${primaryLabel} · reported by the source as ${label}` : base
  return (
    <span
      title={noNewRows ? `${detail} · no new transactions` : detail}
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
      {truncate(primaryLabel)}
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
