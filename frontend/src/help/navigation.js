// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * Help-page back-navigation helpers.
 *
 * The Help route can be reached two ways: via the left-nav Help item (no
 * "previous page" context — just browse the index) or by following a link that
 * stamps where it came from (the in-place viewer's "All help topics" link, or a
 * Read-more). The source path is carried in Link `state` and the Help page reads
 * it back here, mapping the path to a human label for a "Return to <page>" link.
 */

// Matched first, so deep sub-routes get their own name instead of the top-level
// section label below (e.g. /import-export/rule-suggestions is its own page, not
// "Import"). Checked against the full clean path.
const SUBPATH_LABELS = [
  [/\/rule-suggestions$/, 'Imported Rule Suggestions'],
]

const PATH_LABELS = [
  ['/', 'Dashboard'],
  ['/transactions', 'Transactions'],
  ['/categories', 'Categories'],
  ['/rules', 'Rules'],
  ['/accounts', 'Accounts'],
  ['/import-export', 'Import'],
  ['/tasks', 'Tasks'],
  ['/settings', 'Settings'],
  ['/administration', 'Administration'],
]

export function labelForPath(path) {
  if (!path || typeof path !== 'string') return null
  const cleanPath = path.split('?')[0].split('#')[0]
  for (const [pattern, label] of SUBPATH_LABELS) {
    if (pattern.test(cleanPath)) return label
  }
  if (cleanPath === '/') return 'Dashboard'
  const segment = cleanPath.split('/')[1]
  if (!segment) return null
  for (const [prefix, label] of PATH_LABELS) {
    if (prefix === `/${segment}`) return label
  }
  return null
}
