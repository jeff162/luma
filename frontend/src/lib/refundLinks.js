// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { formatMoneyMagnitude } from './moneyDisplay.js'
import { formatDate } from './utils.js'

// What the ledger row's link marker says about a refund pairing (`refund_link` on the list feed; see
// services/refund_links.py). A refund names the payment it returns; a payment names each refund it had —
// several where it was refunded in parts. "Refunded" already says which way the money went, so the amount
// is a magnitude.
export function refundLinkTooltip(link) {
  const others = link?.others || []
  if (!others.length) return ''
  if (link.role === 'refund') {
    const [payment] = others
    return `Refund of ${payment.name || 'a payment'} · ${formatDate(payment.date)}`
  }
  return others.map(refund => `Refunded ${formatMoneyMagnitude(refund.amount)} · ${formatDate(refund.date)}`).join('; ')
}
