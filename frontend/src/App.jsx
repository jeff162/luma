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
import { api } from './lib/api.js'

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

        if (!status.auth_enabled) {
          setCurrentUser(status.user || null)
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

  async function handleLogout() {
    await api.logout().catch(() => {})
    setCurrentUser(null)
    setTaskCount(0)
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
              <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 4 }}>Signed in as</div>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>
                {authEnabled ? (currentUser?.display_name || currentUser?.username) : 'Local access mode'}
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
      </FilterProvider>
    </AppErrorBoundary>
  )
}
