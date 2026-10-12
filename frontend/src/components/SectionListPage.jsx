// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/* eslint-disable react-refresh/only-export-components -- the layout, its subsection heading and the hook that reads its URL parameter live together by design */

/*
 * The layout Settings and Administration share: the section names in a list down the left, the selected
 * section on the right, one at a time.
 *
 * The selection lives in the URL as `?section=<key>` rather than in state or a preference, so a section
 * can be linked to from anywhere and the remembered startup route brings back the one last open. A key
 * the page does not list (an old link, or a section this user is not shown) falls back to the first.
 *
 * Only the selected section is mounted, which is what makes "loads only when selected" true without
 * each section having to know whether it is on screen.
 */

import { useSearchParams } from 'react-router-dom'
import { PageHeader, SectionEyebrow } from './ui.jsx'

const SECTION_PARAM = 'section'
const SECTION_LIST_WIDTH = 200
// Wide enough for the sections that are tables, and no wider: a form stretched across a large window
// puts each control a long way from its label.
const SECTION_CONTENT_MAX_WIDTH = 1040

const listItemStyle = {
  display: 'block',
  width: '100%',
  textAlign: 'left',
  padding: '8px 12px',
  margin: '1px 0',
  border: 'none',
  borderRadius: 6,
  background: 'none',
  color: 'var(--muted)',
  fontSize: 14,
  cursor: 'pointer',
}
const selectedListItemStyle = { ...listItemStyle, background: 'var(--surface2)', color: 'var(--text)' }

// The `section` key the URL asks for, for a page that has to know which section is open before the
// layout renders it (a refresh that sits on the section's title needs the section's data).
export function useSectionParam() {
  const [searchParams] = useSearchParams()
  return searchParams.get(SECTION_PARAM) || ''
}

// One part of a section that holds several things under a single heading.
export function Subsection({ title, children }) {
  return (
    <div>
      <SectionEyebrow style={{ fontSize: 13, marginBottom: 8 }}>{title}</SectionEyebrow>
      {children}
    </div>
  )
}

/*
 * `sections` is `[{ key, title, note, description, help, refresh, content }]`; a falsy entry is skipped,
 * so a page lists a conditional section as `condition && { ... }`. `help` and `refresh` sit on the
 * section's title, as they do on a page's. `note` is a few characters beside the section's name in the
 * list — how much it holds — for a section whose contents decide whether it is worth opening.
 */
export default function SectionListPage({ title, help, sections }) {
  const [searchParams, setSearchParams] = useSearchParams()
  const shown = sections.filter(Boolean)
  const requested = searchParams.get(SECTION_PARAM)
  const selected = shown.find(section => section.key === requested) || shown[0]

  function select(key) {
    // Replaced rather than pushed: stepping through sections is not a trail anyone walks back along,
    // and Back should leave the page.
    setSearchParams({ [SECTION_PARAM]: key }, { replace: true })
  }

  return (
    <div data-browser-context-passthrough="true" style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ padding: '24px 28px 0', flexShrink: 0 }}>
        <PageHeader title={title} help={help} />
      </div>

      <div style={{ flex: 1, minHeight: 0, display: 'flex', gap: 24, padding: '0 28px' }}>
        <nav aria-label={`${title} sections`} style={{ width: SECTION_LIST_WIDTH, flexShrink: 0, overflowY: 'auto', paddingBottom: 24 }}>
          {shown.map(section => {
            const isSelected = section.key === selected?.key
            return (
              <button
                key={section.key}
                type="button"
                aria-current={isSelected ? 'page' : undefined}
                onClick={() => select(section.key)}
                style={isSelected ? selectedListItemStyle : listItemStyle}
              >
                {section.note ? (
                  <span style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
                    <span>{section.title}</span>
                    <span style={{ fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
                      {section.note}
                    </span>
                  </span>
                ) : section.title}
              </button>
            )
          })}
        </nav>

        <div data-browser-context-passthrough="true" style={{ flex: 1, minWidth: 0, overflowY: 'auto', paddingBottom: 24 }}>
          {selected ? (
            // Keyed so one section's state can never be read as the next one's.
            <section key={selected.key} style={{ maxWidth: SECTION_CONTENT_MAX_WIDTH }}>
              <div style={{ marginBottom: 14 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {selected.help}
                  <h2 style={{ fontSize: 17, fontWeight: 600, letterSpacing: '-0.01em' }}>{selected.title}</h2>
                  {selected.refresh}
                </div>
                {selected.description ? (
                  <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.5, marginTop: 4 }}>{selected.description}</div>
                ) : null}
              </div>
              {selected.content}
            </section>
          ) : null}
        </div>
      </div>
    </div>
  )
}
