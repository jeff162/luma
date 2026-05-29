// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: GPL-3.0-or-later

// Click-to-focus stacking for floating detail panels.
//
// The detail-panel system (`DetailPanelShell`) used to assign every panel the same fixed
// `zIndex: 401` and rely on DOM render order for stacking. That breaks down when panels live
// in different parts of the tree (the global duplicate-detection dialog vs. route-mounted
// AccountDetail/BatchDetail panels), and there was no way for the user to bring an older
// panel back to the front after a newer one had opened on top.
//
// This context maintains a single ordered list of registered panel IDs across the whole app.
// The order is "back to front" — the last item is on top. Each panel:
//   * mounts → registers itself, lands at the top of the stack;
//   * on mousedown anywhere on its surface → calls bringToFront(id), which moves the id to
//     the end of the list (no-op if it's already there);
//   * unmounts → removes its id from the list.
//
// `usePanelStackSlot` returns the panel's effective `zIndex`, an `isTopmost` flag, and a
// memoized `bringToFront` handler that consumers wire up to the panel surface. Panels rendered
// outside the provider (test harnesses, dev pages) fall back to safe defaults so the hook is
// drop-in for shared components.
//
// Why two contexts: the order array changes on every register/unregister/bringToFront, but the
// register/unregister/bringToFront *callbacks* are stable. Splitting them avoids a feedback
// cycle where every order change re-fired every consumer's registration effect — which then
// called unregister, mutated order, and re-fired again, infinitely. Consumers that only need
// to act on the stack (e.g., a "bring me to front" button) can read the actions context alone
// without re-rendering on every order change.

import { createContext, useCallback, useContext, useEffect, useId, useMemo, useState } from 'react'

const PanelStackActionsContext = createContext(null)
const PanelStackOrderContext = createContext([])

// Base z-index that matches DetailPanelShell's historical value. Each registered panel gets
// `BASE + position_in_stack` so the back-most panel keeps the same number it always had and
// each successive panel sits one above its predecessor.
const PANEL_STACK_BASE_Z_INDEX = 401

export function PanelStackProvider({ children }) {
  const [order, setOrder] = useState([])

  // Actions are wrapped in a useMemo with EMPTY deps so their identity never changes — that's
  // what lets consumers list `actions` in a useEffect dep array without triggering an infinite
  // re-register loop. setOrder's functional form means we don't need to close over `order`.
  const actions = useMemo(() => ({
    register: (id) => setOrder(prev => (prev.includes(id) ? prev : [...prev, id])),
    unregister: (id) => setOrder(prev => prev.filter(x => x !== id)),
    bringToFront: (id) => setOrder(prev => {
      if (!prev.includes(id)) return prev
      if (prev[prev.length - 1] === id) return prev
      return [...prev.filter(x => x !== id), id]
    }),
  }), [])

  return (
    <PanelStackActionsContext.Provider value={actions}>
      <PanelStackOrderContext.Provider value={order}>
        {children}
      </PanelStackOrderContext.Provider>
    </PanelStackActionsContext.Provider>
  )
}

// Safe to call without a PanelStackProvider mounted — returns the historical fixed zIndex
// so shared components like DetailPanelShell don't have to gate on context presence.
export function usePanelStackSlot() {
  const actions = useContext(PanelStackActionsContext)
  const order = useContext(PanelStackOrderContext)
  const id = useId()

  useEffect(() => {
    if (!actions) return undefined
    actions.register(id)
    return () => actions.unregister(id)
  }, [actions, id])

  const bringToFront = useCallback(() => {
    actions?.bringToFront(id)
  }, [actions, id])

  if (!actions) {
    return { zIndex: PANEL_STACK_BASE_Z_INDEX, isTopmost: true, bringToFront }
  }

  const indexInOrder = order.indexOf(id)
  if (indexInOrder < 0) {
    // We've rendered before the register effect ran. Position at the top of the *current*
    // stack so the panel paints above whatever is already registered; the effect will then
    // formally append the id and produce the same z-index, so there's no visible flicker.
    return {
      zIndex: PANEL_STACK_BASE_Z_INDEX + order.length,
      isTopmost: true,
      bringToFront,
    }
  }

  return {
    zIndex: PANEL_STACK_BASE_Z_INDEX + indexInOrder,
    isTopmost: indexInOrder === order.length - 1,
    bringToFront,
  }
}
