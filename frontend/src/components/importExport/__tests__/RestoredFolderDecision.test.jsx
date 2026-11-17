// @vitest-environment jsdom

// The question a restore from another system leaves on each watched source: use the path here, or clear it.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const api = vi.hoisted(() => ({ settleRestoredWatchFolder: vi.fn() }))
vi.mock('../../../lib/api.js', () => ({ api }))

const RestoredFolderDecision = (await import('../RestoredFolderDecision.jsx')).default
const { AppSessionProvider } = await import('../../../lib/AppSessionContext.jsx')

const PENDING = { id: 'src-1', watch_dir: '/srv/orders', watch_restore_pending: true }

function renderAs(profile, { canAdminister = true, onSettled = vi.fn() } = {}) {
  render(
    <AppSessionProvider value={{ canAdminister }}>
      <RestoredFolderDecision profile={profile} onSettled={onSettled} />
    </AppSessionProvider>,
  )
  return onSettled
}

afterEach(() => {
  cleanup()
  api.settleRestoredWatchFolder.mockReset()
})

describe('RestoredFolderDecision', () => {
  it('answers with the choice and hands back to the surface to reload', async () => {
    api.settleRestoredWatchFolder.mockResolvedValue({ ok: true })
    const onSettled = renderAs(PENDING)
    await userEvent.click(screen.getByRole('button', { name: 'Clear' }))
    expect(api.settleRestoredWatchFolder).toHaveBeenCalledWith('src-1', false)
    await waitFor(() => expect(onSettled).toHaveBeenCalled())
  })

  it('keeps the question open and says why when the folder cannot be used here', async () => {
    api.settleRestoredWatchFolder.mockRejectedValue(new Error('This folder is not there right now.'))
    const onSettled = renderAs(PENDING)
    await userEvent.click(screen.getByRole('button', { name: 'Use here' }))
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(onSettled).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Use here' })).toBeTruthy()
  })

  it('offers nothing once answered, or to someone who may not set a folder', () => {
    renderAs({ ...PENDING, watch_restore_pending: false })
    renderAs(PENDING, { canAdminister: false })
    expect(screen.queryByRole('button')).toBeNull()
  })
})
