// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../lib/api.js'
import { useFilters } from '../lib/FilterContext.jsx'
import { Card, PageHeader, Spinner } from '../components/ui.jsx'
import FeatureExplainer from '../help/FeatureExplainer.jsx'
import { UndoToast } from '../components/CategoryTreePrimitives.jsx'
import CornerTab from '../components/CornerTab.jsx'

/*
 * The nag inbox. Tasks are computed server-side (routers/tasks.py) and re-fetched whenever work
 * elsewhere resolves one, so nothing here is patched in place.
 *
 * A task carrying a `dismiss_key` can be put away. What that stores is the count it was dismissed at,
 * and the task returns when the count rises above it — so dismissing is "not now", never "never
 * again", and new work always resurfaces. The dismissed ones stay reachable at the foot of the page
 * rather than vanishing, because a card that disappears without a trace is indistinguishable from one
 * that was lost.
 */

// The page's content column, named once so the header, the cards and the dismissed list agree.
const TASK_COLUMN = 640

const SEVERITY_COLORS = {
  warning: { bg: 'color-mix(in srgb, var(--warning) 10%, var(--surface2))', border: 'var(--warning)', icon: '!' },
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
          : 'color-mix(in srgb, var(--warning) 72%, var(--surface) 28%)',
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

function TaskCard({ task, onDismiss }) {
  const style = SEVERITY_COLORS[task.severity] || SEVERITY_COLORS.info
  const { clearAll } = useFilters()
  // Task counts are global (e.g. all-time uncategorized), but the shared FilterBar defaults to a
  // "Past 12 months" date window. Clear filters when jumping to a transaction view so the user lands
  // on the same set the badge counted instead of a narrower, confusingly-different number.
  const handleClick = task.link.startsWith('/transactions') ? () => clearAll() : undefined
  return (
    <div
      style={{
        position: 'relative',
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
        {/* Room on the right for the corner tab, so a wrapped action row can never run under it. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', paddingRight: task.dismiss_key ? 72 : 0 }}>
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
      {task.dismiss_key ? (
        // Muted on purpose, as a corner tab: the task's link is the main action.
        <CornerTab
          corner="bottom-right"
          borderColor={style.border}
          onClick={() => onDismiss(task)}
          title="Hide this until there is more of it"
        >
          Dismiss
        </CornerTab>
      ) : null}
    </div>
  )
}

// The dismissed ones, kept at the foot of the page. Collapsed by default: they are deliberately quiet,
// but they must stay reachable, and each says what it is hiding so restoring one is an informed choice.
function DismissedSection({ dismissed, onRestore }) {
  const [open, setOpen] = useState(false)
  if (!dismissed || dismissed.length === 0) return null
  return (
    <div style={{ marginTop: 18, paddingTop: 12, borderTop: '1px solid var(--border)', maxWidth: TASK_COLUMN }}>
      <button
        onClick={() => setOpen(v => !v)}
        style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', fontSize: 12, fontWeight: 600, padding: 0, display: 'inline-flex', alignItems: 'center', gap: 6 }}
      >
        <span style={{ fontSize: 9 }}>{open ? '▾' : '▸'}</span>
        {dismissed.length} dismissed
      </button>
      {open ? (
        <div style={{ marginTop: 8 }}>
          {dismissed.map(task => (
            <div
              key={task.id}
              style={{
                display: 'flex', alignItems: 'center', gap: 12, padding: '7px 2px',
                borderBottom: '1px solid color-mix(in srgb, var(--border) 60%, transparent)',
              }}
            >
              <span style={{ flex: 1, minWidth: 0, fontSize: 13 }}>{task.title}</span>
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>{task.count}</span>
              <button
                onClick={() => onRestore(task)}
                style={{
                  background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6,
                  cursor: 'pointer', color: 'var(--text)', fontSize: 11.5, fontWeight: 500, padding: '3px 9px',
                }}
              >
                Restore
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

export default function Tasks() {
  const [result, setResult] = useState(null)
  const [loading, setLoading] = useState(true)
  const [undo, setUndo] = useState(null)  // { dismiss_key, title } of the last dismissal

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
    // so the per-task counts shown here stay current without a manual reload. Every successful
    // mutation emits `luma:data-mutated` from the api layer (see `signalDataMutated`).
    window.addEventListener('luma:data-mutated', fetchTasks)
    return () => {
      cancelled = true
      window.removeEventListener('luma:data-mutated', fetchTasks)
    }
  }, [])

  // Both calls return the recomputed list, so the page never has to guess what dismissing changed.
  const dismiss = useCallback(async (task) => {
    setResult(await api.dismissTask(task.dismiss_key))
    setUndo({ dismiss_key: task.dismiss_key, title: task.title })
  }, [])

  const restore = useCallback(async (task) => {
    setResult(await api.restoreTask(task.dismiss_key))
    setUndo(null)
  }, [])

  // UndoToast keys its auto-dismiss timer on this callback, so it has to be stable.
  const closeUndo = useCallback(() => setUndo(null), [])

  return (
    <div data-browser-context-passthrough="true" style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {/* The column goes inside the padding, not on the padded element — a maxWidth on a padded box
          measures the column inside the padding, which leaves the header a padding's width narrower
          than the cards below it. Invisible here only because both are left-aligned; it would show the
          moment either was centred. */}
      <div style={{ padding: '32px 32px 0', flexShrink: 0 }}>
        <div style={{ maxWidth: TASK_COLUMN }}>
          <PageHeader title="Tasks" help={<FeatureExplainer topic="page-tasks" placement="bottom-left" />} />
        </div>
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
              maxWidth: TASK_COLUMN,
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
          <div style={{ maxWidth: TASK_COLUMN }}>
            {result?.tasks?.map(task => <TaskCard key={task.id} task={task} onDismiss={dismiss} />)}
          </div>
        )}
        <DismissedSection dismissed={result?.dismissed} onRestore={restore} />
      </div>

      {undo && (
        <UndoToast
          title="Task dismissed"
          description={`"${undo.title}" is hidden until there is more of it.`}
          onUndo={() => restore({ dismiss_key: undo.dismiss_key })}
          onDismiss={closeUndo}
        />
      )}
    </div>
  )
}
