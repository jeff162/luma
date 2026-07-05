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
  classifyEvidenceColumnShape,
  computeEvidenceColumnOptions,
  defaultEvidenceColumns,
  headerMatchesEvidenceKeyword,
  EVIDENCE_COLUMN_SHAPE,
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

describe('evidence-column capture inference', () => {
  it('classifies a low-cardinality repeated column as categorical', () => {
    const samples = [
      ...Array(13).fill('Bank Deposit to PP Account'),
      ...Array(13).fill('General Withdrawal'),
      ...Array(10).fill('Mobile Payment'),
    ]
    expect(classifyEvidenceColumnShape(samples)).toBe(EVIDENCE_COLUMN_SHAPE.CATEGORICAL)
  })

  it('classifies an all-distinct word-like column as free text', () => {
    const samples = Array.from({ length: 9 }, (_, n) => `Order item number ${n}`)
    expect(classifyEvidenceColumnShape(samples)).toBe(EVIDENCE_COLUMN_SHAPE.FREE_TEXT)
  })

  it('classifies near-unique code values as an identifier', () => {
    const samples = Array.from({ length: 12 }, (_, n) => `5AB${n}23CD${n}78`)
    expect(classifyEvidenceColumnShape(samples)).toBe(EVIDENCE_COLUMN_SHAPE.IDENTIFIER)
  })

  it('classifies numeric, date, and time-of-day columns by their value shape', () => {
    expect(classifyEvidenceColumnShape(['1,024.18', '-5.00', '42.10', '7.99'])).toBe(EVIDENCE_COLUMN_SHAPE.NUMBER)
    expect(classifyEvidenceColumnShape(['2026-01-01', '2026-01-02', '2026-01-03'])).toBe(EVIDENCE_COLUMN_SHAPE.DATE)
    expect(classifyEvidenceColumnShape(['05:04:19', '08:11:25', '13:27:49', '9:05 PM'])).toBe(EVIDENCE_COLUMN_SHAPE.DATE)
    expect(classifyEvidenceColumnShape(['', '', ''])).toBe(EVIDENCE_COLUMN_SHAPE.EMPTY)
  })

  it('matches descriptive header keywords', () => {
    expect(headerMatchesEvidenceKeyword('Memo')).toBe(true)
    expect(headerMatchesEvidenceKeyword('Original Statement')).toBe(true)
    expect(headerMatchesEvidenceKeyword('Item Title')).toBe(false)
    expect(headerMatchesEvidenceKeyword('Amount')).toBe(false)
  })

  it('surfaces only unmapped columns and pre-checks capturable ones', () => {
    const rows = []
    for (let n = 0; n < 6; n += 1) {
      rows.push({
        Date: `2026-01-0${n + 1}`,
        Amount: `${10 + n}.00`,
        Name: `Party ${n}`,
        Type: n % 2 === 0 ? 'Bank Deposit' : 'General Withdrawal',
        'Item Title': `Item ${n}`,
        'Transaction ID': `5AB${n}23CD${n}78`,
      })
    }
    const p = preview(['Date', 'Amount', 'Name', 'Type', 'Item Title', 'Transaction ID'], rows)
    const options = computeEvidenceColumnOptions(p, ['Date', 'Amount', 'Name'])
    const byHeader = Object.fromEntries(options.map(o => [o.header, o]))

    // Mapped columns are not offered for capture.
    expect(byHeader.Date).toBeUndefined()
    expect(byHeader.Name).toBeUndefined()
    // Only free text is pre-checked; categorical and identifier are offered but off by default.
    expect(byHeader['Item Title'].shape).toBe(EVIDENCE_COLUMN_SHAPE.FREE_TEXT)
    expect(byHeader.Type.shape).toBe(EVIDENCE_COLUMN_SHAPE.CATEGORICAL)
    expect(byHeader['Transaction ID'].shape).toBe(EVIDENCE_COLUMN_SHAPE.IDENTIFIER)
    expect(defaultEvidenceColumns(options)).toEqual(['Item Title'])
  })

  it('classifies from whole-file preview stats so a sparse column is not read as empty', () => {
    // Item Title is populated in only 2 of the first 10 sample rows and is absent from `rows`, but the
    // preview's whole-file stats know it has real text values — it must still be recognized (free text,
    // pre-checked), while the always-present low-value columns stay off by default.
    const rows = Array.from({ length: 10 }, (_, n) => ({
      Name: `Party ${n}`, Type: n % 2 ? 'General Payment' : 'Bank Deposit', Status: n % 2 ? 'Pending' : 'Completed', 'Item Title': '', Time: `0${n}:11:25`,
    }))
    const p = preview(['Name', 'Type', 'Status', 'Item Title', 'Time'], rows, {
      column_value_counts: {
        Name: { 'Party 0': 1, 'Party 1': 1 },
        Type: { 'General Payment': 8, 'Bank Deposit': 7, 'Express Checkout': 6, Refund: 5, 'Card Deposit': 5, Withdrawal: 4, Fee: 4 },
        Status: { Completed: 30, Pending: 9 },
        'Item Title': { 'Pats Tix': 1, 'Ho Jeff please resend': 1, Burlington: 1 },
        Time: { '05:04:19': 1, '08:11:25': 1, '13:27:49': 1, '21:05:00': 1 },
      },
      column_distinct_meta: {
        Name: { total_count: 12 },
        Type: { total_count: 9 },
        Status: { total_count: 2 },
        'Item Title': { total_count: 3 },
        Time: { total_count: 4 },
      },
    })
    const options = computeEvidenceColumnOptions(p, ['Name'])
    const byHeader = Object.fromEntries(options.map(o => [o.header, o]))
    expect(byHeader['Item Title'].shape).toBe(EVIDENCE_COLUMN_SHAPE.FREE_TEXT)
    expect(byHeader.Type.shape).toBe(EVIDENCE_COLUMN_SHAPE.CATEGORICAL)
    expect(byHeader.Status.shape).toBe(EVIDENCE_COLUMN_SHAPE.CATEGORICAL)
    expect(byHeader.Time.shape).toBe(EVIDENCE_COLUMN_SHAPE.DATE)
    // Informative categorical (Type, 9 distinct) is pre-checked; a near-constant one (Status, 2) is not.
    // Ordered highest value first: free text, then informative categorical.
    expect(defaultEvidenceColumns(options)).toEqual(['Item Title', 'Type'])
  })

  it('orders options highest capture value first', () => {
    const rows = Array.from({ length: 12 }, (_, n) => ({
      TxnID: `5AB${n}23CD${n}78`,
      Amount: `${10 + n}.00`,
      Status: n % 2 ? 'Pending' : 'Completed',
      Type: ['A', 'B', 'C', 'D'][n % 4],
      Memo: `note ${n}`,
      'Item Title': n < 2 ? `Thing ${n}` : '',
    }))
    const p = preview(['TxnID', 'Amount', 'Status', 'Type', 'Memo', 'Item Title'], rows)
    const order = computeEvidenceColumnOptions(p, []).map(o => o.header)
    // Free text (Item Title) and keyword (Memo) first, then informative categorical (Type, 5),
    // then low-value categorical (Status, 2), then identifier (TxnID), then number (Amount).
    expect(order.indexOf('Item Title')).toBeLessThan(order.indexOf('Type'))
    expect(order.indexOf('Memo')).toBeLessThan(order.indexOf('Type'))
    expect(order.indexOf('Type')).toBeLessThan(order.indexOf('Status'))
    expect(order.indexOf('Status')).toBeLessThan(order.indexOf('TxnID'))
    expect(order.indexOf('TxnID')).toBeLessThan(order.indexOf('Amount'))
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
