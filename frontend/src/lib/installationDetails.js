// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// The text Settings -> About -> Copy details puts on the clipboard, for pasting into a bug report. The
// server supplies what only it knows (`GET /api/app/installation-details`); the browser adds itself.

import { connectionProviderLabel } from './connectionSummary.js'

const FORMS = {
  portable: 'packaged build, portable',
  installed: 'packaged build, installed',
  container: 'container',
  checkout: 'source checkout',
}

// Chromium's structured browser description, where the browser offers one. The classic user-agent string
// is frozen: every Chromium browser sends Chrome's (Vivaldi among them), with the version zeroed past the
// major and Windows 11 reporting itself as Windows 10. Firefox and Safari have no structured form, and
// Chromium offers it only on a secure origin, so a plain-HTTP connection from another device falls back.
export async function describeBrowser(nav = globalThis.navigator) {
  const data = nav?.userAgentData
  if (!data?.getHighEntropyValues) return nav?.userAgent || 'unknown'
  try {
    const values = await data.getHighEntropyValues(['fullVersionList', 'platformVersion', 'architecture', 'bitness'])
    return `${describeBrands(values.fullVersionList || data.brands || [])} on ${describePlatform(values)}`
  } catch {
    return nav.userAgent || 'unknown'
  }
}

// The list carries deliberate nonsense entries ("Not A(Brand", "Not)A;Brand") so that sites cannot
// match it exactly; those are dropped. The rest name the engine and, when the browser chooses to, itself.
function describeBrands(brands) {
  const named = brands.filter(entry => !/not.?a.?brand/i.test(entry.brand))
  return named.length ? named.map(entry => `${entry.brand} ${entry.version}`).join(', ') : 'unknown browser'
}

export function describePlatform({ platform = '', platformVersion = '', architecture = '', bitness = '' }) {
  const major = Number.parseInt(platformVersion, 10)
  let name = platform || 'unknown platform'
  // Windows reports a platform version of 13 and up for Windows 11, 1 to 10 for Windows 10, and 0 for
  // anything older.
  if (platform === 'Windows' && Number.isFinite(major)) {
    name = major >= 13 ? 'Windows 11' : major > 0 ? 'Windows 10' : 'Windows 8.1 or older'
  } else if (platformVersion) {
    name = `${platform} ${platformVersion}`
  }
  const arch = architecture === 'x86' ? (bitness === '64' ? 'x86-64' : 'x86')
    : architecture === 'arm' ? (bitness === '64' ? 'arm64' : 'arm') : architecture
  return arch ? `${name} (${arch})` : name
}

export function installationDetailsAsText(details, { appName, browser }) {
  const providers = details.connection_providers || []
  const lines = [
    `${appName} v${details.version}`,
    details.build ? `Build: ${details.build}` : null,
    `Runs as: ${FORMS[details.form] || details.form}`,
    `Reachable from: ${details.reachable_from_network ? 'the network' : 'this machine only'}`,
    `This browser: ${details.request_is_loopback ? 'same machine' : 'another device'}, over ${details.request_is_https ? 'HTTPS' : 'HTTP'}`,
    `Sign-in: ${details.sign_in_required ? 'required' : 'not required'}`,
    `Server: ${details.server_platform}, Python ${details.python_version}`,
    `Browser: ${browser}`,
    `Connections: ${providers.length ? providers.map(connectionProviderLabel).join(', ') : 'none'}`,
  ]
  return lines.filter(Boolean).join('\n')
}
