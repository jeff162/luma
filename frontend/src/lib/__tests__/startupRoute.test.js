/*
 * The remembered landing page is the one navigation target that comes back out of storage rather than
 * from a literal or an internal id, so these pin what it is allowed to be. The off-site forms are the
 * point: `//host` and `/\host` both begin with a slash, which is why a prefix check is not enough.
 */

import { describe, it, expect } from 'vitest'
import { safeStartupRoute } from '../startupRoute.js'

const ORIGIN = 'http://127.0.0.1:5173'

describe('safeStartupRoute', () => {
  it('keeps an ordinary in-app route, query string and all', () => {
    expect(safeStartupRoute('/recurring?series=abc123', ORIGIN)).toBe('/recurring?series=abc123')
    expect(safeStartupRoute('/import-export/batches/42/rule-suggestions', ORIGIN))
      .toBe('/import-export/batches/42/rule-suggestions')
  })

  it('rejects the off-site forms that still begin with a slash', () => {
    expect(safeStartupRoute('//evil.example', ORIGIN)).toBe('')
    expect(safeStartupRoute('/\\evil.example', ORIGIN)).toBe('')
    expect(safeStartupRoute('//evil.example/transactions', ORIGIN)).toBe('')
  })

  it('rejects anything that is not a rooted path', () => {
    expect(safeStartupRoute('https://evil.example/transactions', ORIGIN)).toBe('')
    expect(safeStartupRoute('javascript:alert(1)', ORIGIN)).toBe('')
    expect(safeStartupRoute('transactions', ORIGIN)).toBe('')
  })

  it('treats an absent or unusable value as no remembered route', () => {
    expect(safeStartupRoute('', ORIGIN)).toBe('')
    expect(safeStartupRoute(null, ORIGIN)).toBe('')
    expect(safeStartupRoute(undefined, ORIGIN)).toBe('')
    expect(safeStartupRoute('   ', ORIGIN)).toBe('')
  })

  it('normalizes a route rather than passing the raw string through', () => {
    expect(safeStartupRoute('/transactions/../rules', ORIGIN)).toBe('/rules')
  })
})
