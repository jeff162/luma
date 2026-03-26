import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../lib/api.js'
import { Card, PageHeader, Spinner } from '../components/ui.jsx'

const SEVERITY_COLORS = {
  warning: { bg: 'color-mix(in srgb, #f59e0b 10%, var(--surface2))', border: '#f59e0b', icon: '!' },
  info: { bg: 'color-mix(in srgb, var(--accent) 8%, var(--surface2))', border: 'var(--accent)', icon: 'i' },
}

function TaskCard({ task }) {
  const style = SEVERITY_COLORS[task.severity] || SEVERITY_COLORS.info
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
      <span style={{ fontSize: 22, flexShrink: 0, marginTop: 1 }}>{style.icon}</span>
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
    api.getTasks().then(r => {
      setResult(r)
      setLoading(false)
    })
  }, [])

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ padding: '32px 32px 0', maxWidth: 640, flexShrink: 0 }}>
        <PageHeader title="Tasks" />
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 32px 32px' }}>
        <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 24, maxWidth: 640 }}>
          Things that need your attention. Items clear automatically when resolved.
        </div>

        {loading ? (
          <Spinner />
        ) : result?.tasks?.length === 0 ? (
          <Card style={{ textAlign: 'center', padding: '40px 24px', maxWidth: 640 }}>
            <div style={{ fontSize: 32, marginBottom: 12 }}>OK</div>
            <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 6 }}>All clear</div>
            <div style={{ fontSize: 13, color: 'var(--muted)' }}>
              No action items right now. Check back after importing new data.
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
