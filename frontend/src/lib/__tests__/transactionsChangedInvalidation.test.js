// @vitest-environment jsdom

// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * Every write on the mutation layer invalidates the transaction-derived views.
 *
 * The lint guard stops feature code calling the wrapped `api.*` writes directly, but nothing stops a
 * *new* method here from being added without the notify — which is exactly how a tag edit came to leave
 * the dashboard's tag report stating pre-edit figures. So this asserts the property over the whole
 * object rather than over the methods that happen to exist today: a method added without the dispatch
 * fails here on the day it lands.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const apiMock = new Proxy({}, {
  get: (target, prop) => {
    if (!target[prop]) target[prop] = vi.fn(() => Promise.resolve({ ok: true }))
    return target[prop]
  },
  has: () => true,
})
vi.mock('../api.js', () => ({ api: apiMock }))

const { txnMutations } = await import('../txnMutations.js')

let fired

beforeEach(() => {
  fired = 0
  window.addEventListener('luma:transactions-changed', countEvent)
})

afterEach(() => {
  window.removeEventListener('luma:transactions-changed', countEvent)
})

function countEvent() {
  fired += 1
}

describe('the transaction mutation layer', () => {
  const names = Object.keys(txnMutations)

  it('has writes to check', () => {
    expect(names.length).toBeGreaterThan(0)
  })

  for (const name of names) {
    it(`${name} invalidates transaction-derived views`, async () => {
      await txnMutations[name]('t1', 'x', true)
      expect(fired).toBeGreaterThan(0)
    })
  }
})
