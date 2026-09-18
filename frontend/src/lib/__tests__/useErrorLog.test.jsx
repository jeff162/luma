// @vitest-environment jsdom

// Opening the Error log is what acknowledges the errors in it, which is what clears the Tasks reminder. It
// acknowledges through the count read with the entries, never the latest, so an error logged while the page
// was open stays unseen.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { renderHook, waitFor, cleanup } from '@testing-library/react'

const getErrorLog = vi.fn()
const acknowledgeErrorLog = vi.fn()

vi.mock('../api.js', () => ({
  api: {
    getErrorLog: (...args) => getErrorLog(...args),
    acknowledgeErrorLog: (...args) => acknowledgeErrorLog(...args),
  },
}))

const { useErrorLog } = await import('../useErrorLog.js')

afterEach(() => {
  cleanup()
  getErrorLog.mockReset()
  acknowledgeErrorLog.mockReset()
})

describe('useErrorLog', () => {
  it('acknowledges the errors it was shown', async () => {
    getErrorLog.mockResolvedValue({ entries: [], recorded: 3, unacknowledged: 2 })
    acknowledgeErrorLog.mockResolvedValue({})
    const { result } = renderHook(() => useErrorLog(true))
    await waitFor(() => expect(result.current.log).not.toBeNull())
    expect(acknowledgeErrorLog).toHaveBeenCalledWith(3)
  })
})
