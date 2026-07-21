// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { EVIDENCE_COLUMN_SHAPE } from '../lib/importColumnInference.js'

// A short, human label for each inferred column shape, shown beside the checkbox so the user knows
// why a column is (or isn't) pre-checked for capture.
const SHAPE_LABEL = {
  [EVIDENCE_COLUMN_SHAPE.FREE_TEXT]: 'free text',
  [EVIDENCE_COLUMN_SHAPE.CATEGORICAL]: 'type / category',
  [EVIDENCE_COLUMN_SHAPE.IDENTIFIER]: 'identifier',
  [EVIDENCE_COLUMN_SHAPE.NUMBER]: 'number',
  [EVIDENCE_COLUMN_SHAPE.DATE]: 'date',
  [EVIDENCE_COLUMN_SHAPE.EMPTY]: 'empty',
}

/*
 * The add-on capture panel: every file column NOT mapped to a transaction field, listed with its
 * inferred shape and a checkbox. Checked columns are captured into the source record (import evidence)
 * — surfaced on the transaction and used to enrich matching rows from other imports. Descriptive and
 * categorical columns are pre-checked (see computeEvidenceColumnOptions); the user can adjust freely.
 * The checked set is authoritative: whatever is checked is exactly what gets captured.
 */
export default function ImportEvidenceColumnsSection({ options = [], checked = [], forced = [], onChange, title = 'Capture extra detail' }) {
  if (!options.length) return null
  const forcedSet = new Set(forced)
  // Forced columns (e.g. PayPal's Type / Item Title) are always captured — reflect that in the checked set.
  const checkedSet = new Set([...checked, ...forced])

  function toggle(header) {
    if (forcedSet.has(header)) return // forced columns can't be unchecked
    const next = new Set(checkedSet)
    if (next.has(header)) next.delete(header)
    else next.add(header)
    // Emit in file/column order so the stored list is stable regardless of click order.
    onChange?.(options.filter(option => next.has(option.header)).map(option => option.header))
  }

  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>{title}</div>
      <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 8, maxWidth: 560 }}>
        Columns not mapped above. Checked columns are kept as source detail (memos, item titles, transaction
        type) — shown on the transaction and used to enrich matching transactions from other imports.
      </div>
      <div style={{ maxHeight: 200, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 6 }}>
        {options.map((option, index) => (
          <label
            key={option.header}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '6px 10px',
              fontSize: 13,
              cursor: 'pointer',
              borderBottom: index < options.length - 1 ? '1px solid var(--border)' : 'none',
            }}
          >
            <input
              type="checkbox"
              checked={checkedSet.has(option.header)}
              disabled={forcedSet.has(option.header)}
              onChange={() => toggle(option.header)}
            />
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {option.header}
            </span>
            <span style={{ fontSize: 11, color: 'var(--muted)', flexShrink: 0 }}>
              {forcedSet.has(option.header)
                ? 'always captured for PayPal'
                : (SHAPE_LABEL[option.shape] || option.shape)
                  + (option.shape === 'categorical' && Number.isFinite(option.distinctCount)
                    ? ` · ${option.distinctCount} value${option.distinctCount === 1 ? '' : 's'}`
                    : '')}
            </span>
          </label>
        ))}
      </div>
    </div>
  )
}
