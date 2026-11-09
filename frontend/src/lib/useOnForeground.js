// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// Runs `onForeground` each time the page comes back into view.
//
// A tablet keeps a backgrounded page alive for days, and most of what the app loads is read once at load
// and then kept current only by this device's own actions. Whatever another device or the server did in
// the meantime reaches this page through here. `onForeground` is read through a ref, so a caller need
// not keep it stable.
//
// `backendLiveness.js` watches the same event for its own purpose; it is not a React module, so it keeps
// its own listener.

import { useEffect, useRef } from 'react'

export function useOnForeground(onForeground, { enabled = true } = {}) {
  const callbackRef = useRef(onForeground)
  callbackRef.current = onForeground
  useEffect(() => {
    if (!enabled) return undefined
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') callbackRef.current()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => document.removeEventListener('visibilitychange', onVisibilityChange)
  }, [enabled])
}
