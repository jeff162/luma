// @vitest-environment jsdom

// The rules that decide whether a press is a click, a scroll or a drag, and where a drag lands. A wrong
// answer to any of them fails quietly on whichever kind of device the author was not holding, which is
// how dragging came to work only with a mouse.
//
// jsdom does no layout, so the hit test is pointed at the element under test directly.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { startPointerDrag, useDropZone } from '../pointerDrag.js'

function Zone({ name, accepts, onDrop, children }) {
  const ref = useDropZone({ accepts, onDrop })
  return <div ref={ref} data-testid={name}>{children}</div>
}

function Source({ item = 'row', onClick, onEnd }) {
  return (
    <button type="button" onClick={onClick} onPointerDown={event => startPointerDrag(event, { onStart: () => item, onEnd })}>
      source
    </button>
  )
}

function pointAt(element) {
  document.elementFromPoint = () => element
}

const mouse = { pointerId: 1, pointerType: 'mouse', button: 0, clientY: 0 }

function mouseDrag(source, distance) {
  fireEvent.pointerDown(source, { ...mouse, clientX: 0 })
  fireEvent.pointerMove(window, { ...mouse, clientX: distance })
  fireEvent.pointerUp(window, { ...mouse, clientX: distance })
}

afterEach(() => {
  cleanup()
  delete document.elementFromPoint
  vi.useRealTimers()
})

describe('with a mouse', () => {
  it('leaves a press that barely moves as a click', () => {
    const onClick = vi.fn()
    const onDrop = vi.fn()
    render(<><Source onClick={onClick} /><Zone name="zone" onDrop={onDrop} /></>)
    pointAt(screen.getByTestId('zone'))
    const source = screen.getByRole('button')
    mouseDrag(source, 2)
    fireEvent.click(source)
    expect(onDrop).not.toHaveBeenCalled()
    expect(onClick).toHaveBeenCalled()
  })

  it('drops on the zone under the pointer and swallows the click the release produces', () => {
    const onClick = vi.fn()
    const onDrop = vi.fn()
    render(<><Source item="payload" onClick={onClick} /><Zone name="zone" onDrop={onDrop} /></>)
    pointAt(screen.getByTestId('zone'))
    const source = screen.getByRole('button')
    mouseDrag(source, 20)
    fireEvent.click(source)
    expect(onDrop).toHaveBeenCalledWith('payload', expect.anything(), screen.getByTestId('zone'))
    expect(onClick).not.toHaveBeenCalled()
  })

  it('passes a drop an inner zone refuses out to the zone around it', () => {
    const inner = vi.fn()
    const outer = vi.fn()
    render(
      <>
        <Source />
        <Zone name="outer" onDrop={outer}>
          <Zone name="inner" accepts={() => false} onDrop={inner} />
        </Zone>
      </>,
    )
    pointAt(screen.getByTestId('inner'))
    mouseDrag(screen.getByRole('button'), 20)
    expect(inner).not.toHaveBeenCalled()
    expect(outer).toHaveBeenCalled()
  })

  it('puts the item back on Escape', () => {
    const onDrop = vi.fn()
    const onEnd = vi.fn()
    render(<><Source onEnd={onEnd} /><Zone name="zone" onDrop={onDrop} /></>)
    pointAt(screen.getByTestId('zone'))
    const source = screen.getByRole('button')
    fireEvent.pointerDown(source, { ...mouse, clientX: 0 })
    fireEvent.pointerMove(window, { ...mouse, clientX: 20 })
    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.pointerUp(window, { ...mouse, clientX: 20 })
    expect(onDrop).not.toHaveBeenCalled()
    expect(onEnd).toHaveBeenCalledWith({ dropped: false, cancelled: true })
  })

  it('does not start a drag its source refuses', () => {
    const onDrop = vi.fn()
    render(
      <>
        <button type="button" onPointerDown={event => startPointerDrag(event, { onStart: () => null })}>source</button>
        <Zone name="zone" onDrop={onDrop} />
      </>,
    )
    pointAt(screen.getByTestId('zone'))
    mouseDrag(screen.getByRole('button'), 20)
    expect(onDrop).not.toHaveBeenCalled()
  })
})

describe('with a finger', () => {
  const touch = { pointerId: 2, pointerType: 'touch', button: 0, clientX: 0, clientY: 0 }

  it('picks the item up after a press-and-hold and keeps the page from scrolling under it', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const onDrop = vi.fn()
    render(<><Source /><Zone name="zone" onDrop={onDrop} /></>)
    pointAt(screen.getByTestId('zone'))
    fireEvent.pointerDown(screen.getByRole('button'), touch)
    act(() => vi.advanceTimersByTime(400))
    const scrolled = fireEvent.touchMove(window, { touches: [{ clientX: 40, clientY: 0 }] })
    fireEvent.touchEnd(window, { touches: [] })
    expect(scrolled).toBe(false)
    expect(onDrop).toHaveBeenCalled()
  })

  it('leaves a swipe that moves before the hold completes to scroll', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const onDrop = vi.fn()
    render(<><Source /><Zone name="zone" onDrop={onDrop} /></>)
    pointAt(screen.getByTestId('zone'))
    fireEvent.pointerDown(screen.getByRole('button'), touch)
    const scrolled = fireEvent.touchMove(window, { touches: [{ clientX: 40, clientY: 0 }] })
    act(() => vi.advanceTimersByTime(400))
    fireEvent.touchEnd(window, { touches: [] })
    expect(scrolled).toBe(true)
    expect(onDrop).not.toHaveBeenCalled()
  })
})
