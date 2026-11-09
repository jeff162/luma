// The ordering rules the tracker exists for: a change made elsewhere is reported, this page's own is not,
// and an absorbing re-read landing mid-check cannot hide a change.

import { describe, expect, it, vi } from 'vitest'
import { createLedgerEpochTracker } from '../ledgerEpoch.js'

function deferred() {
  let resolve
  const promise = new Promise(res => { resolve = res })
  return { promise, resolve }
}

describe('createLedgerEpochTracker', () => {
  it('reports a moved epoch and stays quiet when it has not moved', async () => {
    let epoch = 5
    const onChanged = vi.fn()
    const tracker = createLedgerEpochTracker({ read: async () => epoch, onChanged })
    await tracker.absorb()
    await tracker.check()
    expect(onChanged).not.toHaveBeenCalled()
    epoch = 7
    await tracker.check()
    expect(onChanged).toHaveBeenCalledTimes(1)
    await tracker.check()
    expect(onChanged).toHaveBeenCalledTimes(1)
  })

  it('absorbs a write without reporting it', async () => {
    let epoch = 5
    const onChanged = vi.fn()
    const tracker = createLedgerEpochTracker({ read: async () => epoch, onChanged })
    await tracker.absorb()
    epoch = 6
    await tracker.absorb()
    await tracker.check()
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('still reports a change when an absorbing read lands while the check is in flight', async () => {
    const reads = []
    const onChanged = vi.fn()
    const tracker = createLedgerEpochTracker({
      read: () => { const d = deferred(); reads.push(d); return d.promise },
      onChanged,
    })
    const first = tracker.absorb()
    reads[0].resolve(5)
    await first

    const checking = tracker.check()
    const absorbing = tracker.absorb()
    reads[2].resolve(9)
    await absorbing
    reads[1].resolve(9)
    await checking
    expect(onChanged).toHaveBeenCalledTimes(1)
  })

  it('only learns the value when it had none to compare against', async () => {
    let fail = true
    const onChanged = vi.fn()
    const tracker = createLedgerEpochTracker({
      read: async () => { if (fail) throw new Error('offline'); return 3 },
      onChanged,
    })
    await tracker.absorb()
    fail = false
    await tracker.check()
    expect(onChanged).not.toHaveBeenCalled()
  })
})
