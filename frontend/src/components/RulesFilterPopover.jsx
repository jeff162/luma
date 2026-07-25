// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * The Rules page's structured subset filter — the "narrow to a slice" counterpart to the merchant search
 * box, mirroring the Transactions FilterBar concept but page-local (never touches the app-wide, persistent
 * FilterContext) and with rules-relevant facets. The option lists are pre-filtered by the caller to the
 * values that actually appear in the rule set, so the popover only ever offers facets that will match
 * something. Selection state lives in the page (session-scoped); this component is presentational.
 */

import { useRef, useState } from 'react'
import { useDismissibleLayer } from '../lib/uiInteractions.js'
import { TagGlyph } from './TagUi.jsx'
import { activeRulesFacetCount } from '../lib/rulesFilter.js'

// A list longer than this grows a type-to-filter search box, so a big category/tag set stays findable.
const SEARCH_THRESHOLD = 8

function toggleId(list, id) {
  return list.includes(id) ? list.filter(x => x !== id) : [...list, id]
}

const sectionTitleStyle = {
  fontSize: 11, fontWeight: 700, color: 'var(--accent2)', letterSpacing: '0.03em',
  margin: '0 0 6px', textTransform: 'uppercase',
}

const searchInputStyle = {
  width: '100%', boxSizing: 'border-box', marginBottom: 6,
  background: 'var(--surface2)', color: 'var(--text)', border: '1px solid var(--border)',
  borderRadius: 6, padding: '5px 8px', fontSize: 12, outline: 'none',
}

const checkRowStyle = checked => ({
  display: 'flex', alignItems: 'center', gap: 8, padding: '3px 6px', borderRadius: 6,
  cursor: 'pointer', fontSize: 13,
  background: checked ? 'color-mix(in srgb, var(--accent) 16%, var(--surface2))' : 'transparent',
})

function ChecklistSection({ title, options, selected, onToggle, renderGlyph }) {
  const [query, setQuery] = useState('')
  if (!options || options.length === 0) return null
  const q = query.trim().toLowerCase()
  const shown = q ? options.filter(o => o.label.toLowerCase().includes(q)) : options
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={sectionTitleStyle}>{title}</div>
      {options.length > SEARCH_THRESHOLD ? (
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder={`Filter ${title.toLowerCase()}…`} style={searchInputStyle} />
      ) : null}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 168, overflowY: 'auto' }}>
        {shown.map(opt => {
          const checked = selected.includes(opt.id)
          return (
            <label key={opt.id} style={checkRowStyle(checked)}>
              <input type="checkbox" checked={checked} onChange={() => onToggle(opt.id)} style={{ accentColor: 'var(--accent)', cursor: 'pointer' }} />
              {renderGlyph ? renderGlyph(opt) : null}
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{opt.label}</span>
            </label>
          )
        })}
        {shown.length === 0 ? <div style={{ fontSize: 12, color: 'var(--muted)', padding: '3px 6px' }}>No matches</div> : null}
      </div>
    </div>
  )
}

// Categories grouped under their parent group, searchable, with a group-level checkbox (matches any leaf
// under it) plus per-leaf checkboxes. A search matches on either the group name or a leaf name.
function CategorySection({ groups, selectedCategoryIds, selectedGroupIds, onToggleCategory, onToggleGroup }) {
  const [query, setQuery] = useState('')
  if (!groups || groups.length === 0) return null
  const q = query.trim().toLowerCase()
  const totalLeaves = groups.reduce((n, g) => n + g.leaves.length, 0)
  const shown = groups
    .map(g => {
      const groupHit = g.groupLabel.toLowerCase().includes(q)
      const leaves = q && !groupHit ? g.leaves.filter(l => l.label.toLowerCase().includes(q)) : g.leaves
      return { ...g, leaves }
    })
    .filter(g => g.leaves.length > 0 || (q && g.groupLabel.toLowerCase().includes(q)))

  return (
    <div style={{ marginBottom: 12 }}>
      <div style={sectionTitleStyle}>Category</div>
      {totalLeaves > SEARCH_THRESHOLD ? (
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Filter categories…" style={searchInputStyle} />
      ) : null}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 1, maxHeight: 220, overflowY: 'auto' }}>
        {shown.map(g => {
          const groupChecked = selectedGroupIds.includes(g.groupId)
          return (
            <div key={g.groupId}>
              <label style={{ ...checkRowStyle(groupChecked), fontWeight: 600 }}>
                <input type="checkbox" checked={groupChecked} onChange={() => onToggleGroup(g.groupId)} style={{ accentColor: 'var(--accent)', cursor: 'pointer' }} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g.groupLabel}</span>
              </label>
              {g.leaves.map(leaf => {
                const checked = selectedCategoryIds.includes(leaf.id)
                return (
                  <label key={leaf.id} style={{ ...checkRowStyle(checked), paddingLeft: 22 }}>
                    <input type="checkbox" checked={checked} onChange={() => onToggleCategory(leaf.id)} style={{ accentColor: 'var(--accent)', cursor: 'pointer' }} />
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: groupChecked ? 'var(--muted)' : undefined }}>{leaf.label}</span>
                  </label>
                )
              })}
            </div>
          )
        })}
        {shown.length === 0 ? <div style={{ fontSize: 12, color: 'var(--muted)', padding: '3px 6px' }}>No matches</div> : null}
      </div>
    </div>
  )
}

function BooleanToggle({ label, checked, onChange }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 6px', borderRadius: 6, cursor: 'pointer', fontSize: 13 }}>
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} style={{ accentColor: 'var(--accent)', cursor: 'pointer' }} />
      {label}
    </label>
  )
}

export default function RulesFilterPopover({ facets, onChange, options, onClose, onClear }) {
  const ref = useRef(null)
  useDismissibleLayer({ open: true, onClose, refs: [ref], closeOnBlur: true })

  const set = patch => onChange({ ...facets, ...patch })
  const activeCount = activeRulesFacetCount(facets)

  return (
    <div
      ref={ref}
      style={{
        position: 'absolute', top: 'calc(100% + 6px)', left: 0, zIndex: 60,
        width: 300, maxHeight: '70vh', overflowY: 'auto',
        background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12,
        boxShadow: '0 16px 44px rgba(0,0,0,0.24)', padding: 14,
      }}
    >
      <CategorySection
        groups={options.categoryGroups}
        selectedCategoryIds={facets.categoryIds}
        selectedGroupIds={facets.groupIds}
        onToggleCategory={id => set({ categoryIds: toggleId(facets.categoryIds, id) })}
        onToggleGroup={id => set({ groupIds: toggleId(facets.groupIds, id) })}
      />
      <ChecklistSection
        title="Tag"
        options={options.tags}
        selected={facets.tagIds}
        onToggle={id => set({ tagIds: toggleId(facets.tagIds, id) })}
        renderGlyph={opt => <TagGlyph color={opt.color} />}
      />
      <ChecklistSection
        title="Owner"
        options={options.owners}
        selected={facets.ownerIds}
        onToggle={id => set({ ownerIds: toggleId(facets.ownerIds, id) })}
      />
      <ChecklistSection
        title="Account"
        options={options.accounts}
        selected={facets.accountIds}
        onToggle={id => set({ accountIds: toggleId(facets.accountIds, id) })}
      />
      <ChecklistSection
        title="Account type"
        options={options.accountTypes}
        selected={facets.accountTypes}
        onToggle={id => set({ accountTypes: toggleId(facets.accountTypes, id) })}
      />

      <div style={{ marginBottom: 4 }}>
        <div style={sectionTitleStyle}>Only rules that…</div>
        <BooleanToggle label="Track a recurring series" checked={facets.recurring} onChange={v => set({ recurring: v })} />
        <BooleanToggle label="Rename the merchant" checked={facets.hasRename} onChange={v => set({ hasRename: v })} />
        <BooleanToggle label="Match source text" checked={facets.matchSourceText} onChange={v => set({ matchSourceText: v })} />
        <BooleanToggle label="Assign no category (tag/rename-only)" checked={facets.noCategory} onChange={v => set({ noCategory: v })} />
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
        <button
          type="button"
          onClick={onClear}
          disabled={activeCount === 0}
          style={{
            background: 'none', border: 'none', padding: 0, fontSize: 12,
            color: activeCount === 0 ? 'var(--muted)' : 'var(--accent)',
            cursor: activeCount === 0 ? 'default' : 'pointer',
          }}
        >
          Clear all{activeCount > 0 ? ` (${activeCount})` : ''}
        </button>
        <button
          type="button"
          onClick={onClose}
          style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 8, padding: '5px 12px', fontSize: 12, cursor: 'pointer', color: 'var(--text)' }}
        >
          Done
        </button>
      </div>
    </div>
  )
}
