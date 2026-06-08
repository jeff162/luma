// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: GPL-3.0-or-later

/* eslint-disable react-refresh/only-export-components -- App component + notifyAccountsChanged broadcast helper live together as the app-level shell */

import { useState, useEffect, useRef, Component, lazy, Suspense, useMemo } from 'react'
import { Routes, Route, NavLink, useLocation, useNavigate } from 'react-router-dom'
import { FilterProvider, pastTwelveMonthsRange } from './lib/FilterContext.jsx'
import FilterBar from './components/FilterBar.jsx'
import AuthScreen from './components/AuthScreen.jsx'
import RuntimeConfigScreen from './components/RuntimeConfigScreen.jsx'
import { api, setLocalPreferenceProfileId } from './lib/api.js'
import { UserPreferencesProvider } from './lib/UserPreferencesContext.jsx'
import { AppSessionProvider } from './lib/AppSessionContext.jsx'
import {
  UnifiedDuplicatesViewerProvider,
  UnifiedDuplicatesViewerRenderer,
  MinimizedDuplicatesNavItem,
} from './contexts/UnifiedDuplicatesViewerContext.jsx'
import { PanelStackProvider } from './contexts/PanelStackContext.jsx'
import { useDismissibleLayer, useTransientTextEdit } from './lib/uiInteractions.js'
import { AppConfirmDialog } from './components/ui.jsx'
import TransientTextInput from './components/TransientTextInput.jsx'
import {
  APP_NAME,
  APP_VERSION,
  SUPPORTED_DATA_PROVIDERS,
} from './lib/appConfig.js'

class AppErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { error: null } }
  static getDerivedStateFromError(e) { return { error: e } }
  render() {
    if (this.state.error) {
      return (
        <div data-browser-context-passthrough="true" style={{ padding: 40, fontFamily: 'sans-serif' }}>
          <h2 style={{ color: '#ef4444', marginBottom: 12 }}>Something went wrong</h2>
          <pre data-browser-context-passthrough="true" style={{ fontSize: 13, color: '#666', marginBottom: 20, whiteSpace: 'pre-wrap' }}>
            {this.state.error?.message}
          </pre>
          <button
            onClick={() => this.setState({ error: null })}
            style={{
              padding: '8px 18px',
              cursor: 'pointer',
              borderRadius: 6,
              border: '1px solid color-mix(in srgb, var(--accent) 32%, var(--border))',
              background: 'color-mix(in srgb, var(--surface2) 78%, var(--surface))',
              color: 'var(--text)',
              fontWeight: 600,
            }}
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
    background: 'var(--surface)', borderRight: '1px solid var(--border)',
    display: 'flex', flexDirection: 'column', padding: '24px 0', flexShrink: 0,
    position: 'relative',
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
  ['/help', 'Help'],
]

const LOCAL_PROFILE_STORAGE_KEY_PREFIX = 'fintrack.localPreferenceProfile'
const STARTUP_ROUTE_PREFERENCE_KEY = 'ui.startupRoute'
const DATA_PROVIDER_STARTUP_ROUTE = '/accounts'
const loadDashboardPage = () => import('./pages/Dashboard.jsx')
const loadTransactionsPage = () => import('./pages/Transactions.jsx')
const loadCategoriesPage = () => import('./pages/Categories.jsx')
const loadRulesPage = () => import('./pages/Rules.jsx')
const loadAccountsPage = () => import('./pages/Accounts.jsx')
const loadSettingsPage = () => import('./pages/Settings.jsx')
const loadImportExportPage = () => import('./pages/ImportExport.jsx')
const loadImportRuleSuggestionsPage = () => import('./pages/ImportRuleSuggestions.jsx')
const loadTasksPage = () => import('./pages/Tasks.jsx')
const loadHelpPage = () => import('./pages/Help.jsx')
const Dashboard = lazy(loadDashboardPage)
const Transactions = lazy(loadTransactionsPage)
const Categories = lazy(loadCategoriesPage)
const Rules = lazy(loadRulesPage)
const Accounts = lazy(loadAccountsPage)
const Settings = lazy(loadSettingsPage)
const ImportExport = lazy(loadImportExportPage)
const ImportRuleSuggestions = lazy(loadImportRuleSuggestionsPage)
const Tasks = lazy(loadTasksPage)
const Help = lazy(loadHelpPage)
const ROUTE_PREFETCHERS = [
  loadDashboardPage,
  loadTransactionsPage,
  loadCategoriesPage,
  loadRulesPage,
  loadAccountsPage,
  loadSettingsPage,
  loadImportExportPage,
  loadImportRuleSuggestionsPage,
  loadTasksPage,
  loadHelpPage,
]

// Severity-to-color mapping for the nav Tasks badge. Mirrors the palette used by
// `SEVERITY_COLORS` in Tasks.jsx so the badge in the nav reads as the same severity
// the task cards on the page render with. Ordered by ascending urgency so that
// pickTopTaskSeverity() can pick the worst pending task. Extending: add the new
// severity here AND in TASK_SEVERITY_ORDER, then ensure the backend uses the same key.
const TASK_BADGE_COLORS = {
  info:    'var(--accent)',
  warning: '#f59e0b',
}
const TASK_SEVERITY_ORDER = ['info', 'warning']
function pickTopTaskSeverity(tasks) {
  let best = null
  let bestRank = -1
  for (const task of tasks || []) {
    const rank = TASK_SEVERITY_ORDER.indexOf(task?.severity)
    if (rank > bestRank) { bestRank = rank; best = task?.severity || null }
  }
  return best
}

const GLOBAL_SCROLLBAR_STYLES = `
  * {
    scrollbar-width: thin;
    scrollbar-color: color-mix(in srgb, var(--border) 82%, var(--muted) 18%) color-mix(in srgb, var(--surface2) 52%, transparent);
  }

  *::-webkit-scrollbar {
    width: 10px;
    height: 10px;
  }

  *::-webkit-scrollbar-track {
    background: color-mix(in srgb, var(--surface2) 44%, transparent);
    border-radius: 999px;
  }

  *::-webkit-scrollbar-thumb {
    background: color-mix(in srgb, var(--border) 82%, var(--muted) 18%);
    border: 2px solid color-mix(in srgb, var(--surface2) 44%, transparent);
    border-radius: 999px;
  }

  *::-webkit-scrollbar-thumb:hover {
    background: color-mix(in srgb, var(--text) 18%, var(--border) 82%);
  }

  *::-webkit-scrollbar-corner {
    background: transparent;
  }

  .nav-resize-handle {
    position: absolute;
    top: 0;
    right: -3px;
    bottom: 0;
    width: 6px;
    cursor: col-resize;
    z-index: 2;
    background: transparent;
  }
  .nav-resize-handle::after {
    content: '';
    position: absolute;
    top: 0;
    bottom: 0;
    left: 50%;
    width: 2px;
    transform: translateX(-50%);
    background: var(--accent);
    opacity: 0;
    transition: opacity 0.12s ease;
  }
  .nav-resize-handle:hover::after,
  .nav-resize-handle.is-resizing::after {
    opacity: 0.55;
  }
`

const NAV_PANE_WIDTH_STORAGE_KEY = 'fintrack.ui.navPaneWidth'
const NAV_PANE_DEFAULT_WIDTH = 220
const NAV_PANE_MIN_WIDTH = 140
const NAV_PANE_MAX_WIDTH = NAV_PANE_DEFAULT_WIDTH

function clampNavPaneWidth(value) {
  if (!Number.isFinite(value)) return NAV_PANE_DEFAULT_WIDTH
  return Math.min(NAV_PANE_MAX_WIDTH, Math.max(NAV_PANE_MIN_WIDTH, Math.round(value)))
}

function readStoredNavPaneWidth() {
  try {
    const raw = window.localStorage.getItem(NAV_PANE_WIDTH_STORAGE_KEY)
    if (!raw) return NAV_PANE_DEFAULT_WIDTH
    return clampNavPaneWidth(Number(raw))
  } catch {
    return NAV_PANE_DEFAULT_WIDTH
  }
}

function getLocalProfileStorageKey(dbInstanceId) {
  return dbInstanceId ? `${LOCAL_PROFILE_STORAGE_KEY_PREFIX}.${dbInstanceId}` : null
}

// FilterBar is rendered above the active route; date and saved-filter chips only make sense on pages
// whose content respects them — Dashboard reports and the Transactions ledger. Other pages (Categories,
// Rules, Accounts, Settings, Tasks, Help) operate on their own scope and would otherwise show a bar
// that does nothing. The Import/Export page deliberately uses its own local filter panel so the
// shared chip can stay scoped to the user's "what am I looking at" view without dragging the export
// scope along with it.
function shouldShowFilterBar(pathname) {
  if (pathname === '/') return true
  if (pathname === '/transactions') return true
  return false
}

function DataProviderInfoButton({ label = 'data providers' }) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef(null)

  useDismissibleLayer({
    open,
    onClose: () => setOpen(false),
    refs: [containerRef],
  })

  return (
    <span
      ref={containerRef}
      onMouseLeave={() => setOpen(false)}
      style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}
    >
      <button
        type="button"
        onMouseEnter={() => setOpen(true)}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(current => !current)}
        aria-expanded={open}
        style={{
          background: 'none',
          border: 'none',
          padding: 0,
          margin: 0,
          color: 'var(--accent2)',
          textDecoration: 'underline',
          textUnderlineOffset: '0.18em',
          font: 'inherit',
          cursor: 'pointer',
        }}
      >
        {label}
      </button>
      {open ? (
        <div
          onMouseDown={event => event.stopPropagation()}
          style={{
            position: 'absolute',
            left: 0,
            top: 'calc(100% + 8px)',
            zIndex: 20,
            width: 220,
            padding: '10px 12px',
            borderRadius: 12,
            border: '1px solid color-mix(in srgb, var(--accent) 24%, var(--border))',
            background: 'linear-gradient(180deg, color-mix(in srgb, var(--surface) 94%, white 2%), var(--surface))',
            boxShadow: '0 16px 40px rgba(15, 23, 42, 0.24)',
            display: 'grid',
            gap: 8,
          }}
        >
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>Currently supported</div>
          <div style={{ display: 'grid', gap: 6 }}>
            {SUPPORTED_DATA_PROVIDERS.map(provider => (
              <div key={provider.id} style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
                <span style={{ fontSize: 13, color: 'var(--text)' }}>{provider.name}</span>
                <span style={{ fontSize: 11, color: 'var(--muted)', whiteSpace: 'nowrap' }}>{provider.availability}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </span>
  )
}

function RouteLoadingFallback() {
  return (
    <div style={{
      minHeight: '100%',
      display: 'grid',
      placeItems: 'center',
      padding: 24,
    }}>
      <div style={{ fontSize: 14, color: 'var(--muted)' }}>Loading page...</div>
    </div>
  )
}

function WelcomeNameChip({ value, onRename, onRemove }) {
  const {
    editing,
    draft,
    setDraft,
    beginEdit,
    cancelEdit,
    commitEdit,
  } = useTransientTextEdit(value, {
    onCommit: onRename,
  })

  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        minWidth: 0,
      }}
    >
      {editing ? (
        <TransientTextInput
          value={draft}
          onChange={setDraft}
          onCommit={commitEdit}
          onCancel={cancelEdit}
          restoreOnEscape
          style={{
            background: 'var(--surface)',
            color: 'var(--text)',
            border: '1px solid var(--accent)',
            borderRadius: 999,
            padding: '8px 30px 8px 12px',
            fontSize: 13,
            fontWeight: 600,
            minWidth: 120,
            outline: 'none',
          }}
        />
      ) : (
        <button
          type="button"
          onClick={() => beginEdit(value)}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            padding: '8px 12px',
            borderRadius: 999,
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            color: 'var(--text)',
            fontSize: 13,
            fontWeight: 600,
            cursor: 'text',
          }}
        >
          <span>{value}</span>
        </button>
      )}
      <button
        type="button"
        onClick={onRemove}
        style={{
          background: 'none',
          border: 'none',
          color: 'var(--muted)',
          cursor: 'pointer',
          padding: 0,
          fontSize: 13,
          lineHeight: 1,
        }}
        aria-label={`Remove ${value}`}
      >
        x
      </button>
    </div>
  )
}

/*
 * Local mode uses one surface for two related jobs:
 * - first run expands into a welcome flow that seeds preference profiles, optional account owners,
 *   imported-category defaults, and an optional next step
 * - later visits collapse back to a lightweight profile chooser/switcher
 */
/*
 * In local-access mode these profiles are not auth identities; they are named preference buckets so multiple
 * people can share one install while keeping separate layout, filter, and startup-route state.
 */
function LocalPreferenceProfileScreen({
  profiles,
  onSelect,
  onCreate,
  onCompleteWelcome,
  onRename,
  onDelete,
  creating,
  error,
  onClearError,
  showModePill,
  showCancel = false,
  onCancel,
}) {
  const [name, setName] = useState('')
  const [welcomeProfileNames, setWelcomeProfileNames] = useState([])
  const [ownerDraft, setOwnerDraft] = useState('')
  const [welcomeOwnerNames, setWelcomeOwnerNames] = useState([])
  // Owners persist in the data DB independently of local profiles, so the welcome flow can run against a
  // DB that already has owners (e.g. after clearing local users but not the data). Load the reserved
  // names up front so a clash is caught the moment an owner is added rather than only on Continue.
  const [reservedOwnerNames, setReservedOwnerNames] = useState(() => new Set(['shared']))
  const [ownerError, setOwnerError] = useState('')
  const [openDataProvidersNext, setOpenDataProvidersNext] = useState(false)
  const [openWelcomeSection, setOpenWelcomeSection] = useState('users')
  const [showWelcomeHelp, setShowWelcomeHelp] = useState(false)
  const [editingId, setEditingId] = useState(null)
  const [editingName, setEditingName] = useState('')
  const [menu, setMenu] = useState(null)
  const menuRef = useRef(null)

  const hasProfiles = profiles.length > 0

  useEffect(() => {
    let cancelled = false
    api.getOwners().then(owners => {
      if (cancelled) return
      setReservedOwnerNames(new Set([
        'shared',
        ...(owners || []).map(owner => String(owner?.name || '').trim().toLowerCase()).filter(Boolean),
      ]))
    }).catch(() => { })
    return () => { cancelled = true }
  }, [])

  function normalizeName(nextValue) {
    return String(nextValue || '').trim()
  }

  function addOwnerName() {
    const normalized = normalizeName(ownerDraft)
    if (!normalized) return
    const lower = normalized.toLowerCase()
    if (reservedOwnerNames.has(lower)) {
      setOwnerError(`An account owner named "${normalized}" already exists.`)
      return
    }
    if (welcomeOwnerNames.some(item => item.toLowerCase() === lower)) {
      setOwnerError(`"${normalized}" is already added.`)
      return
    }
    setWelcomeOwnerNames([...welcomeOwnerNames, normalized])
    setOwnerDraft('')
    setOwnerError('')
  }

  function addUniqueName(list, nextValue, setItems) {
    const normalized = normalizeName(nextValue)
    if (!normalized) return false
    if (list.some(item => item.toLowerCase() === normalized.toLowerCase())) return false
    setItems([...list, normalized])
    return true
  }

  function renameUniqueName(list, currentValue, nextValue, setItems) {
    const normalized = String(nextValue || '').trim()
    if (!normalized) return false
    if (normalized.toLowerCase() !== String(currentValue || '').trim().toLowerCase()
      && list.some(item => item.toLowerCase() === normalized.toLowerCase())) {
      return false
    }
    setItems(list.map(item => (
      item === currentValue ? normalized : item
    )))
    return true
  }

  useDismissibleLayer({
    open: !!menu,
    onClose: () => setMenu(null),
    refs: [menuRef],
  })

  function renderWelcomeSection({ key, title, summary, required = false, children }) {
    const isOpen = openWelcomeSection === key
    return (
      <div
        style={{
          padding: 14,
          background: isOpen
            ? 'color-mix(in srgb, var(--surface2) 42%, transparent)'
            : 'color-mix(in srgb, var(--surface2) 28%, transparent)',
          border: `1px solid ${isOpen
            ? 'color-mix(in srgb, var(--accent) 34%, var(--border))'
            : 'color-mix(in srgb, var(--border) 88%, white 4%)'}`,
          borderRadius: 16,
          display: 'grid',
          gap: isOpen ? 12 : 0,
        }}
      >
        <button
          type="button"
          onClick={() => setOpenWelcomeSection(current => (current === key ? null : key))}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            width: '100%',
            background: 'none',
            border: 'none',
            padding: 0,
            color: 'inherit',
            cursor: 'pointer',
            textAlign: 'left',
          }}
        >
          <div style={{ display: 'grid', gap: 4, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>{title}</span>
              {required ? (
                <span style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  padding: '2px 8px',
                  borderRadius: 999,
                  background: 'color-mix(in srgb, var(--accent) 12%, transparent)',
                  color: 'var(--accent2)',
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: '0.04em',
                  textTransform: 'uppercase',
                }}>
                  Required
                </span>
              ) : null}
            </div>
            <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.45 }}>
              {summary}
            </div>
          </div>
          <div
            aria-hidden="true"
            style={{
              flex: '0 0 auto',
              width: 28,
              height: 28,
              borderRadius: 999,
              border: '1px solid color-mix(in srgb, var(--border) 88%, white 4%)',
              display: 'grid',
              placeItems: 'center',
              color: 'var(--muted)',
              fontSize: 14,
              background: 'var(--surface)',
            }}
          >
            {isOpen ? '−' : '+'}
          </div>
        </button>
        {isOpen ? children : null}
      </div>
    )
  }

  return (
    <div style={{
      minHeight: '100vh',
      display: 'grid',
      placeItems: 'center',
      padding: 24,
      background: 'radial-gradient(circle at top, color-mix(in srgb, var(--accent) 16%, transparent), transparent 34%), radial-gradient(circle at bottom right, color-mix(in srgb, var(--accent2) 11%, transparent), transparent 30%), linear-gradient(180deg, color-mix(in srgb, var(--surface2) 62%, var(--bg)) 0%, var(--bg) 100%)',
    }}>
      <div style={{
        width: 'min(560px, 100%)',
        background: 'linear-gradient(180deg, color-mix(in srgb, var(--surface) 92%, white 3%), color-mix(in srgb, var(--surface) 98%, var(--surface2) 16%))',
        border: '1px solid color-mix(in srgb, var(--accent) 28%, var(--border))',
        borderRadius: 20,
        padding: 28,
        boxShadow: '0 30px 82px rgba(15, 23, 42, 0.28), 0 0 0 1px color-mix(in srgb, var(--accent) 12%, transparent), inset 0 1px 0 rgba(255,255,255,0.05)',
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
            <div style={{ fontSize: 22, fontWeight: 600, marginBottom: 6, letterSpacing: '-0.02em', lineHeight: 1.1 }}>
              {hasProfiles ? 'User profiles' : `Getting Started`}
            </div>
            <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.55, maxWidth: 470, paddingLeft: 10 }}>
              {hasProfiles
                ? 'Tracks layout and view preferences.'
                : `Create the first user and optionally provide some additional information up front which can be useful later.`}
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
                    <TransientTextInput
                      value={editingName}
                      onChange={setEditingName}
                      restoreOnEscape
                      onCommit={() => {
                        const next = editingName.trim()
                        setEditingId(null)
                        if (next && next !== profile.name) onRename(profile.id, next)
                      }}
                      onCancel={() => {
                        setEditingId(null)
                        setEditingName(profile.name)
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

        {hasProfiles ? (
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
              New profile
            </div>
            <TransientTextInput
              value={name}
              onChange={value => {
                setName(value)
                if (error) onClearError?.()
              }}
              restoreOnEscape
              onCommit={() => {
                if (name.trim() && !creating) onCreate(name.trim(), () => setName(''))
              }}
              onCancel={() => { }}
              onBlurCommit={false}
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
                {creating ? 'Creating…' : 'Create user'}
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
            {error ? (
              <div
                style={{
                  marginTop: 2,
                  padding: '10px 12px',
                  borderRadius: 10,
                  border: '1px solid color-mix(in srgb, var(--danger) 34%, var(--border))',
                  background: 'color-mix(in srgb, var(--danger) 8%, var(--surface))',
                  color: 'var(--text)',
                  fontSize: 12,
                  lineHeight: 1.45,
                }}
              >
                {error}
              </div>
            ) : null}
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 14 }}>
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
              flexWrap: 'wrap',
            }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}></div>
              <button
                type="button"
                onClick={() => setShowWelcomeHelp(current => !current)}
                style={{
                  background: showWelcomeHelp
                    ? 'color-mix(in srgb, var(--accent) 12%, var(--surface2))'
                    : 'var(--surface)',
                  color: showWelcomeHelp ? 'var(--accent2)' : 'var(--text)',
                  border: `1px solid ${showWelcomeHelp ? 'color-mix(in srgb, var(--accent) 34%, var(--border))' : 'var(--border)'}`,
                  borderRadius: 999,
                  padding: '8px 12px',
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                {showWelcomeHelp ? 'Back to setup' : 'More information'}
              </button>
            </div>

            {showWelcomeHelp ? (
              <div style={{
                padding: 18,
                background: 'color-mix(in srgb, var(--surface2) 36%, transparent)',
                border: '1px solid color-mix(in srgb, var(--border) 88%, white 4%)',
                borderRadius: 16,
                display: 'grid',
                gap: 14,
              }}>
                <div style={{ display: 'grid', gap: 6 }}>
                  <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text)' }}>Getting Started</div>
                  <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.6 }}>
                    You only need one user name to begin, everything else can be skipped and added later.
                  </div>
                </div>
                <div style={{ display: 'grid', gap: 10 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>If you are starting from scratch</div>
                  <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.6 }}>
                    Keep it simple: add your user name, skip the optional sections for now, and proceed to the import page to load your first set of transactions or to the accounts page to link accounts through{' '}
                    <DataProviderInfoButton />.
                  </div>
                </div>
                <div style={{ display: 'grid', gap: 10 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>If you are already tracking finances elsewhere</div>
                  <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.6 }}>
                    Add the names of the various account owners and indicate that the transactions you are importing have already been categorized so the system should both preserve the existing categories when importing the transactions and propose rules based on the mappings. You may have multiple data sources, if some have been curated and some have not, you can make this distinction later at the data source level. This is simply the default.
                  </div>
                </div>
                <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.6 }}>
                  Other than user name the fields on the welcome page are there as they can be a useful place to get started but it is perfectly fine to ignore them and their meaning will become clear as you start to work with your data.
                </div>
              </div>
            ) : (
              <>
                {renderWelcomeSection({
                  key: 'users',
                  title: 'Users',
                  summary: welcomeProfileNames.length > 0
                    ? `${welcomeProfileNames.length} added`
                    : `Tracks page layout and preferences.`,
                  required: true,
                  children: (
                    <>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <TransientTextInput
                          value={name}
                          onChange={value => {
                            setName(value)
                            if (error) onClearError?.()
                          }}
                          restoreOnEscape
                          onCommit={() => {
                            if (addUniqueName(welcomeProfileNames, name, setWelcomeProfileNames)) setName('')
                          }}
                          onCancel={() => { }}
                          onBlurCommit={false}
                          placeholder="Add a user name"
                          style={{
                            flex: 1,
                            background: 'var(--surface)',
                            color: 'var(--text)',
                            border: '1px solid var(--border)',
                            borderRadius: 12,
                            padding: '12px 14px',
                            fontSize: 13,
                            outline: 'none',
                          }}
                        />
                        <button
                          type="button"
                          onClick={() => {
                            if (addUniqueName(welcomeProfileNames, name, setWelcomeProfileNames)) setName('')
                          }}
                          disabled={!name.trim()}
                          style={{
                            background: !name.trim() ? 'var(--surface)' : 'var(--accent)',
                            color: !name.trim() ? 'var(--muted)' : '#fff',
                            border: !name.trim() ? '1px solid var(--border)' : 'none',
                            borderRadius: 10,
                            padding: '10px 14px',
                            fontSize: 13,
                            fontWeight: 600,
                            cursor: !name.trim() ? 'not-allowed' : 'pointer',
                          }}
                        >
                          Add
                        </button>
                      </div>
                      {welcomeProfileNames.length > 0 ? (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                          {welcomeProfileNames.map(profileName => (
                            <WelcomeNameChip
                              key={profileName}
                              value={profileName}
                              onRename={nextValue => {
                                renameUniqueName(welcomeProfileNames, profileName, nextValue, setWelcomeProfileNames)
                              }}
                              onRemove={() => setWelcomeProfileNames(prev => prev.filter(item => item !== profileName))}
                            />
                          ))}
                        </div>
                      ) : null}
                    </>
                  ),
                })}

                {renderWelcomeSection({
                  key: 'owners',
                  title: 'Account owners',
                  summary: welcomeOwnerNames.length > 0
                    ? `${welcomeOwnerNames.length} added`
                    : 'of accounts in the transaction data. Managed on the accounts page.',
                  children: (
                    <>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <TransientTextInput
                          value={ownerDraft}
                          onChange={value => {
                            setOwnerDraft(value)
                            if (ownerError) setOwnerError('')
                            if (error) onClearError?.()
                          }}
                          restoreOnEscape
                          onCommit={addOwnerName}
                          onCancel={() => { }}
                          onBlurCommit={false}
                          placeholder="Add an account owner"
                          style={{
                            flex: 1,
                            background: 'var(--surface)',
                            color: 'var(--text)',
                            border: '1px solid var(--border)',
                            borderRadius: 12,
                            padding: '12px 14px',
                            fontSize: 13,
                            outline: 'none',
                          }}
                        />
                        <button
                          type="button"
                          onClick={addOwnerName}
                          disabled={!ownerDraft.trim()}
                          style={{
                            background: !ownerDraft.trim() ? 'var(--surface)' : 'var(--accent)',
                            color: !ownerDraft.trim() ? 'var(--muted)' : '#fff',
                            border: !ownerDraft.trim() ? '1px solid var(--border)' : 'none',
                            borderRadius: 10,
                            padding: '10px 14px',
                            fontSize: 13,
                            fontWeight: 600,
                            cursor: !ownerDraft.trim() ? 'not-allowed' : 'pointer',
                          }}
                        >
                          Add
                        </button>
                      </div>
                      {ownerError ? (
                        <div style={{ fontSize: 12, color: 'var(--danger)', lineHeight: 1.4 }}>{ownerError}</div>
                      ) : null}
                      {welcomeOwnerNames.length > 0 ? (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                          {welcomeOwnerNames.map(ownerName => (
                            <WelcomeNameChip
                              key={ownerName}
                              value={ownerName}
                              onRename={nextValue => {
                                renameUniqueName(welcomeOwnerNames, ownerName, nextValue, setWelcomeOwnerNames)
                              }}
                              onRemove={() => setWelcomeOwnerNames(prev => prev.filter(item => item !== ownerName))}
                            />
                          ))}
                        </div>
                      ) : null}
                    </>
                  ),
                })}

                {renderWelcomeSection({
                  key: 'providers',
                  title: 'Data providers',
                  summary: openDataProvidersNext
                    ? 'Open Data Providers after setup'
                    : 'Link accounts for direct import.',
                  children: (
                    <>
                      <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.6 }}>
                        Connections with <DataProviderInfoButton /> are managed on the accounts page.
                      </div>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, cursor: 'pointer' }}>
                        <input
                          type="checkbox"
                          checked={openDataProvidersNext}
                          onChange={event => setOpenDataProvidersNext(event.target.checked)}
                        />
                        Open Data Providers after setup
                      </label>
                    </>
                  ),
                })}
              </>
            )}

            {!showWelcomeHelp ? (
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <button
                  type="button"
                  onClick={() => onCompleteWelcome?.({
                    profileNames: welcomeProfileNames,
                    ownerNames: welcomeOwnerNames,
                    openDataProvidersNext,
                  })}
                  disabled={welcomeProfileNames.length === 0 || creating}
                  style={{
                    background: welcomeProfileNames.length === 0 || creating ? 'var(--surface)' : 'var(--accent)',
                    color: welcomeProfileNames.length === 0 || creating ? 'var(--muted)' : '#fff',
                    border: welcomeProfileNames.length === 0 || creating ? '1px solid var(--border)' : 'none',
                    borderRadius: 10,
                    padding: '10px 18px',
                    fontSize: 13,
                    fontWeight: 600,
                    cursor: welcomeProfileNames.length === 0 || creating ? 'not-allowed' : 'pointer',
                  }}
                >
                  {creating ? 'Setting up…' : 'Continue'}
                </button>
              </div>
            ) : null}
            {error ? (
              <div
                style={{
                  padding: '10px 12px',
                  borderRadius: 10,
                  border: '1px solid color-mix(in srgb, var(--danger) 34%, var(--border))',
                  background: 'color-mix(in srgb, var(--danger) 8%, var(--surface))',
                  color: 'var(--text)',
                  fontSize: 12,
                  lineHeight: 1.45,
                }}
              >
                {error}
              </div>
            ) : null}
          </div>
        )}
      </div>
      {menu ? (
        <div
          ref={menuRef}
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

// Notify listeners that account mappings have changed (merge/detach/rename/delete/owner-change/
// forget-distinct-pair). Currently consumed by the unified duplicate-detection report so it
// auto-refreshes its entries when the user edits accounts based on what the report shows.
// Other surfaces can listen for the same event if they need to react to account mutations.
export function notifyAccountsChanged() {
  window.dispatchEvent(new CustomEvent('fintrack:accounts-changed'))
}

export default function App() {
  /*
   * App boots through one of three gates before the main shell exists: runtime-config recovery, authenticated
   * sign-in/bootstrap, or local preference-profile selection. After that, the active user/profile becomes the
   * identity boundary for preference providers and startup-route persistence.
   */
  const location = useLocation()
  const navigate = useNavigate()
  const [taskCount, setTaskCount] = useState(0)
  const [topTaskSeverity, setTopTaskSeverity] = useState(null)
  const [navPaneWidth, setNavPaneWidth] = useState(readStoredNavPaneWidth)
  const [navResizing, setNavResizing] = useState(false)
  const [authChecked, setAuthChecked] = useState(false)
  const [authEnabled, setAuthEnabled] = useState(false)
  const [needsBootstrap, setNeedsBootstrap] = useState(false)
  const [currentUser, setCurrentUser] = useState(null)
  const [authError, setAuthError] = useState(null)
  const [runtimeConfig, setRuntimeConfig] = useState({ ok: true })
  const [passwordPolicy, setPasswordPolicy] = useState('min_8')
  const [securityProfile, setSecurityProfile] = useState('local_private')
  const [experimentalSecuritySettings, setExperimentalSecuritySettings] = useState(false)
  const [developerOptionsEnabled, setDeveloperOptionsEnabled] = useState(false)
  const [dbInstanceId, setDbInstanceId] = useState('')
  const [localProfiles, setLocalProfiles] = useState([])
  const [activeLocalProfile, setActiveLocalProfile] = useState(null)
  const [previousLocalProfile, setPreviousLocalProfile] = useState(null)
  const [localProfilePickerDismissible, setLocalProfilePickerDismissible] = useState(false)
  const [creatingLocalProfile, setCreatingLocalProfile] = useState(false)
  const [pendingLocalProfileDelete, setPendingLocalProfileDelete] = useState(null)
  const [localProfileError, setLocalProfileError] = useState('')
  const [navProfileMenu, setNavProfileMenu] = useState(null)
  const [navProfileEditing, setNavProfileEditing] = useState(false)
  const [navProfileDraft, setNavProfileDraft] = useState('')
  const [startupRouteApplied, setStartupRouteApplied] = useState(false)
  const [bootPreferences, setBootPreferences] = useState(null)
  const [bootPreferenceSubjectId, setBootPreferenceSubjectId] = useState('')
  const navProfileMenuRef = useRef(null)
  const savedStartupRouteRef = useRef('')
  const savedStartupRouteSubjectRef = useRef('')
  const preferenceSubjectId = authEnabled
    ? (currentUser?.id || currentUser?.user_id || '')
    : (activeLocalProfile?.id || '')
  const appSessionValue = useMemo(() => ({
    authEnabled,
    currentUser,
    passwordPolicy,
    securityProfile,
    experimentalSecuritySettings,
    developerOptionsEnabled,
    dbInstanceId,
    activeLocalProfile,
    preferenceSubjectId,
  }), [
    authEnabled,
    currentUser,
    passwordPolicy,
    securityProfile,
    experimentalSecuritySettings,
    developerOptionsEnabled,
    dbInstanceId,
    activeLocalProfile,
    preferenceSubjectId,
  ])

  async function hydrateStartupRoute(profileId = '', options = {}) {
    const { forceFromRoot = false, preferenceSubjectIdOverride = '' } = options
    try {
      if (profileId) setLocalPreferenceProfileId(profileId)
      // The startup route is stored per active preference identity, so hydrate it before we start saving the
      // current location; otherwise first load would immediately overwrite the remembered landing page with "/".
      const prefResp = await api.getUserPreferences().catch(() => ({ preferences: {} }))
      const nextPreferenceSubjectId = preferenceSubjectIdOverride || profileId || ''
      setBootPreferenceSubjectId(nextPreferenceSubjectId)
      setBootPreferences(prefResp?.preferences || {})
      const startupRoute = String(prefResp?.preferences?.[STARTUP_ROUTE_PREFERENCE_KEY] || '').trim()
      const validStartupRoute = startupRoute && startupRoute.startsWith('/') ? startupRoute : ''
      savedStartupRouteRef.current = validStartupRoute
      savedStartupRouteSubjectRef.current = nextPreferenceSubjectId
      if (forceFromRoot) {
        navigate(validStartupRoute || '/', { replace: true })
      } else if (location.pathname === '/' && validStartupRoute && validStartupRoute !== location.pathname) {
        navigate(validStartupRoute, { replace: true })
      }
    } finally {
      setStartupRouteApplied(true)
    }
  }

  useDismissibleLayer({
    open: !!navProfileMenu,
    onClose: () => setNavProfileMenu(null),
    refs: [navProfileMenuRef],
  })

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
        setDeveloperOptionsEnabled(!!status.developer_options_enabled)
        setDbInstanceId(status.db_instance_id || '')
        setBootPreferences(null)
        setBootPreferenceSubjectId('')

        if (!status.auth_enabled) {
          const profilesResp = await api.getLocalPreferenceProfiles().catch(() => ({ profiles: [] }))
          if (cancelled) return
          const profiles = profilesResp?.profiles || []
          setLocalProfiles(profiles)
          setCurrentUser(status.user || null)
          const storageKey = getLocalProfileStorageKey(status.db_instance_id || '')
          const rememberedId = storageKey ? window.localStorage.getItem(storageKey) : ''
          const remembered = profiles.find(profile => profile.id === rememberedId) || null
          // Skip the picker when there is an unambiguous local profile so desktop startup lands directly in the
          // last-used workspace instead of stopping on a purely preference-level choice.
          const autoSelected = remembered || (profiles.length === 1 ? profiles[0] : null)
          if (autoSelected) {
            setLocalPreferenceProfileId(autoSelected.id)
            setActiveLocalProfile(autoSelected)
            if (storageKey) {
              try { window.localStorage.setItem(storageKey, autoSelected.id) } catch { }
            }
            await hydrateStartupRoute(autoSelected.id, { preferenceSubjectIdOverride: autoSelected.id })
          } else {
            setLocalPreferenceProfileId('')
            setActiveLocalProfile(null)
            setStartupRouteApplied(true)
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
        await hydrateStartupRoute('', { preferenceSubjectIdOverride: status?.user?.id || status?.user_id || '' })
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
    // This is a true once-per-mount bootstrap. hydrateStartupRoute closes over
    // location.pathname + navigate; wrapping it in useCallback and listing it
    // here would re-fire the auth check on every URL change, which is wrong.
    // Other call sites invoke hydrateStartupRoute directly from click handlers
    // and don't need stable identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!startupRouteApplied) return
    if (authEnabled && !currentUser) return
    if (!authEnabled && !activeLocalProfile) return
    // Do not persist the current route until the initial startup-route hydration finished; that would turn the
    // bootstrap/login/profile-entry route into the new default landing page.
    const route = `${location.pathname}${location.search || ''}`
    if (savedStartupRouteSubjectRef.current === preferenceSubjectId) {
      if (savedStartupRouteRef.current === route) return
      if (!savedStartupRouteRef.current && route === '/') return
    }
    api.saveUserPreference(STARTUP_ROUTE_PREFERENCE_KEY, route)
      .then(() => {
        savedStartupRouteRef.current = route
        savedStartupRouteSubjectRef.current = preferenceSubjectId
      })
      .catch(() => { })
  }, [
    startupRouteApplied,
    authEnabled,
    currentUser,
    activeLocalProfile,
    preferenceSubjectId,
    location.pathname,
    location.search,
  ])

  useEffect(() => {
    if (runtimeConfig && runtimeConfig.ok === false) return
    if (authEnabled && !currentUser) return
    if (!authEnabled && !activeLocalProfile) return

    function fetchTasks() {
      api.getTasks()
        .then(r => {
          setTaskCount(r?.open_items || 0)
          setTopTaskSeverity(pickTopTaskSeverity(r?.tasks))
        })
        .catch(() => { })
    }

    fetchTasks()
    window.addEventListener('fintrack:data-mutated', fetchTasks)
    return () => window.removeEventListener('fintrack:data-mutated', fetchTasks)
    // Two refresh triggers, by design:
    //   * `fintrack:data-mutated` — same-session immediacy: any successful mutation anywhere emits
    //     this from the api layer (see `signalDataMutated` in api.js), so the badge updates without
    //     the user navigating, and no call site has to remember to refresh it.
    //   * `location.pathname` in the deps — navigation backstop: re-fetch on every route change to
    //     pick up changes this session didn't make (another tab, a background sync). With the api
    //     emit covering local mutations, this is no longer compensating for a missed broadcast.
    // activeLocalProfile is gated by the !authEnabled guard above — without it in deps the effect
    // never re-runs after the local profile loads on cold start, so the nav badge stays at 0
    // even when /tasks itself is showing pending items.
  }, [authEnabled, currentUser, runtimeConfig, activeLocalProfile, location.pathname])

  useEffect(() => {
    if (!startupRouteApplied) return
    if (authEnabled && !currentUser) return
    if (!authEnabled && !activeLocalProfile) return

    let cancelled = false
    let timeoutId = null
    let idleId = null

    const preloadRoutes = () => {
      if (cancelled) return
      ROUTE_PREFETCHERS.forEach(loadPage => {
        loadPage().catch(() => { })
      })
    }

    if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
      idleId = window.requestIdleCallback(preloadRoutes, { timeout: 2000 })
    } else {
      timeoutId = window.setTimeout(preloadRoutes, 1200)
    }

    return () => {
      cancelled = true
      if (timeoutId !== null) window.clearTimeout(timeoutId)
      if (idleId !== null && typeof window !== 'undefined' && typeof window.cancelIdleCallback === 'function') {
        window.cancelIdleCallback(idleId)
      }
    }
  }, [startupRouteApplied, authEnabled, currentUser, activeLocalProfile])

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
      if (passThrough) return
      e.preventDefault()
    }

    document.addEventListener('contextmenu', handleContextMenu, true)
    return () => document.removeEventListener('contextmenu', handleContextMenu, true)
  }, [])

  useEffect(() => {
    try {
      window.localStorage.setItem(NAV_PANE_WIDTH_STORAGE_KEY, String(navPaneWidth))
    } catch { }
  }, [navPaneWidth])

  function startNavPaneResize(event) {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = navPaneWidth

    function handleMove(moveEvent) {
      const next = clampNavPaneWidth(startWidth + (moveEvent.clientX - startX))
      setNavPaneWidth(next)
    }

    function stop() {
      window.removeEventListener('mousemove', handleMove)
      window.removeEventListener('mouseup', stop)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      setNavResizing(false)
    }

    setNavResizing(true)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('mousemove', handleMove)
    window.addEventListener('mouseup', stop)
  }

  function resetNavPaneWidth() {
    setNavPaneWidth(NAV_PANE_DEFAULT_WIDTH)
  }

  async function handleLogout() {
    await api.logout().catch(() => { })
    setCurrentUser(null)
    setTaskCount(0)
    setTopTaskSeverity(null)
  }

  function handleSwitchLocalProfile() {
    setPreviousLocalProfile(activeLocalProfile)
    setLocalProfilePickerDismissible(true)
    setActiveLocalProfile(null)
    setLocalPreferenceProfileId('')
  }

  function activateLocalProfile(profile, options = {}) {
    const { forceStartupRoute = false } = options
    setLocalProfileError('')
    setStartupRouteApplied(false)
    setActiveLocalProfile(profile)
    setPreviousLocalProfile(null)
    setLocalProfilePickerDismissible(false)
    setNavProfileEditing(false)
    setNavProfileMenu(null)
    setLocalPreferenceProfileId(profile?.id || '')
    setBootPreferences(null)
    setBootPreferenceSubjectId('')
    const storageKey = getLocalProfileStorageKey(dbInstanceId)
    if (storageKey) {
      try {
        if (profile?.id) window.localStorage.setItem(storageKey, profile.id)
      } catch { }
    }
    hydrateStartupRoute(profile?.id || '', {
      forceFromRoot: forceStartupRoute,
      preferenceSubjectIdOverride: profile?.id || '',
    }).catch(() => setStartupRouteApplied(true))
  }

  async function handleCreateLocalProfile(name, clearForm) {
    setLocalProfileError('')
    setCreatingLocalProfile(true)
    try {
      const resp = await api.createLocalPreferenceProfile(name)
      const profile = resp?.profile
      if (!profile) return
      setLocalProfiles(prev => {
        const exists = prev.find(item => item.id === profile.id)
        return exists ? prev : [...prev, profile].sort((a, b) => a.name.localeCompare(b.name))
      })
      activateLocalProfile(profile, { forceStartupRoute: !localProfilePickerDismissible })
      clearForm?.()
    } catch (err) {
      setLocalProfileError(
        err?.message === 'Failed to fetch'
          ? `Server unreachable. Start or restart ${APP_NAME} and try again.`
          : (err?.message || 'Could not create the user profile.')
      )
    } finally {
      setCreatingLocalProfile(false)
    }
  }

  async function handleCompleteWelcomeSetup(setup) {
    const profileNames = Array.isArray(setup?.profileNames) ? setup.profileNames.map(value => String(value || '').trim()).filter(Boolean) : []
    const ownerNames = Array.isArray(setup?.ownerNames) ? setup.ownerNames.map(value => String(value || '').trim()).filter(Boolean) : []
    const openDataProvidersNext = !!setup?.openDataProvidersNext
    if (profileNames.length === 0) {
      setLocalProfileError('Add at least one user name to continue.')
      return
    }

    setLocalProfileError('')
    setCreatingLocalProfile(true)
    const originalProfileId = activeLocalProfile?.id || ''

    try {
      const existingOwners = await api.getOwners().catch(() => [])
      const existingOwnerNames = new Set((existingOwners || []).map(owner => String(owner?.name || '').trim().toLowerCase()).filter(Boolean))
      const reservedOwnerNames = new Set(['shared', ...existingOwnerNames])
      const conflictingOwner = ownerNames.find(ownerName => reservedOwnerNames.has(ownerName.toLowerCase()))
      if (conflictingOwner) {
        throw new Error(`An account owner named "${conflictingOwner}" already exists.`)
      }

      const createdProfiles = []
      for (const profileName of profileNames) {
        const resp = await api.createLocalPreferenceProfile(profileName)
        if (resp?.profile) createdProfiles.push(resp.profile)
      }
      if (createdProfiles.length === 0) {
        throw new Error('Could not create the first user profile.')
      }

      for (const ownerName of ownerNames) {
        await api.createOwner({ name: ownerName })
      }

      const startupRoute = openDataProvidersNext ? DATA_PROVIDER_STARTUP_ROUTE : '/'
      for (const profile of createdProfiles) {
        setLocalPreferenceProfileId(profile.id)
        await api.saveUserPreference(STARTUP_ROUTE_PREFERENCE_KEY, startupRoute)
      }
      setLocalPreferenceProfileId(originalProfileId)

      setLocalProfiles(prev => {
        const next = [...prev]
        for (const profile of createdProfiles) {
          if (!next.some(item => item.id === profile.id)) next.push(profile)
        }
        return next.sort((a, b) => a.name.localeCompare(b.name))
      })
      activateLocalProfile(createdProfiles[0], { forceStartupRoute: true })
    } catch (err) {
      setLocalPreferenceProfileId(originalProfileId)
      setLocalProfileError(
        err?.message === 'Failed to fetch'
          ? `Server unreachable. Start or restart ${APP_NAME} and try again.`
          : (err?.message || 'Could not finish the welcome setup.')
      )
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
    setPendingLocalProfileDelete(profile)
  }

  async function confirmDeleteLocalProfile() {
    if (!pendingLocalProfileDelete) return
    const profile = pendingLocalProfileDelete
    setPendingLocalProfileDelete(null)
    await api.deleteLocalPreferenceProfile(profile.id)
    setLocalProfiles(prev => prev.filter(item => item.id !== profile.id))
    const deletedCurrentProfile =
      activeLocalProfile?.id === profile.id || previousLocalProfile?.id === profile.id

    if (deletedCurrentProfile) {
      const storageKey = getLocalProfileStorageKey(dbInstanceId)
      if (storageKey) {
        try { window.localStorage.removeItem(storageKey) } catch { }
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
    setLocalProfileError('')
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
        <div style={{ fontSize: 14, color: 'var(--muted)' }}>Loading {APP_NAME}...</div>
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
            setStartupRouteApplied(false)
            setCurrentUser(user)
            setAuthEnabled(true)
            setNeedsBootstrap(false)
            setBootPreferences(null)
            setBootPreferenceSubjectId('')
            hydrateStartupRoute('', {
              forceFromRoot: true,
              preferenceSubjectIdOverride: user?.id || user?.user_id || '',
            }).catch(() => setStartupRouteApplied(true))
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
          error={localProfileError}
          onClearError={() => setLocalProfileError('')}
          onSelect={profile => activateLocalProfile(profile, { forceStartupRoute: !localProfilePickerDismissible })}
          onCreate={handleCreateLocalProfile}
          onCompleteWelcome={handleCompleteWelcomeSetup}
          onRename={handleRenameLocalProfile}
          onDelete={handleDeleteLocalProfile}
          showModePill={experimentalSecuritySettings}
          showCancel={localProfilePickerDismissible && localProfiles.length > 0}
          onCancel={cancelLocalProfilePicker}
        />
      </AppErrorBoundary>
    )
  }

  /*
   * Provider tree composition. Order matters — each layer assumes its enclosing layers are
   * already mounted, so additions need to slot in at the right level.
   *
   *   AppErrorBoundary           — last-resort UI for render-time crashes anywhere below
   *     AppSessionProvider       — current user/profile identity for the rest of the tree
   *       UserPreferencesProvider — keyed by identity; resets cached prefs on switch
   *         FilterProvider       — shared date/account/owner filter state across pages
   *           PanelStackProvider — click-to-focus z-index registry for floating panels
   *             UnifiedDuplicatesViewerProvider — App-level duplicate-detection dialog state
   *               UnifiedDuplicatesViewerRenderer — renders the floating dialog above all
   *                 routes when there's an active viewer; sits BEFORE <Routes> so any
   *                 route-mounted floating panel (batch/account/month/tag detail) opened
   *                 later appears in DOM order after it and naturally stacks on top
   *               shell (nav + main + <Routes>)
   *
   * The bottom two contexts (PanelStack, UnifiedDuplicatesViewer) are the foundation for
   * floating UI that needs to survive route navigation. Anything new in that category should
   * sit at this level — render its UI above <Routes> for stacking, and expose hooks
   * consumers can call from inside routes.
   */
  return (
    <AppErrorBoundary>
      {/* Key the provider by the active preference identity so switching user/profile drops cached preference state instead of leaking it across sessions. */}
      <AppSessionProvider value={appSessionValue}>
        <UserPreferencesProvider
          key={authEnabled ? `user:${currentUser?.id || currentUser?.username || ''}` : `local:${activeLocalProfile?.id || ''}`}
          initialPreferences={bootPreferenceSubjectId && bootPreferenceSubjectId === preferenceSubjectId ? bootPreferences : null}
        >
          <FilterProvider initialDate={pastTwelveMonthsRange()}>
            <PanelStackProvider>
            <UnifiedDuplicatesViewerProvider>
            <UnifiedDuplicatesViewerRenderer />
            <style>{GLOBAL_SCROLLBAR_STYLES}</style>
            {pendingLocalProfileDelete ? (
              <AppConfirmDialog
                title="Delete user profile?"
                description={`Delete user profile "${pendingLocalProfileDelete.name}"?`}
                confirmLabel="Delete"
                confirmVariant="danger"
                borderColor="color-mix(in srgb, var(--danger) 35%, var(--border))"
                onConfirm={confirmDeleteLocalProfile}
                onCancel={() => setPendingLocalProfileDelete(null)}
                width="min(480px, 100%)"
              />
            ) : null}
            <div style={s.shell}>
              <nav style={{ ...s.nav, width: navPaneWidth }}>
                <div style={s.logo}>
                  <div>{APP_NAME}</div>
                  {developerOptionsEnabled ? (
                    <div style={{
                      marginTop: 3,
                      fontSize: 11,
                      fontWeight: 600,
                      color: 'var(--muted)',
                      letterSpacing: '0.04em',
                    }}>
                      v{APP_VERSION}
                    </div>
                  ) : null}
                </div>
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
                        background: TASK_BADGE_COLORS[topTaskSeverity] || TASK_BADGE_COLORS.info,
                        color: '#fff',
                        fontSize: 11, fontWeight: 700,
                        padding: '1px 7px', borderRadius: 99,
                        lineHeight: '18px', minWidth: 20, textAlign: 'center',
                      }}>
                        {taskCount}
                      </span>
                    )}
                  </NavLink>
                ))}
                <MinimizedDuplicatesNavItem />
                <div style={s.navFooter}>
                  <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 12 }}>
                    {authEnabled ? 'Signed in as' : 'Using profile'}{' '}
                    {authEnabled ? (
                      <span style={{ fontWeight: 600, color: 'var(--text)' }}>
                        {currentUser?.display_name || currentUser?.username}
                      </span>
                    ) : (
                      navProfileEditing && activeLocalProfile ? (
                        <TransientTextInput
                          value={navProfileDraft}
                          onChange={setNavProfileDraft}
                          onCommit={commitNavProfileRename}
                          onCancel={() => {
                            setNavProfileEditing(false)
                            setNavProfileDraft(activeLocalProfile.name)
                          }}
                          restoreOnEscape
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
                <div
                  className={`nav-resize-handle${navResizing ? ' is-resizing' : ''}`}
                  onMouseDown={startNavPaneResize}
                  onDoubleClick={resetNavPaneWidth}
                  role="separator"
                  aria-orientation="vertical"
                  aria-label="Resize navigation pane"
                  title="Drag to resize · double-click to reset"
                />
              </nav>
              <div style={s.main}>
                {shouldShowFilterBar(location.pathname) ? <FilterBar /> : null}
                <div style={s.content}>
                  {/* Route-level lazy loading keeps the shell responsive and avoids forcing every large screen into
                    the initial bundle before the user ever visits it. */}
                  <Suspense fallback={<RouteLoadingFallback />}>
                    <Routes>
                      <Route path="/" element={<Dashboard />} />
                      <Route path="/transactions" element={<Transactions />} />
                      <Route path="/categories" element={<Categories />} />
                      <Route path="/rules" element={<Rules />} />
                      <Route path="/accounts" element={<Accounts />} />
                      <Route path="/import-export/rule-suggestions" element={<ImportRuleSuggestions />} />
                      <Route path="/import-export/batches/:batchId/rule-suggestions" element={<ImportRuleSuggestions />} />
                      <Route path="/import-export/profiles/:profileId/rule-suggestions" element={<ImportRuleSuggestions />} />
                      <Route path="/import-export" element={<ImportExport />} />
                      <Route path="/tasks" element={<Tasks />} />
                      <Route path="/settings" element={<Settings />} />
                      <Route path="/help" element={<Help />} />
                      <Route path="/help/:topic" element={<Help />} />
                    </Routes>
                  </Suspense>
                </div>
              </div>
            </div>
            {navProfileMenu && activeLocalProfile && (
              <div
                ref={navProfileMenuRef}
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
            </UnifiedDuplicatesViewerProvider>
            </PanelStackProvider>
          </FilterProvider>
        </UserPreferencesProvider>
      </AppSessionProvider>
    </AppErrorBoundary>
  )
}
