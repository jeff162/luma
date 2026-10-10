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
  importColumnDelta,
  findProfilesMatchingPreview,
  getSuggestedDataSourceName,
  groupFilesBySource,
  unionPreviewColumnValues,
  keepMappingsForAbsentColumns,
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
        enrich_from_source: true,
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
    // Every per-source toggle must survive the save: an omitted field falls back to the API's default,
    // so the next file recognized as this source silently comes back with the box unchecked.
    expect(body.enrich_from_source).toBe(true)
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

describe('findProfilesMatchingPreview', () => {
  const profiles = [
    { id: 'a', name: 'A', header_fingerprint: 'fp1' },
    { id: 'b', name: 'B', header_fingerprint: 'fp2' },
    { id: 'c', name: 'C', header_fingerprint: 'fp1' },
    { id: 'd', name: 'D (no fingerprint)', header_fingerprint: '' },
  ]

  it('returns every saved source whose header fingerprint matches the file', () => {
    const matches = findProfilesMatchingPreview({ header_fingerprint: 'fp1' }, profiles)
    expect(matches.map(p => p.id)).toEqual(['a', 'c'])
  })

  it('returns nothing when no source matches', () => {
    expect(findProfilesMatchingPreview({ header_fingerprint: 'zzz' }, profiles)).toEqual([])
  })

  it('never matches on absent fingerprints (file or profile)', () => {
    // A file with no fingerprint matches nothing, even a profile that also lacks one.
    expect(findProfilesMatchingPreview({ header_fingerprint: '' }, profiles)).toEqual([])
    expect(findProfilesMatchingPreview({}, profiles)).toEqual([])
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

describe('groupFilesBySource', () => {
  const profiles = [
    { id: 'p-riverstone', name: 'Riverstone', header_fingerprint: 'fp-riverstone' },
    { id: 'p-northgate', name: 'Northgate', header_fingerprint: 'fp-northgate' },
    { id: 'p-alt', name: 'Riverstone (alt)', header_fingerprint: 'fp-riverstone' }, // same shape as Riverstone -> ambiguous
  ]
  const entry = (name, fingerprint) => ({
    file: { name },
    preview: { filename: name, header_fingerprint: fingerprint },
  })

  it('groups same-fingerprint files into one group labeled by the matched source', () => {
    const groups = groupFilesBySource(
      [entry('Northgate_01.csv', 'fp-northgate'), entry('Northgate_02.csv', 'fp-northgate')],
      [profiles[1]],
    )
    expect(groups).toHaveLength(1)
    expect(groups[0].files.map(f => f.file.name)).toEqual(['Northgate_01.csv', 'Northgate_02.csv'])
    expect(groups[0].profileId).toBe('p-northgate')
    expect(groups[0].label).toBe('Northgate')
    expect(groups[0].ambiguous).toBe(false)
  })

  it('splits distinct sources into separate groups, first-seen order preserved', () => {
    const groups = groupFilesBySource(
      [entry('Northgate_01.csv', 'fp-northgate'), entry('Riverstone_01.csv', 'fp-riverstone'), entry('Northgate_02.csv', 'fp-northgate')],
      [profiles[0], profiles[1]],
    )
    expect(groups.map(g => g.fingerprint)).toEqual(['fp-northgate', 'fp-riverstone'])
    expect(groups[0].files).toHaveLength(2) // both Northgate files, even though Riverstone came between them
    expect(groups[1].files).toHaveLength(1)
  })

  it('labels an unmatched shape as an unknown source, using the filename suggestion', () => {
    const groups = groupFilesBySource([entry('Venmo_2026-01.csv', 'fp-venmo')], profiles)
    expect(groups[0].profileId).toBeNull()
    expect(groups[0].matchedProfiles).toEqual([])
    expect(groups[0].label).toBe('Venmo')
  })

  it('flags a shape that matches several saved sources as ambiguous', () => {
    const groups = groupFilesBySource([entry('Riverstone_01.csv', 'fp-riverstone')], profiles)
    expect(groups[0].ambiguous).toBe(true)
    expect(groups[0].profileId).toBeNull()
    expect(groups[0].label).toBe('Riverstone, Riverstone (alt)')
  })

  it('never merges files it could not fingerprint', () => {
    const groups = groupFilesBySource([entry('a.csv', ''), entry('b.csv', '')], profiles)
    expect(groups).toHaveLength(2)
  })
})

describe('unionPreviewColumnValues', () => {
  const preview = (distinct, counts) => ({
    column_distinct_values: { Account: distinct },
    column_value_counts: { Account: counts },
  })

  it('unions distinct values across files, first-seen order, no duplicates', () => {
    const { values } = unionPreviewColumnValues(
      [preview(['CHK', 'SAV'], {}), preview(['SAV', 'BIZ'], {})],
      'Account',
    )
    // The account value BIZ appears only in the second file — it must still surface.
    expect(values).toEqual(['CHK', 'SAV', 'BIZ'])
  })

  it('sums the per-value counts across files', () => {
    const { counts } = unionPreviewColumnValues(
      [preview(['CHK'], { CHK: 3 }), preview(['CHK'], { CHK: 5 })],
      'Account',
    )
    expect(counts).toEqual({ CHK: 8 })
  })

  it('is a no-op without a column, and degrades to a single preview', () => {
    expect(unionPreviewColumnValues([preview(['CHK'], {})], null)).toEqual({ values: [], counts: {} })
    expect(unionPreviewColumnValues([preview(['CHK'], { CHK: 2 })], 'Account'))
      .toEqual({ values: ['CHK'], counts: { CHK: 2 } })
  })
})


describe('importColumnDelta', () => {
  const source = { header_fingerprint: 'Date|Merchant|Amount|Account' }

  it('names the column a vendor added, which is the case the source has to be told about', () => {
    expect(importColumnDelta(source, { header_fingerprint: 'Date|Merchant|Amount|Account|Id' }))
      .toEqual({ added: ['Id'], removed: [] })
  })

  it('names a column that is gone, since a mapping may still point at it', () => {
    expect(importColumnDelta(source, { header_fingerprint: 'Date|Merchant|Amount' }))
      .toEqual({ added: [], removed: ['Account'] })
  })

  it('reports nothing for a reordered header — the same columns are the same layout', () => {
    expect(importColumnDelta(source, { header_fingerprint: 'Account|Amount|Merchant|Date' }))
      .toEqual({ added: [], removed: [] })
  })

  it('reports nothing when either side has no fingerprint to compare', () => {
    expect(importColumnDelta({}, { header_fingerprint: 'Date|Amount' })).toEqual({ added: [], removed: [] })
    expect(importColumnDelta(source, null)).toEqual({ added: [], removed: [] })
  })
})

describe('keepMappingsForAbsentColumns', () => {
  // The source learned a transaction-ID column from a newer export; then an older export without it is
  // imported. Saving the source afterwards must not un-map the column, or the next current file would
  // arrive with no ids and nothing would say why.
  const stored = { date: 'Date', description: 'Merchant', amount: 'Amount', transaction_id: 'Id' }

  it('keeps a mapping whose column the file does not carry', () => {
    const fromOlderFile = { date: 'Date', description: 'Merchant', amount: 'Amount', transaction_id: null }
    expect(keepMappingsForAbsentColumns(fromOlderFile, stored, ['Date', 'Merchant', 'Amount']).transaction_id)
      .toBe('Id')
  })

  it('lets the user clear a mapping whose column the file does carry', () => {
    const cleared = { date: 'Date', description: 'Merchant', amount: 'Amount', transaction_id: null }
    expect(keepMappingsForAbsentColumns(cleared, stored, ['Date', 'Merchant', 'Amount', 'Id']).transaction_id)
      .toBeNull()
  })

  it('takes a new mapping over the stored one', () => {
    const remapped = { ...stored, transaction_id: 'Transaction ID' }
    expect(keepMappingsForAbsentColumns(remapped, stored, ['Date', 'Merchant', 'Amount', 'Transaction ID']).transaction_id)
      .toBe('Transaction ID')
  })
})
