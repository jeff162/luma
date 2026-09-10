// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useLayoutEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { Card, PageHeader, Toggle } from '../components/ui.jsx'
import { HELP_TOPICS, HELP_TOPICS_BY_ID, HELP_SECTIONS } from '../help/content.jsx'
import { labelForPath } from '../help/navigation.js'
import { HELP_BODY_CSS } from '../help/helpBody.js'
import { useUserPreference } from '../lib/UserPreferencesContext.jsx'
import { APP_NAME } from '../lib/appConfig.js'
import { HELP_HINTS_ENABLED_PREF_KEY, HELP_DISMISSED_TIPS_PREF_KEY } from '../help/preferences.js'

const EMPTY_DISMISSED = {}

/*
 * Standalone Help page. Without a `:topic` URL param it renders an index of every
 * registered explainer so the user can browse end-to-end. With one, it renders the
 * selected topic's full body. The same registry powers the inline FeatureExplainer
 * popovers used next to feature surfaces, so the two never drift.
 */
export default function Help() {
  const { topic } = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  const [hintsEnabled, setHintsEnabled] = useUserPreference(HELP_HINTS_ENABLED_PREF_KEY, true)
  const [, setDismissedTips] = useUserPreference(HELP_DISMISSED_TIPS_PREF_KEY, EMPTY_DISMISSED)
  const entry = topic ? HELP_TOPICS_BY_ID[topic] : null

  // Re-show every first-use tip on the next visit: turn hints back on and forget which were dismissed.
  function resetHints() {
    setHintsEnabled(true)
    setDismissedTips({})
  }
  // Read-more links inside FeatureExplainer popovers stash the source path so we can
  // surface a labeled back affordance. Clicking the Help nav item directly arrives
  // here without that state, in which case the topic-list fallback link is enough.
  const fromPath = location.state?.from
  const fromLabel = fromPath && !fromPath.startsWith('/help') ? labelForPath(fromPath) : null
  // A topic reached via a cross-link from another topic carries that topic's path. Prefer a one-step
  // unwind back to it (popping history, so chains unwind one hop at a time) over the feature-origin
  // jump below.
  const backTopicPath = location.state?.back
  const backTopicTitle = backTopicPath?.startsWith('/help/')
    ? HELP_TOPICS_BY_ID[backTopicPath.slice('/help/'.length)]?.title
    : null

  // Returning to the index from a topic (via "All help topics") carries the topic id so the list
  // scrolls back to the card just read and briefly highlights it, instead of restarting at the top.
  const returnTo = location.state?.returnTo
  const [highlightId, setHighlightId] = useState(null)
  // The index and topic views share one persistent scroll container, so its scrollTop carries over
  // between them. Reset to the top whenever a topic is shown (and on topic→topic cross-links).
  const scrollRef = useRef(null)
  // The sticky topic index overlaps the top of the scroll area, so section headings jumped to via the
  // pills must clear it. Measure its live height (it changes as the pills rewrap on resize) and offset
  // each section's scroll-margin by it, rather than guessing a fixed value.
  const indexRef = useRef(null)
  const [indexHeight, setIndexHeight] = useState(0)
  useLayoutEffect(() => {
    const el = indexRef.current
    if (!el || typeof ResizeObserver === 'undefined') return undefined
    const measure = () => setIndexHeight(el.offsetHeight)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [entry])
  useLayoutEffect(() => {
    if (entry && scrollRef.current) scrollRef.current.scrollTop = 0
  }, [entry, topic])
  useLayoutEffect(() => {
    if (entry || !returnTo) return
    const el = document.getElementById(`help-topic-${returnTo}`)
    if (!el) return
    el.scrollIntoView({ block: 'center' })
    setHighlightId(returnTo)
    const timer = setTimeout(() => setHighlightId(null), 1100)
    return () => clearTimeout(timer)
  }, [entry, returnTo])

  function renderTopicCard(t) {
    return (
      <Link
        key={t.id}
        id={`help-topic-${t.id}`}
        to={`/help/${t.id}`}
        state={fromPath ? { from: fromPath } : undefined}
        style={{ textDecoration: 'none', color: 'inherit', scrollMarginTop: 24 }}
      >
        <Card style={{
          padding: '14px 18px',
          transition: 'box-shadow 0.5s ease',
          boxShadow: highlightId === t.id ? '0 0 0 2px var(--accent2)' : undefined,
        }}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>{t.title}</div>
          <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.5 }}>{t.summary}</div>
        </Card>
      </Link>
    )
  }

  // The index lives in a scrollable container; jump straight to a section heading rather than
  // navigating, so the always-expanded list stays put and the user keeps their place.
  function scrollToSection(key) {
    document.getElementById(`help-section-${key}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  if (entry) {
    const Body = entry.body
    return (
      <div ref={scrollRef} style={{ height: '100%', overflowY: 'auto' }}>
        <style>{HELP_BODY_CSS}</style>
        <div data-browser-context-passthrough="true" style={{ padding: '32px', maxWidth: 760, margin: '0 auto' }}>
          <PageHeader title={entry.title} />
          <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: (backTopicTitle || fromLabel) ? 6 : 16, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <Link to="/help" state={{ ...(fromPath ? { from: fromPath } : {}), returnTo: topic }} style={{ color: 'var(--accent2)' }}>&larr; All help topics</Link>
            {entry.surfaces?.length ? (
              <>
                <span style={{ color: 'var(--border)' }}>&middot;</span>
                <span>Where in the app: {entry.surfaces.join(', ')}</span>
              </>
            ) : null}
          </div>
          {/* Contextual one-step back sits on its own line below so it doesn't shove the constant
              "All help topics · Where in the app" row off to the right. */}
          {(backTopicTitle || fromLabel) ? (
            <div style={{ fontSize: 12, marginBottom: 16 }}>
              <button
                type="button"
                onClick={() => (backTopicTitle ? navigate(-1) : navigate(fromPath))}
                style={{
                  background: 'none', border: 'none', padding: 0,
                  color: 'var(--accent2)', cursor: 'pointer', fontSize: 12,
                }}
              >
                &larr; Back to {backTopicTitle || fromLabel}
              </button>
            </div>
          ) : null}
          <Card style={{ padding: '20px 24px', lineHeight: 1.6, fontSize: 14 }}>
            <div className="help-body"><Body /></div>
          </Card>
        </div>
      </div>
    )
  }

  return (
    <div style={{ height: '100%', overflowY: 'auto' }}>
      <div data-browser-context-passthrough="true" style={{ padding: '32px', maxWidth: 760, margin: '0 auto' }}>
        <PageHeader title="Help" />
        {fromLabel ? (
          <div style={{ marginBottom: 16 }}>
            <button
              type="button"
              onClick={() => navigate(fromPath)}
              style={{
                background: 'none', border: 'none', padding: 0,
                color: 'var(--accent2)', cursor: 'pointer', fontSize: 12,
              }}
            >
              &larr; Return to {fromLabel}
            </button>
          </div>
        ) : null}
        <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.6, marginBottom: 18 }}>
          Explanations for how features in {APP_NAME} are designed to be used. Topics also
          appears as a <strong>?</strong> popover next to the feature it describes.
        </div>

        <Card style={{ padding: '14px 18px', marginBottom: 18, display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 280px', minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>First-use hints</div>
            <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.5 }}>
              Tips that appear the first time a situation is encountered (for example a cross-account duplicate).
              Turning them off leaves the <strong>?</strong> so they can be revisited later. Resetting clears the
              tracking of previously encountered situations.
            </div>
          </div>
          <Toggle
            checked={hintsEnabled}
            onChange={setHintsEnabled}
            label="Show first-use hints"
            style={{ whiteSpace: 'nowrap' }}
          />
          <button
            type="button"
            onClick={resetHints}
            title="Turn hints back on and reset tracking so hints display again the next time the situation each applies to is reached."
            style={{
              background: 'var(--surface2)', border: '1px solid var(--border)',
              borderRadius: 8, padding: '6px 12px', cursor: 'pointer',
              color: 'var(--text)', fontSize: 13, whiteSpace: 'nowrap',
            }}
          >
            Reset hints
          </button>
        </Card>

        {/*
          Section jump-nav. The blurb rides along as a native `title` tooltip rather than the shared
          <Tooltip>: it's plain text, and native handles window-edge cases (and can spill past the
          edge) better than a viewport-clamped DOM tooltip would here. The look-and-feel mismatch is
          an accepted trade for that. See docs/ui-patterns.md on native vs. custom tooltips.
        */}
        {/* The index pins to the top of the scroll container so the section jump-nav stays reachable
            while the topic cards scroll beneath it. It carries an opaque page-background fill and a
            bottom divider so cards passing under it never show through. */}
        <div ref={indexRef} style={{
          position: 'sticky',
          top: 0,
          zIndex: 5,
          background: 'var(--bg)',
          marginBottom: 22,
          paddingTop: 8,
          paddingBottom: 12,
          borderBottom: '1px solid var(--border)',
        }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', marginBottom: 8 }}>
            Topic index
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, paddingLeft: 12 }}>
            {HELP_SECTIONS.map(section => (
              HELP_TOPICS.some(t => t.section === section.key) ? (
                <button
                  key={section.key}
                  type="button"
                  title={section.blurb}
                  onClick={() => scrollToSection(section.key)}
                  style={{
                    background: 'var(--surface2)', border: '1px solid var(--border)',
                    borderRadius: 999, padding: '5px 12px', cursor: 'pointer',
                    color: 'var(--text)', fontSize: 12.5, whiteSpace: 'nowrap',
                  }}
                >
                  {section.label}
                </button>
              ) : null
            ))}
          </div>
        </div>

        {HELP_SECTIONS.map(section => {
          const topics = HELP_TOPICS.filter(t => t.section === section.key)
          if (!topics.length) return null
          return (
            <div key={section.key} id={`help-section-${section.key}`} style={{ marginBottom: 28, scrollMarginTop: indexHeight + 12 }}>
              <div style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.6, color: 'var(--text)', marginBottom: 10 }}>
                {section.label}
              </div>
              <div style={{ display: 'grid', gap: 10 }}>
                {topics.map(renderTopicCard)}
              </div>
            </div>
          )
        })}
        {(() => {
          const known = new Set(HELP_SECTIONS.map(s => s.key))
          const orphans = HELP_TOPICS.filter(t => !known.has(t.section))
          if (!orphans.length) return null
          return (
            <div style={{ marginBottom: 28 }}>
              <div style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.6, color: 'var(--text)', marginBottom: 12 }}>
                More
              </div>
              <div style={{ display: 'grid', gap: 10 }}>
                {orphans.map(renderTopicCard)}
              </div>
            </div>
          )
        })()}
      </div>
    </div>
  )
}
