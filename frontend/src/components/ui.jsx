// Shared UI primitives

export function Card({ children, style }) {
  return (
    <div style={{
      background: 'var(--surface)', border: '1px solid var(--border)',
      borderRadius: 12, padding: 20, ...style,
    }}>
      {children}
    </div>
  )
}

export function PageHeader({ title, children }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      marginBottom: 24,
    }}>
      <h1 style={{ fontSize: 22, fontWeight: 600 }}>{title}</h1>
      <div style={{ display: 'flex', gap: 8 }}>{children}</div>
    </div>
  )
}

export function Button({ children, onClick, variant = 'primary', small, disabled, style }) {
  const base = {
    padding: small ? '6px 12px' : '9px 16px',
    borderRadius: 8, border: 'none', cursor: disabled ? 'not-allowed' : 'pointer',
    fontSize: small ? 13 : 14, fontWeight: 500, transition: 'opacity 0.15s',
    opacity: disabled ? 0.5 : 1, ...style,
  }
  const variants = {
    primary:  { background: 'var(--accent)',  color: '#fff' },
    ghost:    { background: 'var(--surface2)', color: 'var(--text)' },
    danger:   { background: 'var(--danger)',  color: '#fff' },
  }
  return (
    <button onClick={disabled ? undefined : onClick} style={{ ...base, ...variants[variant] }}>
      {children}
    </button>
  )
}

export function Select({ value, onChange, options, style }) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      style={{
        background: 'var(--surface2)', color: 'var(--text)',
        border: '1px solid var(--border)', borderRadius: 8,
        padding: '8px 12px', fontSize: 14, cursor: 'pointer', ...style,
      }}
    >
      {options.map(o => (
        <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>
      ))}
    </select>
  )
}

export function Input({ value, onChange, placeholder, style }) {
  return (
    <input
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      style={{
        background: 'var(--surface2)', color: 'var(--text)',
        border: '1px solid var(--border)', borderRadius: 8,
        padding: '8px 12px', fontSize: 14, outline: 'none', ...style,
      }}
    />
  )
}

export function Badge({ label, icon }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      background: 'var(--surface2)',
      color: 'var(--text)',
      border: '1px solid var(--border)',
      borderRadius: 99, padding: '2px 8px', fontSize: 12, fontWeight: 500,
      whiteSpace: 'nowrap',
    }}>
      {icon && <span style={{ fontSize: 11 }}>{icon}</span>}
      {label}
    </span>
  )
}

export function Spinner() {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 40, color: 'var(--muted)', fontSize: 14,
    }}>
      Loading…
    </div>
  )
}

export function EmptyState({ message }) {
  return (
    <div style={{
      textAlign: 'center', padding: '48px 24px',
      color: 'var(--muted)', fontSize: 14,
    }}>
      {message}
    </div>
  )
}

export function GroupedSelect({ value, onChange, groups, extra = [], style }) {
  // groups: [{ label, color, icon, options: [{ value, label, icon }] }]
  // extra:  flat options appended after the groups (e.g. "+ New category...")
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      style={{
        background: 'var(--surface2)', color: 'var(--text)',
        border: '1px solid var(--border)', borderRadius: 8,
        padding: '8px 12px', fontSize: 14, cursor: 'pointer', ...style,
      }}
    >
      {groups.map(g => (
        <optgroup key={g.value || g.label} label={`${g.icon || ''} ${g.label}`}>
          {(g.options || []).map(o => (
            <option key={o.value} value={o.value}>{o.icon} {o.label}</option>
          ))}
        </optgroup>
      ))}
      {extra.map(o => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  )
}
