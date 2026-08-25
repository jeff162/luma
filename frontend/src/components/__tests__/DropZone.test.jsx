// @vitest-environment jsdom

// The shared drop target, extracted once a third surface wanted one (docs/shared-components.md's
// watchlist trigger). What is worth pinning is the contract its three callers depend on rather than the
// styling: both ways in reach `onFiles`, `multiple` actually bounds what is handed over, a disabled
// zone is inert on every path, and the input resets so the *same* file can be picked twice — the last
// of which is not cosmetic, since without it a failed upload cannot be retried by choosing the same
// file again.

import { afterEach, describe, it, expect, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import DropZone from '../DropZone.jsx'

function file(name) {
  return new File(['x'], name, { type: 'application/pdf' })
}

function drop(zone, files) {
  const event = new Event('drop', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: { files } })
  zone.dispatchEvent(event)
}

afterEach(cleanup)

describe('DropZone', () => {
  it('hands over files from both the picker and a drop', async () => {
    const onFiles = vi.fn()
    const user = userEvent.setup()
    const { container } = render(<DropZone onFiles={onFiles}>Drop here</DropZone>)

    await user.upload(container.querySelector('input[type="file"]'), file('a.pdf'))
    expect(onFiles).toHaveBeenCalledTimes(1)
    expect(onFiles.mock.calls[0][0][0].name).toBe('a.pdf')

    drop(screen.getByRole('button'), [file('b.pdf')])
    expect(onFiles).toHaveBeenCalledTimes(2)
    expect(onFiles.mock.calls[1][0][0].name).toBe('b.pdf')
  })

  it('passes one file unless multiple is set', () => {
    const single = vi.fn()
    const { unmount } = render(<DropZone onFiles={single}>Drop</DropZone>)
    drop(screen.getByRole('button'), [file('a.pdf'), file('b.pdf')])
    expect(single.mock.calls[0][0]).toHaveLength(1)
    unmount()

    const many = vi.fn()
    render(<DropZone onFiles={many} multiple>Drop</DropZone>)
    drop(screen.getByRole('button'), [file('a.pdf'), file('b.pdf')])
    expect(many.mock.calls[0][0]).toHaveLength(2)
  })

  it('is inert while disabled, on click and on drop alike', async () => {
    const onFiles = vi.fn()
    const user = userEvent.setup()
    render(<DropZone onFiles={onFiles} disabled>Drop</DropZone>)

    await user.click(screen.getByRole('button'))
    drop(screen.getByRole('button'), [file('a.pdf')])
    expect(onFiles).not.toHaveBeenCalled()
  })

  it('ignores a drop carrying no files', () => {
    const onFiles = vi.fn()
    render(<DropZone onFiles={onFiles}>Drop</DropZone>)
    drop(screen.getByRole('button'), [])
    expect(onFiles).not.toHaveBeenCalled()
  })

  it('clears the input so the same file can be chosen twice', async () => {
    // The retry path: an upload that failed is most naturally retried by picking the identical file,
    // which a browser will not report as a change unless the value was cleared.
    const onFiles = vi.fn()
    const user = userEvent.setup()
    const { container } = render(<DropZone onFiles={onFiles}>Drop</DropZone>)
    const input = container.querySelector('input[type="file"]')

    await user.upload(input, file('same.pdf'))
    await user.upload(input, file('same.pdf'))

    expect(onFiles).toHaveBeenCalledTimes(2)
    expect(input.value).toBe('')
  })

  it('opens the picker from the keyboard, since it is a real control', async () => {
    const user = userEvent.setup()
    const { container } = render(<DropZone onFiles={vi.fn()}>Drop</DropZone>)
    const input = container.querySelector('input[type="file"]')
    const clicked = vi.spyOn(input, 'click')

    screen.getByRole('button').focus()
    await user.keyboard('{Enter}')

    expect(clicked).toHaveBeenCalled()
  })
})
