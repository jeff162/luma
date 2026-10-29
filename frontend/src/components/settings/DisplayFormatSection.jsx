// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from 'react'
import { SegmentedToggle } from '../ui.jsx'
import { useUserPreference } from '../../lib/UserPreferencesContext.jsx'
import {
  DATE_ORDER_PREF_KEY, DATE_ORDER_MDY, DATE_ORDER_DMY, DATE_ORDER_YMD, DEFAULT_DATE_ORDER,
  NUMBER_FORMAT_PREF_KEY, NUMBER_FORMAT_POINT, NUMBER_FORMAT_COMMA, NUMBER_FORMAT_SPACE, DEFAULT_NUMBER_FORMAT,
  normalizeDateOrder, normalizeNumberFormat,
} from '../../lib/displayFormat.js'

// Each option is labelled with what it produces, so the choice needs no explanation.
const DATE_OPTIONS = [
  { value: DATE_ORDER_MDY, label: 'Jan 31, 2026' },
  { value: DATE_ORDER_DMY, label: '31 Jan 2026' },
  { value: DATE_ORDER_YMD, label: '2026-01-31' },
]

const NUMBER_OPTIONS = [
  { value: NUMBER_FORMAT_POINT, label: '1,234.56' },
  { value: NUMBER_FORMAT_COMMA, label: '1.234,56' },
  { value: NUMBER_FORMAT_SPACE, label: '1 234,56' },
]

// The viewer's date order and number format (`lib/displayFormat.js`). A change is saved and then the app
// reloads, for the reason the currency setting does: every date and amount already on screen was
// formatted with the old choice and nothing tells those components to run again.
export default function DisplayFormatSection() {
  const [dateOrder, setDateOrder] = useUserPreference(DATE_ORDER_PREF_KEY, DEFAULT_DATE_ORDER)
  const [numberFormat, setNumberFormat] = useUserPreference(NUMBER_FORMAT_PREF_KEY, DEFAULT_NUMBER_FORMAT)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function choose(setter, current, value) {
    if (value === current) return
    setSaving(true)
    setError('')
    if (await setter(value)) {
      window.location.reload()
      return
    }
    setSaving(false)
    setError('The format could not be saved.')
  }

  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <Row label="Dates">
        <SegmentedToggle
          size="compact"
          ariaLabel="Date format"
          value={normalizeDateOrder(dateOrder)}
          options={DATE_OPTIONS}
          disabled={saving}
          onChange={value => choose(setDateOrder, normalizeDateOrder(dateOrder), value)}
        />
      </Row>
      <Row label="Numbers">
        <SegmentedToggle
          size="compact"
          ariaLabel="Number format"
          value={normalizeNumberFormat(numberFormat)}
          options={NUMBER_OPTIONS}
          disabled={saving}
          onChange={value => choose(setNumberFormat, normalizeNumberFormat(numberFormat), value)}
        />
      </Row>
      <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.55 }}>
        Dates and amounts typed into the app are read the same way. A date written as 2026-01-31 is
        always understood.
      </div>
      {error ? <div style={{ fontSize: 12, color: 'var(--danger)' }}>{error}</div> : null}
    </div>
  )
}

function Row({ label, children }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
      <span style={{ fontSize: 13, color: 'var(--muted)', minWidth: 64 }}>{label}</span>
      {children}
    </div>
  )
}
