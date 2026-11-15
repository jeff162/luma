// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// The "Older imports" archive inside an expanded data-source row: the cards the per-source recency
// window left out (`lib/importExport/importHistoryWindow.js`), disclosed by the year they cover. Both card surfaces
// render through it — the generic data-source row and the marketplace vendor row — so the two cannot
// drift in how far back a source's list runs.
//
// Two interaction rules, both there to keep the archive from hiding work:
//   * The disclosure, and each year inside it, says what its cards still want done, in the same pills
//     the collapsed source row uses. An archive that quietly swallowed a card needing review would be
//     the old lossy cap's failure again, one level down.
//   * The newest archived year opens with the archive and older ones stay shut, so the common case —
//     one year of older cards — costs one click rather than two, and a decade of history still opens
//     to a list of years rather than to every card at once.
//   * A card the host is landing on (`revealIds`) opens the archive and its year around it — a file
//     of old transactions is archived the moment it is imported, and its card is what the import shows.


import { useState } from 'react'
import { HistoryAttentionPill } from './importPresentational.jsx'
import { archivedCardCount, summarizeBatchAttention } from '../../lib/importExport/importHistoryWindow.js'

// Aligns the disclosure headings with the card text above them, which the two surfaces pad equally.
const CARD_TEXT_INDENT = 46

function DisclosureToggle({ open, onToggle, title, indent = 0, children }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      title={title}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        width: '100%',
        padding: `8px 16px 8px ${CARD_TEXT_INDENT + indent}px`,
        background: 'none',
        border: 'none',
        cursor: 'pointer',
        font: 'inherit',
        fontSize: 12,
        color: 'var(--muted)',
        textAlign: 'left',
      }}
    >
      <span
        aria-hidden="true"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 18,
          height: 18,
          flexShrink: 0,
          borderRadius: 6,
          border: '1px solid var(--border)',
          background: 'var(--surface2)',
          fontSize: 11,
          lineHeight: 1,
        }}
      >
        {open ? '−' : '+'}
      </span>
      {children}
    </button>
  )
}


// The attention pills for one set of archived cards. Silent when there is nothing to say.
function AttentionPills({ batches, noun }) {
  const attention = summarizeBatchAttention(batches)
  const scope = `the ${noun} in here`
  return (
    <>
      {attention.unresolvedDuplicates > 0 ? (
        <HistoryAttentionPill title={`${attention.unresolvedDuplicates} duplicate-report row${attention.unresolvedDuplicates === 1 ? '' : 's'} among ${scope} still waiting for a verdict`}>
          ⚠ {attention.unresolvedDuplicates} duplicate{attention.unresolvedDuplicates === 1 ? '' : 's'}
        </HistoryAttentionPill>
      ) : null}
      {attention.needsReview > 0 ? (
        <HistoryAttentionPill tone="review" title={`${attention.needsReview} transaction${attention.needsReview === 1 ? '' : 's'} among ${scope} still need review`}>
          {attention.needsReview} to review
        </HistoryAttentionPill>
      ) : null}
      {attention.reconAttention + attention.walletAttention > 0 ? (
        <HistoryAttentionPill title={`${attention.reconAttention + attention.walletAttention} reconciliation item${attention.reconAttention + attention.walletAttention === 1 ? '' : 's'} among ${scope} need a look`}>
          ⚠ {attention.reconAttention + attention.walletAttention} to resolve
        </HistoryAttentionPill>
      ) : null}
    </>
  )
}

/**
 * `archive` is `partitionImportHistory`'s by-year output; `renderBatch` is the host's own card
 * renderer, so an archived card is the same card it would have been in the list above.
 */
export function ImportHistoryArchive({ archive, renderBatch, noun = 'imports', revealIds }) {
  const [open, setOpen] = useState(false)
  const [closedYears, setClosedYears] = useState(() => new Set(archive.slice(1).map(group => group.year)))
  // Opened once per set of cards to reveal, during render so they are in the DOM in the same commit
  // as the row around them; afterwards the disclosures are the reader's to close again.
  const revealYears = archive.filter(group => group.batches.some(b => revealIds?.has(b.id))).map(group => group.year)
  const revealKey = revealYears.join('|') + (revealYears.length ? `#${[...revealIds].join(',')}` : '')
  const [revealed, setRevealed] = useState('')
  if (revealKey !== revealed) {
    setRevealed(revealKey)
    if (revealYears.length) {
      setOpen(true)
      setClosedYears(prev => new Set([...prev].filter(year => !revealYears.includes(year))))
    }
  }
  if (!archive.length) return null
  const total = archivedCardCount(archive)

  return (
    <div style={{ borderTop: '1px solid color-mix(in srgb, var(--border) 80%, transparent)' }}>
      <DisclosureToggle
        open={open}
        onToggle={() => setOpen(value => !value)}
        title={open ? 'Hide older imports' : `Show the ${total} older ${noun} kept in this data source's history`}
      >
        <span>
          <span style={{ fontWeight: 600 }}>Older {noun}</span> · {total}
        </span>
        <AttentionPills batches={archive.flatMap(group => group.batches)} noun={noun} />
      </DisclosureToggle>

      {open ? archive.map(group => {
        const yearOpen = !closedYears.has(group.year)
        return (
          <div key={group.year || 'undated'}>
            <DisclosureToggle
              open={yearOpen}
              indent={18}
              onToggle={() => setClosedYears(prev => {
                const next = new Set(prev)
                if (next.has(group.year)) next.delete(group.year)
                else next.add(group.year)
                return next
              })}
            >
              <span>
                <span style={{ fontWeight: 600, color: 'var(--text)' }}>{group.label}</span>
                {' · '}{group.batches.length} {group.batches.length === 1 ? noun.replace(/s$/, '') : noun}
              </span>
              <AttentionPills batches={group.batches} noun={noun} />
            </DisclosureToggle>
            {yearOpen ? group.batches.map(renderBatch) : null}
          </div>
        )
      }) : null}

    </div>
  )
}
