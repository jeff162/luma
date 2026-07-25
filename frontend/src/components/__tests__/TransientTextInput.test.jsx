// @vitest-environment jsdom

// Interaction contract for the shared inline-edit primitive (ui-patterns.md "Inline edit commit
// behavior"). Every in-place rename funnels through it, so Enter-commits / Escape-reverts /
// blur-commit must mean the same thing everywhere — and the create-vs-rename distinction rides on
// `onBlurCommit`, exactly the kind of behavior a refactor can silently flip. Real DOM events
// (keydown/blur/focus) need a DOM, so this runs under jsdom rather than the node helper suite.

import { afterEach, describe, it, expect, vi } from 'vitest'
import { useState, useRef } from 'react'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import TransientTextInput from '../TransientTextInput.jsx'
import { ESCAPE_BEHAVIOR } from '../../lib/uiInteractions.js'

afterEach(cleanup)

// Controlled wrapper: the primitive is controlled, so a host owns the value and reflects onChange.
function Harness({ initial = '', label = 'field', ...props }) {
  const [value, setValue] = useState(initial)
  return <TransientTextInput value={value} onChange={setValue} aria-label={label} autoFocus={false} {...props} />
}

describe('TransientTextInput inline-edit contract', () => {
  it('commits on Enter in single-line mode', async () => {
    const user = userEvent.setup()
    const onCommit = vi.fn()
    render(<Harness initial="abc" onCommit={onCommit} />)
    const input = screen.getByLabelText('field')
    await user.click(input)
    await user.keyboard('{Enter}')
    expect(onCommit).toHaveBeenCalledTimes(1)
  })

  it('reverts to the pre-edit value on Escape and signals cancel', async () => {
    const user = userEvent.setup()
    const onCancel = vi.fn()
    // blurOnEscape disabled so the assertion isn't racing the rAF-scheduled blur-commit.
    render(<Harness initial="original" onCancel={onCancel} restoreOnEscape blurOnEscape={false} />)
    const input = screen.getByLabelText('field')
    await user.click(input)
    await user.type(input, 'XYZ')
    expect(input.value).toBe('originalXYZ')
    await user.keyboard('{Escape}')
    expect(input.value).toBe('original')
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('commits on blur by default (rename) but not when onBlurCommit is false (create/forms)', async () => {
    const user = userEvent.setup()
    const renameCommit = vi.fn()
    const createCommit = vi.fn()
    render(
      <>
        <Harness initial="r" label="rename" onCommit={renameCommit} />
        <Harness initial="c" label="create" onCommit={createCommit} onBlurCommit={false} />
        <button type="button">elsewhere</button>
      </>,
    )
    await user.click(screen.getByLabelText('rename'))
    await user.click(screen.getByRole('button', { name: 'elsewhere' }))
    expect(renameCommit).toHaveBeenCalledTimes(1)

    await user.click(screen.getByLabelText('create'))
    await user.click(screen.getByRole('button', { name: 'elsewhere' }))
    expect(createCommit).not.toHaveBeenCalled()
  })

  it('does not commit on Enter in multiline mode (newline stays native)', async () => {
    const user = userEvent.setup()
    const onCommit = vi.fn()
    render(<Harness initial="" onCommit={onCommit} multiline />)
    const field = screen.getByLabelText('field')
    await user.click(field)
    await user.keyboard('{Enter}')
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('stops Escape from bubbling to a container/window handler', async () => {
    const user = userEvent.setup()
    // A window-level Escape listener is exactly how dismissible layers close (useEscapeAction). The
    // focused field must consume its Escape so the surface behind it never closes underneath the edit.
    const windowEscape = vi.fn(e => { if (e.key === 'Escape') windowEscape.escapes = (windowEscape.escapes || 0) + 1 })
    window.addEventListener('keydown', windowEscape)
    render(<Harness initial="x" restoreOnEscape blurOnEscape={false} />)
    const input = screen.getByLabelText('field')
    await user.click(input)
    await user.keyboard('{Escape}')
    window.removeEventListener('keydown', windowEscape)
    expect(windowEscape.escapes || 0).toBe(0)
  })

  it('reverts and restores focus to the trigger (REVERT_DRAFT_AND_RESTORE_FOCUS)', async () => {
    const user = userEvent.setup()
    // Focus is restored on the next animation frame; run rAF synchronously so the assertion is stable.
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(cb => { cb(); return 0 })
    function Host() {
      const triggerRef = useRef(null)
      const [value, setValue] = useState('orig')
      return (
        <>
          <button ref={triggerRef} type="button">trigger</button>
          <TransientTextInput
            aria-label="field"
            autoFocus={false}
            value={value}
            onChange={setValue}
            restoreOnEscape
            escapeBehavior={ESCAPE_BEHAVIOR.REVERT_DRAFT_AND_RESTORE_FOCUS}
            restoreFocusRef={triggerRef}
          />
        </>
      )
    }
    render(<Host />)
    const input = screen.getByLabelText('field')
    await user.click(input)
    await user.type(input, 'ZZ')
    expect(input.value).toBe('origZZ')
    await user.keyboard('{Escape}')
    expect(input.value).toBe('orig')
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'trigger' }))
    rafSpy.mockRestore()
  })
})
