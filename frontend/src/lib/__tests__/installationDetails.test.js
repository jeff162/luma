// How the browser is described for a bug report. Windows 10 and 11 send the same classic user-agent
// string, so the structured platform version is the only thing that separates them.

import { describe, it, expect } from 'vitest'
import { describeBrowser, describePlatform } from '../installationDetails.js'

describe('describePlatform', () => {
  it('tells Windows 11 from Windows 10 by platform version', () => {
    expect(describePlatform({ platform: 'Windows', platformVersion: '15.0.0', architecture: 'x86', bitness: '64' }))
      .toBe('Windows 11 (x86-64)')
    expect(describePlatform({ platform: 'Windows', platformVersion: '10.0.0', architecture: 'x86', bitness: '64' }))
      .toBe('Windows 10 (x86-64)')
  })

  it('passes other platforms through with their version', () => {
    expect(describePlatform({ platform: 'macOS', platformVersion: '15.1.0', architecture: 'arm', bitness: '64' }))
      .toBe('macOS 15.1.0 (arm64)')
  })
})

describe('describeBrowser', () => {
  it('names the brands and drops the placeholder entry', async () => {
    const nav = {
      userAgent: 'ignored',
      userAgentData: {
        getHighEntropyValues: async () => ({
          fullVersionList: [
            { brand: 'Not)A;Brand', version: '8.0.0.0' },
            { brand: 'Chromium', version: '152.0.7012.45' },
          ],
          platform: 'Windows', platformVersion: '15.0.0', architecture: 'x86', bitness: '64',
        }),
      },
    }
    expect(await describeBrowser(nav)).toBe('Chromium 152.0.7012.45 on Windows 11 (x86-64)')
  })

  it('falls back to the user-agent string where there is no structured form', async () => {
    expect(await describeBrowser({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:141.0) Gecko/20100101 Firefox/141.0' }))
      .toBe('Mozilla/5.0 (X11; Linux x86_64; rv:141.0) Gecko/20100101 Firefox/141.0')
  })
})
