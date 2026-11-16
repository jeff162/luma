// @vitest-environment jsdom

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import InlineRename from '../InlineRename.jsx'

afterEach(cleanup)

function edit(text) {
  fireEvent.click(screen.getByRole('button'))
  const input = screen.getByRole('textbox', { name: 'Name' })
  if (text !== undefined) fireEvent.change(input, { target: { value: text } })
  fireEvent.keyDown(input, { key: 'Enter' })
}

describe('InlineRename', () => {
  it('saves the typed name', async () => {
    const onRename = vi.fn().mockResolvedValue()
    render(<InlineRename shown="Harborline" onRename={onRename} ariaLabel="Name" />)
    edit('  Harborline Joint ')
    await waitFor(() => expect(onRename).toHaveBeenCalledWith('Harborline Joint'))
  })

  it('saves nothing when the fallback is committed unchanged, and clears a name that is emptied', async () => {
    const onRename = vi.fn().mockResolvedValue()
    const { rerender } = render(<InlineRename shown="Harborline" onRename={onRename} ariaLabel="Name" />)
    edit()
    expect(onRename).not.toHaveBeenCalled()

    rerender(<InlineRename value="Harborline Joint" shown="Harborline Joint" onRename={onRename} ariaLabel="Name" />)
    edit('')
    await waitFor(() => expect(onRename).toHaveBeenCalledWith(''))
  })

  it('keeps the field open when the save fails', async () => {
    const onRename = vi.fn().mockRejectedValue(new Error('Connection not found'))
    render(<InlineRename shown="Harborline" onRename={onRename} ariaLabel="Name" />)
    edit('Harborline Joint')
    await waitFor(() => expect(screen.getByRole('textbox').getAttribute('aria-invalid')).toBe('true'))
  })
})
