// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from 'vitest'
import { getTxnOriginRows, providerLabel } from '../importSourceFields.js'

describe('providerLabel', () => {
  it('maps known providers to display names and capitalizes unknown ones', () => {
    expect(providerLabel('plaid')).toBe('Plaid')
    expect(providerLabel('PLAID')).toBe('Plaid')
    expect(providerLabel('simplefin')).toBe('SimpleFIN')
    expect(providerLabel('acme')).toBe('Acme')
    expect(providerLabel('')).toBe('')
    expect(providerLabel(null)).toBe('')
  })
})

describe('getTxnOriginRows source/connection rows', () => {
  const row = (txn, key) => getTxnOriginRows(txn).find(r => r.key === key)

  it('labels the origin "Source" (not "Source file")', () => {
    const source = row({ merchant_name: 'X', import_batch_filename: 'export.csv' }, 'source_file')
    expect(source.label).toBe('Source')
    expect(source.value).toBe('export.csv')
  })

  it('adds a Connection row for a synced batch and none for a CSV batch', () => {
    const synced = row(
      { merchant_name: 'X', import_batch_filename: 'Chase · Initial import', import_batch_provider: 'plaid' },
      'connection',
    )
    expect(synced).toMatchObject({ label: 'Connection', value: 'Plaid' })

    // A plain CSV batch (no provider) gets no Connection row.
    expect(row({ merchant_name: 'X', import_batch_filename: 'export.csv' }, 'connection')).toBeUndefined()
  })

  it('keeps the "not from an import" placeholder labeled Source', () => {
    const source = row({ merchant_name: 'X' }, 'source_file')
    expect(source.label).toBe('Source')
    expect(source.value).toMatch(/not from an import/)
  })
})
