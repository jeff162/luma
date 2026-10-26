// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { getFormControlStyle } from './ui.jsx'
import { RULE_PRIORITY_NORMAL, RULE_PRIORITY_OPTIONS } from '../lib/rulePriority.js'

// `compact` sits on a line of 11px label text (the rule editor's section eyebrow); the default suits a row
// of buttons.
const COMPACT_STYLE = { padding: '2px 6px', fontSize: 11, borderRadius: 5 }

export default function RulePrioritySelect({ value, onChange, disabled = false, size = 'regular' }) {
  return (
    <select
      name="rule-priority"
      aria-label="Rule priority"
      value={value ?? RULE_PRIORITY_NORMAL}
      onChange={e => onChange(Number(e.target.value))}
      disabled={disabled}
      style={{ ...getFormControlStyle({ size: 'sm', clickable: true }), ...(size === 'compact' ? COMPACT_STYLE : null) }}
    >
      {RULE_PRIORITY_OPTIONS.map(option => (
        <option key={option.value} value={option.value}>{option.label}</option>
      ))}
    </select>
  )
}
