// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: GPL-3.0-or-later

/*
 * Help-page back-navigation helpers.
 *
 * The Help route can be reached two ways: via the left-nav Help item (no
 * "previous page" context — just browse the index) or via a Read-more link
 * inside a FeatureExplainer popover (we want a labeled "Back to <page>"
 * affordance). The popover stamps the source path into Link `state` and the
 * Help page reads it back here, mapping the path to a human label.
 */

const PATH_LABELS = [
  ['/', 'Dashboard'],
  ['/transactions', 'Transactions'],
  ['/categories', 'Categories'],
  ['/rules', 'Rules'],
  ['/accounts', 'Accounts'],
  ['/import-export', 'Import / Export'],
  ['/tasks', 'Tasks'],
  ['/settings', 'Settings'],
]

export function labelForPath(path) {
  if (!path || typeof path !== 'string') return null
  const cleanPath = path.split('?')[0].split('#')[0]
  if (cleanPath === '/') return 'Dashboard'
  const segment = cleanPath.split('/')[1]
  if (!segment) return null
  for (const [prefix, label] of PATH_LABELS) {
    if (prefix === `/${segment}`) return label
  }
  return null
}
