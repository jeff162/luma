// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: GPL-3.0-or-later

import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { Card, PageHeader } from '../components/ui.jsx'
import { HELP_TOPICS, HELP_TOPICS_BY_ID } from '../help/content.jsx'
import { labelForPath } from '../help/navigation.js'

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
  const entry = topic ? HELP_TOPICS_BY_ID[topic] : null
  // Read-more links inside FeatureExplainer popovers stash the source path so we can
  // surface a labeled back affordance. Clicking the Help nav item directly arrives
  // here without that state, in which case the topic-list fallback link is enough.
  const fromPath = location.state?.from
  const fromLabel = fromPath && !fromPath.startsWith('/help') ? labelForPath(fromPath) : null

  if (entry) {
    const Body = entry.body
    return (
      <div style={{ padding: '32px', maxWidth: 760, margin: '0 auto' }}>
        <PageHeader title={entry.title} />
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          {fromLabel ? (
            <button
              type="button"
              onClick={() => navigate(fromPath)}
              style={{
                background: 'none', border: 'none', padding: 0,
                color: 'var(--accent2)', cursor: 'pointer', fontSize: 12,
              }}
            >
              &larr; Back to {fromLabel}
            </button>
          ) : null}
          <Link to="/help" style={{ color: 'var(--accent2)' }}>All help topics</Link>
          {entry.surfaces?.length ? (
            <>
              <span style={{ color: 'var(--border)' }}>&middot;</span>
              <span>Where in the app: {entry.surfaces.join(', ')}</span>
            </>
          ) : null}
        </div>
        <Card style={{ padding: '20px 24px', lineHeight: 1.6, fontSize: 14 }}>
          <Body />
        </Card>
      </div>
    )
  }

  return (
    <div style={{ padding: '32px', maxWidth: 760, margin: '0 auto' }}>
      <PageHeader title="Help" />
      <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.6, marginBottom: 18 }}>
        Short explainers for how features in FinTrack are designed to be used. Each topic also
        appears as a <strong>?</strong> popover next to the feature it describes, so the same
        guidance is one click away when you’re actually looking at the thing.
      </div>
      <div style={{ display: 'grid', gap: 10 }}>
        {HELP_TOPICS.map(t => (
          <Link
            key={t.id}
            to={`/help/${t.id}`}
            style={{ textDecoration: 'none', color: 'inherit' }}
          >
            <Card style={{ padding: '14px 18px' }}>
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>{t.title}</div>
              <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.5 }}>{t.summary}</div>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  )
}
