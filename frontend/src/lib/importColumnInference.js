// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: GPL-3.0-or-later

/*
 * Shared CSV-header inference keeps the import mapping page and saved data source editor in sync about how
 * we recognize dates, amounts, merchant columns, and file fingerprints from a previewed CSV.
 */

export const DEFAULT_IMPORT_DATE_FORMAT = '%m/%d/%Y'

export function inferFilenamePattern(filename) {
  let base = String(filename || '')
    .replace(/\.[^.]+$/, '')
    .trim()
  if (!base) return ''

  // Providers often append dates or export sequence suffixes to an otherwise
  // stable base filename. Strip those trailing patterns iteratively so saved
  // data sources can match "same source, newer export" without overfitting.
  const trailingPatterns = [
    /(?:[-_ ]+\d{4}(?:[-_]\d{2}){2}(?:T\d{2}(?:[-_:]?\d{2}){0,2})?)$/i,
    /(?:[-_ ]+\d{4}(?:[-_]\d{2}){2}T)$/i,
    /(?:[-_ ]+\d{4}(?:[-_]\d{2}){0,2})$/i,
    /(?:[-_ ]+\d{8})$/i,
    /(?:[-_ ]+\d{6,})$/i,
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

function looksLikeAmountSample(value) {
  const sample = String(value || '').trim()
  if (!sample) return false
  const compact = sample.replace(/\s+/g, '')
  return /^(\(\$?\d[\d,]*(\.\d+)?\)|[+-]?\$?\d[\d,]*(\.\d+)?(?:CR|DR)?)$/i.test(compact)
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
    if (/^\(\$?\d[\d,]*(\.\d+)?\)$/i.test(sample)) styles.accounting += 1
    else if (/(CR|DR)$/i.test(sample)) styles.trailingCode += 1
    else if (/^[+-]/.test(sample)) styles.signed += 1
    else if (sample.includes('$')) styles.currency += 1
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
    account: ['account', 'acct'],
    debit: ['debit', 'withdrawal', 'outflow', 'payment', 'charge'],
    credit: ['credit', 'deposit', 'inflow', 'refund'],
    direction: ['type', 'direction', 'dr/cr', 'transaction type'],
    pending: ['pending', 'is pending', 'pending status', 'posted', 'cleared'],
  }

  return (tests[type] || []).reduce((score, token) => score + (normalized.includes(token) ? 1 : 0), 0)
}

export function formatLikelyMatchLabel(count) {
  if (!count) return ''
  return `${count} likely ${count === 1 ? 'match' : 'matches'}`
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
      accountCandidates: [],
      debitCandidates: [],
      creditCandidates: [],
      directionCandidates: [],
      pendingCandidates: [],
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
    accountCandidates: [],
    debitCandidates: [],
    creditCandidates: [],
    directionCandidates: [],
    pendingCandidates: [],
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
  })

  for (const key of ['dateCandidates', 'amountCandidates', 'merchantCandidates', 'categoryCandidates', 'accountCandidates', 'debitCandidates', 'creditCandidates', 'directionCandidates', 'pendingCandidates']) {
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
      notes: '',
      pending: pickUnambiguousHeader(analysis.pendingCandidates),
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
      notes: '',
      pending: analysis.pendingCandidates[0] || '',
      account: analysis.accountCandidates[0] || '',
    },
    analysis,
  }
}
