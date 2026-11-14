// @vitest-environment jsdom

// Press-and-hold is the only way to reach a right-click menu on an iPad, and nothing on a desktop
// exercises it, so a regression would go unseen until someone picked up a tablet. This pins the gesture:
// a still hold opens the menu at the finger, a moving or lifted finger does not, and a hold that opened a
// menu withholds the click its release would send.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installTouchContextMenu } from '../touchContextMenu.js'

function pointer(type, target, { x = 50, y = 60, pointerType = 'touch' } = {}) {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.assign(event, { pointerType, isPrimary: true, pointerId: 1, clientX: x, clientY: y })
  target.dispatchEvent(event)
}

let uninstall
let row
let menuHandler

beforeEach(() => {
  vi.useFakeTimers()
  uninstall = installTouchContextMenu()
  row = document.createElement('div')
  document.body.appendChild(row)
  menuHandler = vi.fn(event => event.preventDefault())
  row.addEventListener('contextmenu', menuHandler)
})

afterEach(() => {
  uninstall()
  row.remove()
  vi.useRealTimers()
})

describe('touch press-and-hold', () => {
  it('opens the right-click menu at the finger after a still hold', () => {
    pointer('pointerdown', row)
    vi.advanceTimersByTime(499)
    expect(menuHandler).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(menuHandler).toHaveBeenCalledTimes(1)
    expect(menuHandler.mock.calls[0][0]).toMatchObject({ clientX: 50, clientY: 60 })
  })

  it('does nothing for a finger that moves, lifts early, or a mouse', () => {
    pointer('pointerdown', row)
    pointer('pointermove', row, { x: 70 })
    vi.advanceTimersByTime(600)

    pointer('pointerdown', row)
    pointer('pointerup', row)
    vi.advanceTimersByTime(600)

    pointer('pointerdown', row, { pointerType: 'mouse' })
    vi.advanceTimersByTime(600)

    expect(menuHandler).not.toHaveBeenCalled()
  })

  it('withholds the click a release sends after opening a menu', () => {
    const onClick = vi.fn()
    row.addEventListener('click', onClick)

    pointer('pointerdown', row)
    vi.advanceTimersByTime(500)
    pointer('pointerup', row)
    row.click()
    expect(onClick).not.toHaveBeenCalled()

    vi.advanceTimersByTime(400)
    row.click()
    expect(onClick).toHaveBeenCalledTimes(1)
  })
})
