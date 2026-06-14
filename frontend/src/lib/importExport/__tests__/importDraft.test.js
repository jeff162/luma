// Import-draft serialization + file-compatibility contracts (ui-patterns "Import mapping persistence").
// Two of these encode invariants a refactor can silently break: a draft only carries forward when the
// next file still looks like the same provider shape (hash-first, header-fallback), and the
// snapshot→profile-body conversion must nest the account mapping + imported-category settings into the
// exact column_map shape the backend persists. Pure logic, so the node env (no localStorage round-trip).

import { describe, it, expect } from 'vitest'
import {
  stableSerialize,
  buildProfileBodyFromSnapshot,
  doesDraftMatchPreview,
  profileHeaderClearlyMismatches,
  getSuggestedDataSourceName,
} from '../importDraft.js'
import { IMPORTED_CATEGORY_SETTINGS_KEY } from '../constants.js'

describe('stableSerialize', () => {
  it('is independent of object key order (so it can detect real changes, not reordering)', () => {
    expect(stableSerialize({ a: 1, b: [2, { c: 3, d: 4 }] }))
      .toBe(stableSerialize({ b: [2, { d: 4, c: 3 }], a: 1 }))
  })

  it('distinguishes genuinely different values', () => {
    expect(stableSerialize({ a: 1 })).not.toBe(stableSerialize({ a: 2 }))
  })
})

describe('buildProfileBodyFromSnapshot', () => {
  it('flattens a draft snapshot into the persisted profile body shape', () => {
    const draftRecord = {
      filenamePattern: 'acme',
      headerFingerprint: 'fp1',
      templateFilename: 'acme.csv',
      templateFileHash: 'h1',
      snapshot: {
        column_map: { date: 'Date', amount: 'Amount' },
        account_map: { 'CSV-A': 'acc1' },
        skip_accounts: ['CSV-B'],
        account_new: { 'CSV-C': { name: 'New', type: 'credit' } },
        single_account_new: { name: '  Solo  ', type: '' },
        account_id: 'acc0',
        date_format: '%Y-%m-%d',
        amount_convention: 'two_column',
        skip_rows: 1,
        apply_categorization: false,
        use_imported_categories: true,
      },
    }
    const body = buildProfileBodyFromSnapshot('  My Source  ', draftRecord)

    // Top-level scalars + the draft's source hints carry through.
    expect(body.name).toBe('My Source')
    expect(body.filename_pattern).toBe('acme')
    expect(body.header_fingerprint).toBe('fp1')
    expect(body.template_file_hash).toBe('h1')
    expect(body.account_id).toBe('acc0')
    expect(body.date_format).toBe('%Y-%m-%d')
    expect(body.amount_convention).toBe('two_column')
    expect(body.skip_rows).toBe(1)
    expect(body.apply_categorization).toBe(false)
    expect(body.use_imported_categories).toBe(true)

    // Account mapping nests under column_map; single_account_new gets the default type.
    expect(body.column_map.date).toBe('Date')
    expect(body.column_map.account_assignments).toEqual({ 'CSV-A': 'acc1' })
    expect(body.column_map.account_skips).toEqual(['CSV-B'])
    expect(body.column_map.account_new).toEqual({ 'CSV-C': { name: 'New', type: 'credit' } })
    expect(body.column_map.single_account_new).toEqual({ name: 'Solo', type: 'depository' })

    // Imported-category settings are present both nested and lifted to top-level fields.
    expect(body.column_map).toHaveProperty(IMPORTED_CATEGORY_SETTINGS_KEY)
    expect(body).toHaveProperty('imported_category_scope_mode')
  })

  it('returns null when there is no snapshot to convert', () => {
    expect(buildProfileBodyFromSnapshot('x', {})).toBeNull()
    expect(buildProfileBodyFromSnapshot('x', null)).toBeNull()
  })
})

describe('doesDraftMatchPreview', () => {
  it('matches on file content hash when both sides have one', () => {
    expect(doesDraftMatchPreview({ templateFileHash: 'h1' }, { file_content_hash: 'h1' })).toBe(true)
  })

  it('treats a content-hash mismatch as decisive even if the headers agree', () => {
    // Same provider shape (matching header) but a different file → not the same draft target.
    const draft = { templateFileHash: 'h1', headerFingerprint: 'fp' }
    const preview = { file_content_hash: 'h2', header_fingerprint: 'fp' }
    expect(doesDraftMatchPreview(draft, preview)).toBe(false)
  })

  it('falls back to header fingerprint when a content hash is absent', () => {
    expect(doesDraftMatchPreview({ headerFingerprint: 'fp' }, { header_fingerprint: 'fp' })).toBe(true)
    expect(doesDraftMatchPreview({ headerFingerprint: 'fp' }, { header_fingerprint: 'other' })).toBe(false)
  })

  it('is false when there is nothing comparable on either side', () => {
    expect(doesDraftMatchPreview({}, {})).toBe(false)
    expect(doesDraftMatchPreview(null, { header_fingerprint: 'fp' })).toBe(false)
  })
})

describe('profileHeaderClearlyMismatches', () => {
  it('only reports a mismatch when both fingerprints are present and differ', () => {
    expect(profileHeaderClearlyMismatches({ header_fingerprint: 'a' }, { header_fingerprint: 'b' })).toBe(true)
    expect(profileHeaderClearlyMismatches({ header_fingerprint: 'a' }, { header_fingerprint: 'a' })).toBe(false)
    // Absent information is not a "clear" mismatch — don't reject the profile on missing data.
    expect(profileHeaderClearlyMismatches({}, { header_fingerprint: 'b' })).toBe(false)
  })
})

describe('getSuggestedDataSourceName', () => {
  it('prefers a saved filename pattern over inferring from the current file', () => {
    expect(getSuggestedDataSourceName({
      draftRecord: { filenamePattern: 'saved' },
      previewLike: { filename: 'Other_2026-01.csv' },
    })).toBe('saved')
  })

  it('infers from the filename (stripping the date suffix) when no pattern is saved', () => {
    expect(getSuggestedDataSourceName({ draftRecord: { templateFilename: 'Acme_2026-03-15.csv' } })).toBe('Acme')
    expect(getSuggestedDataSourceName({ previewLike: { filename: 'Acme_2026-03-15.csv' } })).toBe('Acme')
  })
})
