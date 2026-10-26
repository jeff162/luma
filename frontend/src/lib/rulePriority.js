// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// A rule's priority as the screens offer it. Stored as an integer (`category_rule.priority_level`, higher
// wins), so a level added later is one more entry here and in `categorizer.RULE_PRIORITY_LEVELS`.
export const RULE_PRIORITY_NORMAL = 0
export const RULE_PRIORITY_LOW = -1

export const RULE_PRIORITY_OPTIONS = [
  { value: RULE_PRIORITY_NORMAL, label: 'Normal' },
  { value: RULE_PRIORITY_LOW, label: 'Low' },
]

export const isLowPriority = rule => Number(rule?.priority_level ?? RULE_PRIORITY_NORMAL) < RULE_PRIORITY_NORMAL
