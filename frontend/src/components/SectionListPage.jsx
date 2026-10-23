// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/* eslint-disable react-refresh/only-export-components -- the layout, its subsection heading and the hook that reads its URL parameter live together by design */

/*
 * The Settings layout: the section names in a list down the left, each group in a block of its own under
 * its heading, and the selected section on the right, one at a time. The groups are what keep a long
 * list scannable: a name is found by its group first.
 *
 * The selection lives in the URL as `?section=<key>` rather than in state or a preference, so a section
 * can be linked to from anywhere and the remembered startup route brings back the one last open. A key
 * the page does not list (an old link, or a section this user is not shown) falls back to the first.
 *
 * Only the selected section is mounted, which is what makes "loads only when selected" true without
 * each section having to know whether it is on screen.
 */

import { useSearchParams } from 'react-router-dom'
import { Button, PageHeader, SectionEyebrow } from './ui.jsx'

const SECTION_PARAM = 'section'
const SECTION_LIST_WIDTH = 216
// Wide enough for the sections that are tables, and no wider: a form stretched across a large window
// puts each control a long way from its label.
const SECTION_CONTENT_MAX_WIDTH = 1040

// A group is a faint tint rather than a bordered card: the tint alone marks where a group ends, and a
// border around each of several small blocks makes the list read as boxes rather than as a list.
const groupStyle = {
  background: 'color-mix(in srgb, var(--surface) 55%, transparent)',
  borderRadius: 10,
  padding: '8px 4px 6px',
}
const listItemStyle = {
  display: 'block',
  width: '100%',
  textAlign: 'left',
  padding: '4px 8px 4px 10px',
  margin: 0,
  border: 'none',
  borderRadius: 6,
  background: 'none',
  color: 'var(--muted)',
  fontSize: 13,
  lineHeight: 1.35,
  cursor: 'pointer',
}
const selectedListItemStyle = {
  ...listItemStyle,
  background: 'var(--surface)',
  color: 'var(--text)',
  fontWeight: 500,
  boxShadow: 'inset 2px 0 0 var(--accent)',
  borderRadius: '0 6px 6px 0',
}

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
 * `groups` is `[{ title, sections }]`, and each section is `{ key, title, note, description, help,
 * refresh, content }`. A falsy section is skipped, so a page lists a conditional one as
 * `condition && { ... }`, and a group left with none is not drawn. A group without a title lists its
 * sections under no heading. `help` and `refresh` sit on the section's title, as they do on a page's.
 * `note` is a few characters beside the section's name in the list — how much it holds — for a section
 * whose contents decide whether it is worth opening.
 *
 * `headerSections` are sections opened from a button on the page's title row instead of from the list —
 * reference material such as About, which is looked up rather than set. They are never the fallback.
 */
export default function SectionListPage({ title, help, groups, headerSections = [] }) {
  const [searchParams, setSearchParams] = useSearchParams()
  const shownGroups = groups
    .map(group => ({ ...group, sections: group.sections.filter(Boolean) }))
    .filter(group => group.sections.length > 0)
  const shown = shownGroups.flatMap(group => group.sections)
  const shownHeaderSections = headerSections.filter(Boolean)
  const requested = searchParams.get(SECTION_PARAM)
  const selected = [...shown, ...shownHeaderSections].find(section => section.key === requested) || shown[0]

  function select(key) {
    // Replaced rather than pushed: stepping through sections is not a trail anyone walks back along,
    // and Back should leave the page.
    setSearchParams({ [SECTION_PARAM]: key }, { replace: true })
  }

  return (
    <div data-browser-context-passthrough="true" style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ padding: '24px 28px 0', flexShrink: 0 }}>
        <PageHeader title={title} help={help}>
          {shownHeaderSections.map(section => (
            <Button
              key={section.key}
              small
              variant="ghost"
              onClick={() => select(section.key)}
            >
              {section.title}
            </Button>
          ))}
        </PageHeader>
      </div>

      <div style={{ flex: 1, minHeight: 0, display: 'flex', gap: 24, padding: '0 28px' }}>
        <nav
          aria-label={`${title} sections`}
          style={{ width: SECTION_LIST_WIDTH, flexShrink: 0, overflowY: 'auto', paddingBottom: 24, display: 'grid', gap: 10, alignContent: 'start' }}
        >
          {shownGroups.map((group, index) => (
            <div key={group.title || index} style={groupStyle}>
              <div role="group" aria-label={group.title}>
                {group.title ? (
                  <SectionEyebrow
                    style={{
                      margin: '0 6px 4px',
                      padding: '0 0 4px',
                      borderBottom: '1px solid var(--border)',
                      fontSize: 10.5,
                      letterSpacing: '0.06em',
                    }}
                  >
                    {group.title}
                  </SectionEyebrow>
                ) : null}
                {group.sections.map(section => {
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
              </div>
            </div>
          ))}
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
