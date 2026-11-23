// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// The count on the nav's Tasks link: how many tasks the Tasks page will show.
//
// **Narrowed by the owner lens as chosen, on every page.** The badge previews the Tasks page, which the lens
// narrows, so it counts what that page will list; reading the route-gated lens instead would make the number
// change as the user moves between scoped and unscoped pages (`docs/data-model.md` → *Owner lens*).
//
// Two refresh triggers, by design:
//   * `luma:data-mutated` — same-session immediacy: any successful mutation anywhere emits this from the api
//     layer (see `signalDataMutated` in api.js), so no call site has to remember to refresh the badge.
//     `BackgroundCatchUp` emits it too, for what changed while the page was out of view.
//   * the route — navigation backstop: re-fetch on every route change to pick up changes this session
//     didn't make (another tab, a background sync).

import { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { api } from '../lib/api.js'
import { useOwnerLens } from '../lib/OwnerLensContext.jsx'

// Mirrors `SEVERITY_COLORS` in Tasks.jsx so the badge reads as the same severity the task cards render with.
// Ordered by ascending urgency so that `topSeverity` can pick the worst pending task. Extending: add the new
// severity here AND in SEVERITY_ORDER, then ensure the backend uses the same key.
const BADGE_COLORS = {
  info: 'var(--accent)',
  warning: 'var(--warning)',
}
const SEVERITY_ORDER = ['info', 'warning']

function topSeverity(tasks) {
  let best = null
  let bestRank = -1
  for (const task of tasks || []) {
    const rank = SEVERITY_ORDER.indexOf(task?.severity)
    if (rank > bestRank) { bestRank = rank; best = task?.severity || null }
  }
  return best
}

export function NavTaskBadge({ collapsed }) {
  const { pathname } = useLocation()
  const { choiceParams } = useOwnerLens()
  const [badge, setBadge] = useState({ count: 0, severity: null })

  useEffect(() => {
    let cancelled = false
    const load = () => api.getTasks(choiceParams)
      .then(r => { if (!cancelled) setBadge({ count: r?.open_items || 0, severity: topSeverity(r?.tasks) }) })
      .catch(() => { })
    load()
    window.addEventListener('luma:data-mutated', load)
    return () => { cancelled = true; window.removeEventListener('luma:data-mutated', load) }
  }, [choiceParams, pathname])

  if (badge.count <= 0) return null
  return (
    <span style={{
      background: BADGE_COLORS[badge.severity] || BADGE_COLORS.info,
      color: '#fff',
      fontWeight: 700,
      borderRadius: 99,
      textAlign: 'center',
      ...(collapsed
        ? { position: 'absolute', top: 3, left: 22, fontSize: 10, padding: '0 4px', lineHeight: '15px', minWidth: 15 }
        : { fontSize: 11, padding: '1px 7px', lineHeight: '18px', minWidth: 20 }),
    }}>
      {badge.count}
    </span>
  )
}
