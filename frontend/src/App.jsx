import { useState, useEffect, Component } from 'react'
import { Routes, Route, NavLink } from 'react-router-dom'
import { FilterProvider } from './lib/FilterContext.jsx'
import FilterBar from './components/FilterBar.jsx'
import AuthScreen from './components/AuthScreen.jsx'
import RuntimeConfigScreen from './components/RuntimeConfigScreen.jsx'
import Dashboard from './pages/Dashboard.jsx'
import Transactions from './pages/Transactions.jsx'
import Categories from './pages/Categories.jsx'
import Rules from './pages/Rules.jsx'
import Accounts from './pages/Accounts.jsx'
import Settings from './pages/Settings.jsx'
import ImportExport from './pages/ImportExport.jsx'
import Tasks from './pages/Tasks.jsx'
import { api, setLocalPreferenceProfileId } from './lib/api.js'

class AppErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { error: null } }
  static getDerivedStateFromError(e) { return { error: e } }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 40, fontFamily: 'sans-serif' }}>
          <h2 style={{ color: '#ef4444', marginBottom: 12 }}>Something went wrong</h2>
          <pre style={{ fontSize: 13, color: '#666', marginBottom: 20, whiteSpace: 'pre-wrap' }}>
            {this.state.error?.message}
          </pre>
          <button
            onClick={() => this.setState({ error: null })}
            style={{ padding: '8px 18px', cursor: 'pointer', borderRadius: 6, border: '1px solid #ccc' }}
          >
            Try again
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

const s = {
  shell: { display: 'flex', height: '100vh', overflow: 'hidden' },
  nav: {
    width: 220, background: 'var(--surface)', borderRight: '1px solid var(--border)',
    display: 'flex', flexDirection: 'column', padding: '24px 0', flexShrink: 0,
  },
  logo: {
    fontSize: 20, fontWeight: 700, color: 'var(--accent2)',
    padding: '0 20px 28px', letterSpacing: '-0.5px',
  },
  link: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '10px 20px', color: 'var(--muted)',
    textDecoration: 'none', fontSize: 14, borderRadius: 6,
    margin: '1px 8px', transition: 'all 0.15s',
  },
  main: { flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minHeight: 0 },
  content: { flex: 1, overflow: 'hidden', minHeight: 0 },
  navFooter: { marginTop: 'auto', padding: '18px 16px 0', borderTop: '1px solid var(--border)' },
}

const activeStyle = { ...s.link, background: 'var(--surface2)', color: 'var(--text)' }

const NAV_LINKS = [
  ['/', 'Dashboard'],
  ['/transactions', 'Transactions'],
  ['/categories', 'Categories'],
  ['/rules', 'Rules'],
  ['/accounts', 'Accounts'],
  ['/import-export', 'Import / Export'],
  ['/tasks', 'Tasks'],
  ['/settings', 'Settings'],
]

const LOCAL_PROFILE_STORAGE_KEY_PREFIX = 'fintrack.localPreferenceProfile'

function getLocalProfileStorageKey(dbInstanceId) {
  return dbInstanceId ? `${LOCAL_PROFILE_STORAGE_KEY_PREFIX}.${dbInstanceId}` : null
}

function LocalPreferenceProfileScreen({
  profiles,
  onSelect,
  onCreate,
  onRename,
  onDelete,
  creating,
  showModePill,
  showCancel = false,
  onCancel,
}) {
  const [name, setName] = useState('')
  const [editingId, setEditingId] = useState(null)
  const [editingName, setEditingName] = useState('')
  const [menu, setMenu] = useState(null)

  const hasProfiles = profiles.length > 0

  useEffect(() => {
    if (!menu) return
    function handleClick() {
      setMenu(null)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [menu])

  return (
    <div style={{
      minHeight: '100vh',
      display: 'grid',
      placeItems: 'center',
      padding: 24,
      background: 'radial-gradient(circle at top, color-mix(in srgb, var(--accent) 8%, transparent), transparent 36%), radial-gradient(circle at bottom right, color-mix(in srgb, var(--accent2) 6%, transparent), transparent 32%), linear-gradient(180deg, color-mix(in srgb, var(--surface2) 48%, var(--bg)) 0%, var(--bg) 100%)',
    }}>
      <div style={{
        width: 'min(560px, 100%)',
        background: 'var(--surface)',
        border: '1px solid color-mix(in srgb, var(--border) 82%, white 5%)',
        borderRadius: 20,
        padding: 28,
        boxShadow: '0 18px 48px rgba(0,0,0,0.14)',
      }}>
        <div style={{ marginBottom: 18 }}>
          <div>
        {showModePill ? (
          <div style={{
            display: 'inline-flex',
            alignItems: 'center',
            padding: '5px 11px',
            borderRadius: 999,
            background: 'color-mix(in srgb, var(--accent) 12%, var(--surface2))',
            color: 'var(--accent2)',
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            marginBottom: 14,
          }}>
            Local access mode
          </div>
        ) : null}
            <div style={{ fontSize: 22, fontWeight: 600, marginBottom: 6, letterSpacing: '-0.02em', lineHeight: 1.1 }}>User profiles</div>
            <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.55, maxWidth: 410, paddingLeft: 10 }}>
              Tracks layout and view preferences.
            </div>
          </div>
        </div>

        {hasProfiles ? (
          <div style={{
            marginBottom: 18,
            padding: 15,
            borderRadius: 16,
            border: '1px solid color-mix(in srgb, var(--border) 88%, white 4%)',
            background: 'color-mix(in srgb, var(--surface2) 42%, transparent)',
          }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', marginBottom: 10 }}>
              Current Users
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
            {profiles.map(profile => (
              <div
                key={profile.id}
                style={{
                  position: 'relative',
                  display: 'inline-flex',
                  alignItems: 'center',
                  minWidth: 0,
                }}
              >
                {editingId === profile.id ? (
                  <input
                    autoFocus
                    value={editingName}
                    onChange={e => setEditingName(e.target.value)}
                    onBlur={() => {
                      const next = editingName.trim()
                      setEditingId(null)
                      if (next && next !== profile.name) onRename(profile.id, next)
                    }}
                    onKeyDown={e => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        const next = editingName.trim()
                        setEditingId(null)
                        if (next && next !== profile.name) onRename(profile.id, next)
                      }
                      if (e.key === 'Escape') {
                        setEditingId(null)
                        setEditingName(profile.name)
                      }
                    }}
                    style={{
                      background: 'var(--surface)',
                      color: 'var(--text)',
                      border: '1px solid var(--accent)',
                      borderRadius: 999,
                      padding: '9px 30px 9px 15px',
                      fontSize: 13,
                      minWidth: 120,
                      outline: 'none',
                    }}
                  />
                ) : (
                  <button
                    onClick={() => onSelect(profile)}
                    onContextMenu={e => {
                      e.preventDefault()
                      setMenu({
                        profile,
                        x: e.clientX,
                        y: e.clientY,
                      })
                    }}
                    style={{
                      background: 'var(--surface)',
                      color: 'var(--text)',
                      border: '1px solid color-mix(in srgb, var(--border) 90%, white 4%)',
                      borderRadius: 999,
                      padding: '10px 16px',
                      fontSize: 13,
                      cursor: 'pointer',
                      boxShadow: '0 4px 12px rgba(0,0,0,0.04)',
                      fontWeight: 600,
                    }}
                    title="Click to use"
                  >
                    {profile.name}
                  </button>
                )}
              </div>
            ))}
            </div>
          </div>
        ) : null}

        <div style={{
          padding: 17,
          background: 'color-mix(in srgb, var(--surface2) 36%, transparent)',
          border: '1px solid color-mix(in srgb, var(--border) 88%, white 4%)',
          borderRadius: 16,
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>
            {hasProfiles ? 'New profile' : 'Add the first user'}
          </div>
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && name.trim() && !creating) onCreate(name.trim(), () => setName(''))
            }}
            placeholder="user name"
            style={{
              background: 'var(--surface)',
              color: 'var(--text)',
              border: '1px solid var(--border)',
              borderRadius: 12,
              padding: '12px 14px',
              fontSize: 13,
              outline: 'none',
            }}
          />
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button
              onClick={() => name.trim() && onCreate(name.trim(), () => setName(''))}
              disabled={!name.trim() || creating}
              style={{
                background: !name.trim() || creating ? 'var(--surface)' : 'var(--accent)',
                color: !name.trim() || creating ? 'var(--muted)' : '#fff',
                border: !name.trim() || creating ? '1px solid var(--border)' : 'none',
                borderRadius: 10,
                padding: '9px 16px',
                fontSize: 13,
                fontWeight: 600,
                cursor: !name.trim() || creating ? 'not-allowed' : 'pointer',
              }}
            >
              {creating ? 'Creating…' : hasProfiles ? 'Create user' : 'Create and continue'}
            </button>
            {showCancel ? (
              <button
                onClick={onCancel}
                style={{
                  marginLeft: 'auto',
                  background: 'none',
                  color: 'var(--muted)',
                  border: '1px solid var(--border)',
                  borderRadius: 10,
                  padding: '9px 14px',
                  fontSize: 13,
                  cursor: 'pointer',
                }}
              >
                Cancel
              </button>
            ) : null}
          </div>
        </div>
      </div>
      {menu ? (
        <div
          onMouseDown={e => e.stopPropagation()}
          style={{
            position: 'fixed',
            left: Math.min(menu.x, window.innerWidth - 160),
            top: Math.min(menu.y, window.innerHeight - 100),
            zIndex: 20,
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 10,
            boxShadow: '0 14px 36px rgba(0,0,0,0.18)',
            padding: 4,
            minWidth: 150,
          }}
        >
          <button
            onClick={() => {
              setEditingId(menu.profile.id)
              setEditingName(menu.profile.name)
              setMenu(null)
            }}
            style={{
              display: 'block',
              width: '100%',
              textAlign: 'left',
              background: 'none',
              border: 'none',
              color: 'var(--text)',
              fontSize: 13,
              padding: '8px 10px',
              borderRadius: 6,
              cursor: 'pointer',
            }}
          >
            Rename
          </button>
          <button
            onClick={() => {
              onDelete(menu.profile)
              setMenu(null)
            }}
            style={{
              display: 'block',
              width: '100%',
              textAlign: 'left',
              background: 'none',
              border: 'none',
              color: 'var(--danger)',
              fontSize: 13,
              padding: '8px 10px',
              borderRadius: 6,
              cursor: 'pointer',
            }}
          >
            Delete
          </button>
        </div>
      ) : null}
    </div>
  )
}

export function refreshTaskBadge() {
  window.dispatchEvent(new CustomEvent('fintrack:refresh-tasks'))
}

export default function App() {
  const [taskCount, setTaskCount] = useState(0)
  const [authChecked, setAuthChecked] = useState(false)
  const [authEnabled, setAuthEnabled] = useState(false)
  const [needsBootstrap, setNeedsBootstrap] = useState(false)
  const [currentUser, setCurrentUser] = useState(null)
  const [authError, setAuthError] = useState(null)
  const [runtimeConfig, setRuntimeConfig] = useState({ ok: true })
  const [passwordPolicy, setPasswordPolicy] = useState('min_8')
  const [securityProfile, setSecurityProfile] = useState('local_private')
  const [experimentalSecuritySettings, setExperimentalSecuritySettings] = useState(false)
  const [dbInstanceId, setDbInstanceId] = useState('')
  const [localProfiles, setLocalProfiles] = useState([])
  const [activeLocalProfile, setActiveLocalProfile] = useState(null)
  const [previousLocalProfile, setPreviousLocalProfile] = useState(null)
  const [localProfilePickerDismissible, setLocalProfilePickerDismissible] = useState(false)
  const [creatingLocalProfile, setCreatingLocalProfile] = useState(false)
  const [navProfileMenu, setNavProfileMenu] = useState(null)
  const [navProfileEditing, setNavProfileEditing] = useState(false)
  const [navProfileDraft, setNavProfileDraft] = useState('')

  useEffect(() => {
    if (!navProfileMenu) return
    function handleClick() {
      setNavProfileMenu(null)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [navProfileMenu])

  useEffect(() => {
    let cancelled = false

    async function loadAuth() {
      try {
        const status = await api.getAuthStatus()
        if (cancelled) return
        setRuntimeConfig(status.runtime_config || { ok: true })
        setAuthEnabled(!!status.auth_enabled)
        setNeedsBootstrap(!!status.needs_bootstrap)
        setPasswordPolicy(status.password_policy || 'min_8')
        setSecurityProfile(status.security_profile || 'local_private')
        setExperimentalSecuritySettings(!!status.experimental_security_settings)
        setDbInstanceId(status.db_instance_id || '')

        if (!status.auth_enabled) {
          const profilesResp = await api.getLocalPreferenceProfiles().catch(() => ({ profiles: [] }))
          if (cancelled) return
          const profiles = profilesResp?.profiles || []
          setLocalProfiles(profiles)
          setCurrentUser(status.user || null)
          const storageKey = getLocalProfileStorageKey(status.db_instance_id || '')
          const rememberedId = storageKey ? window.localStorage.getItem(storageKey) : ''
          const remembered = profiles.find(profile => profile.id === rememberedId) || null
          if (remembered) {
            setLocalPreferenceProfileId(remembered.id)
            setActiveLocalProfile(remembered)
          } else {
            setLocalPreferenceProfileId('')
            setActiveLocalProfile(null)
          }
          setPreviousLocalProfile(null)
          setLocalProfilePickerDismissible(false)
          setAuthChecked(true)
          return
        }

        if (status.needs_bootstrap) {
          setCurrentUser(null)
          setAuthChecked(true)
          return
        }

        setCurrentUser(status.user || null)
        setAuthChecked(true)
      } catch (err) {
        if (cancelled) return
        if (err.status && err.status !== 401) {
          setAuthError(err)
        } else {
          setCurrentUser(null)
        }
        setAuthChecked(true)
      }
    }

    loadAuth()
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (runtimeConfig && runtimeConfig.ok === false) return
    if (authEnabled && !currentUser) return

    function fetchTasks() {
      api.getTasks()
        .then(r => setTaskCount(r?.open_items || 0))
        .catch(() => {})
    }

    fetchTasks()
    window.addEventListener('fintrack:refresh-tasks', fetchTasks)
    return () => window.removeEventListener('fintrack:refresh-tasks', fetchTasks)
  }, [authEnabled, currentUser, runtimeConfig])

  useEffect(() => {
    function isEditableTarget(target) {
      if (!(target instanceof HTMLElement)) return false
      if (target.isContentEditable) return true
      const tag = target.tagName
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
    }

    function handleKeyDown(e) {
      if (e.key !== 'Backspace') return
      if (isEditableTarget(e.target)) return
      e.preventDefault()
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  useEffect(() => {
    function handleContextMenu(e) {
      const target = e.target
      if (!(target instanceof HTMLElement)) return
      const passThrough = target.closest('[data-browser-context-passthrough="true"]')
      if (passThrough && passThrough === target) return
      e.preventDefault()
    }

    document.addEventListener('contextmenu', handleContextMenu, true)
    return () => document.removeEventListener('contextmenu', handleContextMenu, true)
  }, [])

  async function handleLogout() {
    await api.logout().catch(() => {})
    setCurrentUser(null)
    setTaskCount(0)
  }

  function handleSwitchLocalProfile() {
    setPreviousLocalProfile(activeLocalProfile)
    setLocalProfilePickerDismissible(true)
    setActiveLocalProfile(null)
    setLocalPreferenceProfileId('')
  }

  function activateLocalProfile(profile) {
    setActiveLocalProfile(profile)
    setPreviousLocalProfile(null)
    setLocalProfilePickerDismissible(false)
    setNavProfileEditing(false)
    setNavProfileMenu(null)
    setLocalPreferenceProfileId(profile?.id || '')
    const storageKey = getLocalProfileStorageKey(dbInstanceId)
    if (storageKey) {
      try {
        if (profile?.id) window.localStorage.setItem(storageKey, profile.id)
      } catch {}
    }
  }

  async function handleCreateLocalProfile(name, clearForm) {
    setCreatingLocalProfile(true)
    try {
      const resp = await api.createLocalPreferenceProfile(name)
      const profile = resp?.profile
      if (!profile) return
      setLocalProfiles(prev => {
        const exists = prev.find(item => item.id === profile.id)
        return exists ? prev : [...prev, profile].sort((a, b) => a.name.localeCompare(b.name))
      })
      activateLocalProfile(profile)
      clearForm?.()
    } finally {
      setCreatingLocalProfile(false)
    }
  }

  async function handleRenameLocalProfile(profileId, name) {
    const resp = await api.updateLocalPreferenceProfile(profileId, name)
    const updated = resp?.profile
    if (!updated) return
    setLocalProfiles(prev => prev.map(profile => profile.id === profileId ? updated : profile).sort((a, b) => a.name.localeCompare(b.name)))
    setActiveLocalProfile(prev => prev?.id === profileId ? updated : prev)
    if (activeLocalProfile?.id === profileId) {
      setNavProfileDraft(updated.name)
    }
  }

  async function handleDeleteLocalProfile(profile) {
    if (!confirm(`Delete user profile "${profile.name}"?`)) return
    await api.deleteLocalPreferenceProfile(profile.id)
    setLocalProfiles(prev => prev.filter(item => item.id !== profile.id))
    const deletedCurrentProfile =
      activeLocalProfile?.id === profile.id || previousLocalProfile?.id === profile.id

    if (deletedCurrentProfile) {
      const storageKey = getLocalProfileStorageKey(dbInstanceId)
      if (storageKey) {
        try { window.localStorage.removeItem(storageKey) } catch {}
      }
      setLocalPreferenceProfileId('')
      setActiveLocalProfile(null)
      setPreviousLocalProfile(null)
      setLocalProfilePickerDismissible(false)
      setNavProfileEditing(false)
      setNavProfileMenu(null)
    }
  }

  function cancelLocalProfilePicker() {
    if (!previousLocalProfile) return
    activateLocalProfile(previousLocalProfile)
  }

  async function commitNavProfileRename() {
    const next = navProfileDraft.trim()
    const currentName = activeLocalProfile?.name || ''
    setNavProfileEditing(false)
    if (!activeLocalProfile || !next || next === currentName) {
      setNavProfileDraft(currentName)
      return
    }
    await handleRenameLocalProfile(activeLocalProfile.id, next)
  }

  if (!authChecked) {
    return (
      <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center' }}>
        <div style={{ fontSize: 14, color: 'var(--muted)' }}>Loading FinTrack...</div>
      </div>
    )
  }

  if (authError) {
    throw authError
  }

  if (runtimeConfig && runtimeConfig.ok === false) {
    return <RuntimeConfigScreen runtimeConfig={runtimeConfig} />
  }

  if (authEnabled && !currentUser) {
    return (
      <AppErrorBoundary>
        <AuthScreen
          needsBootstrap={needsBootstrap}
          passwordPolicy={passwordPolicy}
          securityProfile={securityProfile}
          onAuthenticated={user => {
            setCurrentUser(user)
            setAuthEnabled(true)
            setNeedsBootstrap(false)
          }}
        />
      </AppErrorBoundary>
    )
  }

  if (!authEnabled && !activeLocalProfile) {
    return (
      <AppErrorBoundary>
        <LocalPreferenceProfileScreen
          profiles={localProfiles}
          creating={creatingLocalProfile}
          onSelect={activateLocalProfile}
          onCreate={handleCreateLocalProfile}
          onRename={handleRenameLocalProfile}
          onDelete={handleDeleteLocalProfile}
          showModePill={experimentalSecuritySettings}
          showCancel={localProfilePickerDismissible && localProfiles.length > 0}
          onCancel={cancelLocalProfilePicker}
        />
      </AppErrorBoundary>
    )
  }

  return (
    <AppErrorBoundary>
      <FilterProvider>
        <div style={s.shell}>
          <nav style={s.nav}>
            <div style={s.logo}>FinTrack</div>
            {NAV_LINKS.map(([to, label]) => (
              <NavLink
                key={to}
                to={to}
                end={to === '/'}
                style={({ isActive }) => (isActive ? activeStyle : s.link)}
              >
                <span>{label}</span>
                {to === '/tasks' && taskCount > 0 && (
                  <span style={{
                    background: '#f59e0b', color: '#fff',
                    fontSize: 11, fontWeight: 700,
                    padding: '1px 7px', borderRadius: 99,
                    lineHeight: '18px', minWidth: 20, textAlign: 'center',
                  }}>
                    {taskCount}
                  </span>
                )}
              </NavLink>
            ))}
            <div style={s.navFooter}>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 12 }}>
                {authEnabled ? 'Signed in as' : 'Using profile'}{' '}
                {authEnabled ? (
                  <span style={{ fontWeight: 600, color: 'var(--text)' }}>
                    {currentUser?.display_name || currentUser?.username}
                  </span>
                ) : (
                  navProfileEditing && activeLocalProfile ? (
                    <input
                      autoFocus
                      value={navProfileDraft}
                      onChange={e => setNavProfileDraft(e.target.value)}
                      onBlur={commitNavProfileRename}
                      onKeyDown={e => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          commitNavProfileRename()
                        }
                        if (e.key === 'Escape') {
                          setNavProfileEditing(false)
                          setNavProfileDraft(activeLocalProfile.name)
                        }
                      }}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        background: 'var(--surface2)',
                        color: 'var(--text)',
                        border: '1px solid var(--accent)',
                        borderRadius: 999,
                        padding: '4px 10px',
                        fontSize: 12,
                        fontWeight: 600,
                        verticalAlign: 'middle',
                        minWidth: 110,
                        outline: 'none',
                      }}
                    />
                  ) : (
                    <button
                      onClick={handleSwitchLocalProfile}
                      onContextMenu={e => {
                        e.preventDefault()
                        if (!activeLocalProfile) return
                        setNavProfileMenu({
                          x: e.clientX,
                          y: e.clientY,
                        })
                      }}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                        background: 'var(--surface2)',
                        color: 'var(--text)',
                        border: '1px solid var(--border)',
                        borderRadius: 999,
                        padding: '4px 10px',
                        fontSize: 12,
                        fontWeight: 600,
                        cursor: 'pointer',
                        verticalAlign: 'middle',
                      }}
                      title="Switch user profile"
                    >
                      {activeLocalProfile?.name || 'Choose profile'}
                    </button>
                  )
                )}
              </div>
              {authEnabled && (
                <button
                  onClick={handleLogout}
                  style={{
                    width: '100%',
                    background: 'none',
                    border: '1px solid var(--border)',
                    color: 'var(--text)',
                    borderRadius: 8,
                    padding: '8px 10px',
                    cursor: 'pointer',
                  }}
                >
                  Sign out
                </button>
              )}
            </div>
          </nav>
          <div style={s.main}>
            <FilterBar />
            <div style={s.content}>
              <Routes>
                <Route path="/" element={<Dashboard />} />
                <Route path="/transactions" element={<Transactions />} />
                <Route path="/categories" element={<Categories />} />
                <Route path="/rules" element={<Rules />} />
                <Route path="/accounts" element={<Accounts />} />
                <Route path="/import-export" element={<ImportExport />} />
                <Route path="/tasks" element={<Tasks />} />
                <Route path="/settings" element={<Settings />} />
              </Routes>
            </div>
          </div>
        </div>
        {navProfileMenu && activeLocalProfile && (
          <div
            onMouseDown={e => e.stopPropagation()}
            style={{
              position: 'fixed',
              left: Math.min(navProfileMenu.x, window.innerWidth - 160),
              top: Math.min(navProfileMenu.y, window.innerHeight - 100),
              zIndex: 30,
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: 10,
              boxShadow: '0 14px 36px rgba(0,0,0,0.18)',
              padding: 4,
              minWidth: 150,
            }}
          >
            <button
              onClick={() => {
                setNavProfileMenu(null)
                setNavProfileDraft(activeLocalProfile.name)
                setNavProfileEditing(true)
              }}
              style={{
                display: 'block',
                width: '100%',
                textAlign: 'left',
                background: 'none',
                border: 'none',
                borderRadius: 8,
                padding: '8px 10px',
                fontSize: 13,
                cursor: 'pointer',
                color: 'var(--text)',
              }}
            >
              Rename
            </button>
          </div>
        )}
      </FilterProvider>
    </AppErrorBoundary>
  )
}
