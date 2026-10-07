// The import's progress comes from a second request polled alongside it, so what matters here is the
// relationship between the two: the poll asks about the run the import was sent under, a count is passed
// on only once the rows have started, the bar ends full when the import answers, a failed poll costs
// nothing, and no poll outlives the import.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import { IMPORT_PROGRESS_POLL_MS, runImportWithProgress } from '../importRunProgress.js'
import { api } from '../../api.js'

vi.mock('../../api.js', () => ({ api: { runImport: vi.fn(), getImportRunProgress: vi.fn() } }))

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

describe('runImportWithProgress', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    api.runImport.mockReset()
    api.getImportRunProgress.mockReset()
  })
  afterEach(() => { vi.useRealTimers() })

  it('polls the run the import was sent under and reports counts once the rows start', async () => {
    const upload = deferred()
    api.runImport.mockReturnValue(upload.promise)
    api.getImportRunProgress
      .mockResolvedValueOnce({ active: true, done: 0, total: null })
      .mockResolvedValueOnce({ active: true, done: 1200, total: 3500 })
      .mockResolvedValue({ active: true, done: 3100, total: 3500 })
    const onProgress = vi.fn()

    const run = runImportWithProgress('file', { a: 1 }, onProgress)
    const { progressId } = api.runImport.mock.calls[0][2]
    await vi.advanceTimersByTimeAsync(IMPORT_PROGRESS_POLL_MS * 3)

    expect(api.getImportRunProgress).toHaveBeenCalledWith(progressId)
    expect(onProgress.mock.calls.map(([p]) => p)).toEqual([
      { done: 1200, total: 3500 },
      { done: 3100, total: 3500 },
    ])

    upload.resolve({ imported: 3500 })
    await expect(run).resolves.toEqual({ imported: 3500 })
    expect(onProgress).toHaveBeenLastCalledWith({ done: 3500, total: 3500 })

    const polls = api.getImportRunProgress.mock.calls.length
    await vi.advanceTimersByTimeAsync(IMPORT_PROGRESS_POLL_MS * 5)
    expect(api.getImportRunProgress).toHaveBeenCalledTimes(polls)
  })

  it('keeps polling through a failed poll and stops when the import fails', async () => {
    const upload = deferred()
    api.runImport.mockReturnValue(upload.promise)
    api.getImportRunProgress
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValue({ active: true, done: 10, total: 50 })
    const onProgress = vi.fn()

    const run = runImportWithProgress('file', {}, onProgress)
    await vi.advanceTimersByTimeAsync(IMPORT_PROGRESS_POLL_MS * 2)
    expect(onProgress).toHaveBeenCalledWith({ done: 10, total: 50 })

    upload.reject(new Error('Import failed'))
    await expect(run).rejects.toThrow('Import failed')
    const polls = api.getImportRunProgress.mock.calls.length
    await vi.advanceTimersByTimeAsync(IMPORT_PROGRESS_POLL_MS * 5)
    expect(api.getImportRunProgress).toHaveBeenCalledTimes(polls)
  })
})
