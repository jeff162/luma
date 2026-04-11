// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: GPL-3.0-or-later

import ImportAccountHandlingPicker from './ImportAccountHandlingPicker.jsx'
import ImportColumnSelect from './ImportColumnSelect.jsx'
import ImportMappingFieldGrid from './ImportMappingFieldGrid.jsx'

// This shared section keeps the import preview and data-source editor aligned on
// how mapping fields render suggestions, required states, and account handling.
export default function ImportColumnMappingSection({
  title = 'Column mapping',
  marginBottom = 14,
  fields = [],
  accountField = null,
}) {
  function renderField(field) {
    if (!field) return null
    const {
      key,
      label,
      headers = [],
      allHeaders = headers,
      value,
      onChange,
      suggestedValue = '',
      onAcceptSuggestion = null,
      required = false,
      hint = '',
      tone = 'muted',
      placeholder = '',
      after = null,
    } = field

    const content = allHeaders.length > 0 ? (
      <ImportColumnSelect
        label={label}
        headers={headers}
        allHeaders={allHeaders}
        value={value}
        onChange={onChange}
        suggestedValue={suggestedValue}
        onAcceptSuggestion={onAcceptSuggestion}
        required={required}
        hint={hint}
        tone={tone}
      />
    ) : (
      <div>
        <label style={{ fontSize: 11, color: 'var(--muted)', display: 'block', marginBottom: 3 }}>
          {label}
          {required ? ' *' : ''}
        </label>
        <input
          value={value}
          onChange={event => onChange(event.target.value)}
          placeholder={placeholder}
          style={{
            background: 'var(--surface)',
            color: 'var(--text)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            padding: '6px 10px',
            fontSize: 13,
            width: '100%',
            outline: 'none',
          }}
        />
      </div>
    )

    return (
      <div key={key} style={after ? { position: 'relative' } : undefined}>
        {content}
        {after}
      </div>
    )
  }

  return (
    <ImportMappingFieldGrid title={title} marginBottom={marginBottom}>
      {fields.map(renderField)}
      {accountField ? (
        <ImportAccountHandlingPicker
          headers={accountField.headers}
          allHeaders={accountField.allHeaders}
          accounts={accountField.accounts}
          colAccount={accountField.colAccount}
          accountId={accountField.accountId}
          singleAccountNew={accountField.singleAccountNew}
          suggestedColumn={accountField.suggestedColumn}
          onAcceptSuggestedColumn={accountField.onAcceptSuggestedColumn}
          isRequired={accountField.isRequired}
          hint={accountField.hint}
          allowCreateNew={accountField.allowCreateNew}
          onChange={accountField.onChange}
        />
      ) : null}
    </ImportMappingFieldGrid>
  )
}
