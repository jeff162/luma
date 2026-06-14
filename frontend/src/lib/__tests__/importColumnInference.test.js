// CSV column inference decides how every imported file is read — date format, amount convention,
// and which column is the date/amount/merchant/etc. A silent regression here mis-maps real imports,
// so these pin the subtle, judgment-heavy behaviors: date-format disambiguation, the three amount
// conventions (including two-column exclusivity detection), filename-pattern stripping that lets a
// saved source match "same source, newer export", and the unambiguous-vs-best-guess distinction.

import { describe, it, expect } from 'vitest'
import {
  inferFilenamePattern,
  inferImportFileCharacteristicsFromPreview,
  inferImportMappingFromPreview,
  inferUnambiguousImportMappingFromPreview,
  DEFAULT_IMPORT_DATE_FORMAT,
} from '../importColumnInference.js'

function preview(headers, rows, extra = {}) {
  return { headers, rows, filename: 'acct.csv', header_fingerprint: 'fp', ...extra }
}

describe('inferFilenamePattern', () => {
  it('strips trailing date/sequence suffixes down to the stable base', () => {
    expect(inferFilenamePattern('Northgate_2026-03-15.csv')).toBe('Chase')
    expect(inferFilenamePattern('statement_20260315.csv')).toBe('statement')
    expect(inferFilenamePattern('export-2026-03.csv')).toBe('export')
  })

  it('leaves a suffix-free base alone and only drops the extension', () => {
    expect(inferFilenamePattern('Monthly Activity.csv')).toBe('Monthly Activity')
    expect(inferFilenamePattern('data.csv')).toBe('data')
  })

  it('returns empty for empty/missing input', () => {
    expect(inferFilenamePattern('')).toBe('')
    expect(inferFilenamePattern(null)).toBe('')
  })
})

describe('date format inference', () => {
  it('detects ISO yyyy-mm-dd', () => {
    const p = preview(['Date', 'Amount'], [
      { Date: '2026-03-01', Amount: '-5.00' },
      { Date: '2026-03-02', Amount: '-6.00' },
      { Date: '2026-03-03', Amount: '-7.00' },
    ])
    expect(inferImportFileCharacteristicsFromPreview(p).dateFormat).toBe('%Y-%m-%d')
  })

  it('disambiguates US month-first when a day value exceeds 12', () => {
    const p = preview(['Date', 'Amount'], [
      { Date: '03/15/2026', Amount: '-5.00' },
      { Date: '04/20/2026', Amount: '-6.00' },
    ])
    expect(inferImportFileCharacteristicsFromPreview(p).dateFormat).toBe('%m/%d/%Y')
  })

  it('falls back to the default format when no date column is recognizable', () => {
    const p = preview(['Memo', 'Amount'], [
      { Memo: 'x', Amount: '-5.00' },
      { Memo: 'y', Amount: '-6.00' },
    ])
    expect(inferImportFileCharacteristicsFromPreview(p).dateFormat).toBe(DEFAULT_IMPORT_DATE_FORMAT)
  })
})

describe('amount convention inference', () => {
  it('a single signed amount column → single_signed', () => {
    const p = preview(['Date', 'Amount'], [
      { Date: '2026-03-01', Amount: '-5.00' },
      { Date: '2026-03-02', Amount: '12.34' },
    ])
    expect(inferImportFileCharacteristicsFromPreview(p).amountConvention).toBe('single_signed')
  })

  it('two debit/credit columns populated one-per-row → two_column', () => {
    const p = preview(['Date', 'Debit', 'Credit'], [
      { Date: '2026-03-01', Debit: '5.00', Credit: '' },
      { Date: '2026-03-02', Debit: '', Credit: '10.00' },
      { Date: '2026-03-03', Debit: '7.50', Credit: '' },
    ])
    expect(inferImportFileCharacteristicsFromPreview(p).amountConvention).toBe('two_column')
  })

  it('an amount column plus a direction column → single_unsigned', () => {
    const p = preview(['Date', 'Amount', 'Type'], [
      { Date: '2026-03-01', Amount: '5.00', Type: 'debit' },
      { Date: '2026-03-02', Amount: '10.00', Type: 'credit' },
      { Date: '2026-03-03', Amount: '7.00', Type: 'debit' },
    ])
    expect(inferImportFileCharacteristicsFromPreview(p).amountConvention).toBe('single_unsigned')
  })
})

describe('column mapping', () => {
  it('best-guess maps a typical Date/Description/Amount file', () => {
    const p = preview(['Date', 'Description', 'Amount'], [
      { Date: '2026-03-01', Description: 'WHOLE FOODS', Amount: '-5.00' },
      { Date: '2026-03-02', Description: 'STARBUCKS', Amount: '-6.00' },
    ])
    const map = inferImportMappingFromPreview(p).columnMap
    expect(map.date).toBe('Date')
    expect(map.description).toBe('Description')
    expect(map.amount).toBe('Amount')
  })

  it('unambiguous mapping declines to auto-pick when 2+ columns tie, but best-guess still chooses', () => {
    const p = preview(['Posted Date', 'Transaction Date', 'Amount'], [
      { 'Posted Date': '2026-03-01', 'Transaction Date': '2026-03-01', Amount: '-5.00' },
      { 'Posted Date': '2026-03-02', 'Transaction Date': '2026-03-02', Amount: '-6.00' },
    ])
    expect(inferUnambiguousImportMappingFromPreview(p).columnMap.date).toBe('')
    expect(inferImportMappingFromPreview(p).columnMap.date).not.toBe('')
  })

  it('returns safe defaults for an empty preview', () => {
    expect(inferImportFileCharacteristicsFromPreview({}).amountConvention).toBe('single_signed')
    expect(inferImportMappingFromPreview({}).columnMap.date).toBe('')
  })
})
