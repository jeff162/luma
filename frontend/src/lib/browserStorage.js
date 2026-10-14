// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * The one path to localStorage and sessionStorage.
 *
 * Browser storage here holds only what the app can run without: view state, a pre-paint cache, an
 * unsaved draft. Reaching it can throw — a browser set to block site data refuses on the property
 * access itself, a write fails once the origin's quota is full, and there is no `window` at all under
 * a Node test — and none of those is something the user can act on. So a failed read answers as if
 * nothing was stored, and a failed write is dropped: the cost is that the state is not remembered.
 *
 * - A read gives `null` for a value that is missing, unreadable or (for JSON) malformed; callers
 *   validate the shape they get, since stored values outlive the code that wrote them.
 * - A write answers whether it landed, for the caller that has to know (the import draft).
 * - A missing key is a no-op, so a key built from an identity that is not known yet needs no guard.
 * - Only the storage call is guarded. `setJson` serializes first, so a value that cannot be
 *   serialized is reported as the bug it is.
 */

function storeOver(areaName) {
  function get(key) {
    if (!key) return null
    try {
      return window[areaName].getItem(key)
    } catch {
      return null
    }
  }

  function set(key, value) {
    if (!key) return false
    try {
      window[areaName].setItem(key, value)
      return true
    } catch {
      return false
    }
  }

  function remove(key) {
    if (!key) return
    try {
      window[areaName].removeItem(key)
    } catch { /* see the header */ }
  }

  function clear() {
    try {
      window[areaName].clear()
    } catch { /* see the header */ }
  }

  function getJson(key) {
    const raw = get(key)
    if (raw === null) return null
    try {
      return JSON.parse(raw)
    } catch {
      return null
    }
  }

  function setJson(key, value) {
    return set(key, JSON.stringify(value))
  }

  return { get, set, remove, clear, getJson, setJson }
}

export const localStore = storeOver('localStorage')
export const sessionStore = storeOver('sessionStorage')
