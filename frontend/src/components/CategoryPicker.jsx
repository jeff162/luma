import React, { useEffect, useState } from 'react'
import { InlineCategorySelect } from './TransactionRow.jsx'
import { Badge } from './ui.jsx'

export default function CategoryPicker({ value, categories, onChange, onAddCategory, placeholder = 'Type to search…', style, compact = false, initialQuery = '', openToken = 0 }) {
  const [editing, setEditing] = useState(false)
  const currentCat = categories.find(c => c.id === value)
  const txn = {
    id: '__category_picker__',
    category_id: value || null,
    merchant_name: placeholder,
    raw_name: placeholder,
  }

  useEffect(() => {
    if (openToken) setEditing(true)
  }, [openToken])

  return (
    <div style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', ...style }}>
      {editing ? (
        <InlineCategorySelect
          txn={txn}
          categories={categories}
          initialQuery={initialQuery}
          onSave={(...args) => { onChange(args[1] ?? args[0] ?? ''); setEditing(false) }}
          onSaveNew={cat => { onChange(cat.id); setEditing(false) }}
          onAddCategory={onAddCategory}
          onClose={() => setEditing(false)}
        />
      ) : (
        <div style={{ display: 'inline-flex', alignItems: 'stretch', gap: 6, width: '100%' }}>
          <button
            type="button"
            onClick={() => setEditing(true)}
            style={{
              flex: 1,
              minHeight: compact ? 28 : 32,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'flex-start',
              gap: 8,
              padding: compact ? '2px 6px' : '4px 8px',
              borderRadius: 8,
              border: '1px solid var(--border)',
              background: 'var(--surface2)',
              color: 'var(--text)',
              cursor: 'pointer',
              textAlign: 'left',
              minWidth: 0,
            }}
          >
            {currentCat ? (
              <Badge label={currentCat.name} color={currentCat.color} icon={currentCat.icon} />
            ) : (
              <span style={{ color: 'var(--muted)', fontSize: 13 }}>Select category</span>
            )}
          </button>
          {currentCat && (
            <button
              type="button"
              onClick={() => onChange('')}
              title="Unassign category"
              aria-label="Unassign category"
              style={{
                flexShrink: 0,
                minHeight: compact ? 28 : 32,
                minWidth: compact ? 28 : 32,
                borderRadius: 8,
                border: '1px solid var(--border)',
                background: 'var(--surface2)',
                color: 'var(--muted)',
                cursor: 'pointer',
                fontSize: 18,
                lineHeight: 1,
                padding: 0,
              }}
            >
              ×
            </button>
          )}
        </div>
      )}
    </div>
  )
}
