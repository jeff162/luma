// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: GPL-3.0-or-later

import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../lib/api.js'
import { useFilters } from '../lib/FilterContext.jsx'
import { Card, PageHeader, Spinner } from '../components/ui.jsx'

const SEVERITY_COLORS = {
  warning: { bg: 'color-mix(in srgb, #f59e0b 10%, var(--surface2))', border: '#f59e0b', icon: '!' },
  info: { bg: 'color-mix(in srgb, var(--accent) 8%, var(--surface2))', border: 'var(--accent)', icon: 'i' },
}

function TaskSeverityIcon({ severity }) {
  const style = SEVERITY_COLORS[severity] || SEVERITY_COLORS.info
  const isInfo = severity === 'info'
  return (
    <span
      aria-hidden="true"
      style={{
        width: 22,
        height: 22,
        flexShrink: 0,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: '50%',
        border: `1px solid ${style.border}`,
        background: isInfo
          ? 'color-mix(in srgb, var(--accent) 84%, var(--surface) 16%)'
          : 'color-mix(in srgb, #f59e0b 72%, var(--surface) 28%)',
        color: isInfo ? '#f8fafc' : '#fff7ed',
        fontSize: isInfo ? 13 : 15,
        fontWeight: 700,
        fontFamily: isInfo ? 'Georgia, "Times New Roman", serif' : 'inherit',
        fontStyle: isInfo ? 'italic' : 'normal',
        lineHeight: 1,
        marginTop: 1,
      }}
    >
      {style.icon}
    </span>
  )
}

function TaskCard({ task }) {
  const style = SEVERITY_COLORS[task.severity] || SEVERITY_COLORS.info
  const { clearAll } = useFilters()
  // Task counts are global (e.g. all-time uncategorized), but the shared FilterBar defaults to a
  // "Past 12 months" date window. Clear filters when jumping to a transaction view so the user lands
  // on the same set the badge counted instead of a narrower, confusingly-different number.
  const handleClick = task.link.startsWith('/transactions') ? () => clearAll() : undefined
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 16,
        padding: '16px 20px',
        background: style.bg,
        border: `1px solid ${style.border}`,
        borderRadius: 10,
        marginBottom: 12,
      }}
    >
      <TaskSeverityIcon severity={task.severity} />
      <div style={{ flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 4 }}>
          <span style={{ fontSize: 15, fontWeight: 600 }}>{task.title}</span>
          <span
            style={{
              fontSize: 12,
              fontWeight: 700,
              padding: '1px 8px',
              background: style.border,
              color: '#fff',
              borderRadius: 99,
            }}
          >
            {task.count}
          </span>
        </div>
        <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 10 }}>
          {task.description}
        </div>
        <Link
          to={task.link}
          onClick={handleClick}
          style={{
            display: 'inline-block',
            fontSize: 13,
            fontWeight: 500,
            color: 'var(--accent2)',
            textDecoration: 'none',
            padding: '5px 14px',
            borderRadius: 6,
            border: '1px solid var(--border)',
            background: 'var(--surface)',
          }}
        >
          {task.link_label} {'->'}
        </Link>
      </div>
    </div>
  )
}

export default function Tasks() {
  const [result, setResult] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    function fetchTasks() {
      api.getTasks().then(r => {
        if (cancelled) return
        setResult(r)
        setLoading(false)
      })
    }
    fetchTasks()
    // Re-fetch when work elsewhere (categorizing transactions, etc.) resolves task items,
    // so the per-task counts shown here stay current without a manual reload.
    window.addEventListener('fintrack:refresh-tasks', fetchTasks)
    return () => {
      cancelled = true
      window.removeEventListener('fintrack:refresh-tasks', fetchTasks)
    }
  }, [])

  return (
    <div data-browser-context-passthrough="true" style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ padding: '32px 32px 0', maxWidth: 640, flexShrink: 0 }}>
        <PageHeader title="Tasks" />
      </div>
      <div data-browser-context-passthrough="true" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 32px 32px' }}>
        {loading ? (
          <Spinner />
        ) : result?.tasks?.length === 0 ? (
          // Keep the empty state intentionally quiet so this page feels like an inbox:
          // visual urgency comes from the tasks themselves, not from "all clear."
          <Card
            style={{
              textAlign: 'center',
              padding: '48px 32px',
              maxWidth: 640,
              border: '2px dashed var(--border)',
              borderRadius: 12,
              background: 'var(--surface2)',
            }}
          >
            <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 6 }}>
              {'<'}<span style={{ fontStyle: 'italic' }}>empty</span>{'>'}
            </div>
            <div style={{ fontSize: 13, color: 'var(--muted)' }}>
              Nothing requires attention
            </div>
          </Card>
        ) : (
          <div style={{ maxWidth: 640 }}>
            {result?.tasks?.map(task => <TaskCard key={task.id} task={task} />)}
          </div>
        )}
      </div>
    </div>
  )
}
