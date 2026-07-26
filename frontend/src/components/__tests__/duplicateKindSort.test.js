// The Kind column of the duplicate-detection report sorts by kindRank, and the cell paints kindMeta's
// label — both derived from the one KIND_STATES table. This guards the drift that let acknowledged
// "Reviewed" (and enriched "Matched") rows collapse into the plain-"Rejected" rank and sort scattered
// among them: every label must have its own distinct rank, and each state's representative row must land
// on the label + rank the table promises.
import { describe, it, expect } from 'vitest'
import { KIND_STATES, kindMeta, kindRank } from '../UnifiedDuplicatesDialog.jsx'

// One representative entry per state, in the table's own order (most urgent first).
const SAMPLES = [
  { label: 'Review',            entry: { kind: 'soft_flag' } },
  { label: 'Rejected · review', entry: { kind: 'hard_reject', review_substate: 'no_match', incoming: { row_number: 1 } } },
  { label: 'Resolved',          entry: { kind: 'hard_reject', incoming: { txn_id: 't1' } } },
  { label: 'Matched',           entry: { kind: 'hard_reject', enriched: true, incoming: { row_number: 2 } } },
  { label: 'Reviewed',          entry: { kind: 'hard_reject', reviewed: true, matched: { covered: true }, incoming: { row_number: 3 } } },
  { label: 'Rejected',          entry: { kind: 'hard_reject', incoming: { row_number: 4 } } },
]

describe('duplicate-report Kind column', () => {
  it('gives every label its own distinct sort rank', () => {
    const labels = KIND_STATES.map(s => s.label)
    expect(new Set(labels).size).toBe(labels.length)          // no two states share a label
    const ranks = KIND_STATES.map((_, i) => i)
    expect(new Set(ranks).size).toBe(ranks.length)            // ...and each has a distinct rank (the index)
  })

  it('maps each state to the label + rank the table promises', () => {
    SAMPLES.forEach(({ label, entry }, i) => {
      expect(kindMeta(entry).label).toBe(label)
      expect(kindRank(entry)).toBe(i)
    })
  })

  it('sorts each label together — Reviewed and Matched no longer scatter among Rejected', () => {
    // Two Rejected rows bracketing a Reviewed and a Matched (the reported symptom). Sorting by rank must
    // cluster like-labelled rows, never interleave a Reviewed/Matched between two Rejected.
    const rows = [
      SAMPLES.find(s => s.label === 'Rejected').entry,
      SAMPLES.find(s => s.label === 'Reviewed').entry,
      SAMPLES.find(s => s.label === 'Rejected').entry,
      SAMPLES.find(s => s.label === 'Matched').entry,
    ]
    const sortedLabels = [...rows].sort((a, b) => kindRank(a) - kindRank(b)).map(e => kindMeta(e).label)
    // Every run of a given label is contiguous.
    const firstIndex = {}
    const lastIndex = {}
    sortedLabels.forEach((label, i) => {
      if (!(label in firstIndex)) firstIndex[label] = i
      lastIndex[label] = i
    })
    for (const label of Object.keys(firstIndex)) {
      const count = sortedLabels.filter(l => l === label).length
      expect(lastIndex[label] - firstIndex[label] + 1).toBe(count)   // contiguous block, no interleaving
    }
  })
})
