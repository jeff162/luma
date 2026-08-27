// The one editorial rule the client owns about the data location: when the control database is worth
// naming. The paths themselves are the backend's answer and are not re-derived here.

import { describe, it, expect } from 'vitest'
import { describeDataLocation } from '../dataLocation.js'

describe('describeDataLocation', () => {
  it('says nothing when the server withheld the location', () => {
    // A session that may not be told gets no field at all, and the line must render nothing rather
    // than an empty row where a path would be.
    expect(describeDataLocation(null)).toBeNull()
    expect(describeDataLocation({})).toBeNull()
  })

  it('leaves the control database out while it sits beside the ledger', () => {
    const described = describeDataLocation({
      db_path: '/home/someone/.local/share/luma/luma-data.db',
      control_db_path: '/home/someone/.local/share/luma/luma-control.db',
    })
    expect(described.path).toBe('/home/someone/.local/share/luma/luma-data.db')
    // The two normally travel together, so repeating the folder would say nothing.
    expect(described.controlPath).toBeNull()
  })

  it('names the control database once it is in another directory', () => {
    // The per-file overrides an older installation runs on can split them apart, which is exactly the
    // case the tooltip exists to carry.
    const described = describeDataLocation({
      db_path: '/srv/ledgers/household.db',
      control_db_path: '/home/someone/.local/share/luma/luma-control.db',
    })
    expect(described.controlPath).toBe('/home/someone/.local/share/luma/luma-control.db')
  })

  it('reads a Windows path the browser is not running on', () => {
    // The path is the server's, so the separator is the server's too.
    const described = describeDataLocation({
      db_path: 'C:\\Users\\someone\\AppData\\Local\\Luma\\luma-data.db',
      control_db_path: 'C:\\Users\\someone\\AppData\\Local\\Luma\\luma-control.db',
    })
    expect(described.controlPath).toBeNull()
  })
})
