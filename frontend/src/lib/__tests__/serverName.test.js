// When the nav pane shows the server's name, and where its colour goes. The build's own name is 'Luma'
// here, as `VITE_APP_NAME` is unset under vitest.

import { describe, it, expect } from 'vitest'
import { describeServerName, SERVER_NAME_COLORS } from '../serverName.js'

describe('describeServerName', () => {
  it('gives a renamed server a line of its own', () => {
    expect(describeServerName({ name: 'Ledger Demo', color: null })).toEqual({ line: 'Ledger Demo', color: null })
    expect(describeServerName({ name: 'Ledger Demo', color: 'red' }))
      .toEqual({ line: 'Ledger Demo', color: SERVER_NAME_COLORS.red })
  })

  it('says nothing when the server goes by the name on screen', () => {
    // The default case must not repeat the wordmark beneath it.
    expect(describeServerName({ name: 'Luma', color: null })).toBeNull()
    expect(describeServerName(null)).toBeNull()
  })

  it('colours the wordmark when only the colour is new', () => {
    expect(describeServerName({ name: 'Luma', color: 'red' })).toEqual({ line: null, color: SERVER_NAME_COLORS.red })
  })
})
