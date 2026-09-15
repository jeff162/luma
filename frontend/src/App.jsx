// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/* eslint-disable react-refresh/only-export-components -- App component + notifyAccountsChanged broadcast helper live together as the app-level shell */

import { useState, useEffect, useRef, Component, useMemo } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { FilterProvider } from './lib/FilterContext.jsx'
import FilterBar from './components/FilterBar.jsx'
import AuthScreen from './components/AuthScreen.jsx'
import { api, SESSION_LOST_EVENT } from './lib/api.js'
import {
  BACKEND_RETURNED_EVENT,
  BACKEND_STOPPED_EVENT,
  announceBackendStopped,
  backendHasStopped,
  checkForBackendReturn,
  noteRequestFailure,
  watchBackendLiveness,
} from './lib/backendLiveness.js'
import { applyLedgerCurrency } from './lib/moneyDisplay.js'
import { safeStartupRoute } from './lib/startupRoute.js'
import AppRoutes, { RouteLoadingFallback } from './AppRoutes.jsx'
import { ROUTE_PREFETCHERS } from './lib/routeChunks.js'
import { HELP_HINTS_ENABLED_PREF_KEY } from './help/preferences.js'
import { UserPreferencesProvider, useUserPreference } from './lib/UserPreferencesContext.jsx'
import DataLocationLine from './components/DataLocationLine.jsx'
import { THEME_PREF_KEY, THEME_SYSTEM, applyTheme, normalizeThemeChoice, reconcileThemeCacheForDb } from './lib/theme.js'
import { AppSessionProvider } from './lib/AppSessionContext.jsx'
import {
  UnifiedDuplicatesViewerProvider,
  UnifiedDuplicatesViewerRenderer,
  MinimizedDuplicatesNavItem,
} from './contexts/UnifiedDuplicatesViewerContext.jsx'
import {
  AmazonReconciliationViewerProvider,
  AmazonReconciliationViewerRenderer,
  MinimizedAmazonReconciliationNavItem,
} from './contexts/AmazonReconciliationViewerContext.jsx'
import {
  AmazonImportDetailViewerProvider,
  AmazonImportDetailViewerRenderer,
  MinimizedAmazonImportDetailNavItem,
} from './contexts/AmazonImportDetailViewerContext.jsx'
import {
  SyncStatusProvider,
  SyncStatusRenderer,
} from './contexts/SyncStatusContext.jsx'
import { VaultGateProvider, VaultGateRenderer } from './contexts/VaultGateContext.jsx'
import { SyncNavItem } from './components/SyncNavItem.jsx'
import {
  ImportedCategoryWorkspaceProvider,
  ImportedCategoryWorkspaceRenderer,
  MinimizedImportedCategoryWorkspaceNavItem,
} from './contexts/ImportedCategoryWorkspaceContext.jsx'
import { PanelStackProvider } from './contexts/PanelStackContext.jsx'
import { TransactionShareProvider } from './contexts/TransactionShareContext.jsx'
import { useDismissibleLayer } from './lib/uiInteractions.js'
import { AppConfirmDialog, AppDialog, Button, Toggle } from './components/ui.jsx'
import TransientTextInput from './components/TransientTextInput.jsx'
import {
  APP_NAME,
  APP_VERSION,
  SUPPORTED_DATA_PROVIDERS,
} from './lib/appConfig.js'

// Shown in two places that cannot share a component: the dialog below, which renders inside the app,
// and the error boundary's fallback, which renders in place of it. Sharing the words is what keeps the
// two from drifting apart.
const BACKEND_STOPPED_TITLE = 'Luma has stopped'
const BACKEND_STOPPED_BODY = 'Starting Luma again brings this tab back with everything as it was.'
const BACKEND_ABSENT_BODY = `Luma is not answering yet. ${BACKEND_STOPPED_BODY}`

/* The button beside the notice, and the state it needs.
 *
 * A press that found nothing has to say so: the probe is fast enough that without a reported outcome
 * the button would look like it had done nothing at all. A press that *does* find the backend says
 * nothing here, because the answer to that is the page reloading. */
function useBackendReturnCheck() {
  const [checking, setChecking] = useState(false)
  const [stillAbsent, setStillAbsent] = useState(false)

  async function check() {
    setChecking(true)
    setStillAbsent(false)
    const alive = await checkForBackendReturn()
    setChecking(false)
    if (!alive) setStillAbsent(true)
  }

  return { checking, stillAbsent, check }
}

/* The error boundary's version of the notice. Deliberately plain markup rather than `AppDialog`: this
 * renders *outside* every provider, and a fallback that depended on one would throw while handling an
 * error, which is the one place a component must not. */
function BackendStoppedNotice() {
  const { checking, stillAbsent, check } = useBackendReturnCheck()
  return (
    <div style={{ padding: 40, fontFamily: 'sans-serif' }}>
      <h2 style={{ marginBottom: 12 }}>{BACKEND_STOPPED_TITLE}</h2>
      <p style={{ fontSize: 14, color: 'var(--muted)', marginBottom: 20, maxWidth: 460 }}>
        {stillAbsent ? BACKEND_ABSENT_BODY : BACKEND_STOPPED_BODY}
      </p>
      <button
        onClick={check}
        disabled={checking}
        style={{
          padding: '8px 18px',
          cursor: checking ? 'default' : 'pointer',
          borderRadius: 6,
          border: '1px solid color-mix(in srgb, var(--accent) 32%, var(--border))',
          background: 'color-mix(in srgb, var(--surface2) 78%, var(--surface))',
          color: 'var(--text)',
          fontWeight: 600,
        }}
      >
        {checking ? 'Checking…' : 'Check again'}
      </button>
    </div>
  )
}

/* The in-app notice. No dismiss, because there is nothing behind it to go back to — every request the
 * page could make now fails. The button is the whole affordance: it says a check is worth making
 * without a line of prose telling anyone to click, and clicks anywhere are watched silently besides. */
function BackendStoppedDialog() {
  const { checking, stillAbsent, check } = useBackendReturnCheck()
  return (
    <AppDialog
      title={BACKEND_STOPPED_TITLE}
      description={stillAbsent ? BACKEND_ABSENT_BODY : BACKEND_STOPPED_BODY}
      onClose={null}
      width="min(460px, 100%)"
      actions={
        <Button small onClick={check} disabled={checking}>
          {checking ? 'Checking…' : 'Check again'}
        </Button>
      }
    />
  )
}

/** Whether the browser failed to load a code-split route chunk, as opposed to the app throwing.
 *
 * Every engine words this differently and none of them expose a code, so matching the message is the
 * only option available. A miss costs the calmer of two panels, not correctness. */
function isModuleLoadError(error) {
  if (error?.name === 'ChunkLoadError') return true
  return /dynamically imported module|importing a module script failed/i.test(String(error?.message || ''))
}

/*
 * Last-resort UI, and the one place that has to tell a crash from a departed server.
 *
 * A route chunk is fetched by the browser's module loader rather than by anything in `lib/api.js`, so a
 * backend that has stopped fails `lazy()` imports without the liveness watch hearing about it — which
 * is how a stopped server showed "Something went wrong" over the whole app instead of the notice that
 * explains it. The error alone cannot settle which it is: a stale chunk hash after a rebuild fails
 * identically against a perfectly live server. So a module-load failure is reported to the watch and
 * the probe decides, and until it answers this renders neither verdict — guessing wrong would put an
 * alarming red panel over a working app, or hide a real crash behind a calm explanation.
 */
class AppErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null, settled: true, stopped: backendHasStopped() }
    // Another tab, or this one's own probe, may reach the verdict after the fallback is already up.
    this.handleStopped = () => this.setState({ stopped: true })
  }

  static getDerivedStateFromError(e) {
    return { error: e, settled: !isModuleLoadError(e) }
  }

  componentDidMount() { window.addEventListener(BACKEND_STOPPED_EVENT, this.handleStopped) }

  componentWillUnmount() { window.removeEventListener(BACKEND_STOPPED_EVENT, this.handleStopped) }

  componentDidCatch(error) {
    if (!isModuleLoadError(error)) return
    noteRequestFailure(error).then(() => this.setState({ settled: true }))
  }

  render() {
    // Only ever in place of a crash. A backend that stops while the app is rendering fine is the
    // dialog's business, and replacing a working page with this panel would take away everything the
    // user can still read.
    if (this.state.error && this.state.stopped) return <BackendStoppedNotice />
    if (!this.state.error) return this.props.children
    if (!this.state.settled) return <RouteLoadingFallback />

    return (
      <div data-browser-context-passthrough="true" style={{ padding: 40, fontFamily: 'sans-serif' }}>
        <h2 style={{ color: 'var(--danger)', marginBottom: 12 }}>Something went wrong</h2>
        <pre data-browser-context-passthrough="true" style={{ fontSize: 13, color: '#666', marginBottom: 20, whiteSpace: 'pre-wrap' }}>
          {this.state.error?.message}
        </pre>
        <button
          onClick={() => this.setState({ error: null, settled: true })}
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
}

const s = {
  shell: { display: 'flex', height: '100vh', overflow: 'hidden' },
  nav: {
    background: 'var(--surface)', borderRight: '1px solid var(--border)',
    display: 'flex', flexDirection: 'column', padding: '24px 0', flexShrink: 0,
    position: 'relative',
    // The pane is exactly the width the user dragged it to, whatever is inside it. A flex item's
    // `min-width: auto` is content-based, so one long unbreakable string — a filesystem path — would
    // otherwise widen the pane past that width, or refuse to let it be dragged narrower. Zero here is
    // what lets a child elide instead of pushing.
    minWidth: 0,
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
  ['/recurring', 'Recurring'],
  ['/import-export', 'Import / Export'],
  ['/tasks', 'Tasks'],
  ['/settings', 'Settings'],
  ['/help', 'Help'],
]

const LOCAL_PROFILE_STORAGE_KEY_PREFIX = 'luma.localPreferenceProfile'
const STARTUP_ROUTE_PREFERENCE_KEY = 'ui.startupRoute'
const DATA_PROVIDER_STARTUP_ROUTE = '/accounts'
// Severity-to-color mapping for the nav Tasks badge. Mirrors the palette used by
// `SEVERITY_COLORS` in Tasks.jsx so the badge in the nav reads as the same severity
// the task cards on the page render with. Ordered by ascending urgency so that
// pickTopTaskSeverity() can pick the worst pending task. Extending: add the new
// severity here AND in TASK_SEVERITY_ORDER, then ensure the backend uses the same key.
const TASK_BADGE_COLORS = {
  info: 'var(--accent)',
  warning: 'var(--warning)',
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

const NAV_PANE_WIDTH_STORAGE_KEY = 'luma.ui.navPaneWidth'
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
  // Open the popover upward when there isn't room below; otherwise it overflows the bottom of the page,
  // forces a scroll, and the scroll shifts the hover target out from under the cursor (the flicker).
  const [dropUp, setDropUp] = useState(false)
  const containerRef = useRef(null)

  useDismissibleLayer({
    open,
    onClose: () => setOpen(false),
    refs: [containerRef],
  })

  function openMenu() {
    const rect = containerRef.current?.getBoundingClientRect()
    if (rect) {
      const spaceBelow = window.innerHeight - rect.bottom
      setDropUp(spaceBelow < 220 && rect.top > spaceBelow)
    }
    setOpen(true)
  }

  return (
    <span
      ref={containerRef}
      onMouseLeave={() => setOpen(false)}
      style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}
    >
      <button
        type="button"
        onMouseEnter={openMenu}
        onFocus={openMenu}
        onClick={() => (open ? setOpen(false) : openMenu())}
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
            ...(dropUp ? { bottom: 'calc(100% + 8px)' } : { top: 'calc(100% + 8px)' }),
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
  showCancel = false,
  onCancel,
}) {
  const [name, setName] = useState('')
  const [skipHints, setSkipHints] = useState(false)
  const [showWelcomeHelp, setShowWelcomeHelp] = useState(false)
  const [editingId, setEditingId] = useState(null)
  const [editingName, setEditingName] = useState('')
  const [menu, setMenu] = useState(null)
  // The chooser owns its own delete confirmation so the dialog is mounted while the chooser is up
  // (it renders as a full-screen route, so a dialog rendered by the parent app tree would be hidden).
  const [pendingDelete, setPendingDelete] = useState(null)
  const menuRef = useRef(null)

  const hasProfiles = profiles.length > 0
  const trimmedName = name.trim()

  useDismissibleLayer({
    open: !!menu,
    onClose: () => setMenu(null),
    refs: [menuRef],
  })

  // First-run data-entry choices. Each card creates the user and sends them once to that surface; the
  // catch-all completion contract is { name, destination, loadDemo } (see handleCompleteWelcomeSetup).
  function completeWelcome(choice) {
    if (!trimmedName || creating) return
    onCompleteWelcome?.({ name: trimmedName, disableHints: skipHints, ...choice })
  }

  const dataEntryChoices = [
    {
      key: 'import',
      title: 'Import a CSV file or restore a Backup',
      summary: 'Load transactions from a transaction export or a prior backup.',
      destination: '/import-export',
    },
    {
      key: 'connect',
      title: 'Connect a data provider',
      summary: 'Link an account/accounts through a data provider.',
      destination: DATA_PROVIDER_STARTUP_ROUTE,
    },
    {
      key: 'demo',
      title: 'Load demo data',
      summary: 'Explore the application with a sample dataset.',
      destination: '/',
      loadDemo: true,
    },
    {
      key: 'skip',
      title: 'Skip for now',
      summary: 'Just load the application',
      destination: '/',
    },
  ]

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
            {/* This screen only renders with the sign-in perimeter off, so the label is always accurate
                — it is here to explain why no password was asked for. */}
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
            <div style={{ fontSize: 22, fontWeight: 600, marginBottom: 6, letterSpacing: '-0.02em', lineHeight: 1.1 }}>
              {hasProfiles ? 'User profiles' : `Getting Started`}
            </div>
            <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.55, maxWidth: 470, paddingLeft: 10 }}>
              {hasProfiles
                ? 'Tracks layout and view preferences.'
                : `Add a user name and bring in your first transactions to get started.`}
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
          <div style={{ display: 'grid', gap: 16 }}>
            <div style={{
              display: 'flex',
              alignItems: 'flex-start',
              justifyContent: 'space-between',
              gap: 12,
              flexWrap: 'wrap',
            }}>
              <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.55, flex: 1, minWidth: 220 }}>
                {APP_NAME} turns your transactions into reports and a searchable history. Add a name, then
                bring in some data — that is what drives everything else.
              </div>
              <button
                type="button"
                onClick={() => setShowWelcomeHelp(current => !current)}
                style={{
                  flex: '0 0 auto',
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
                {showWelcomeHelp ? 'Hide overview' : 'What is this?'}
              </button>
            </div>

            {showWelcomeHelp ? (
              <div style={{
                padding: 18,
                background: 'color-mix(in srgb, var(--surface2) 36%, transparent)',
                border: '1px solid color-mix(in srgb, var(--border) 88%, white 4%)',
                borderRadius: 16,
                display: 'grid',
                gap: 12,
              }}>
                <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.6 }}>
                  The two things {APP_NAME} is for are <strong style={{ color: 'var(--text)' }}>reports</strong> (mostly
                  through the dashboard) and <strong style={{ color: 'var(--text)' }}>searching</strong> your transaction
                  history. Everything else — accounts, owners, categories, tags, and rules — exists to make those
                  better, and you can pick them up as you need them.
                </div>
                <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.6 }}>
                  It all starts with data. Import a CSV or connect a data provider below and the rest of the app fills
                  in around it. None of the choices here are permanent — almost anything can be changed later.
                </div>
              </div>
            ) : null}

            <div style={{
              padding: 15,
              background: 'color-mix(in srgb, var(--surface2) 36%, transparent)',
              border: '1px solid color-mix(in srgb, var(--border) 88%, white 4%)',
              borderRadius: 16,
              display: 'grid',
              gap: 8,
            }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>Your name</div>
              <TransientTextInput
                value={name}
                onChange={value => {
                  setName(value)
                  if (error) onClearError?.()
                }}
                restoreOnEscape
                onCommit={() => { }}
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
            </div>

            <div style={{ display: 'grid', gap: 4 }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>Bring in some data</div>
              <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.45 }}>
                {trimmedName ? 'Pick how you want to start.' : 'Add your name above, then pick how you want to start.'}
              </div>
            </div>

            <div style={{ display: 'grid', gap: 10 }}>
              {dataEntryChoices.map(choice => {
                const ready = !!trimmedName && !creating
                return (
                  <button
                    key={choice.key}
                    type="button"
                    disabled={!ready}
                    onClick={() => completeWelcome({ destination: choice.destination, loadDemo: choice.loadDemo, navState: choice.navState })}
                    style={{
                      textAlign: 'left',
                      display: 'grid',
                      gap: 4,
                      padding: 14,
                      borderRadius: 16,
                      background: ready ? 'var(--surface)' : 'color-mix(in srgb, var(--surface2) 28%, transparent)',
                      border: `1px solid ${ready ? 'color-mix(in srgb, var(--accent) 22%, var(--border))' : 'color-mix(in srgb, var(--border) 88%, white 4%)'}`,
                      cursor: ready ? 'pointer' : 'not-allowed',
                      opacity: ready ? 1 : 0.6,
                    }}
                  >
                    <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>{choice.title}</div>
                    <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.45 }}>{choice.summary}</div>
                  </button>
                )
              })}
            </div>

            <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.45 }}>
              Connecting links bank accounts through one of the supported <DataProviderInfoButton />.
            </div>

            <Toggle
              checked={skipHints}
              onChange={setSkipHints}
              label="Skip first-use hints (you can turn them back on from the Help page)"
              style={{ fontSize: 12, color: 'var(--muted)' }}
            />

            {creating ? (
              <div style={{ fontSize: 12, color: 'var(--muted)' }}>Setting up…</div>
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
              setPendingDelete(menu.profile)
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
      {pendingDelete ? (
        <AppConfirmDialog
          title="Delete user?"
          description={`Delete user "${pendingDelete.name}"? This removes their saved preferences.`}
          confirmLabel="Delete"
          confirmVariant="danger"
          borderColor="color-mix(in srgb, var(--danger) 35%, var(--border))"
          onConfirm={() => { onDelete(pendingDelete); setPendingDelete(null) }}
          onCancel={() => setPendingDelete(null)}
          width="min(480px, 100%)"
        />
      ) : null}
    </div>
  )
}

// Notify listeners that account mappings have changed (merge/detach/rename/delete/owner-change/
// forget-distinct-pair). Currently consumed by the unified duplicate-detection report so it
// auto-refreshes its entries when the user edits accounts based on what the report shows.
// Other surfaces can listen for the same event if they need to react to account mutations.
export function notifyAccountsChanged() {
  window.dispatchEvent(new CustomEvent('luma:accounts-changed'))
}

// Applies the user's stored theme choice to <html> and keeps a 'system' choice in sync with the OS.
// Lives inside UserPreferencesProvider so it reads the per-profile preference; the pre-paint script in
// index.html handles first paint from the localStorage cache, this reconciles to the real preference.
function ThemeController() {
  const [themeChoice] = useUserPreference(THEME_PREF_KEY, THEME_SYSTEM)
  useEffect(() => {
    applyTheme(themeChoice)
    if (normalizeThemeChoice(themeChoice) !== THEME_SYSTEM) return undefined
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => applyTheme(themeChoice)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [themeChoice])
  return null
}

export default function App() {
  /*
   * App boots through one of two gates before the main shell exists: authenticated sign-in/bootstrap, or local
   * preference-profile selection. After that, the active user/profile becomes the identity boundary for
   * preference providers and startup-route persistence.
   */
  const location = useLocation()
  const navigate = useNavigate()
  const [taskCount, setTaskCount] = useState(0)
  const [topTaskSeverity, setTopTaskSeverity] = useState(null)
  const [navPaneWidth, setNavPaneWidth] = useState(readStoredNavPaneWidth)
  const [navResizing, setNavResizing] = useState(false)
  const [authChecked, setAuthChecked] = useState(false)
  // Bumped when the api layer reports a lost session; the identity bootstrap below keys on it so the
  // shell re-establishes or re-gates rather than sitting on a dead session.
  const [sessionEpoch, setSessionEpoch] = useState(0)
  const [authEnabled, setAuthEnabled] = useState(false)
  const [needsBootstrap, setNeedsBootstrap] = useState(false)
  const [currentUser, setCurrentUser] = useState(null)
  const [authError, setAuthError] = useState(null)
  const [passwordPolicy, setPasswordPolicy] = useState('min_8')
  const [securityProfile, setSecurityProfile] = useState('local_private')
  const [dataProviderIntended, setDataProviderIntended] = useState(false)
  const [developerOptionsEnabled, setDeveloperOptionsEnabled] = useState(false)
  // Where this copy's databases are. Absent for a session the server will not tell (a non-admin under
  // sign-in protection), which is what keeps the nav line and `/auth/config` on one rule.
  const [dataLocation, setDataLocation] = useState(null)
  // Stopping the whole application, offered only where it would work — see `routers/app_control.py`.
  const [shutdownAvailable, setShutdownAvailable] = useState(false)
  const [pendingShutdown, setPendingShutdown] = useState(false)
  const [shuttingDown, setShuttingDown] = useState(false)
  const [shutdownError, setShutdownError] = useState('')
  const [appStopped, setAppStopped] = useState(false)
  const [dbInstanceId, setDbInstanceId] = useState('')
  // Whether this build ships its own license copy — the About page's offline fallback.
  const [bundledLicenseAvailable, setBundledLicenseAvailable] = useState(false)
  const [localProfiles, setLocalProfiles] = useState([])
  const [activeLocalProfile, setActiveLocalProfile] = useState(null)
  const [previousLocalProfile, setPreviousLocalProfile] = useState(null)
  const [localProfilePickerDismissible, setLocalProfilePickerDismissible] = useState(false)
  const [creatingLocalProfile, setCreatingLocalProfile] = useState(false)
  const [localProfileError, setLocalProfileError] = useState('')
  // Demo-data mode: a global app strip + the guard that blocks new imports/connections while the
  // explorable demo set is loaded (see the demo-data marker in the backend).
  const [demoLoaded, setDemoLoaded] = useState(false)
  // Held in state purely so applying it re-renders; the value itself is read from MONEY_DISPLAY_CONFIG.
  const [, setLedgerCurrencyCode] = useState('')
  const [pendingDemoClear, setPendingDemoClear] = useState(false)
  const [clearingDemo, setClearingDemo] = useState(false)
  const [demoClearError, setDemoClearError] = useState('')
  const [navProfileMenu, setNavProfileMenu] = useState(null)
  const [navProfileEditing, setNavProfileEditing] = useState(false)
  const [navProfileDraft, setNavProfileDraft] = useState('')
  const [startupRouteApplied, setStartupRouteApplied] = useState(false)
  const [bootPreferences, setBootPreferences] = useState(null)
  const [bootPreferenceSubjectId, setBootPreferenceSubjectId] = useState('')
  const navProfileMenuRef = useRef(null)
  const recurringAutoScanScopeRef = useRef(null)
  const savedStartupRouteRef = useRef('')
  const savedStartupRouteSubjectRef = useRef('')
  const preferenceSubjectId = authEnabled
    ? (currentUser?.id || currentUser?.user_id || '')
    : (activeLocalProfile?.id || '')
  // Setters are exposed alongside getters so the Settings security forms can persist a change to
  // the backend and immediately reflect it in shell-level session state without a reload. (useState
  // setters are stable, so they never re-trigger this memo.)
  const appSessionValue = useMemo(() => ({
    authEnabled,
    currentUser,
    passwordPolicy,
    securityProfile,
    dataProviderIntended,
    developerOptionsEnabled,
    dataLocation,
    dbInstanceId,
    bundledLicenseAvailable,
    activeLocalProfile,
    preferenceSubjectId,
    setAuthEnabled,
    setSecurityProfile,
    setPasswordPolicy,
    setDataProviderIntended,
    setCurrentUser,
  }), [
    authEnabled,
    currentUser,
    passwordPolicy,
    securityProfile,
    dataProviderIntended,
    developerOptionsEnabled,
    dataLocation,
    dbInstanceId,
    bundledLicenseAvailable,
    activeLocalProfile,
    preferenceSubjectId,
  ])

  async function hydrateStartupRoute(profileId = '', options = {}) {
    const { forceFromRoot = false, preferenceSubjectIdOverride = '' } = options
    try {
      // Identity is carried by the session cookie now; the caller establishes it (select-identity /
      // login) before hydrating, so there is nothing to set here.
      // The startup route is stored per active preference identity, so hydrate it before we start saving the
      // current location; otherwise first load would immediately overwrite the remembered landing page with "/".
      const prefResp = await api.getUserPreferences().catch(() => ({ preferences: {} }))
      const nextPreferenceSubjectId = preferenceSubjectIdOverride || profileId || ''
      setBootPreferenceSubjectId(nextPreferenceSubjectId)
      setBootPreferences(prefResp?.preferences || {})
      const startupRoute = String(prefResp?.preferences?.[STARTUP_ROUTE_PREFERENCE_KEY] || '').trim()
      const validStartupRoute = safeStartupRoute(startupRoute)
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

  // Before anything else, and unconditionally: a backend that stops does so regardless of whether
  // anyone is signed in, and the tab that has to be told may be sitting on the sign-in screen. The
  // failed requests that carry the news arrive from the api layer (see `lib/backendLiveness.js` for why
  // there is no heartbeat behind this).
  useEffect(() => {
    const stopWatching = watchBackendLiveness()
    const onStopped = () => setAppStopped(true)
    // A reload rather than an unlatch: a restart may be on a different port, under a different session,
    // against a different database, and every value on screen was read from the process that has gone.
    // Nothing here is unsaved — mutations went to the server — so there is nothing to weigh against it.
    const onReturned = () => window.location.reload()
    window.addEventListener(BACKEND_STOPPED_EVENT, onStopped)
    window.addEventListener(BACKEND_RETURNED_EVENT, onReturned)
    return () => {
      window.removeEventListener(BACKEND_STOPPED_EVENT, onStopped)
      window.removeEventListener(BACKEND_RETURNED_EVENT, onReturned)
      stopWatching()
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    async function loadAuth() {
      try {
        const status = await api.getAuthStatus()
        if (cancelled) return
        setAuthEnabled(!!status.auth_enabled)
        setNeedsBootstrap(!!status.needs_bootstrap)
        setPasswordPolicy(status.password_policy || 'min_8')
        setSecurityProfile(status.security_profile || 'local_private')
        setDataProviderIntended(!!status.data_provider_intended)
        setDeveloperOptionsEnabled(!!status.developer_options_enabled)
        setDataLocation(status.data_location || null)
        setShutdownAvailable(!!status.app_shutdown_available)
        setDbInstanceId(status.db_instance_id || '')
        setBundledLicenseAvailable(!!status.bundled_license_available)
        // Drop a theme cache left over from a different/previous database (e.g. a recreated DB) so the
        // welcome screen — which paints before any per-profile theme loads — falls back to System
        // rather than inheriting the old palette. Same-DB profile clears keep their configured theme.
        reconcileThemeCacheForDb(status.db_instance_id || '')
        setBootPreferences(null)
        setBootPreferenceSubjectId('')

        if (!status.auth_enabled) {
          const identsResp = await api.getIdentities().catch(() => ({ identities: [] }))
          if (cancelled) return
          // Present the unified user_account rows as the local chooser; keep the internal `{id, name}`
          // shape the picker/nav already use by folding display_name -> name.
          const profiles = (identsResp?.identities || []).map(i => ({ id: i.id, name: i.display_name }))
          setLocalProfiles(profiles)
          const storageKey = getLocalProfileStorageKey(status.db_instance_id || '')
          const rememberedId = storageKey ? window.localStorage.getItem(storageKey) : ''
          // An already-established (pwless) session — status.user — means an identity is picked; adopt it
          // without re-selecting. Otherwise auto-select a remembered/only identity (which establishes the
          // session), else stop on the chooser. "No anonymous default": nothing is active without a pick.
          const sessionProfile = status.user
            ? (profiles.find(p => p.id === status.user.id) || { id: status.user.id, name: status.user.display_name })
            : null
          const remembered = profiles.find(profile => profile.id === rememberedId) || null
          const target = sessionProfile || remembered || (profiles.length === 1 ? profiles[0] : null)
          if (target) {
            setCurrentUser(status.user || null)
            await activateLocalProfile(target, { alreadySelected: !!sessionProfile })
          } else {
            setCurrentUser(null)
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
    // Re-runs only when the session is lost (`sessionEpoch`), which is the one thing that invalidates
    // its result. hydrateStartupRoute closes over location.pathname + navigate; wrapping it in
    // useCallback and listing it here would re-fire the auth check on every URL change, which is wrong.
    // Other call sites invoke hydrateStartupRoute directly from click handlers
    // and don't need stable identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionEpoch])

  /*
   * A 401 anywhere means the server no longer knows who is asking, so the shell — not the surface that
   * happened to make the request — answers it: drop back behind the gate and re-run the bootstrap,
   * which re-establishes a passwordless session or stops on the chooser / sign-in. Before this, a lapse
   * surfaced as whatever error text the unlucky component rendered, with nothing to act on.
   */
  useEffect(() => {
    function onSessionLost() {
      setAuthChecked(false)
      setCurrentUser(null)
      setSessionEpoch(epoch => epoch + 1)
    }
    window.addEventListener(SESSION_LOST_EVENT, onSessionLost)
    return () => window.removeEventListener(SESSION_LOST_EVENT, onSessionLost)
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
    window.addEventListener('luma:data-mutated', fetchTasks)
    return () => window.removeEventListener('luma:data-mutated', fetchTasks)
    // Two refresh triggers, by design:
    //   * `luma:data-mutated` — same-session immediacy: any successful mutation anywhere emits
    //     this from the api layer (see `signalDataMutated` in api.js), so the badge updates without
    //     the user navigating, and no call site has to remember to refresh it.
    //   * `location.pathname` in the deps — navigation backstop: re-fetch on every route change to
    //     pick up changes this session didn't make (another tab, a background sync). With the api
    //     emit covering local mutations, this is no longer compensating for a missed broadcast.
    // activeLocalProfile is gated by the !authEnabled guard above — without it in deps the effect
    // never re-runs after the local profile loads on cold start, so the nav badge stays at 0
    // even when /tasks itself is showing pending items.
  }, [authEnabled, currentUser, activeLocalProfile, location.pathname])

  // Recurring-detection catch-up: once the data scope is active, ask the backend to scan if one is due
  // (never scanned — e.g. a database migrated from a pre-recurring schema — or stale). The backend gates
  // on a watermark, so this is a cheap no-op when a recent import/sync already scanned. Keyed to the
  // active scope (not navigation) so it fires once per session, and again after a profile switch.
  useEffect(() => {
    if (authEnabled && !currentUser) return
    if (!authEnabled && !activeLocalProfile) return
    if (!preferenceSubjectId || recurringAutoScanScopeRef.current === preferenceSubjectId) return
    recurringAutoScanScopeRef.current = preferenceSubjectId
    api.autoScanRecurring().catch(() => { })
    // Same shape, different trigger: re-examine stored rows once when the duplicate matcher's rules have
    // changed since this database was last scanned. Version-gated rather than time-gated, so it is a
    // no-op on every load but the first after a rule change.
    api.rescanDuplicates().catch(() => { })
  }, [authEnabled, currentUser, activeLocalProfile, preferenceSubjectId])

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

  async function confirmShutdownApp() {
    setShuttingDown(true)
    setShutdownError('')
    try {
      await api.shutdownApp()
    } catch (error) {
      setShuttingDown(false)
      setShutdownError(error?.message || 'Could not stop the application.')
      return
    }
    // The server answers before it stops, so success here means the request was accepted rather than
    // that the process is already gone. What follows is a dead app either way — every later request
    // fails — so the UI says so plainly instead of letting the page decay into unexplained errors.
    // Announced rather than set directly: every other tab is about to lose the same backend, and this
    // is the one moment where that is known rather than discovered. The announcement comes back to
    // this tab through the same listener that serves the others.
    setPendingShutdown(false)
    setShuttingDown(false)
    announceBackendStopped()
  }

  function handleSwitchLocalProfile() {
    // Switching shows the chooser again; the session cookie keeps pointing at the current identity until
    // a new one is picked (select-identity), so there is nothing to clear here.
    setPreviousLocalProfile(activeLocalProfile)
    setLocalProfilePickerDismissible(true)
    setActiveLocalProfile(null)
  }

  // Make `profile` the active identity. Unless it is `alreadySelected`, establish its perimeter-off
  // session first (select-identity) — that is what carries identity now, in place of the old header.
  async function activateLocalProfile(profile, options = {}) {
    const { forceStartupRoute = false, alreadySelected = false } = options
    setLocalProfileError('')
    if (!alreadySelected) {
      try {
        const resp = await api.selectIdentity(profile.id)
        setCurrentUser(resp?.user || null)
      } catch (err) {
        setLocalProfileError(err?.message || 'Could not switch to this user.')
        setStartupRouteApplied(true)
        return
      }
    }
    setStartupRouteApplied(false)
    setActiveLocalProfile(profile)
    setPreviousLocalProfile(null)
    setLocalProfilePickerDismissible(false)
    setNavProfileEditing(false)
    setNavProfileMenu(null)
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
      const resp = await api.createIdentity(name)
      const identity = resp?.identity
      if (!identity) return
      const profile = { id: identity.id, name: identity.display_name }
      setLocalProfiles(prev => {
        const exists = prev.find(item => item.id === profile.id)
        return exists ? prev : [...prev, profile].sort((a, b) => a.name.localeCompare(b.name))
      })
      await activateLocalProfile(profile, { forceStartupRoute: !localProfilePickerDismissible })
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

  // First-run completion. The welcome flow creates one local profile and then sends the user once to the
  // data-entry surface they chose (import, data providers, demo dashboard, or an empty app). The persisted
  // startup route is left at its default so later launches don't keep reopening that one-time destination.
  async function handleCompleteWelcomeSetup(setup) {
    const name = String(setup?.name || '').trim()
    const destination = String(setup?.destination || '/')
    const loadDemo = !!setup?.loadDemo
    if (!name) {
      setLocalProfileError('Add a user name to continue.')
      return
    }

    setLocalProfileError('')
    setCreatingLocalProfile(true)

    try {
      const resp = await api.createIdentity(name)
      const identity = resp?.identity
      if (!identity) {
        throw new Error('Could not create the first user.')
      }
      const profile = { id: identity.id, name: identity.display_name }

      setLocalProfiles(prev => (
        prev.some(item => item.id === profile.id)
          ? prev
          : [...prev, profile].sort((a, b) => a.name.localeCompare(b.name))
      ))

      // Preferences and demo data are scoped to the current identity's session, so establish it first.
      await api.selectIdentity(profile.id)
      // Persist the welcome screen's "skip first-use hints" choice against the brand-new identity (the
      // session is now set), before the app mounts the preferences provider and navigates.
      if (setup?.disableHints) {
        await api.saveUserPreference(HELP_HINTS_ENABLED_PREF_KEY, false).catch(() => { })
      }
      if (loadDemo) {
        await api.loadDemoData()
        setDemoLoaded(true)
      }

      await activateLocalProfile(profile, { alreadySelected: true })
      navigate(destination, { replace: true, state: setup?.navState || undefined })
    } catch (err) {
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
    const resp = await api.renameIdentity(profileId, name)
    const updated = resp?.identity ? { id: resp.identity.id, name: resp.identity.display_name } : null
    if (!updated) return
    setLocalProfiles(prev => prev.map(profile => profile.id === profileId ? updated : profile).sort((a, b) => a.name.localeCompare(b.name)))
    setActiveLocalProfile(prev => prev?.id === profileId ? updated : prev)
    if (activeLocalProfile?.id === profileId) {
      setNavProfileDraft(updated.name)
    }
  }

  // The chooser confirms the deletion itself and calls this on confirm, so this performs the delete.
  async function handleDeleteLocalProfile(profile) {
    if (!profile) return
    await api.deleteIdentity(profile.id)
    setLocalProfiles(prev => prev.filter(item => item.id !== profile.id))
    const deletedCurrentProfile =
      activeLocalProfile?.id === profile.id || previousLocalProfile?.id === profile.id
    if (deletedCurrentProfile) {
      const storageKey = getLocalProfileStorageKey(dbInstanceId)
      if (storageKey) {
        try { window.localStorage.removeItem(storageKey) } catch { }
      }
      setActiveLocalProfile(null)
      setPreviousLocalProfile(null)
      setLocalProfilePickerDismissible(false)
      setNavProfileEditing(false)
      setNavProfileMenu(null)
    }
  }

  // Demo-data status follows the active tenant/profile; it drives the global demo strip and is the
  // signal that imports/connections are paused. Errors (e.g. auth mode, where the endpoint 400s) just
  // mean "no demo".
  //
  // This and the currency lookup below wait for a session subject: both endpoints need one, and a request
  // sent before the identity bootstrap finishes answers 401, which the shell reads as a lost session and
  // restarts that same bootstrap.
  useEffect(() => {
    if (!preferenceSubjectId) return
    let cancelled = false
    api.getDemoDataStatus()
      .then(result => { if (!cancelled) setDemoLoaded(!!result?.loaded) })
      .catch(() => { if (!cancelled) setDemoLoaded(false) })
    return () => { cancelled = true }
  }, [dbInstanceId, preferenceSubjectId])

  // The ledger's currency symbol, applied to the shared money formatters. Keyed on the database identity
  // because it is tenant state: switching profile or restoring a backup can bring a differently
  // denominated ledger, and the symbol has to follow the data rather than the browser.
  //
  // Failure is deliberately silent and leaves the default in place — a currency lookup is not a reason to
  // block the app, and every amount still renders, just with the symbol it has always had.
  useEffect(() => {
    if (!preferenceSubjectId) return
    let cancelled = false
    api.getLedgerCurrency()
      .then(result => {
        if (cancelled || !result?.code) return
        // A state bump so the tree re-renders with the new symbol. The formatters read the config at call
        // time, so they are already correct — this is only what makes React ask them again.
        if (applyLedgerCurrency(result.code)) setLedgerCurrencyCode(result.code)
      })
      .catch(() => { })
    return () => { cancelled = true }
  }, [dbInstanceId, preferenceSubjectId])

  async function confirmClearDemoData() {
    setClearingDemo(true)
    setDemoClearError('')
    try {
      await api.clearDemoData()
      // Hard reload to a clean slate: every page drops its cached (now-deleted) data and re-bootstraps.
      window.location.assign('/')
    } catch (err) {
      setClearingDemo(false)
      setDemoClearError(err?.message || 'Could not clear the demo data. Please try again.')
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

  if (authEnabled && !currentUser) {
    return (
      <AppErrorBoundary>
        <AuthScreen
          needsBootstrap={needsBootstrap}
          passwordPolicy={passwordPolicy}
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
          {/* No seeded date: the filter starts unset (all-time). The Dashboard reinterprets "unset" as
              its own configurable default period; other pages treat unset as all-time. */}
          <FilterProvider>
            <PanelStackProvider>
              <TransactionShareProvider>
                <UnifiedDuplicatesViewerProvider>
                  <AmazonReconciliationViewerProvider>
                  <AmazonImportDetailViewerProvider>
                  <ImportedCategoryWorkspaceProvider>
                  <VaultGateProvider>
                  <SyncStatusProvider>
                    <ThemeController />
                    <UnifiedDuplicatesViewerRenderer />
                    <AmazonReconciliationViewerRenderer />
                    <AmazonImportDetailViewerRenderer />
                    <ImportedCategoryWorkspaceRenderer />
                    <SyncStatusRenderer />
                    <VaultGateRenderer />
                    <style>{GLOBAL_SCROLLBAR_STYLES}</style>
                    {pendingShutdown ? (
                      <AppConfirmDialog
                        title="Shut down Luma?"
                        description={shutdownError
                          ? shutdownError
                          : 'This stops Luma on this computer, not just this session — the page stops working until it is started again. Nothing is lost: data is already saved.'}
                        confirmLabel={shuttingDown ? 'Shutting down…' : 'Shut down Luma'}
                        confirmVariant="danger"
                        confirmDisabled={shuttingDown}
                        cancelDisabled={shuttingDown}
                        onConfirm={confirmShutdownApp}
                        onCancel={() => { setPendingShutdown(false); setShutdownError('') }}
                        width="min(460px, 100%)"
                      />
                    ) : null}
                    {appStopped ? <BackendStoppedDialog /> : null}
                    {pendingDemoClear ? (
                      <AppConfirmDialog
                        title="Clear demo data?"
                        description={demoClearError
                          ? demoClearError
                          : 'This removes the demo dataset and returns the app to a clean slate so you can bring in your own data. This cannot be undone.'}
                        confirmLabel={clearingDemo ? 'Clearing…' : 'Clear demo data'}
                        confirmVariant="danger"
                        confirmDisabled={clearingDemo}
                        cancelDisabled={clearingDemo}
                        borderColor="color-mix(in srgb, var(--danger) 35%, var(--border))"
                        onConfirm={confirmClearDemoData}
                        onCancel={() => { setPendingDemoClear(false); setDemoClearError('') }}
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
                          <DataLocationLine dataLocation={dataLocation} />
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
                        {/* Permanent, so it belongs with the pages rather than among the stashed-report
                            pills below it — see components/SyncNavItem.jsx. */}
                        <SyncNavItem style={s.link} activeStyle={activeStyle} />
                        <MinimizedDuplicatesNavItem />
                        <MinimizedAmazonReconciliationNavItem />
                        <MinimizedAmazonImportDetailNavItem />
                        <MinimizedImportedCategoryWorkspaceNavItem />
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
                          {/* Last, because it is the most final thing here — and named for the whole
                              application rather than "Quit", which beside "Sign out" would read as
                              ending the session. Absent unless the backend says stopping would work. */}
                          {shutdownAvailable && (
                            <button
                              onClick={() => { setShutdownError(''); setPendingShutdown(true) }}
                              style={{
                                width: '100%',
                                marginTop: 8,
                                background: 'none',
                                border: '1px solid var(--border)',
                                color: 'var(--muted)',
                                borderRadius: 8,
                                padding: '8px 10px',
                                cursor: 'pointer',
                              }}
                              title="Stop Luma on this computer"
                            >
                              Shut down Luma
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
                        {demoLoaded ? (
                          <div style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 12,
                            flexWrap: 'wrap',
                            padding: '7px 16px',
                            fontSize: 12.5,
                            background: 'color-mix(in srgb, var(--danger) 12%, var(--surface))',
                            borderBottom: '1px solid color-mix(in srgb, var(--danger) 30%, var(--border))',
                          }}>
                            <span style={{ fontWeight: 700, color: 'color-mix(in srgb, var(--danger) 72%, var(--text))', letterSpacing: '0.02em' }}>
                              Demo data
                            </span>
                            <span style={{ color: 'var(--muted)' }}>
                              Exploring the sample dataset — imports and connections are disabled.
                            </span>
                            <button
                              type="button"
                              onClick={() => { setDemoClearError(''); setPendingDemoClear(true) }}
                              style={{
                                marginLeft: 'auto',
                                background: 'color-mix(in srgb, var(--danger) 14%, var(--surface))',
                                color: 'color-mix(in srgb, var(--danger) 82%, var(--text))',
                                border: '1px solid color-mix(in srgb, var(--danger) 40%, var(--border))',
                                borderRadius: 8,
                                padding: '5px 12px',
                                fontSize: 12,
                                fontWeight: 600,
                                cursor: 'pointer',
                              }}
                            >
                              Clear demo data
                            </button>
                          </div>
                        ) : null}
                        {shouldShowFilterBar(location.pathname) ? <FilterBar /> : null}
                        <div style={s.content}>
                          <AppRoutes />
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
                  </SyncStatusProvider>
                  </VaultGateProvider>
                  </ImportedCategoryWorkspaceProvider>
                  </AmazonImportDetailViewerProvider>
                  </AmazonReconciliationViewerProvider>
                </UnifiedDuplicatesViewerProvider>
              </TransactionShareProvider>
            </PanelStackProvider>
          </FilterProvider>
        </UserPreferencesProvider>
      </AppSessionProvider>
    </AppErrorBoundary>
  )
}
