// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// A metered provider's allowance as of the providers listing, in words, for the connection's hover text.
// Read from `request_allowance` (`ProviderAdapter.request_allowance` in the backend): `{capacity,
// refill_per_hour, pools: {pool key: requests left}}`, where `shared` is the pool an unfiltered request
// draws on and every other key is one account's own.
//
// The shared pool and the per-account ones are reported apart because they fail differently: an empty
// shared pool stops the whole connection, while one empty account pool stops that account and leaves its
// siblings walking.
export function allowanceSummary(allowance) {
  const pools = allowance?.pools
  if (!pools || typeof pools !== 'object') return null
  const capacity = Number(allowance.capacity) || 0
  const refill = Number(allowance.refill_per_hour) || 0
  // An absent pool is a full one — the adapter drops a pool once it refills completely.
  const shared = pools.shared ?? capacity
  const accounts = Object.entries(pools).filter(([key]) => key !== 'shared')
  const parts = [`${formatTokens(shared)} of ${capacity} requests left`]
  const drained = accounts.filter(([, tokens]) => Number(tokens) < 1)
  if (drained.length) {
    parts.push(`${drained.length} account${drained.length === 1 ? '' : 's'} out of requests`)
  } else if (accounts.length) {
    const lowest = Math.min(...accounts.map(([, t]) => Number(t)))
    parts.push(`${formatTokens(lowest)} left on the lowest account`)
  }
  // When the next one arrives is worth saying only when something is empty.
  const emptiest = Math.min(Number(shared), ...accounts.map(([, t]) => Number(t)))
  if (emptiest < 1 && refill > 0) {
    parts.push(`next request in ~${formatHours((1 - emptiest) / refill)}`)
  } else if (refill > 0) {
    parts.push(`${refill} more each hour`)
  }
  return parts.join(' · ')
}

function formatTokens(tokens) {
  const n = Math.max(0, Number(tokens) || 0)
  // Floored, never rounded up: this is a spendable count, and claiming a request that is not yet granted
  // is the error that costs a disabled token on a provider that meters strictly.
  return String(Math.floor(n))
}

function formatHours(hours) {
  if (!(hours > 0)) return 'moments'
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} min`
  return `${Math.round(hours)} hr`
}

// The same, for every metered connection of one provider, as hover lines: one each, named when there is
// more than one. Empty when none is metered.
export function connectionsAllowanceLines(connections) {
  const metered = (connections || [])
    .map(c => ({ name: c.institution || 'Connection', text: allowanceSummary(c.request_allowance) }))
    .filter(c => c.text)
  if (metered.length === 1) return [`Requests: ${metered[0].text}`]
  return metered.map(c => `${c.name} requests: ${c.text}`)
}
