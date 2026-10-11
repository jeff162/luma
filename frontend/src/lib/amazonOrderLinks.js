// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { formatMoneyMagnitude } from './moneyDisplay.js'
import { formatDate } from './utils.js'

// An order's name is its whole item list, which can run to hundreds of characters.
const ORDER_NAME_MAX = 80

// What the ledger row's link marker says about an Amazon order pairing (`amazon_order` on the list feed;
// see routers/import_export/amazon.py). The card charge names the order it paid for; the order names each
// charge that paid it — several where Amazon billed it as split shipments. "Card charge" already says which
// way the money went, so the amount is a magnitude.
export function amazonOrderLinkTooltip(link) {
  const others = link?.others || []
  if (!others.length) return ''
  if (link.role === 'charge') {
    const [order] = others
    const name = order.name || ''
    const shown = name.length > ORDER_NAME_MAX ? `${name.slice(0, ORDER_NAME_MAX).trimEnd()}…` : name
    return `Amazon order${shown ? `: ${shown}` : ''} · ${formatDate(order.date)}`
  }
  return others.map(charge => `Card charge ${formatMoneyMagnitude(charge.amount)} · ${formatDate(charge.date)}`).join('; ')
}
