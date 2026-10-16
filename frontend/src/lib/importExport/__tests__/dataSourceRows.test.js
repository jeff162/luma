// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// Which history row a card lands in, and — for a marketplace vendor — which account subtree inside it.
// Both are decisions a card cannot state about itself, so they are made here from its fields.

import { describe, it, expect } from 'vitest'
import { buildDataSourceRows, buildMarketplaceAccountGroups } from '../dataSourceRows.js'

const amazonCard = (overrides = {}) => ({
  id: 'b1', source_kind: 'marketplace:amazon', imported_at: '2026-01-02T03:04:05',
  filename: 'orders.csv', ...overrides,
})

describe('buildMarketplaceAccountGroups', () => {
  it('splits a vendor’s cards into one subtree per account', () => {
    const groups = buildMarketplaceAccountGroups([
      amazonCard({ id: 'a', amazon_account_id: 'acc-2', amazon_account_name: 'Second Amazon' }),
      amazonCard({ id: 'b', amazon_account_id: 'acc-1', amazon_account_name: 'Amazon' }),
      amazonCard({ id: 'c', amazon_account_id: 'acc-1', amazon_account_name: 'Amazon' }),
    ])
    expect(groups.map(g => [g.label, g.batches.map(b => b.id)]))
      .toEqual([['Amazon', ['b', 'c']], ['Second Amazon', ['a']]])
  })

  it('names the leftover group for the state its cards are in, and puts it last', () => {
    const groups = buildMarketplaceAccountGroups([
      amazonCard({ id: 'waiting', unmatched_item_count: 1 }),
      amazonCard({ id: 'placed', amazon_account_id: 'acc-1', amazon_account_name: 'Amazon' }),
    ])
    expect(groups.map(g => g.label)).toEqual(['Amazon', 'Waiting for orders file'])
  })

  it('does not claim a card is waiting when it is simply unattributed', () => {
    const groups = buildMarketplaceAccountGroups([amazonCard({ id: 'old', unmatched_item_count: 0 })])
    expect(groups.map(g => g.label)).toEqual(['No account recorded'])
  })
})

describe('buildDataSourceRows', () => {
  it('keeps a marketplace card under its vendor even once it names a saved source', () => {
    // A saved Amazon source is a `csv_import_profile` row, so a card stamped with one would otherwise
    // fall into that profile's CSV row — which has no mapping, no column map and nothing to show.
    const profile = { id: 'amz-1', name: 'Amazon household' }
    const rows = buildDataSourceRows({
      profiles: [profile],
      batches: [amazonCard({ profile_id: 'amz-1', amazon_account_id: 'acc-1', amazon_account_name: 'Amazon' })],
    })
    const marketplace = rows.find(r => r.kind === 'marketplace')
    expect(marketplace.batches.map(b => b.id)).toEqual(['b1'])
    expect(rows.find(r => r.kind === 'profile').batches).toEqual([])
    expect(marketplace.accountGroups.map(g => g.label)).toEqual(['Amazon'])
  })
})
