// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { formatDecimal } from './displayFormat.js'

// How the housekeeping surfaces say a size, and what share of the database it is.

export function formatBytes(bytes) {
  const n = Number(bytes || 0)
  if (n >= 1024 * 1024) return `${formatDecimal(n / (1024 * 1024), 1)} MB`
  if (n >= 1024) return `${Math.round(n / 1024)} KB`
  return `${n} B`
}

// `part` as a share of `whole`, worded as the estimate it is: stored-detail sizes are measured from the
// text held, where the database's is its file, so the two are close rather than exact. Empty when
// there is nothing to compare against.
export function formatShare(part, whole) {
  const total = Number(whole || 0)
  const n = Number(part || 0)
  if (!total || !n) return ''
  const percent = (n / total) * 100
  if (percent < 1) return 'under 1%'
  return `about ${Math.min(100, Math.round(percent))}%`
}
