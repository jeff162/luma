// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useRef, useState } from 'react'

// A value shown for a moment and then cleared, such as a button's "Copied". A new flash restarts the
// clock, and the timer is cleared on unmount, so it never sets state on a component that has gone.
// `flash(null)` clears at once. Two seconds is long enough to read a word or two.
export function useFlash(ms = 2000) {
  const [value, setValue] = useState(null)
  const timer = useRef(null)
  useEffect(() => () => clearTimeout(timer.current), [])
  const flash = useCallback(next => {
    clearTimeout(timer.current)
    setValue(next)
    if (next != null) timer.current = setTimeout(() => setValue(null), ms)
  }, [ms])
  return [value, flash]
}
