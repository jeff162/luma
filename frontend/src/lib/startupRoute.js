// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * Validation for the remembered landing page before it is navigated to.
 *
 * The startup route is *persisted* rather than chosen from a list: the app records the last place the
 * user was, as `pathname + search`, and navigates there on the next load. That makes it the one string
 * reaching `navigate()` that did not come from a literal or an internal id, so it is the one that has
 * to be re-checked on the way back out of storage.
 *
 * The check is whether the value still resolves to *this* origin, asked of the URL parser rather than
 * of the string. A prefix test ("starts with a slash") is the shape that keeps failing: `//host` is
 * protocol-relative and `/\host` is read as host-relative by browsers and routers alike, and both pass
 * it while pointing off-site. Parsing against the current origin and then rebuilding the route from
 * the parsed parts also normalizes the value, so nothing exotic survives into the router.
 */

export function safeStartupRoute(value, origin) {
  const raw = String(value || '').trim()
  if (!raw.startsWith('/')) return ''
  const base = origin || (typeof window === 'undefined' ? '' : window.location.origin)
  if (!base) return ''
  try {
    const url = new URL(raw, base)
    if (url.origin !== base) return ''
    return `${url.pathname}${url.search}`
  } catch {
    return ''
  }
}
