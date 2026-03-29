import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api.js'

const CAT_ICONS = ['📦','🛒','🍽️','☕','🏠','🚗','💊','🎬','✈️','💰','🏋️','👕','💻','🐾','🎁','🔧','📱','🏥','🎨','🌿']

function NewCategoryForm({ groups, mode, defaultGroupId, onSave, onCancel }) {
  const [name, setName] = useState('')
  const [groupId, setGroupId] = useState(defaultGroupId || (groups[0]?.id ?? ''))
  const [icon, setIcon] = useState('📦')
  const [saving, setSaving] = useState(false)
  const inputRef = useRef(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  async function handleSave() {
    if (!name.trim()) return
    if (mode === 'leaf' && !groupId) return
    setSaving(true)
    const body = mode === 'group'
      ? { name: name.trim(), icon, parent_id: null }
      : { name: name.trim(), icon, parent_id: groupId }
    const created = await api.createCategory(body)
    await onSave(created)
    setSaving(false)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }} onMouseDown={e => e.stopPropagation()}>
      {mode === 'leaf' && groups.length > 1 && (
        <select value={groupId} onChange={e => setGroupId(e.target.value)} style={{ background: 'var(--surface2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: '5px 8px', fontSize: 12 }}>
          {groups.map(g => <option key={g.id} value={g.id}>{g.icon} {g.name}</option>)}
        </select>
      )}
      <input
        ref={inputRef}
        value={name}
        onChange={e => setName(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') handleSave(); if (e.key === 'Escape') onCancel() }}
        placeholder={mode === 'group' ? 'Group name…' : 'Category name…'}
        style={{ background: 'var(--surface2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: '6px 8px', fontSize: 13, outline: 'none' }}
      />
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
        {CAT_ICONS.map(ic => (
          <button key={ic} onClick={() => setIcon(ic)} style={{ fontSize: 14, padding: '2px 4px', borderRadius: 4, cursor: 'pointer', border: ic === icon ? '1px solid var(--accent)' : '1px solid transparent', background: ic === icon ? 'color-mix(in srgb, var(--accent) 12%, var(--surface2))' : 'none' }}>{ic}</button>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <button onClick={handleSave} disabled={saving || !name.trim()} style={{ flex: 1, background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 6, padding: '5px 0', fontSize: 12, cursor: saving || !name.trim() ? 'not-allowed' : 'pointer', opacity: saving || !name.trim() ? 0.5 : 1 }}>{saving ? 'Saving…' : 'Create'}</button>
        <button onClick={onCancel} style={{ background: 'var(--surface2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: '5px 10px', fontSize: 12, cursor: 'pointer' }}>Cancel</button>
      </div>
    </div>
  )
}

export default function CategoryPicker({
  value,
  categories,
  onChange,
  onCategoryCreated,
  placeholder = 'Type to search categories…',
  style,
}) {
  const [open, setOpen] = useState(false)
  const [creating, setCreating] = useState(null)
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const ref = useRef(null)
  const inputRef = useRef(null)
  const groups = categories.filter(c => !c.parent_id)
  const leaves = categories.filter(c => c.parent_id)
  const selected = categories.find(c => c.id === value)
  const filtered = query.trim()
    ? leaves.filter(c => {
        const haystack = `${c.name} ${groups.find(g => g.id === c.parent_id)?.name || ''}`.toLowerCase()
        return haystack.includes(query.toLowerCase())
      })
    : leaves

  useEffect(() => {
    setCursor(0)
  }, [query])

  useEffect(() => {
    if (!open) setCreating(null)
  }, [open])

  useEffect(() => {
    if (!open) return
    function h(e) {
      if (ref.current && !ref.current.contains(e.target)) {
        setOpen(false)
        setCreating(null)
      }
    }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [open])

  async function handleCreated(created) {
    await onCategoryCreated?.()
    onChange(created.id)
    setQuery(created.name)
    setCreating(null)
    setOpen(false)
  }

  function pick(cat) {
    onChange(cat.id)
    setQuery(cat.name)
    setOpen(false)
    setCreating(null)
  }

  function handleKeyDown(e) {
    e.stopPropagation()
    if (!open && (e.key === 'ArrowDown' || e.key === 'Enter')) {
      e.preventDefault()
      setOpen(true)
      return
    }
    if (e.key === 'Escape') {
      setOpen(false)
      setCreating(null)
      return
    }
    if (creating || !open || filtered.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setCursor(c => Math.min(c + 1, filtered.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setCursor(c => Math.max(c - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      pick(filtered[cursor])
    }
  }

  return (
    <div ref={ref} style={{ position: 'relative', flex: 1, ...style }}>
      <div style={{ background: 'var(--surface)', color: 'var(--text)', border: open ? '1px solid var(--accent)' : '1px solid var(--border)', borderRadius: 8, padding: '6px 10px', fontSize: 13, display: 'flex', alignItems: 'center', gap: 6, minHeight: 38 }}>
        <input
          ref={inputRef}
          value={query}
          onFocus={() => setOpen(true)}
          onChange={e => { setQuery(e.target.value); setOpen(true); setCreating(null) }}
          onKeyDown={handleKeyDown}
          onMouseDown={e => e.stopPropagation()}
          placeholder={selected ? `${selected.icon} ${selected.name}` : placeholder}
          style={{ flex: 1, background: 'none', color: 'var(--text)', border: 'none', outline: 'none', fontSize: 13, minWidth: 0 }}
        />
        <button
          type="button"
          onMouseDown={e => {
            e.preventDefault()
            setOpen(v => !v)
            setCreating(null)
            inputRef.current?.focus()
          }}
          style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 11, padding: '0 2px', lineHeight: 1 }}
          title="Browse categories"
        >
          {open ? '▴' : '▾'}
        </button>
      </div>
      {open && (
        <div style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 300, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,0.25)', maxHeight: 300, overflowY: 'auto' }}>
          {creating === 'group' ? (
            <div style={{ padding: 10 }}>
              <NewCategoryForm groups={groups} mode="group" defaultGroupId={null} onSave={handleCreated} onCancel={() => setCreating(null)} />
            </div>
          ) : (
            <>
              {query.trim() ? (
                filtered.length === 0 ? (
                  <div style={{ padding: '10px 12px', fontSize: 13, color: 'var(--muted)' }}>No matching categories</div>
                ) : filtered.map((c, idx) => {
                  const parent = groups.find(g => g.id === c.parent_id)
                  const active = idx === cursor
                  const selectedRow = value === c.id
                  return (
                    <div
                      key={c.id}
                      onMouseDown={e => { e.preventDefault(); pick(c) }}
                      onMouseEnter={() => setCursor(idx)}
                      style={{
                        padding: '7px 12px',
                        fontSize: 13,
                        cursor: 'pointer',
                        background: active || selectedRow ? 'color-mix(in srgb, var(--accent) 12%, var(--surface2))' : 'transparent',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 7,
                      }}
                    >
                      <span>{c.icon} {c.name}</span>
                      {parent && <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--muted)' }}>{parent.name}</span>}
                    </div>
                  )
                })
              ) : groups.map(g => {
                const kids = leaves.filter(c => c.parent_id === g.id)
                const creatingHere = creating?.type === 'leaf' && creating.groupId === g.id
                return (
                  <div key={g.id}>
                    <div style={{ padding: '6px 12px 2px', fontSize: 11, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{g.icon} {g.name}</div>
                    {kids.map(c => (
                      <div
                        key={c.id}
                        onMouseDown={e => { e.preventDefault(); pick(c) }}
                        style={{ padding: '7px 12px 7px 28px', fontSize: 13, cursor: 'pointer', background: value === c.id ? 'color-mix(in srgb, var(--accent) 12%, var(--surface2))' : 'transparent', display: 'flex', alignItems: 'center', gap: 7 }}
                        onMouseEnter={e => e.currentTarget.style.background = 'var(--surface2)'}
                        onMouseLeave={e => e.currentTarget.style.background = value === c.id ? 'color-mix(in srgb, var(--accent) 12%, var(--surface2))' : 'transparent'}
                      >
                        {c.icon} {c.name}
                        {value === c.id && <span style={{ marginLeft: 'auto', color: 'var(--accent2)', fontSize: 11 }}>✓</span>}
                      </div>
                    ))}
                    {creatingHere ? (
                      <div style={{ padding: '6px 12px 8px 20px' }}>
                        <NewCategoryForm groups={groups} mode="leaf" defaultGroupId={g.id} onSave={handleCreated} onCancel={() => setCreating(null)} />
                      </div>
                    ) : (
                      <div
                        onMouseDown={e => { e.stopPropagation(); setCreating({ type: 'leaf', groupId: g.id }) }}
                        style={{ padding: '5px 12px 6px 28px', fontSize: 12, color: 'var(--accent2)', cursor: 'pointer', opacity: 0.8 }}
                        onMouseEnter={e => e.currentTarget.style.opacity = '1'}
                        onMouseLeave={e => e.currentTarget.style.opacity = '0.8'}
                      >
                        ＋ New category in {g.name}
                      </div>
                    )}
                  </div>
                )
              })}
              <div style={{ borderTop: '1px solid var(--border)', margin: '4px 0' }} />
              <div
                onMouseDown={e => { e.stopPropagation(); setCreating('group') }}
                style={{ padding: '7px 12px', fontSize: 12, fontWeight: 500, color: 'var(--accent2)', cursor: 'pointer', opacity: 0.8 }}
                onMouseEnter={e => e.currentTarget.style.opacity = '1'}
                onMouseLeave={e => e.currentTarget.style.opacity = '0.8'}
              >
                ＋ New group
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
