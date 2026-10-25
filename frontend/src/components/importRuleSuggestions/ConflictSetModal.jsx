// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// Overlay listing the conflict sections for one merchant (conflicting category assignments). It is
// pure layout: the parent passes the grouped `sections` and a `renderSuggestionCard` callback so the
// cards render identically to the main list.

import { IconButton } from '../ui.jsx'
import { ProgressPill } from './suggestionPresentational.jsx'

export function ConflictSetModal({ sections, onClose, renderSuggestionCard }) {
  if (!sections.length) return null

  return (
    <div
      onMouseDown={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 890,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0,0,0,0.46)',
        padding: 24,
      }}
    >
      <div
        onMouseDown={event => event.stopPropagation()}
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 14,
          width: 980,
          maxWidth: '96vw',
          maxHeight: '88vh',
          overflowY: 'auto',
          boxShadow: '0 20px 60px rgba(0,0,0,0.42)',
        }}
      >
        <div style={{
          position: 'sticky',
          top: 0,
          zIndex: 1,
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 16,
          padding: '14px 16px',
          borderBottom: '1px solid var(--border)',
          background: 'color-mix(in srgb, var(--surface) 94%, rgba(15, 23, 42, 0.12))',
          backdropFilter: 'blur(10px)',
        }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 700 }}>Conflict set</div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4, lineHeight: 1.5 }}>
              Conflicting category assignments for the same merchant. Pick one or add selection criteria to distinguish them.
            </div>
          </div>
          <IconButton aria-label="Close" onClick={onClose} style={{ fontSize: 20 }}>
            ×
          </IconButton>
        </div>

        <div style={{ display: 'grid', gap: 18, padding: 20 }}>
          {sections.map(section => (
            <div key={section.key} style={{ display: 'grid', gap: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <ProgressPill
                  label={section.label}
                  value={section.suggestions.length}
                  tone={section.tone}
                />
              </div>
              <div style={{ display: 'grid', gap: 12 }}>
                {section.suggestions.map(suggestion => renderSuggestionCard(suggestion, {
                  filterKey: section.key,
                  conflictFollowerIds: section.conflictContext.followerIds,
                  conflictLeadIds: section.conflictContext.leadIds,
                  allowConflictOpen: false,
                }))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
