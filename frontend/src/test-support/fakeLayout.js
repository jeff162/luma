// jsdom does no layout: every box measures 0x0, so a virtualizer given one renders no rows at all. Tests
// of windowed lists install this instead, which hands every element a size.
//
// A mounted row (anything carrying `data-index`) reports the row height; every other element reports the
// viewport's. Every size property has to agree on that, because virtual-core reads the scroll viewport
// through `clientHeight` and measures rows through whichever of the others its build uses. A row that
// reported the viewport's height would make one row look like it fills the screen, which quietly defeats
// the windowing these tests exist to check.

/**
 * Give every element a fixed size for the rest of the test file. Call from `beforeAll`.
 *
 * @param {object} sizes
 * @param {number} sizes.viewportHeight - Height of the scroll viewport, and of any element that is not a row.
 * @param {number} sizes.rowHeight - Height every mounted row measures at.
 * @param {number} [sizes.width] - Width of every element.
 */
export function installFakeLayout({ viewportHeight, rowHeight, width = 800 }) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  const heightOf = element => (element.hasAttribute('data-index') ? rowHeight : viewportHeight)
  for (const name of ['offsetWidth', 'clientWidth']) {
    Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get() { return width } })
  }
  for (const name of ['offsetHeight', 'clientHeight']) {
    Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get() { return heightOf(this) } })
  }
  Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    const height = heightOf(this)
    return { x: 0, y: 0, top: 0, left: 0, right: width, bottom: height, width, height, toJSON() {} }
  }
}
