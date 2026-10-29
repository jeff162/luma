// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * Shared CSV-header inference keeps the import mapping page and saved data source editor in sync about how
 * we recognize dates, amounts, merchant columns, and file fingerprints from a previewed CSV.
 */

export const DEFAULT_IMPORT_DATE_FORMAT = '%m/%d/%Y'
export const DEFAULT_DECIMAL_SEPARATOR = 'point'

export function inferFilenamePattern(filename) {
  let base = String(filename || '')
    .replace(/\.[^.]+$/, '')
    .trim()
  if (!base) return ''

  // Providers often append dates or export sequence suffixes to an otherwise
  // stable base filename. Strip those trailing patterns iteratively so saved
  // data sources can match "same source, newer export" without overfitting.
  const separator = '[-_ ]'
  const monthToken = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)'
  const trailingPatterns = [
    new RegExp(`(?:${separator}+\\d{4}${separator}${monthToken}${separator}\\d{1,2}(?:${separator}\\d{4}(?:${separator}${monthToken}${separator}\\d{1,2})?)?(?:${separator}[a-z]{2,6})?)$`, 'i'),
    new RegExp(`(?:${separator}+${monthToken}${separator}\\d{1,2}${separator}\\d{4}(?:${separator}${monthToken}${separator}\\d{1,2}${separator}\\d{4})?(?:${separator}[a-z]{2,6})?)$`, 'i'),
    new RegExp(`(?:${separator}+\\d{4}(?:${separator}\\d{2}){2}(?:T\\d{2}(?:[-_:]?\\d{2}){0,2})?)$`, 'i'),
    new RegExp(`(?:${separator}+\\d{4}(?:${separator}\\d{2}){2}T)$`, 'i'),
    new RegExp(`(?:${separator}+\\d{4}(?:${separator}\\d{2}){0,2})$`, 'i'),
    new RegExp(`(?:${separator}+\\d{8})$`, 'i'),
    new RegExp(`(?:${separator}+\\d{6,})$`, 'i'),
  ]

  let changed = true
  while (changed) {
    changed = false
    for (const pattern of trailingPatterns) {
      const next = base.replace(pattern, '').trim()
      if (next !== base) {
        base = next.replace(/[-_ ]+$/, '').trim()
        changed = true
      }
    }
  }

  return base
}

export function normalizeImportHeaderName(header) {
  return String(header || '').trim().toLowerCase()
}

function parseIntegerWithinRange(value, min, max) {
  if (!/^\d{1,4}$/.test(value)) return null
  const parsed = Number(value)
  return parsed >= min && parsed <= max ? parsed : null
}

function getDateCandidatesFromSample(value) {
  const sample = String(value || '').trim()
  if (!sample) return []

  let match = sample.match(/^(\d{4})([/-])(\d{1,2})\2(\d{1,2})$/)
  if (match) {
    const month = parseIntegerWithinRange(match[3], 1, 12)
    const day = parseIntegerWithinRange(match[4], 1, 31)
    if (month && day) {
      return [match[2] === '-' ? '%Y-%m-%d' : '%Y/%m/%d']
    }
  }

  match = sample.match(/^(\d{1,2})([/-])(\d{1,2})\2(\d{4})$/)
  if (match) {
    const first = parseIntegerWithinRange(match[1], 1, 31)
    const second = parseIntegerWithinRange(match[3], 1, 31)
    const sep = match[2]
    if (!first || !second) return []
    const monthFirstFormat = sep === '-' ? '%m-%d-%Y' : '%m/%d/%Y'
    const dayFirstFormat = sep === '-' ? '%d-%m-%Y' : '%d/%m/%Y'
    if (first > 12 && second <= 12) return [dayFirstFormat]
    if (second > 12 && first <= 12) return [monthFirstFormat]
    const candidates = []
    if (first <= 12) candidates.push(monthFirstFormat)
    if (second <= 12) candidates.push(dayFirstFormat)
    return candidates
  }

  if (/^[A-Za-z]{3}\s+\d{1,2},\s*\d{4}$/.test(sample)) return ['%b %d, %Y']
  if (/^[A-Za-z]{3}-\d{1,2}-\d{4}$/.test(sample)) return ['%b-%d-%Y']
  return []
}

function analyzeDateSamples(values) {
  const scores = new Map()
  let matchedCount = 0
  let decisiveCount = 0

  values.forEach(value => {
    const candidates = getDateCandidatesFromSample(value)
    if (!candidates.length) return
    matchedCount += 1
    if (candidates.length === 1) decisiveCount += 1
    candidates.forEach(candidate => scores.set(candidate, (scores.get(candidate) || 0) + 1))
  })

  const rankedFormats = [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([format]) => format)

  return {
    matchedCount,
    decisiveCount,
    rankedFormats,
    guessedFormat: rankedFormats[0] || null,
  }
}

// The same grammar the backend reads a number by (`services/amount_text.py`): a currency symbol,
// whitespace, a sign, accounting parentheses and a DR/CR suffix around a number written in one of the two
// decimal conventions. The backend's parse is the authority; this only recognizes amount columns and
// suggests which convention a file uses.
const NUMBER_BY_DECIMAL_SEPARATOR = {
  point: /^(?:\d{1,3}(?:,\d{3})+|\d+)?(?:\.\d*)?$/,
  comma: /^(?:\d{1,3}(?:\.\d{3})+|\d+)?(?:,\d*)?$/,
}

function amountSampleNumber(value) {
  const compact = String(value || '').replace(/[\s\p{Sc}]/gu, '').replace(/(?:CR|DR)$/i, '')
  const match = compact.match(/^[+\-\u2212]?([\d.,]+)$/) || compact.match(/^\(([\d.,]+)\)$/)
  return match && /\d/.test(match[1]) ? match[1] : null
}

function amountSampleSeparators(value) {
  const number = amountSampleNumber(value)
  if (!number) return []
  return Object.keys(NUMBER_BY_DECIMAL_SEPARATOR).filter(separator => NUMBER_BY_DECIMAL_SEPARATOR[separator].test(number))
}

function looksLikeAmountSample(value) {
  return amountSampleSeparators(value).length > 0
}

// A sample decides only when it reads in exactly one convention: `12,50` and `1,234.56` do, while
// `1,234` and `1.234` read in both and say nothing. The majority of deciding samples wins, and with
// none the file is no evidence either way.
function guessDecimalSeparator(values) {
  const votes = { point: 0, comma: 0 }
  values.forEach(value => {
    const separators = amountSampleSeparators(value)
    if (separators.length === 1) votes[separators[0]] += 1
  })
  if (!votes.point && !votes.comma) return null
  return votes.comma > votes.point ? 'comma' : 'point'
}

export function guessDecimalSeparatorForColumns(preview, headers, skipRows = 0) {
  const columnSamples = buildColumnSamples(preview, skipRows)
  return guessDecimalSeparator(headers.filter(Boolean).flatMap(header => columnSamples[header] || []))
}

function analyzeAmountSamples(values) {
  const styles = {
    accounting: 0,
    currency: 0,
    trailingCode: 0,
    signed: 0,
    plain: 0,
  }

  values.forEach(value => {
    const sample = String(value || '').trim()
    if (!looksLikeAmountSample(sample)) return
    if (/^\(.*\)$/.test(sample)) styles.accounting += 1
    else if (/(CR|DR)$/i.test(sample)) styles.trailingCode += 1
    else if (/^[+\-\u2212]/.test(sample)) styles.signed += 1
    else if (/\p{Sc}/u.test(sample)) styles.currency += 1
    else styles.plain += 1
  })

  const ranked = Object.entries(styles).sort((a, b) => b[1] - a[1])
  const [topStyle, topCount] = ranked[0] || [null, 0]
  const labels = {
    accounting: 'Detected accounting-style negatives.',
    currency: 'Detected currency amounts.',
    trailingCode: 'Detected trailing CR/DR amounts.',
    signed: 'Detected signed amounts.',
    plain: 'Detected plain numeric amounts.',
  }

  return {
    guessedStyle: topCount > 0 ? topStyle : null,
    guessedLabel: topCount > 0 ? labels[topStyle] : null,
  }
}

function looksLikeDirectionSample(value) {
  const normalized = String(value || '').trim().toLowerCase()
  return ['credit', 'debit', 'cr', 'dr', 'deposit', 'withdrawal', 'payment', 'incoming', 'outgoing'].includes(normalized)
}

function looksLikePendingSample(value) {
  const normalized = String(value || '').trim().toLowerCase()
  return ['pending', 'posted', 'cleared', 'complete', 'completed', 'final', 'finalized', 'finalised', 'true', 'false', 'yes', 'no', 'y', 'n', '1', '0', 'p'].includes(normalized)
}

function scoreHeaderName(header, type) {
  const normalized = normalizeImportHeaderName(header)
  if (!normalized) return 0

  const tests = {
    date: ['date', 'posted', 'trans date', 'transaction date', 'post date'],
    amount: ['amount', 'amt', 'value'],
    merchant: ['merchant', 'payee', 'description', 'desc'],
    category: ['category', 'cat', 'classification', 'type'],
    notes: ['notes', 'note', 'memo', 'comment', 'comments'],
    account: ['account', 'acct'],
    debit: ['debit', 'withdrawal', 'outflow', 'payment', 'charge'],
    credit: ['credit', 'deposit', 'inflow', 'refund'],
    direction: ['type', 'direction', 'dr/cr', 'transaction type'],
    pending: ['pending', 'is pending', 'pending status', 'posted', 'cleared'],
    currency: ['currency', 'ccy'],
  }

  return (tests[type] || []).reduce((score, token) => score + (normalized.includes(token) ? 1 : 0), 0)
}

// A source's own row identifier, recognized by an exact header name only: a substring test would claim
// the many identifier columns that are not the transaction's own (a receipt id, an order id, the id of
// the transaction a refund refers to). Lower-case, as `normalizeImportHeaderName` leaves it.
const TRANSACTION_ID_HEADER_NAMES = new Set(['id', 'transaction id', 'transaction_id', 'transactionid', 'txn id', 'fitid'])

function isTransactionIdHeader(header) {
  return TRANSACTION_ID_HEADER_NAMES.has(normalizeImportHeaderName(header))
}

export function formatLikelyMatchLabel(count) {
  if (!count) return ''
  return `${count} likely ${count === 1 ? 'match' : 'matches'}`
}

// Header keywords that mark a column as descriptive free text worth capturing into import evidence —
// the visible, adjustable mirror of the backend IMPORT_EVIDENCE_HEADER_KEYWORDS zero-effort default.
// Keep in sync with backend/routers/import_export/core.py.
const IMPORT_EVIDENCE_HEADER_KEYWORDS = [
  'original statement', 'statement', 'memo', 'details', 'detail', 'reference', 'ref', 'payee',
  'merchant', 'description', 'note', 'narrative', 'particulars', 'remittance', 'comment', 'purpose',
  'counterparty', 'beneficiary', 'originator',
]

export function headerMatchesEvidenceKeyword(header) {
  const normalized = String(header || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (!normalized) return false
  return IMPORT_EVIDENCE_HEADER_KEYWORDS.some(keyword => normalized.includes(keyword))
}

// The shape we infer for an unmapped column, which drives its default capture state and the label the
// user sees. Only free text is descriptive detail worth capturing by default; categorical vocabularies
// (transaction type/status/currency) are offered but off by default — in practice they're low value and
// noisy as suggestions. Number/date/time belong to mapping; identifiers and empties add no recognition
// value. The descriptive-vs-categorical split still mirrors the backend cardinality classifier (which
// uses it to gate the duplicate matcher), but the *default capture* decision is intentionally narrower.
export const EVIDENCE_COLUMN_SHAPE = {
  EMPTY: 'empty',
  NUMBER: 'number',
  DATE: 'date',
  IDENTIFIER: 'identifier',
  CATEGORICAL: 'categorical',
  FREE_TEXT: 'free_text',
}

const EVIDENCE_CATEGORICAL_MAX_DISTINCT = 12
const EVIDENCE_CATEGORICAL_MAX_DISTINCT_RATIO = 0.5
const EVIDENCE_CATEGORICAL_MIN_REPEATS = 2
const EVIDENCE_IDENTIFIER_MIN_DISTINCT_RATIO = 0.9
// A categorical column is worth auto-suggesting only when its vocabulary actually classifies
// transactions. A near-constant column (Currency = 1 value, Status/TimeZone = 2) carries almost no
// per-row information; a real vocabulary (a PayPal "Type" with ~9 kinds) does. The distinct count is
// the signal — 4+ distinct values is a genuine vocabulary, binary/ternary flags are not.
const EVIDENCE_INFORMATIVE_CATEGORICAL_MIN_DISTINCT = 4

function looksLikeCodeSample(value) {
  const sample = String(value || '').trim()
  if (!sample || /\s/.test(sample)) return false
  return /\d/.test(sample) || (sample.length >= 10 && /^[A-Za-z0-9._-]+$/.test(sample))
}

function looksLikeTimeOfDaySample(value) {
  return /^\d{1,2}:\d{2}(:\d{2})?(\.\d+)?\s*([AaPp][Mm])?$/.test(String(value || '').trim())
}

function looksLikeTemporalSample(value) {
  return getDateCandidatesFromSample(value).length > 0 || looksLikeTimeOfDaySample(value)
}

/*
 * Classify a column from whole-file cardinality stats: `nonemptyCount` (rows with a value),
 * `distinctCount` (distinct values across the whole file), and `values` (a representative set of the
 * actual value strings, for numeric/date/time/code sniffing). Preferring file-wide stats over a small
 * row sample is what lets a *sparse* descriptive column (e.g. PayPal "Item Title", populated in a
 * handful of rows) be recognized instead of read as empty.
 */
export function classifyEvidenceColumnShapeFromStats({ nonemptyCount = 0, distinctCount = 0, values = [] } = {}) {
  const n = nonemptyCount
  if (!n) return EVIDENCE_COLUMN_SHAPE.EMPTY
  const d = Math.max(distinctCount, 1)
  const sample = (values || []).map(value => String(value ?? '').trim()).filter(Boolean)
  if (sample.length) {
    if (sample.filter(looksLikeAmountSample).length / sample.length >= 0.7) return EVIDENCE_COLUMN_SHAPE.NUMBER
    if (sample.filter(looksLikeTemporalSample).length / sample.length >= 0.7) return EVIDENCE_COLUMN_SHAPE.DATE
  }
  if (d <= EVIDENCE_CATEGORICAL_MAX_DISTINCT && (n - d) >= EVIDENCE_CATEGORICAL_MIN_REPEATS && (d / n) <= EVIDENCE_CATEGORICAL_MAX_DISTINCT_RATIO) {
    return EVIDENCE_COLUMN_SHAPE.CATEGORICAL
  }
  if ((d / n) >= EVIDENCE_IDENTIFIER_MIN_DISTINCT_RATIO && sample.length && sample.filter(looksLikeCodeSample).length / sample.length >= 0.6) {
    return EVIDENCE_COLUMN_SHAPE.IDENTIFIER
  }
  return EVIDENCE_COLUMN_SHAPE.FREE_TEXT
}

export function classifyEvidenceColumnShape(samples) {
  const nonempty = (samples || []).map(value => String(value ?? '').trim()).filter(Boolean)
  const distinct = new Set(nonempty.map(value => value.toLowerCase()))
  return classifyEvidenceColumnShapeFromStats({ nonemptyCount: nonempty.length, distinctCount: distinct.size, values: nonempty })
}

// Whole-file cardinality for a column from the preview payload's per-column stats (computed over every
// row server-side), or null when unavailable so the caller falls back to the row sample. `total_count`
// is the true distinct count even when the displayed value list is capped.
function evidenceColumnStatsFromPreview(preview, header) {
  const counts = preview?.column_value_counts?.[header]
  const meta = preview?.column_distinct_meta?.[header]
  if (!counts || !meta) return null
  const values = Object.keys(counts)
  const nonemptyCount = Object.values(counts).reduce((sum, count) => sum + (Number(count) || 0), 0)
  const distinctCount = Number.isFinite(meta.total_count) ? meta.total_count : values.length
  // nonempty can only be under-counted if the value list was capped, and such a column is high-
  // cardinality anyway; keep nonempty >= distinct so the ratios stay well-defined.
  return { nonemptyCount: Math.max(nonemptyCount, distinctCount), distinctCount, values }
}

// Column cardinality from whichever source is best: the preview's whole-file stats (preferred, so a
// sparse column isn't judged on the first 10 rows) or the row sample as a fallback.
function evidenceColumnStats(preview, header, columnSamples) {
  const fromPreview = evidenceColumnStatsFromPreview(preview, header)
  if (fromPreview) return fromPreview
  const nonempty = columnSamples[header] || []
  const distinct = new Set(nonempty.map(value => value.toLowerCase()))
  return { nonemptyCount: nonempty.length, distinctCount: distinct.size, values: nonempty }
}

// Capture-value rank for ordering the panel (lower = higher value = shown first). This is our value
// judgment made explicit: descriptive free text first, then a real (informative) categorical vocabulary
// or a keyword-headed column, then near-constant categoricals, identifiers, numbers, dates, and finally
// empties. Columns of equal rank keep file order (the sort is stable).
function evidenceOptionSortRank(option) {
  if (option.shape === EVIDENCE_COLUMN_SHAPE.FREE_TEXT) return 0
  if (option.keyword) return 1
  if (option.shape === EVIDENCE_COLUMN_SHAPE.CATEGORICAL && option.distinctCount >= EVIDENCE_INFORMATIVE_CATEGORICAL_MIN_DISTINCT) return 1
  if (option.shape === EVIDENCE_COLUMN_SHAPE.CATEGORICAL) return 2
  if (option.shape === EVIDENCE_COLUMN_SHAPE.IDENTIFIER) return 3
  if (option.shape === EVIDENCE_COLUMN_SHAPE.NUMBER) return 4
  if (option.shape === EVIDENCE_COLUMN_SHAPE.DATE) return 5
  return 6
}

/*
 * The capture-panel options: every file column NOT already mapped to a transaction field, with its
 * inferred shape, distinct-value count, whether its header is a descriptive keyword, and whether it is
 * checked by default. Default = keyword-matched OR free text OR an *informative* categorical (a real
 * vocabulary, distinct >= EVIDENCE_INFORMATIVE_CATEGORICAL_MIN_DISTINCT — e.g. a PayPal "Type") — the
 * intelligent prefill that surfaces useful detail without a hard-coded keyword, while leaving low-value
 * near-constant categoricals (Status/Currency/TimeZone), identifiers, and numbers offered-but-unchecked.
 * Ordered highest capture value first (see evidenceOptionSortRank) so useful columns aren't buried.
 * Classification prefers the preview's whole-file stats and falls back to the row sample. `mappedHeaders`
 * is the set/array of headers consumed by the current column mapping.
 */
export function computeEvidenceColumnOptions(preview, mappedHeaders = [], skipRows = 0) {
  if (!preview?.headers?.length) return []
  const mapped = new Set(
    (Array.isArray(mappedHeaders) ? mappedHeaders : [...mappedHeaders])
      .map(header => String(header || '').trim())
      .filter(Boolean),
  )
  const columnSamples = buildColumnSamples(preview, skipRows)
  return preview.headers
    .map(header => String(header || '').trim())
    .filter(header => header && !mapped.has(header))
    .map(header => {
      const stats = evidenceColumnStats(preview, header, columnSamples)
      const shape = classifyEvidenceColumnShapeFromStats(stats)
      const keyword = headerMatchesEvidenceKeyword(header)
      const informativeCategorical = shape === EVIDENCE_COLUMN_SHAPE.CATEGORICAL
        && stats.distinctCount >= EVIDENCE_INFORMATIVE_CATEGORICAL_MIN_DISTINCT
      return {
        header,
        shape,
        keyword,
        distinctCount: stats.distinctCount,
        defaultChecked: keyword || shape === EVIDENCE_COLUMN_SHAPE.FREE_TEXT || informativeCategorical,
      }
    })
    .sort((a, b) => evidenceOptionSortRank(a) - evidenceOptionSortRank(b))
}

export function defaultEvidenceColumns(options) {
  return (options || []).filter(option => option.defaultChecked).map(option => option.header)
}

// Headers a recognized source always captures, regardless of the user's checkboxes. Mirrors the backend
// `_forced_evidence_headers`: for a PayPal file (`preview.is_paypal`), Type + Item Title. Returned as the
// actual header strings present in `options`, so the capture panel can show them checked-and-disabled.
const PAYPAL_FORCED_EVIDENCE = new Set(['type', 'item title'])
export function forcedEvidenceColumns(preview, options) {
  if (!preview?.is_paypal) return []
  return (options || [])
    .filter(option => PAYPAL_FORCED_EVIDENCE.has(String(option.header || '').trim().toLowerCase()))
    .map(option => option.header)
}

function buildColumnSamples(preview, skipRows = 0) {
  if (!preview?.headers?.length || !preview?.rows?.length) return {}
  const rows = preview.rows.slice(skipRows)
  return preview.headers.reduce((acc, header) => {
    acc[header] = rows
      .map(row => String(row?.[header] ?? '').trim())
      .filter(Boolean)
    return acc
  }, {})
}

export function analyzeImportColumns(preview, skipRows = 0) {
  if (!preview?.headers?.length) {
    return {
      dateCandidates: [],
      amountCandidates: [],
      merchantCandidates: [],
      categoryCandidates: [],
      notesCandidates: [],
      accountCandidates: [],
      debitCandidates: [],
      creditCandidates: [],
      directionCandidates: [],
      pendingCandidates: [],
      currencyCandidates: [],
      transactionIdCandidates: [],
      dateAnalysisByHeader: {},
      amountAnalysisByHeader: {},
    }
  }

  const columnSamples = buildColumnSamples(preview, skipRows)
  const analyses = {
    dateCandidates: [],
    amountCandidates: [],
    merchantCandidates: [],
    categoryCandidates: [],
    notesCandidates: [],
    accountCandidates: [],
    debitCandidates: [],
    creditCandidates: [],
    directionCandidates: [],
    pendingCandidates: [],
    currencyCandidates: [],
    transactionIdCandidates: [],
    dateAnalysisByHeader: {},
    amountAnalysisByHeader: {},
  }

  preview.headers.forEach(header => {
    const samples = columnSamples[header] || []
    const sampleCount = samples.length
    const headerBoostDate = scoreHeaderName(header, 'date')
    const dateAnalysis = analyzeDateSamples(samples)
    const dateScore = dateAnalysis.matchedCount + dateAnalysis.decisiveCount + (headerBoostDate * 2)
    analyses.dateAnalysisByHeader[header] = { ...dateAnalysis, sampleCount, score: dateScore }
    if ((sampleCount > 0 && dateAnalysis.matchedCount >= Math.max(2, Math.ceil(sampleCount * 0.6))) || headerBoostDate > 0) {
      analyses.dateCandidates.push({ header, score: dateScore })
    }

    const amountMatches = samples.filter(looksLikeAmountSample).length
    const amountRatio = sampleCount ? amountMatches / sampleCount : 0
    const amountBoost = scoreHeaderName(header, 'amount')
    const amountScore = amountMatches + (amountBoost * 2)
    const amountFormat = analyzeAmountSamples(samples)
    analyses.amountAnalysisByHeader[header] = { sampleCount, amountMatches, amountRatio, score: amountScore, ...amountFormat }
    if ((sampleCount > 0 && amountRatio >= 0.7) || amountBoost > 0) {
      analyses.amountCandidates.push({ header, score: amountScore })
    }

    const merchantBoost = scoreHeaderName(header, 'merchant')
    if (merchantBoost > 0) {
      analyses.merchantCandidates.push({ header, score: merchantBoost })
    }

    const categoryBoost = scoreHeaderName(header, 'category')
    if (categoryBoost > 0) {
      analyses.categoryCandidates.push({ header, score: categoryBoost })
    }

    const notesBoost = scoreHeaderName(header, 'notes')
    if (notesBoost > 0) {
      analyses.notesCandidates.push({ header, score: notesBoost })
    }

    const accountBoost = scoreHeaderName(header, 'account')
    if (accountBoost > 0) {
      analyses.accountCandidates.push({ header, score: accountBoost })
    }

    const debitBoost = scoreHeaderName(header, 'debit')
    const debitScore = amountMatches + (debitBoost * 3)
    if ((sampleCount > 0 && amountRatio >= 0.7 && debitBoost > 0) || debitBoost > 0) {
      analyses.debitCandidates.push({ header, score: debitScore })
    }

    const creditBoost = scoreHeaderName(header, 'credit')
    const creditScore = amountMatches + (creditBoost * 3)
    if ((sampleCount > 0 && amountRatio >= 0.7 && creditBoost > 0) || creditBoost > 0) {
      analyses.creditCandidates.push({ header, score: creditScore })
    }

    const directionMatches = samples.filter(looksLikeDirectionSample).length
    const directionRatio = sampleCount ? directionMatches / sampleCount : 0
    const directionBoost = scoreHeaderName(header, 'direction')
    const directionScore = directionMatches + (directionBoost * 2)
    if ((sampleCount > 0 && directionRatio >= 0.6) || directionBoost > 0) {
      analyses.directionCandidates.push({ header, score: directionScore })
    }

    const pendingMatches = samples.filter(looksLikePendingSample).length
    const pendingBoost = scoreHeaderName(header, 'pending')
    const pendingScore = pendingMatches + (pendingBoost * 2)
    if (pendingBoost > 0) {
      analyses.pendingCandidates.push({ header, score: pendingScore })
    }

    // By header alone: a column of ISO codes looks like any other short-code column, and a wallet export
    // that mixes currencies always names the column.
    const currencyBoost = scoreHeaderName(header, 'currency')
    if (currencyBoost > 0) {
      analyses.currencyCandidates.push({ header, score: currencyBoost })
    }

    if (isTransactionIdHeader(header)) {
      analyses.transactionIdCandidates.push({ header, score: 1 })
    }
  })

  for (const key of ['dateCandidates', 'amountCandidates', 'merchantCandidates', 'categoryCandidates', 'notesCandidates', 'accountCandidates', 'debitCandidates', 'creditCandidates', 'directionCandidates', 'pendingCandidates', 'currencyCandidates', 'transactionIdCandidates']) {
    analyses[key].sort((a, b) => b.score - a.score || a.header.localeCompare(b.header))
    analyses[key] = analyses[key].map(entry => entry.header)
  }

  return analyses
}

function detectTwoColumnAmountConvention(amountHeaders, previewRows) {
  if (amountHeaders.length < 2) return null

  let bestPair = null

  // Two-column debit/credit files usually populate exactly one side per row.
  // We look for that exclusivity pattern instead of trusting header names alone.
  for (let index = 0; index < amountHeaders.length; index += 1) {
    for (let compareIndex = index + 1; compareIndex < amountHeaders.length; compareIndex += 1) {
      const leftHeader = amountHeaders[index]
      const rightHeader = amountHeaders[compareIndex]
      const rowCount = previewRows.length
      if (!rowCount) continue

      let rowsWithEither = 0
      let rowsWithExactlyOne = 0
      for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
        const row = previewRows[rowIndex] || {}
        const leftHasAmount = looksLikeAmountSample(row[leftHeader] || '')
        const rightHasAmount = looksLikeAmountSample(row[rightHeader] || '')
        if (!leftHasAmount && !rightHasAmount) continue
        rowsWithEither += 1
        if ((leftHasAmount || rightHasAmount) && leftHasAmount !== rightHasAmount) {
          rowsWithExactlyOne += 1
        }
      }

      if (!rowsWithEither) continue
      const exclusivityRatio = rowsWithExactlyOne / rowsWithEither
      if (exclusivityRatio >= 0.8 && (!bestPair || exclusivityRatio > bestPair.exclusivityRatio)) {
        bestPair = {
          headers: [leftHeader, rightHeader],
          exclusivityRatio,
        }
      }
    }
  }

  return bestPair
}

export function inferImportFileCharacteristicsFromPreview(preview, skipRows = 0) {
  if (!preview?.headers?.length) {
    return {
      dateFormat: DEFAULT_IMPORT_DATE_FORMAT,
      amountConvention: 'single_signed',
      decimalSeparator: DEFAULT_DECIMAL_SEPARATOR,
    }
  }

  const columnSamples = buildColumnSamples(preview, skipRows)
  const previewRows = Array.isArray(preview?.rows) ? preview.rows.slice(skipRows) : []
  const dateCandidates = []
  const amountCandidates = []
  const directionCandidates = []
  const dateAnalysisByHeader = {}

  preview.headers.forEach(header => {
    const samples = columnSamples[header] || []
    const sampleCount = samples.length
    if (!sampleCount) return

    const dateAnalysis = analyzeDateSamples(samples)
    dateAnalysisByHeader[header] = dateAnalysis
    if (dateAnalysis.matchedCount >= Math.max(2, Math.ceil(sampleCount * 0.6))) {
      dateCandidates.push({
        header,
        score: dateAnalysis.matchedCount + dateAnalysis.decisiveCount,
      })
    }

    const amountMatches = samples.filter(looksLikeAmountSample).length
    const amountRatio = amountMatches / sampleCount
    if (amountRatio >= 0.7) {
      amountCandidates.push({ header, score: amountMatches })
    }

    const directionMatches = samples.filter(looksLikeDirectionSample).length
    const directionRatio = directionMatches / sampleCount
    if (directionRatio >= 0.6) {
      directionCandidates.push({ header, score: directionMatches })
    }
  })

  dateCandidates.sort((a, b) => b.score - a.score || a.header.localeCompare(b.header))
  amountCandidates.sort((a, b) => b.score - a.score || a.header.localeCompare(b.header))
  directionCandidates.sort((a, b) => b.score - a.score || a.header.localeCompare(b.header))

  const topDateHeader = dateCandidates[0]?.header || ''
  const twoColumnPair = detectTwoColumnAmountConvention(
    amountCandidates.map(entry => entry.header),
    previewRows,
  )

  let amountConvention = 'single_signed'
  if (twoColumnPair) {
    amountConvention = 'two_column'
  } else if (amountCandidates[0]?.header && directionCandidates[0]?.header && amountCandidates[0].header !== directionCandidates[0].header) {
    amountConvention = 'single_unsigned'
  }

  return {
    dateFormat: (topDateHeader && dateAnalysisByHeader[topDateHeader]?.guessedFormat) || DEFAULT_IMPORT_DATE_FORMAT,
    amountConvention,
    decimalSeparator: guessDecimalSeparator(amountCandidates.flatMap(entry => columnSamples[entry.header] || []))
      || DEFAULT_DECIMAL_SEPARATOR,
  }
}

function pickUnambiguousHeader(headers) {
  return headers.length === 1 ? headers[0] : ''
}

export function inferUnambiguousImportMappingFromPreview(preview, skipRows = 0) {
  const analysis = analyzeImportColumns(preview, skipRows)
  const characteristics = inferImportFileCharacteristicsFromPreview(preview, skipRows)
  const amountConvention = characteristics.amountConvention || 'single_signed'

  return {
    filenamePattern: inferFilenamePattern(preview?.filename),
    headerFingerprint: String(preview?.header_fingerprint || '').trim(),
    dateFormat: characteristics.dateFormat || DEFAULT_IMPORT_DATE_FORMAT,
    amountConvention,
    columnMap: {
      date: pickUnambiguousHeader(analysis.dateCandidates),
      amount: amountConvention === 'two_column' ? '' : pickUnambiguousHeader(analysis.amountCandidates),
      debit: amountConvention === 'two_column' ? pickUnambiguousHeader(analysis.debitCandidates) : '',
      credit: amountConvention === 'two_column' ? pickUnambiguousHeader(analysis.creditCandidates) : '',
      direction: amountConvention === 'single_unsigned' ? pickUnambiguousHeader(analysis.directionCandidates) : '',
      description: pickUnambiguousHeader(analysis.merchantCandidates),
      category: pickUnambiguousHeader(analysis.categoryCandidates),
      notes: pickUnambiguousHeader(analysis.notesCandidates),
      pending: pickUnambiguousHeader(analysis.pendingCandidates),
      currency: pickUnambiguousHeader(analysis.currencyCandidates),
      transaction_id: pickUnambiguousHeader(analysis.transactionIdCandidates),
      account: pickUnambiguousHeader(analysis.accountCandidates),
    },
    analysis,
  }
}

export function inferImportMappingFromPreview(preview, skipRows = 0) {
  const analysis = analyzeImportColumns(preview, skipRows)
  const date = analysis.dateCandidates[0] || ''
  const debit = analysis.debitCandidates[0] || ''
  const credit = analysis.creditCandidates[0] || ''
  const amount = analysis.amountCandidates[0] || ''
  const direction = analysis.directionCandidates[0] || ''

  let amountConvention = 'single_signed'
  if (debit && credit && debit !== credit) {
    amountConvention = 'two_column'
  } else if (amount && direction && amount !== direction) {
    amountConvention = 'single_unsigned'
  }

  return {
    filenamePattern: inferFilenamePattern(preview?.filename),
    headerFingerprint: String(preview?.header_fingerprint || '').trim(),
    dateFormat: (date && analysis.dateAnalysisByHeader[date]?.guessedFormat) || DEFAULT_IMPORT_DATE_FORMAT,
    amountConvention,
    columnMap: {
      date,
      amount: amountConvention === 'two_column' ? '' : amount,
      debit: amountConvention === 'two_column' ? debit : '',
      credit: amountConvention === 'two_column' ? credit : '',
      direction: amountConvention === 'single_unsigned' ? direction : '',
      description: analysis.merchantCandidates[0] || '',
      category: analysis.categoryCandidates[0] || '',
      notes: analysis.notesCandidates[0] || '',
      pending: analysis.pendingCandidates[0] || '',
      currency: analysis.currencyCandidates[0] || '',
      transaction_id: analysis.transactionIdCandidates[0] || '',
      account: analysis.accountCandidates[0] || '',
    },
    analysis,
  }
}
