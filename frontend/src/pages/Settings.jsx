// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState, useEffect, useRef, useId, useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api } from '../lib/api.js'
import { txnMutations } from '../lib/txnMutations.js'
import { APP_NAME, APP_VERSION } from '../lib/appConfig.js'
import { useAppSession } from '../lib/AppSessionContext.jsx'
import { Card, PageHeader, Button, Spinner, EmptyState, FormLabel, InsetPanel, SectionEyebrow, getFormControlStyle, PasswordInput, AppConfirmDialog, Tooltip } from '../components/ui.jsx'
import FeatureExplainer from '../help/FeatureExplainer.jsx'
import { PASSWORD_POLICIES, passwordPolicyHelpText, validatePasswordForPolicy } from '../lib/passwordPolicy.js'
import { useTransientTextEdit } from '../lib/uiInteractions.js'
import { useBusyIndicator } from '../lib/useBusyIndicator.js'
import { useUserPreference } from '../lib/UserPreferencesContext.jsx'
import { THEME_PREF_KEY, THEME_SYSTEM, THEME_CHOICES, THEME_LABELS } from '../lib/theme.js'
import TransientTextInput from '../components/TransientTextInput.jsx'
import { OutcomeChip } from '../components/importExport/SourceAccountChip.jsx'
import { TagGlyph, TAG_COLOR_PALETTE } from '../components/TagUi.jsx'
import { invalidateTags } from '../lib/useTags.js'
import { formatDate } from '../lib/utils.js'
import { notifyAccountsChanged } from '../App.jsx'
import { DEFAULT_LEDGER_CURRENCY, applyLedgerCurrency, currencySymbolFor } from '../lib/moneyDisplay.js'
import {
  allowanceSummary, cardSummary, checkpointSummary, finalStatusSummary, historyDepthSummary,
  requestPoolSummary, skippedBreakdown, syncLogDate, syncModeLabel, windowSummary,
} from '../lib/syncLogSummary.js'

const SETTINGS_SECTIONS_PREF_KEY = 'ui.settings.stickySections'
// Stable default so the preference value keeps a constant identity when nothing is saved yet.
const EMPTY_SECTION_STATE = {}
const SETTINGS_CONTENT_WIDTH = 'min(1040px, 100%)'
// Password fields don't need the full card width — cap them so a ~40-50 character entry is visible
// without the field spanning the whole (wide) settings card.
const PASSWORD_FIELD_WIDTH = { maxWidth: 360 }
function clearBrowserStoredState() {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.clear()
  } catch { }
  try {
    window.sessionStorage.clear()
  } catch { }
}

function UserAdminSection({ passwordPolicy }) {
  const fieldIdBase = useId()
  const [viewer, setViewer] = useState(null)
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [savingUserId, setSavingUserId] = useState(null)
  const [deletingUserId, setDeletingUserId] = useState(null)
  const [editingUserId, setEditingUserId] = useState(null)
  const [pendingDeleteUser, setPendingDeleteUser] = useState(null)
  const [error, setError] = useState('')
  const [form, setForm] = useState({
    username: '',
    display_name: '',
    password: '',
    role: 'member',
  })
  const [editForm, setEditForm] = useState({
    username: '',
    display_name: '',
    password: '',
    role: 'member',
    status: 'active',
  })
  const [newUserId, setNewUserId] = useState(null)
  const userRowRefs = useRef(new Map())
  const editRowRefs = useRef(new Map())
  const userTableHeaderRef = useRef(null)

  async function load() {
    setLoading(true)
    try {
      const me = await api.getCurrentUser()
      setViewer(me.user)
      if (me.user.role === 'admin') {
        const resp = await api.listUsers()
        setUsers(resp.users)
      }
      setError('')
    } catch (err) {
      setError(err.message || 'Failed to load user management')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  useEffect(() => {
    if (!newUserId) return
    const row = userRowRefs.current.get(newUserId)
    if (!row) return
    row.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    setNewUserId(null)
  }, [users, newUserId])

  useEffect(() => {
    if (!editingUserId) return
    const row = editRowRefs.current.get(editingUserId)
    if (!row) return
    row.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [editingUserId])

  async function handleCreate(e) {
    e.preventDefault()
    setCreating(true)
    setError('')
    try {
      const resp = await api.createUser(form)
      setNewUserId(resp?.user?.id || null)
      setForm({ username: '', display_name: '', password: '', role: 'member' })
      await load()
    } catch (err) {
      setError(err.message || 'Failed to create user')
    } finally {
      setCreating(false)
    }
  }

  function startEditing(user) {
    setEditingUserId(user.id)
    setEditForm({
      username: user.username || '',
      display_name: user.display_name || '',
      password: '',
      role: user.role || 'member',
      status: user.status || 'active',
      must_change_password: !!user.must_change_password,
    })
    setError('')
  }

  function cancelEditing() {
    setEditingUserId(null)
    setEditForm({
      username: '',
      display_name: '',
      password: '',
      role: 'member',
      status: 'active',
      must_change_password: false,
    })
  }

  async function handleSaveUser(userId) {
    setSavingUserId(userId)
    setError('')
    try {
      const payload = {
        username: editForm.username,
        display_name: editForm.display_name,
        role: editForm.role,
        status: editForm.status,
        must_change_password: editForm.must_change_password,
        ...(editForm.password ? { password: editForm.password } : {}),
      }
      await api.updateUser(userId, payload)
      cancelEditing()
      await load()
    } catch (err) {
      setError(err.message || 'Failed to update user')
    } finally {
      setSavingUserId(null)
    }
  }

  async function handleDeleteUser(user) {
    setPendingDeleteUser(null)
    setDeletingUserId(user.id)
    setError('')
    try {
      await api.deleteUser(user.id)
      if (editingUserId === user.id) cancelEditing()
      await load()
      userTableHeaderRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    } catch (err) {
      setError(err.message || 'Failed to delete user')
    } finally {
      setDeletingUserId(null)
    }
  }

  if (loading) return <Spinner />
  if (!viewer || viewer.role !== 'admin') return null

  const inputStyle = {
    ...getFormControlStyle({ size: 'md', surface: 'base' }),
    width: '100%',
  }

  return (
    <>
      {pendingDeleteUser ? (
        <AppConfirmDialog
          title="Delete user?"
          description={`Delete ${pendingDeleteUser.display_name || pendingDeleteUser.username}? This removes their sign-in account.`}
          confirmLabel="Delete user"
          confirmVariant="danger"
          borderColor="color-mix(in srgb, var(--danger) 35%, var(--border))"
          onConfirm={() => handleDeleteUser(pendingDeleteUser)}
          onCancel={() => setPendingDeleteUser(null)}
          width="min(520px, 100%)"
        />
      ) : null}

      <Card style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)', background: 'var(--surface2)' }}>
          <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.5 }}>
            Use this area when more than one person needs their own sign-in, such as a shared household system or a password-protected home server.
          </div>
        </div>

        <form onSubmit={handleCreate} style={{ padding: 16, borderBottom: '1px solid var(--border)', display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 120px auto', gap: 10, alignItems: 'end' }}>
          <div>
            <FormLabel htmlFor={`${fieldIdBase}-create-username`} style={{ marginBottom: 4 }}>Username</FormLabel>
            <input id={`${fieldIdBase}-create-username`} name="settings-create-user-username" value={form.username} onChange={e => setForm(prev => ({ ...prev, username: e.target.value }))} style={inputStyle} />
          </div>
          <div>
            <FormLabel htmlFor={`${fieldIdBase}-create-display-name`} style={{ marginBottom: 4 }}>Display name</FormLabel>
            <input id={`${fieldIdBase}-create-display-name`} name="settings-create-user-display-name" value={form.display_name} onChange={e => setForm(prev => ({ ...prev, display_name: e.target.value }))} style={inputStyle} />
          </div>
          <div>
            <FormLabel htmlFor={`${fieldIdBase}-create-password`} style={{ marginBottom: 4 }}>Password</FormLabel>
            <input id={`${fieldIdBase}-create-password`} name="settings-create-user-password" type="password" value={form.password} onChange={e => setForm(prev => ({ ...prev, password: e.target.value }))} style={inputStyle} />
          </div>
          <div>
            <FormLabel htmlFor={`${fieldIdBase}-create-role`} style={{ marginBottom: 4 }}>Role</FormLabel>
            <select id={`${fieldIdBase}-create-role`} name="settings-create-user-role" value={form.role} onChange={e => setForm(prev => ({ ...prev, role: e.target.value }))} style={{ ...inputStyle, cursor: 'pointer' }}>
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </select>
          </div>
          <Button small type="submit" disabled={creating || !form.username.trim() || !validatePasswordForPolicy(form.password, passwordPolicy)}>
            {creating ? 'Creating...' : 'Add user'}
          </Button>
        </form>
        <div style={{ padding: '10px 16px', color: 'var(--muted)', fontSize: 12, borderBottom: '1px solid var(--border)' }}>
          Password policy: {passwordPolicyHelpText(passwordPolicy)}
        </div>

        {error && (
          <div style={{ padding: '10px 16px', color: 'var(--danger)', fontSize: 13, borderBottom: '1px solid var(--border)' }}>
            {error}
          </div>
        )}

        <div ref={userTableHeaderRef} style={{ display: 'grid', gridTemplateColumns: '1.4fr 120px 1fr 1fr auto', padding: '8px 16px', borderBottom: '1px solid var(--border)', gap: 10 }}>
          <SectionEyebrow>User</SectionEyebrow>
          <SectionEyebrow>Role</SectionEyebrow>
          <SectionEyebrow>Status</SectionEyebrow>
          <SectionEyebrow>Last login</SectionEyebrow>
          <span />
        </div>
        {users.map(user => (
          editingUserId === user.id ? (
            <div
              key={user.id}
              ref={node => {
                if (node) editRowRefs.current.set(user.id, node)
                else editRowRefs.current.delete(user.id)
              }}
              style={{ padding: 16, borderBottom: '1px solid var(--border)', display: 'grid', gap: 12, background: 'var(--surface2)' }}
            >
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 120px 120px', gap: 10 }}>
                <div>
                  <FormLabel htmlFor={`${fieldIdBase}-edit-${user.id}-username`} style={{ marginBottom: 4 }}>Username</FormLabel>
                  <input id={`${fieldIdBase}-edit-${user.id}-username`} name={`settings-edit-user-${user.id}-username`} value={editForm.username} onChange={e => setEditForm(prev => ({ ...prev, username: e.target.value }))} style={inputStyle} />
                </div>
                <div>
                  <FormLabel htmlFor={`${fieldIdBase}-edit-${user.id}-display-name`} style={{ marginBottom: 4 }}>Display name</FormLabel>
                  <input id={`${fieldIdBase}-edit-${user.id}-display-name`} name={`settings-edit-user-${user.id}-display-name`} value={editForm.display_name} onChange={e => setEditForm(prev => ({ ...prev, display_name: e.target.value }))} style={inputStyle} />
                </div>
                <div>
                  <FormLabel htmlFor={`${fieldIdBase}-edit-${user.id}-password`} style={{ marginBottom: 4 }}>New password</FormLabel>
                  <input id={`${fieldIdBase}-edit-${user.id}-password`} name={`settings-edit-user-${user.id}-password`} type="password" value={editForm.password} onChange={e => setEditForm(prev => ({ ...prev, password: e.target.value }))} placeholder="Leave blank to keep current" style={inputStyle} />
                </div>
                <div>
                  <FormLabel htmlFor={`${fieldIdBase}-edit-${user.id}-role`} style={{ marginBottom: 4 }}>Role</FormLabel>
                  <select id={`${fieldIdBase}-edit-${user.id}-role`} name={`settings-edit-user-${user.id}-role`} value={editForm.role} onChange={e => setEditForm(prev => ({ ...prev, role: e.target.value }))} style={{ ...inputStyle, cursor: 'pointer' }}>
                    <option value="member">Member</option>
                    <option value="admin">Admin</option>
                  </select>
                </div>
                <div>
                  <FormLabel htmlFor={`${fieldIdBase}-edit-${user.id}-status`} style={{ marginBottom: 4 }}>Status</FormLabel>
                  <select id={`${fieldIdBase}-edit-${user.id}-status`} name={`settings-edit-user-${user.id}-status`} value={editForm.status} onChange={e => setEditForm(prev => ({ ...prev, status: e.target.value }))} style={{ ...inputStyle, cursor: 'pointer' }}>
                    <option value="active">Active</option>
                    <option value="disabled">Disabled</option>
                  </select>
                </div>
              </div>
              <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                {editForm.password ? passwordPolicyHelpText(passwordPolicy) : 'Leave the password field empty to keep the existing password.'}
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={editForm.must_change_password}
                  onChange={e => setEditForm(prev => ({ ...prev, must_change_password: e.target.checked }))}
                />
                Require a password change at next sign-in
              </label>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <Button
                  small
                  onClick={() => handleSaveUser(user.id)}
                  disabled={savingUserId === user.id || !editForm.username.trim() || !editForm.display_name.trim() || (editForm.password && !validatePasswordForPolicy(editForm.password, passwordPolicy))}
                >
                  {savingUserId === user.id ? 'Saving...' : 'Save changes'}
                </Button>
                <Button small variant="ghost" onClick={cancelEditing}>Cancel</Button>
                {viewer?.id !== user.id && (
                  <Button small variant="ghost" onClick={() => setPendingDeleteUser(user)} disabled={deletingUserId === user.id}>
                    {deletingUserId === user.id ? 'Deleting...' : 'Delete user'}
                  </Button>
                )}
              </div>
            </div>
          ) : (
            <div
              key={user.id}
              ref={node => {
                if (node) userRowRefs.current.set(user.id, node)
                else userRowRefs.current.delete(user.id)
              }}
              style={{ display: 'grid', gridTemplateColumns: '1.4fr 120px 1fr 1fr auto', padding: '10px 16px', fontSize: 13, borderBottom: '1px solid var(--border)', alignItems: 'center', gap: 10 }}
            >
              <div>
                <div style={{ fontWeight: 500 }}>
                  {user.username}
                  <span style={{ fontWeight: 400, color: 'var(--muted)' }}>
                    {` - ${user.display_name || user.username}`}
                  </span>
                  {viewer?.id === user.id ? ' (you)' : ''}
                </div>
              </div>
              <span style={{ textTransform: 'capitalize' }}>{user.role}</span>
              <span style={{ textTransform: 'capitalize' }}>{user.status}</span>
              <span style={{ color: 'var(--muted)' }}>{user.last_login_at || 'Never'}</span>
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <Button small variant="ghost" onClick={() => startEditing(user)}>Edit</Button>
              </div>
            </div>
          )
        ))}
      </Card>
    </>
  )
}

// The "Intended usage" selector. Three mutually-exclusive setup states, projected onto two orthogonal
// backend settings: the deployment `security_profile` (local_private / network_private) and the
// `data_provider_intended` flag. Standalone absorbs the "provider optional" case (a provider works over
// loopback with just a vault passphrase, so it needs no declaration); client-server splits into
// with/without a provider because that is exactly what flips HTTPS from recommended to required (and,
// in later phases, drives the HTTPS-readiness task + Connect-bank gate). It steers recommendations only
// — it does not force sign-in on or off.
const INTENDED_USAGE_OPTIONS = [
  {
    key: 'standalone',
    profile: 'local_private',
    dataProvider: false,
    label: 'Standalone',
    summary: 'Luma runs on this one computer and you use it right here. Nothing else connects to it. A bank or data provider can be configured if desired — it stays on this machine, so no HTTPS is needed.',
  },
  {
    key: 'client_server',
    profile: 'network_private',
    dataProvider: false,
    label: 'Client-server',
    summary: 'The backend runs on a computer on your network, and you (and anyone you allow) reach it from a browser on another device.',
  },
  {
    key: 'client_server_provider',
    profile: 'network_private',
    dataProvider: true,
    label: 'Client-server with an online data provider (e.g. Plaid)',
    summary: 'A networked setup where you also connect a bank or data provider. This requires HTTPS, because the secrets that unlock the provider travel across the network.',
  },
]

function IntendedUsageSection({ authEnabled, securityProfile, dataProviderIntended, passwordPolicy, onProfileChange, onDataProviderChange }) {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  // local_private always maps to standalone (the provider flag is inert there); network_private splits
  // on the flag.
  const selectedKey = securityProfile !== 'network_private'
    ? 'standalone'
    : (dataProviderIntended ? 'client_server_provider' : 'client_server')
  // HTTPS is *recommended* for plain client-server (protects the login password/cookie — the operator's
  // call, not enforced), but *required* once a data provider is in play (enforced at connect time, since
  // the provider-unlock secrets cross the network).
  const recommendation = selectedKey === 'standalone'
    ? 'Sign-in protection is optional here — nothing outside this computer can reach Luma.'
    : selectedKey === 'client_server_provider'
      ? 'Turn on sign-in protection to control who can connect. HTTPS becomes required at the point you connect a data provider, because the secrets that unlock it cross the network — set it up before then.'
      : 'Turn on sign-in protection to control who can connect. HTTPS is recommended (not required) so sign-in passwords aren\'t sent across your network in the clear — strongly advised once sign-in is on.'

  async function selectOption(option) {
    setSaving(true)
    setError('')
    try {
      if (option.profile !== securityProfile) {
        const resp = await api.saveSecurityProfile(option.profile)
        onProfileChange?.(resp.security_profile || option.profile)
      }
      if (option.dataProvider !== !!dataProviderIntended) {
        const resp = await api.saveDataProviderIntent(option.dataProvider)
        onDataProviderChange?.(!!resp.data_provider_intended)
      }
    } catch (err) {
      setError(err.message || 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card style={{ padding: 20 }}>
      <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.6, marginBottom: 14 }}>
        How will you run {APP_NAME}? This tells {APP_NAME} whether it runs on just this computer or is reached over your network — and whether you&apos;ll connect a bank — so it can recommend the right protections. It doesn&apos;t turn sign-in protection on or off by itself.
      </div>
      <div style={{ display: 'grid', gap: 8 }}>
        {INTENDED_USAGE_OPTIONS.map(option => (
          <label
            key={option.key}
            style={{
              display: 'grid',
              gap: 4,
              padding: '12px 14px',
              border: `1px solid ${selectedKey === option.key ? 'var(--accent)' : 'var(--border)'}`,
              borderRadius: 12,
              background: selectedKey === option.key
                ? 'color-mix(in srgb, var(--accent) 7%, var(--surface2))'
                : 'var(--surface2)',
              cursor: saving ? 'default' : 'pointer',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <input
                type="radio"
                name="intended-usage"
                checked={selectedKey === option.key}
                onChange={() => selectOption(option)}
                disabled={saving}
              />
              <span style={{ fontSize: 13, fontWeight: 600 }}>{option.label}</span>
            </div>
            <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5, paddingLeft: 24 }}>
              {option.summary}
            </div>
          </label>
        ))}
      </div>

      <div style={{ marginTop: 14, padding: 12, borderRadius: 10, background: 'var(--surface2)', border: '1px solid var(--border)' }}>
        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Current recommendation</div>
        <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.6 }}>
          {recommendation}
        </div>
        {authEnabled && (
          <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.6, marginTop: 6 }}>
            Active password policy: {passwordPolicyHelpText(passwordPolicy)}
          </div>
        )}
      </div>

      {error && (
        <div style={{ marginTop: 12, color: '#ef4444', fontSize: 13 }}>
          {error}
        </div>
      )}
    </Card>
  )
}

// Password-strength policy for new sign-ins and account passwords. Shares the PASSWORD_POLICIES
// vocabulary with AuthScreen and new-user validation, so all three agree on the same choices.
function PasswordPolicyPanel({ passwordPolicy, onChange }) {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function handleChange(nextPolicy) {
    setSaving(true)
    setError('')
    try {
      const resp = await api.savePasswordPolicy(nextPolicy)
      onChange?.(resp.password_policy || nextPolicy)
    } catch (err) {
      setError(err.message || 'Failed to save password policy')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ display: 'grid', gap: 8, marginBottom: 18 }}>
      <div style={{ fontSize: 14, fontWeight: 600 }}>Password policy</div>
      <div style={{ fontSize: 13, color: 'var(--muted)' }}>
        Choose how strictly passwords are validated for new sign-ins and user accounts.
      </div>
      <div style={{ display: 'grid', gap: 6, paddingLeft: 14 }}>
        {PASSWORD_POLICIES.map(option => (
          <label
            key={option.value}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '8px 12px',
              border: `1px solid ${passwordPolicy === option.value ? 'var(--accent)' : 'var(--border)'}`,
              borderRadius: 999,
              background: passwordPolicy === option.value
                ? 'color-mix(in srgb, var(--accent) 8%, var(--surface2))'
                : 'var(--surface2)',
              cursor: saving ? 'default' : 'pointer',
            }}
          >
            <input
              type="radio"
              name="password-policy"
              checked={passwordPolicy === option.value}
              onChange={() => handleChange(option.value)}
              disabled={saving}
            />
            <span style={{ fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap' }}>{option.label}</span>
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>{option.hint}</span>
          </label>
        ))}
      </div>
      {error && (
        <div style={{ color: '#ef4444', fontSize: 13 }}>
          {error}
        </div>
      )}
    </div>
  )
}

// Sign-in protection is turned on here. Identities are already unified `user_account` rows, so this
// only assigns passwords/roles: the operator claims one identity as the admin (setting a password),
// and may set an optional starting password for each other identity. Every non-claimed account is
// forced to set its own password at next login, so a blank starting password just means "the person
// claims it themselves." On success the page reloads into authenticated mode signed in as the admin.
function AuthModeSection({ passwordPolicy, activeLocalProfile }) {
  const [profiles, setProfiles] = useState(null)
  const [loadError, setLoadError] = useState('')
  const [claimId, setClaimId] = useState('')
  const [adminPassword, setAdminPassword] = useState('')
  const [adminConfirm, setAdminConfirm] = useState('')
  const [otherPasswords, setOtherPasswords] = useState({})
  // The operator picks the password policy for the install here (seeded from the stored default) rather
  // than being locked to it; it is persisted server-side as part of enabling sign-in.
  const [policy, setPolicy] = useState(passwordPolicy)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    api.getIdentities()
      .then(resp => {
        if (cancelled) return
        const list = (resp.identities || []).map(i => ({ id: i.id, name: i.display_name }))
        setProfiles(list)
        // Pre-select the operator's active identity as the claim; fall back to the first.
        const preferred = list.find(p => p.id === activeLocalProfile?.id) || list[0]
        setClaimId(preferred?.id || '')
      })
      .catch(err => { if (!cancelled) setLoadError(err.message || 'Failed to load users') })
    return () => { cancelled = true }
  }, [activeLocalProfile?.id])

  async function enableWithMigration(e) {
    e.preventDefault()
    setError('')
    if (!claimId) { setError('Choose which user is yours.'); return }
    if (!validatePasswordForPolicy(adminPassword, policy)) {
      setError(`Your password does not meet the policy: ${passwordPolicyHelpText(policy)}`)
      return
    }
    if (adminPassword !== adminConfirm) { setError('Passwords do not match.'); return }
    const others = (profiles || []).filter(p => p.id !== claimId)
    const initial_passwords = {}
    for (const p of others) {
      const pw = otherPasswords[p.id] || ''
      if (pw && !validatePasswordForPolicy(pw, policy)) {
        setError(`The starting password for "${p.name}" does not meet the policy.`)
        return
      }
      if (pw) initial_passwords[p.id] = pw
    }
    setSaving(true)
    try {
      await api.enableAuth({ claim_user_id: claimId, admin_password: adminPassword, initial_passwords, password_policy: policy })
      window.location.reload()
    } catch (err) {
      setError(err.message || 'Failed to enable sign-in protection')
      setSaving(false)
    }
  }

  // With no existing identities there is nothing to claim — enable auth and let the sign-in screen
  // bootstrap the first admin.
  async function enablePlain() {
    setSaving(true)
    setError('')
    try {
      await api.enableAuth()
      window.location.reload()
    } catch (err) {
      setError(err.message || 'Failed to enable sign-in protection')
      setSaving(false)
    }
  }

  if (profiles === null && !loadError) return <Spinner />

  if (loadError) {
    return <Card style={{ padding: 20 }}><div style={{ color: '#ef4444', fontSize: 13 }}>{loadError}</div></Card>
  }

  if (profiles.length === 0) {
    return (
      <Card style={{ padding: 20 }}>
        <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.6 }}>
          Turning this on enables authenticated mode. You&apos;ll then create the first user account and use that account to manage any additional users.
        </div>
        <div style={{ marginTop: 14 }}>
          <Button small onClick={enablePlain} disabled={saving}>
            {saving ? 'Enabling...' : 'Enable sign-in protection'}
          </Button>
        </div>
        {error && <div style={{ marginTop: 12, color: '#ef4444', fontSize: 13 }}>{error}</div>}
      </Card>
    )
  }

  const others = profiles.filter(p => p.id !== claimId)
  const single = profiles.length === 1

  return (
    <Card style={{ padding: 20 }}>
      <form onSubmit={enableWithMigration} style={{ display: 'grid', gap: 16 }}>
        <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.6 }}>
          {single
            ? 'Turning this on password-protects your user. Set a password to continue — you become the admin.'
            : 'Turning this on password-protects each user. Choose which user is yours (you become the admin), then optionally set a starting password for the others. Everyone else is required to set their own password the next time they sign in.'}
        </div>

        {!single && (
          <div style={{ display: 'grid', gap: 8 }}>
            <FormLabel>Which user is yours?</FormLabel>
            {profiles.map(p => (
              <label key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, cursor: 'pointer' }}>
                <input type="radio" name="claim-profile" checked={claimId === p.id} onChange={() => setClaimId(p.id)} disabled={saving} />
                <span style={{ fontWeight: 600 }}>{p.name}</span>
              </label>
            ))}
          </div>
        )}

        <div style={{ display: 'grid', gap: 8 }}>
          <FormLabel>Password requirements</FormLabel>
          <div style={{ display: 'grid', gap: 6 }}>
            {PASSWORD_POLICIES.map(option => (
              <label key={option.value} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, cursor: saving ? 'default' : 'pointer' }}>
                <input type="radio" name="enable-password-policy" checked={policy === option.value} onChange={() => setPolicy(option.value)} disabled={saving} />
                <span style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>{option.label}</span>
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>{option.hint}</span>
              </label>
            ))}
          </div>
        </div>

        <div style={{ display: 'grid', gap: 8 }}>
          <FormLabel>Your password (admin)</FormLabel>
          <PasswordInput value={adminPassword} onChange={setAdminPassword} disabled={saving} wrapperStyle={PASSWORD_FIELD_WIDTH} />
          <PasswordInput value={adminConfirm} onChange={setAdminConfirm} placeholder="Confirm password" disabled={saving} wrapperStyle={PASSWORD_FIELD_WIDTH} />
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>{passwordPolicyHelpText(policy)}</div>
        </div>

        {!single && others.length > 0 && (
          <div style={{ display: 'grid', gap: 10 }}>
            <FormLabel>Starting passwords for the other users (optional)</FormLabel>
            <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>
              Leave blank to let each person set their own on first sign-in. Whatever you enter, they will be asked to choose a new password the next time they sign in.
            </div>
            {others.map(p => (
              <div key={p.id} style={{ display: 'grid', gap: 4 }}>
                <span style={{ fontSize: 12, fontWeight: 600 }}>{p.name}</span>
                <PasswordInput
                  placeholder="Leave blank to let them set it"
                  wrapperStyle={PASSWORD_FIELD_WIDTH}
                  value={otherPasswords[p.id] || ''}
                  onChange={value => setOtherPasswords(prev => ({ ...prev, [p.id]: value }))}
                  disabled={saving}
                />
              </div>
            ))}
          </div>
        )}

        {error && <div style={{ color: '#ef4444', fontSize: 13 }}>{error}</div>}

        <div>
          <Button small type="submit" disabled={saving}>
            {saving ? 'Enabling...' : 'Enable sign-in protection'}
          </Button>
        </div>
      </form>
    </Card>
  )
}

// Turning sign-in protection back off (admin-gated). It is a flag flip — identities and their password
// hashes are preserved so re-enabling is seamless — but it reopens network access, so it confirms first.
function DisableAuthSection() {
  const [confirming, setConfirming] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function disable() {
    setSaving(true)
    setError('')
    try {
      await api.disableAuth()
      window.location.reload()
    } catch (err) {
      setError(err.message || 'Failed to turn off sign-in protection')
      setSaving(false)
      setConfirming(false)
    }
  }

  return (
    <Card style={{ padding: 20 }}>
      {confirming ? (
        <AppConfirmDialog
          title="Turn off sign-in protection?"
          description="Anyone who can reach this installation on the network will be able to open it and pick any identity — no password, no 2FA. Accounts and their passwords are kept, so you can turn protection back on at any time."
          confirmLabel="Turn off sign-in protection"
          confirmVariant="danger"
          borderColor="color-mix(in srgb, var(--danger) 35%, var(--border))"
          onConfirm={disable}
          onCancel={() => setConfirming(false)}
          confirmDisabled={saving}
          width="min(520px, 100%)"
        />
      ) : null}
      <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.6 }}>
        Sign-in protection is on. Turning it off drops the login perimeter but keeps every account and
        password, so re-enabling later is seamless.
      </div>
      {error && <div style={{ marginTop: 12, color: '#ef4444', fontSize: 13 }}>{error}</div>}
      <div style={{ marginTop: 14 }}>
        <Button small variant="danger" onClick={() => setConfirming(true)} disabled={saving}>
          {saving ? 'Turning off...' : 'Turn off sign-in protection'}
        </Button>
      </div>
    </Card>
  )
}

function AccountSecuritySection({ passwordPolicy, onPasswordPolicyChange }) {
  const fieldIdBase = useId()
  const [currentUser, setCurrentUser] = useState(null)
  const [loading, setLoading] = useState(true)
  const [setup, setSetup] = useState(null)
  const [setupCode, setSetupCode] = useState('')
  const [disableCode, setDisableCode] = useState('')
  const [regenCode, setRegenCode] = useState('')
  const [recoveryCodes, setRecoveryCodes] = useState([])
  const [copiedCodes, setCopiedCodes] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function copyRecoveryCodes() {
    try {
      await navigator.clipboard.writeText(recoveryCodes.join('\n'))
      setCopiedCodes(true)
      setTimeout(() => setCopiedCodes(false), 2000)
    } catch {
      setError('Could not reach the clipboard — select the codes above and copy them manually.')
    }
  }

  async function load() {
    setLoading(true)
    try {
      const resp = await api.getCurrentUser()
      setCurrentUser(resp.user)
      setError('')
    } catch (err) {
      setError(err.message || 'Failed to load security settings')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  async function beginSetup() {
    setSaving(true)
    setError('')
    try {
      const resp = await api.startTwoFactorSetup()
      setSetup(resp)
      setSetupCode('')
    } catch (err) {
      setError(err.message || 'Failed to start authenticator setup')
    } finally {
      setSaving(false)
    }
  }

  async function confirmSetup(e) {
    e.preventDefault()
    setSaving(true)
    setError('')
    try {
      const resp = await api.confirmTwoFactorSetup(setup.secret, setupCode)
      setCurrentUser(resp.user)
      setRecoveryCodes(resp.recovery_codes || [])
      setSetup(null)
      setSetupCode('')
    } catch (err) {
      setError(err.message || 'Failed to enable authenticator app')
    } finally {
      setSaving(false)
    }
  }

  async function turnOff2fa(e) {
    e.preventDefault()
    setSaving(true)
    setError('')
    try {
      const resp = await api.disableTwoFactor(disableCode)
      setCurrentUser(resp.user)
      setDisableCode('')
    } catch (err) {
      setError(err.message || 'Failed to disable authenticator app')
    } finally {
      setSaving(false)
    }
  }

  async function regenerateCodes(e) {
    e.preventDefault()
    setSaving(true)
    setError('')
    try {
      const resp = await api.regenerateRecoveryCodes(regenCode)
      setCurrentUser(resp.user)
      setRecoveryCodes(resp.recovery_codes || [])
      setRegenCode('')
    } catch (err) {
      setError(err.message || 'Failed to regenerate recovery codes')
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <Spinner />
  if (!currentUser) return null

  const inputStyle = {
    ...getFormControlStyle({ size: 'md', surface: 'base' }),
    width: '100%',
  }

  return (
    <Card style={{ padding: 20 }}>
      {onPasswordPolicyChange && (
        <PasswordPolicyPanel passwordPolicy={passwordPolicy} onChange={onPasswordPolicyChange} />
      )}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 14 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 600 }}>Authenticator app</div>
          <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4 }}>
            Status: {currentUser.two_factor_enabled ? 'Enabled' : 'Not enabled'}
          </div>
          {currentUser.two_factor_enabled && (
            <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4 }}>
              Recovery codes remaining: {currentUser.recovery_code_count}
            </div>
          )}
        </div>
        {!currentUser.two_factor_enabled && !setup && (
          <Button small onClick={beginSetup} disabled={saving}>Set up 2FA</Button>
        )}
      </div>

      {setup && !currentUser.two_factor_enabled && (
        <InsetPanel as="form" onSubmit={confirmSetup} style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.5 }}>
            Scan this QR code with your authenticator app (or enter the key manually), then enter the current 6-digit code to confirm.
          </div>
          {setup.qr_svg && (
            <div style={{ display: 'flex', justifyContent: 'center' }}>
              <img
                src={setup.qr_svg}
                alt="Authenticator setup QR code"
                width={168}
                height={168}
                style={{ background: '#fff', padding: 8, borderRadius: 8, border: '1px solid var(--border)' }}
              />
            </div>
          )}
          <div>
            <div style={{ fontSize: 11, color: 'var(--muted)', display: 'block', marginBottom: 4 }}>Manual setup key</div>
            <div style={{ fontFamily: 'monospace', fontSize: 14, padding: '10px 12px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, wordBreak: 'break-all' }}>
              {setup.secret}
            </div>
          </div>
          <div>
            <div style={{ fontSize: 11, color: 'var(--muted)', display: 'block', marginBottom: 4 }}>Provisioning URI</div>
            <div style={{ fontFamily: 'monospace', fontSize: 11, padding: '10px 12px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, wordBreak: 'break-all' }}>
              {setup.otpauth_uri}
            </div>
          </div>
          <input
            id={`${fieldIdBase}-setup-code`}
            name="settings-2fa-setup-code"
            value={setupCode}
            onChange={e => setSetupCode(e.target.value)}
            placeholder="Enter 6-digit code"
            inputMode="numeric"
            aria-label="Authenticator app setup code"
            style={inputStyle}
          />
          <div style={{ display: 'flex', gap: 8 }}>
            <Button small type="submit" disabled={saving || setupCode.trim().length < 6}>
              {saving ? 'Enabling...' : 'Confirm setup'}
            </Button>
            <Button small variant="ghost" type="button" onClick={() => { setSetup(null); setSetupCode(''); setError('') }}>
              Cancel
            </Button>
          </div>
        </InsetPanel>
      )}

      {currentUser.two_factor_enabled && (
        <div style={{ display: 'grid', gap: 12 }}>
          <InsetPanel as="form" onSubmit={turnOff2fa}>
            <div style={{ fontSize: 13, color: 'var(--muted)' }}>
              Enter a current authenticator code to disable 2FA for this account.
            </div>
            <input
              id={`${fieldIdBase}-disable-code`}
              name="settings-2fa-disable-code"
              value={disableCode}
              onChange={e => setDisableCode(e.target.value)}
              placeholder="Enter 6-digit code"
              inputMode="numeric"
              aria-label="Authenticator code to disable 2FA"
              style={inputStyle}
            />
            <div>
              <Button small type="submit" disabled={saving || disableCode.trim().length < 6}>
                {saving ? 'Disabling...' : 'Disable 2FA'}
              </Button>
            </div>
          </InsetPanel>

          <InsetPanel as="form" onSubmit={regenerateCodes}>
            <div style={{ fontSize: 13, color: 'var(--muted)' }}>
              Regenerate your recovery codes. This invalidates the current set immediately.
            </div>
            <input
              id={`${fieldIdBase}-regen-code`}
              name="settings-2fa-regenerate-code"
              value={regenCode}
              onChange={e => setRegenCode(e.target.value)}
              placeholder="Enter current 6-digit code"
              inputMode="numeric"
              aria-label="Authenticator code to regenerate recovery codes"
              style={inputStyle}
            />
            <div>
              <Button small type="submit" disabled={saving || regenCode.trim().length < 6}>
                {saving ? 'Regenerating...' : 'Regenerate recovery codes'}
              </Button>
            </div>
          </InsetPanel>
        </div>
      )}

      {recoveryCodes.length > 0 && (
        <div style={{ marginTop: 14, padding: 14, border: '1px solid var(--warning)', borderRadius: 10, background: 'color-mix(in srgb, var(--warning) 10%, var(--surface))' }}>
          <div style={{ fontSize: 13, color: 'var(--muted)' }}>
            Save these recovery codes somewhere secure. They are shown only once and each code can be used one time.
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8, marginTop: 12 }}>
            {recoveryCodes.map(code => (
              <div key={code} style={{ fontFamily: 'monospace', fontSize: 13, padding: '8px 10px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8 }}>
                {code}
              </div>
            ))}
          </div>
          <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
            <Button small type="button" onClick={copyRecoveryCodes}>
              {copiedCodes ? 'Copied' : 'Copy codes'}
            </Button>
            <Button small variant="ghost" type="button" onClick={() => { setRecoveryCodes([]); setCopiedCodes(false) }}>
              Dismiss codes
            </Button>
          </div>
        </div>
      )}

      {error && (
        <div style={{ marginTop: 14, color: 'var(--danger)', fontSize: 13 }}>
          {error}
        </div>
      )}
    </Card>
  )
}

function StickySection({ title, description, actions, children, defaultCollapsed = true, scrollContainerRef = null, open: controlledOpen, onOpenChange }) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(!defaultCollapsed)
  const sectionRef = useRef(null)
  const open = controlledOpen ?? uncontrolledOpen
  const setOpen = onOpenChange ?? setUncontrolledOpen

  useEffect(() => {
    if (!open) return
    const node = sectionRef.current
    if (!node) return

    const scrollAfterLayout = () => {
      const scrollParent = scrollContainerRef?.current
      if (!scrollParent) {
        node.scrollIntoView({ behavior: 'smooth', block: 'start' })
        return
      }
      const padding = 12
      const sectionTop = node.offsetTop
      const sectionBottom = sectionTop + node.offsetHeight
      const viewTop = scrollParent.scrollTop
      const viewBottom = viewTop + scrollParent.clientHeight

      let targetTop = null

      if (sectionTop < viewTop + padding) {
        targetTop = Math.max(0, sectionTop - padding)
      }
      else if (sectionBottom > viewBottom - padding) {
        targetTop = Math.max(0, sectionBottom - scrollParent.clientHeight + padding)
      }

      if (targetTop !== null && Math.abs(targetTop - scrollParent.scrollTop) > 2) {
        scrollParent.scrollTo({ top: targetTop, behavior: 'smooth' })
      }
    }

    let timeoutId = null
    let frame2 = null
    // Wait until the expand/collapse layout settles before scrolling, or the
    // section can jump to the wrong spot using stale pre-expansion measurements.
    const frame = window.requestAnimationFrame(() => {
      frame2 = window.requestAnimationFrame(() => {
        timeoutId = window.setTimeout(scrollAfterLayout, 0)
      })
    })

    return () => {
      window.cancelAnimationFrame(frame)
      if (frame2 !== null) window.cancelAnimationFrame(frame2)
      if (timeoutId !== null) window.clearTimeout(timeoutId)
    }
  }, [open, scrollContainerRef])

  return (
    <section ref={sectionRef} style={{ marginBottom: 18, display: 'grid', justifyItems: 'stretch', width: '100%' }}>
      <div
        style={{
          padding: '4px 0 6px',
          width: 'min(100%, 420px)',
        }}
      >
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          padding: '8px 12px',
          border: '1px solid var(--border)',
          borderRadius: 16,
          background: open ? 'color-mix(in srgb, var(--surface) 78%, var(--surface2))' : 'var(--surface)',
          width: '100%',
          boxShadow: open ? '0 8px 24px rgba(15, 23, 42, 0.05)' : '0 1px 0 rgba(15, 23, 42, 0.03)',
          transition: 'background 0.18s ease, box-shadow 0.18s ease, border-color 0.18s ease',
        }}>
          <button
            type="button"
            onClick={() => setOpen(!open)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              background: 'none',
              border: 'none',
              padding: 0,
              margin: 0,
              color: 'inherit',
              cursor: 'pointer',
              textAlign: 'left',
              flex: 1,
              minWidth: 0,
            }}
          >
            <span style={{
              width: 20,
              height: 20,
              borderRadius: 999,
              border: '1px solid color-mix(in srgb, var(--border) 82%, transparent)',
              display: 'grid',
              placeItems: 'center',
              fontSize: 13,
              color: 'var(--muted)',
              background: open ? 'color-mix(in srgb, var(--surface2) 65%, var(--surface))' : 'var(--surface2)',
              lineHeight: 1,
              flexShrink: 0,
            }}>
              {open ? '-' : '+'}
            </span>
            <span style={{ display: 'grid', gap: description ? 2 : 0, minWidth: 0 }}>
              <span style={{ fontSize: 15, fontWeight: 600, letterSpacing: '-0.01em' }}>{title}</span>
              {description ? <span style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.45 }}>{description}</span> : null}
            </span>
          </button>
          {actions ? <div style={{ flexShrink: 0 }}>{actions}</div> : null}
        </div>
      </div>
      {open ? (
        <div
          style={{
            marginTop: 2,
            marginLeft: 12,
            width: 'calc(100% - 12px)',
            paddingLeft: 14,
            paddingBottom: 8,
            position: 'relative',
          }}
        >
          <span
            aria-hidden="true"
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              bottom: 10,
              width: 1,
              background: 'color-mix(in srgb, var(--border) 70%, transparent)',
              pointerEvents: 'none',
            }}
          />
          <span
            aria-hidden="true"
            style={{
              position: 'absolute',
              left: 0,
              bottom: 0,
              width: 10,
              height: 10,
              borderLeft: '1px solid color-mix(in srgb, var(--border) 70%, transparent)',
              borderBottom: '1px solid color-mix(in srgb, var(--border) 70%, transparent)',
              borderBottomLeftRadius: 10,
              pointerEvents: 'none',
            }}
          />
          {children}
        </div>
      ) : null}
    </section>
  )
}

// `compact` shrinks the swatches and tightens the gap so the full 18-color palette fits on a single
// row in the narrow per-tag palette column (the tag list); the add-tag form spans the card width and
// keeps the roomier default targets.
function TagColorPalette({ value, onChange, compact = false, align = 'flex-start' }) {
  const swatch = compact ? 22 : 28
  const glyph = compact ? 12 : 14
  const gap = compact ? 4 : 6
  // `align='flex-end'` (used by the tag list) pins the palette to the right of its column so every
  // row's swatches line up in shared columns regardless of label width, and leaves the grid gap
  // before the delete button. A long label still shrinks the column and wraps the swatches.
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap, justifyContent: align }}>
      {TAG_COLOR_PALETTE.map(color => {
        const selected = value === color
        return (
          <button
            key={color}
            type="button"
            onClick={() => onChange(color)}
            title={color}
            style={{
              width: swatch,
              height: swatch,
              borderRadius: 999,
              border: `1px solid ${selected ? 'var(--accent)' : 'var(--border)'}`,
              background: selected
                ? 'color-mix(in srgb, var(--accent) 10%, var(--surface2))'
                : 'var(--surface2)',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              padding: 0,
            }}
          >
            <TagGlyph color={color} size={glyph} />
          </button>
        )
      })}
    </div>
  )
}

function EditableTagName({ tag, onCommit }) {
  const {
    editing,
    draft,
    setDraft,
    beginEdit,
    cancelEdit,
    commitEdit,
  } = useTransientTextEdit(tag.name || '', { onCommit })

  if (editing) {
    return (
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
          padding: '4px 10px',
          fontSize: 13,
          fontWeight: 600,
          lineHeight: 1.2,
          minWidth: 120,
          outline: 'none',
        }}
      />
    )
  }

  return (
    <button
      type="button"
      onClick={() => beginEdit(tag.name || '')}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        background: 'var(--surface2)',
        color: 'var(--text)',
        border: '1px solid var(--border)',
        borderRadius: 999,
        padding: '4px 10px',
        fontSize: 13,
        fontWeight: 600,
        lineHeight: 1.2,
        cursor: 'text',
      }}
    >
      <TagGlyph color={tag.color} size={13} />
      <span>{tag.name}</span>
    </button>
  )
}

function TransactionTagsSection() {
  const fieldIdBase = useId()
  const [tags, setTags] = useState([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')
  const [pendingDeleteTag, setPendingDeleteTag] = useState(null)
  const [form, setForm] = useState({
    name: '',
    color: TAG_COLOR_PALETTE[0],
  })

  async function load() {
    setLoading(true)
    try {
      setTags(await api.getTags())
      setError('')
    } catch (err) {
      setError(err.message || 'Failed to load tags')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  async function handleCreate(event) {
    event.preventDefault()
    setCreating(true)
    setError('')
    try {
      const created = await api.createTag(form)
      setTags(prev => [...prev, created].sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name)))
      setForm({ name: '', color: form.color })
      invalidateTags()  // keep the shared tag-picker cache (useTags) in step with this management edit
    } catch (err) {
      setError(err.message || 'Failed to create tag')
    } finally {
      setCreating(false)
    }
  }

  async function handleUpdateTag(tagId, payload) {
    try {
      const updated = await api.updateTag(tagId, payload)
      setTags(prev => prev.map(tag => tag.id === tagId ? updated : tag))
      setError('')
      invalidateTags()
    } catch (err) {
      setError(err.message || 'Failed to update tag')
      throw err
    }
  }

  async function handleDeleteTag(tag) {
    setPendingDeleteTag(null)
    try {
      await api.deleteTag(tag.id)
      setTags(prev => prev.filter(item => item.id !== tag.id))
      setError('')
      invalidateTags()
    } catch (err) {
      setError(err.message || 'Failed to delete tag')
    }
  }

  return (
    <>
      {pendingDeleteTag ? (
        <AppConfirmDialog
          title="Delete tag?"
          description={`Delete tag "${pendingDeleteTag.name}"? Existing transaction assignments will be removed too.`}
          confirmLabel="Delete"
          confirmVariant="danger"
          borderColor="color-mix(in srgb, var(--danger) 35%, var(--border))"
          onConfirm={() => handleDeleteTag(pendingDeleteTag)}
          onCancel={() => setPendingDeleteTag(null)}
          width="min(500px, 100%)"
        />
      ) : null}

      <Card style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ padding: '14px 16px 0', color: 'var(--muted)', fontSize: 13, lineHeight: 1.5 }}>
          Tags are lightweight labels you can add manually or through rules. They show up on transaction rows and can filter dashboard views and exports.
        </div>
        <form onSubmit={handleCreate} style={{ display: 'grid', gap: 12, padding: 16, borderBottom: '1px solid var(--border)' }}>
          <input
            id={`${fieldIdBase}-tag-name`}
            name="settings-new-tag-name"
            value={form.name}
            onChange={event => setForm(prev => ({ ...prev, name: event.target.value }))}
            placeholder="Tag name"
            aria-label="Tag name"
            style={{ ...getFormControlStyle({ size: 'md', surface: 'base' }), width: '100%' }}
          />
          <div style={{ display: 'grid', gap: 8 }}>
            <div style={{ fontSize: 11, color: 'var(--muted)', display: 'block' }}>Color</div>
            <TagColorPalette
              value={form.color}
              onChange={color => setForm(prev => ({ ...prev, color }))}
            />
          </div>
          <div>
            <Button small type="submit" disabled={creating || !form.name.trim()}>
              {creating ? 'Saving...' : 'Add tag'}
            </Button>
          </div>
        </form>

        {error ? (
          <div style={{ padding: '10px 16px', color: 'var(--danger)', fontSize: 13, borderBottom: '1px solid var(--border)' }}>
            {error}
          </div>
        ) : null}

        {loading && tags.length === 0 ? <Spinner /> : tags.length === 0 ? (
          <div style={{ padding: '18px 16px', color: 'var(--muted)', fontSize: 13 }}>
            No tags created yet.
          </div>
        ) : (
          tags.map(tag => (
            <div
              key={tag.id}
              style={{
                // Label keeps a guaranteed minimum so it can never be squeezed to
                // nothing; the palette column takes the remaining width and wraps to
                // additional rows (flexWrap) rather than expanding over the label.
                display: 'grid',
                gridTemplateColumns: 'minmax(130px, max-content) minmax(0, 1fr) auto',
                gap: 12,
                alignItems: 'center',
                padding: '8px 16px',
                borderBottom: '1px solid var(--border)',
              }}
            >
              <EditableTagName
                tag={tag}
                onCommit={name => handleUpdateTag(tag.id, { name })}
              />
              <TagColorPalette
                value={tag.color}
                onChange={color => handleUpdateTag(tag.id, { color })}
                compact
                align="flex-end"
              />
              <button
                type="button"
                onClick={() => setPendingDeleteTag(tag)}
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'var(--danger)',
                  cursor: 'pointer',
                  fontSize: 18,
                  lineHeight: 1,
                  width: 28,
                  height: 28,
                  borderRadius: 999,
                }}
              >
                ×
              </button>
            </div>
          ))
        )}
      </Card>
    </>
  )
}

// The configuration report: every resolved setting and which layer supplied it. Read-only on purpose.
// Settings that can be changed in the app have their own sections (sign-in, security profile, currency,
// data-source credentials); what remains here is resolved before the app is running — database
// locations, ports, the developer gate — so the honest thing to show is the effective value and its
// origin, not a form that cannot take effect. A plain install needs no `.env` file at all: defaults
// cover it, and the session secret is generated once and kept in the control database.
const CONFIG_SOURCE_LABELS = {
  default: 'Default',
  app_setting: 'Stored',
  env: 'Set in environment',
  derived: 'Derived',
}

function configSourceLabel(row) {
  if (row.source === 'env') return row.from_env_file ? 'Set in .env' : CONFIG_SOURCE_LABELS.env
  return CONFIG_SOURCE_LABELS[row.source] || row.source
}

// Each row is its own grid, so a content-sized label column is measured per row and no two rows agree on
// where the value starts. One shared width is what lines the value and source columns up down the whole
// panel. It is sized for the longest label and the longest variable name (LUMA_BACKEND_READY_TIMEOUT);
// anything longer added later wraps within the column rather than pushing the rows out of alignment.
const CONFIG_LABEL_COLUMN_PX = 210
// A derived row is indented, so its label column gives back exactly the indent — otherwise everything to
// its right would sit one indent off the lines the rest of the panel shares.
const CONFIG_DERIVED_INDENT_PX = 18

const CONFIG_PILL_STYLE = {
  display: 'inline-flex', alignItems: 'center',
  borderRadius: 99, padding: '2px 8px', fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap',
  border: '1px solid var(--border)',
}

// Smaller than the source chip beside it, deliberately: the chip is the row's answer to "what is in
// effect", which every row has, while this is a rare correction most installations never need. The hint
// carries the reason to press it, since neither "Reset" nor "Regenerate" says when it would be wanted.
function ConfigRowAction({ label, hint, disabled, onClick }) {
  return (
    <Tooltip content={hint}>
      <button
        type="button"
        disabled={disabled}
        onClick={onClick}
        style={{
          ...CONFIG_PILL_STYLE,
          padding: '0 6px',
          fontSize: 10,
          background: 'transparent',
          color: 'var(--muted)',
          cursor: disabled ? 'default' : 'pointer',
          opacity: disabled ? 0.6 : 1,
        }}
      >
        {label}
      </button>
    </Tooltip>
  )
}

function ConfigSourceChip({ row }) {
  const overridden = row.source === 'env'
  return (
    <span style={{
      ...CONFIG_PILL_STYLE,
      background: overridden ? 'color-mix(in srgb, var(--accent) 14%, transparent)' : 'var(--surface2)',
      color: overridden ? 'var(--accent)' : 'var(--muted)',
    }}>
      {configSourceLabel(row)}
    </span>
  )
}

/*
 * A value computed from another setting (the database paths, which follow the data directory) renders
 * indented under the setting it follows, and never names an environment variable unless that variable is
 * what supplied it — naming it otherwise advertises the per-file database overrides as ordinary knobs
 * when they exist only for a database that is not on the default filename.
 */
function orderedConfigRows(settings) {
  const children = new Map()
  for (const row of settings) {
    if (!row.derived_from) continue
    if (!children.has(row.derived_from)) children.set(row.derived_from, [])
    children.get(row.derived_from).push(row)
  }
  const ordered = []
  for (const row of settings) {
    if (row.derived_from) continue
    ordered.push(row)
    ordered.push(...(children.get(row.key) || []))
  }
  return ordered
}

/*
 * Most of these settings are read once at startup by an operator who will never look at them; the three
 * an ordinary install might change (the data directory and the two ports) would otherwise be buried
 * among them. A setting is filed as advanced by declaration rather than by whether it currently holds
 * its default — placement that moved with the value would make a row people saw last week vanish this
 * week — but one actually set in the environment is surfaced anyway, since overriding it is direct
 * evidence this installation cares about it. A derived row follows its parent so it is never orphaned
 * from the setting it explains.
 */
function splitConfigRows(rows) {
  const primary = []
  const advanced = []
  let bucketForParent = primary
  for (const row of rows) {
    if (row.derived_from) {
      bucketForParent.push(row)
      continue
    }
    bucketForParent = !row.advanced || row.source === 'env' ? primary : advanced
    bucketForParent.push(row)
  }
  return { primary, advanced }
}

/*
 * A stored value is otherwise permanent: it is written once and the environment cannot un-write it. The
 * one action offered here forgets it, so the current derivation (or a freshly generated secret) applies
 * at the next start. It is a reset rather than an edit because both settings that can reach it derive or
 * generate themselves — there is no value worth typing — and because everything on this panel is read at
 * startup, so a field accepting input that visibly does nothing until a restart reads as broken.
 */
function ConfigRow({ row, onReset, resetting }) {
  const derived = !!row.derived_from
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: `minmax(0, ${derived ? CONFIG_LABEL_COLUMN_PX - CONFIG_DERIVED_INDENT_PX : CONFIG_LABEL_COLUMN_PX}px) minmax(0, 1fr) auto`,
        gap: 12,
        alignItems: 'baseline',
        padding: '10px 12px',
        borderRadius: 8,
        background: 'var(--surface2)',
        marginLeft: derived ? CONFIG_DERIVED_INDENT_PX : 0,
        borderLeft: derived ? '2px solid var(--border)' : undefined,
      }}
    >
      <div style={{ display: 'grid', gap: 3 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>{row.label}</div>
        {row.env_var ? (
          <code style={{ fontSize: 11, color: 'var(--muted)', overflowWrap: 'anywhere' }}>{row.env_var}</code>
        ) : null}
      </div>
      <div style={{ display: 'grid', gap: 3, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', wordBreak: 'break-all' }}>
          {row.redacted ? (row.is_set ? 'Set' : 'Not set') : row.value}
          {/* The literal value is what appears in `.env`, so the absolute form accompanies it rather
              than replacing it — and only when the two actually differ. */}
          {row.absolute_value ? (
            <span style={{ color: 'var(--muted)' }}> ({row.absolute_value})</span>
          ) : null}
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>{row.help}</div>
      </div>
      <div style={{ display: 'inline-flex', alignItems: 'baseline', gap: 6 }}>
        {row.resettable ? (
          <ConfigRowAction
            label={row.redacted ? 'Regenerate' : 'Reset'}
            hint={configResetPrompt(row).hint}
            disabled={resetting}
            onClick={() => onReset(row)}
          />
        ) : null}
        <ConfigSourceChip row={row} />
      </div>
    </div>
  )
}

// Both resets sign every session out, so the confirm says that in the words of the setting rather than
// naming the mechanism.
function configResetPrompt(row) {
  if (row.key === 'session_secret') {
    return {
      title: 'Regenerate the session secret?',
      description: 'A new secret is generated at the next backend start. Every signed-in session is invalidated, so everyone has to sign in again. Worth doing if the secret may have been exposed — in a shared backup, for instance.',
      confirmLabel: 'Regenerate secret',
      hint: 'Replace the signing secret at the next restart — worth doing if it may have been exposed, such as in a shared backup. Everyone signs in again.',
    }
  }
  return {
    title: `Reset ${row.label.toLowerCase()}?`,
    description: `The stored value is forgotten and the default applies at the next backend start. Renaming the session cookie signs everyone out, so this takes effect once the backend restarts.`,
    confirmLabel: 'Reset to default',
    hint: 'Forget the stored value so the current default applies at the next restart — useful when it was stored under an older rule, or copied in from a database that has moved.',
  }
}

function ConfigurationSection({ authEnabled, currentUser }) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [config, setConfig] = useState({ settings: [], env_file_path: '', env_file_present: false })
  const [pendingReset, setPendingReset] = useState(null)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [resettingKey, setResettingKey] = useState('')
  const [notice, setNotice] = useState('')

  const canManage = !authEnabled || currentUser?.role === 'admin'

  const load = useCallback(async () => {
    const resp = await api.getEffectiveConfig()
    setConfig({
      settings: resp.settings || [],
      env_file_path: resp.env_file_path || '',
      env_file_present: !!resp.env_file_present,
    })
  }, [])

  useEffect(() => {
    if (!canManage) {
      setLoading(false)
      return
    }

    let cancelled = false
    async function loadInitial() {
      setLoading(true)
      try {
        await load()
        if (!cancelled) setError('')
      } catch (err) {
        if (!cancelled) setError(err.message || 'Failed to load configuration')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    loadInitial()
    return () => { cancelled = true }
  }, [canManage, load])

  if (!canManage) return null

  const rowGroups = splitConfigRows(orderedConfigRows(config.settings))

  async function handleReset(row) {
    setPendingReset(null)
    setResettingKey(row.key)
    setError('')
    setNotice('')
    try {
      const result = await api.resetConfigValue(row.key)
      // The row still reads as stored until the backend restarts — the value in force was resolved at
      // startup — so the panel says what will happen rather than implying it already has.
      setNotice(result.pending_value
        ? `${row.label} will be ${result.pending_value} after the backend restarts.`
        : `${row.label} will be regenerated when the backend restarts. Everyone will need to sign in again.`)
      await load()
    } catch (err) {
      setError(err.message || 'Failed to reset the setting')
    } finally {
      setResettingKey('')
    }
  }

  return (
    <Card style={{ padding: 0, overflow: 'hidden' }}>
      {loading ? <Spinner /> : (
        <div style={{ display: 'grid', gap: 14, padding: 16 }}>
          <InsetPanel style={{ gap: 8 }}>
            <SectionEyebrow style={{ fontSize: 13, fontWeight: 600, textTransform: 'none', letterSpacing: '0.03em' }}>Configuration variables</SectionEyebrow>
            <p style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.6, margin: 0 }}>
              The defaults are suitable for many installations. Settings can be overridden via a
              <code>.env</code> file in the installation directory. This is useful mainly for running
              multiple copies on one machine from the same installation. Changes require a restart.
            </p>
            <p style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.6, margin: 0 }}>
              {config.env_file_present
                ? <>Overrides are being read from <code>{config.env_file_path}</code>.</>
                : <>No override file is present. One can be created at <code>{config.env_file_path}</code>.</>}
            </p>
          </InsetPanel>

          {error && (
            <div style={{ fontSize: 13, color: 'var(--danger)' }}>{error}</div>
          )}
          {notice && (
            <div style={{ fontSize: 13, color: '#16a34a' }}>{notice}</div>
          )}

          <div style={{ display: 'grid', gap: 2 }}>
            {rowGroups.primary.map(row => (
              <ConfigRow
                key={row.key}
                row={row}
                onReset={setPendingReset}
                resetting={resettingKey === row.key}
              />
            ))}
          </div>

          {rowGroups.advanced.length > 0 ? (
            <div style={{ display: 'grid', gap: 2 }}>
              <button
                type="button"
                onClick={() => setShowAdvanced(value => !value)}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6, alignSelf: 'start',
                  background: 'transparent', border: 'none', padding: '4px 0',
                  color: 'var(--muted)', fontSize: 12, fontWeight: 600, cursor: 'pointer',
                }}
                aria-expanded={showAdvanced}
              >
                <span style={{ display: 'inline-block', transform: showAdvanced ? 'rotate(90deg)' : 'none', transition: 'transform 0.12s' }}>›</span>
                Advanced
              </button>
              {showAdvanced ? rowGroups.advanced.map(row => (
                <ConfigRow
                  key={row.key}
                  row={row}
                  onReset={setPendingReset}
                  resetting={resettingKey === row.key}
                />
              )) : null}
            </div>
          ) : null}

          {pendingReset ? (
            <AppConfirmDialog
              {...configResetPrompt(pendingReset)}
              confirmVariant="danger"
              borderColor="color-mix(in srgb, var(--danger) 35%, var(--border))"
              onConfirm={() => handleReset(pendingReset)}
              onCancel={() => setPendingReset(null)}
              width="min(520px, 100%)"
            />
          ) : null}
        </div>
      )}
    </Card>
  )
}

function DeveloperOptionsSection({ authEnabled }) {
  const { currentUser } = useAppSession()
  const [workingAction, setWorkingAction] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [pendingActionConfirm, setPendingActionConfirm] = useState(null)

  async function runAction(actionKey, work) {
    setWorkingAction(actionKey)
    setMessage('')
    setError('')
    try {
      await work()
    } catch (err) {
      setError(err.message || 'Unable to complete that reset.')
    } finally {
      setWorkingAction('')
    }
  }

  function requestActionConfirm(actionKey) {
    const confirmConfig = {
      all: {
        title: 'Reset all stored state?',
        description: authEnabled
          ? 'Turn sign-in protection OFF and delete ALL users (passwords, 2FA, and recovery codes included), then clear browser-local state, saved preferences, and import memory and reload to the welcome screen?'
          : 'Delete all users, then clear browser-local state, saved preferences, and import memory and reload to the welcome screen?',
      },
      browser: {
        title: 'Clear browser-local state?',
        description: `Clear browser-local state and reload?`,
      },
      preferences: {
        title: 'Clear saved preferences?',
        description: 'Clear saved user/profile preferences and reload?',
      },
      importMemory: {
        title: 'Clear import memory?',
        description: 'Clear saved data sources and import snapshots, then reload?',
      },
      profiles: {
        title: 'Reset to first-run?',
        description: authEnabled
          ? 'Turn sign-in protection OFF and delete ALL users — passwords, 2FA, and recovery codes included — returning to the welcome screen?'
          : 'Delete all users and return to the welcome screen?',
      },
    }[actionKey]
    if (!confirmConfig) return
    setPendingActionConfirm({ actionKey, ...confirmConfig })
  }

  function executeConfirmedAction(actionKey) {
    if (actionKey === 'all') {
      return runAction('all', async () => {
        await api.clearUserPreferences()
        await api.clearImportMemory()
        await resetToFirstRun()
        clearBrowserStoredState()
        window.location.reload()
      })
    }
    if (actionKey === 'browser') {
      return runAction('browser', async () => {
        clearBrowserStoredState()
        window.location.reload()
      })
    }
    if (actionKey === 'preferences') {
      return runAction('preferences', async () => {
        await api.clearUserPreferences()
        window.location.reload()
      })
    }
    if (actionKey === 'importMemory') {
      return runAction('importMemory', async () => {
        await api.clearImportMemory()
        window.location.reload()
      })
    }
    if (actionKey === 'profiles') {
      return runAction('profiles', async () => {
        await resetToFirstRun()
        clearBrowserStoredState()
        window.location.reload()
      })
    }
    return Promise.resolve()
  }

  // Full reset to the first-run welcome screen. In auth mode this first turns sign-in protection off
  // (admin-gated) — which drops to local mode, so the identity endpoints become reachable and
  // delete_user's keep-one-admin guard no longer applies — then removes every user, the admin included.
  async function resetToFirstRun() {
    if (authEnabled) await api.disableAuth()
    // No bulk endpoint — identities are ordinary users — so remove them one by one; individual failures
    // are ignored so a partial reset still reloads to a clean welcome screen. Delete the current
    // session's own identity LAST: deleting it first invalidates the session and would 401 (and thus
    // strand) the remaining users.
    const resp = await api.getIdentities().catch(() => ({ identities: [] }))
    const ids = (resp?.identities || []).map(i => i.id)
    const currentId = currentUser?.id
    const ordered = [...ids.filter(id => id !== currentId), ...ids.filter(id => id === currentId)]
    for (const id of ordered) {
      await api.deleteIdentity(id).catch(() => { })
    }
  }

  return (
    <Card style={{ display: 'grid', gap: 16, position: 'relative', paddingTop: 18, overflow: 'hidden' }}>
      {pendingActionConfirm ? (
        <AppConfirmDialog
          title={pendingActionConfirm.title}
          description={pendingActionConfirm.description}
          confirmLabel="Clear"
          confirmVariant="danger"
          borderColor="color-mix(in srgb, var(--danger) 35%, var(--border))"
          onConfirm={() => {
            const actionKey = pendingActionConfirm.actionKey
            setPendingActionConfirm(null)
            executeConfirmedAction(actionKey)
          }}
          onCancel={() => setPendingActionConfirm(null)}
          width="min(560px, 100%)"
        />
      ) : null}

      <Button
        small
        variant="ghost"
        style={{
          position: 'absolute',
          top: -1,
          right: -1,
          borderRadius: '0 12px 0 12px',
          borderLeft: '1px solid var(--border)',
          borderBottom: '1px solid var(--border)',
          padding: '10px 18px',
        }}
        title={authEnabled
          ? "Turns sign-in protection off and deletes all users, then clears browser state, saved preferences, and import memory and reloads to the welcome screen."
          : "Deletes all users, then clears browser state, saved preferences, and import memory and reloads to the welcome screen."}
        onClick={() => requestActionConfirm('all')}
        disabled={!!workingAction}
      >
        {workingAction === 'all' ? 'Resetting…' : 'Clear all'}
      </Button>
      <div style={{ paddingRight: 146 }}>
        <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.6, maxWidth: 560 }}>
          Tools to erase stored state; return to a clean starting point.
        </div>
      </div>
      <div style={{ display: 'grid', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 600 }}>Clear browser-local state</div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3 }}>
              Clears localStorage and sessionStorage for this browser, then reloads.
            </div>
          </div>
          <Button
            small
            variant="ghost"
            title="Clears this browser's localStorage and sessionStorage, then reloads the app."
            onClick={() => requestActionConfirm('browser')}
            disabled={!!workingAction}
          >
            {workingAction === 'browser' ? 'Clearing…' : 'Clear browser state'}
          </Button>
        </div>
        <div style={{ height: 1, background: 'var(--border)' }} />
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 600 }}>Clear saved preferences</div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3 }}>
              Clears server-stored user or profile preferences, then reloads.
            </div>
          </div>
          <Button
            small
            variant="ghost"
            title="Clears saved user or local-profile preferences stored by the backend, then reloads the app."
            onClick={() => requestActionConfirm('preferences')}
            disabled={!!workingAction}
          >
            {workingAction === 'preferences' ? 'Clearing…' : 'Clear preferences'}
          </Button>
        </div>
        <div style={{ height: 1, background: 'var(--border)' }} />
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 600 }}>Clear import memory</div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3 }}>
              Clears saved CSV data sources and import snapshots stored in the backend, then reloads.
            </div>
          </div>
          <Button
            small
            variant="ghost"
            title="Clears saved CSV data sources and remembered import snapshots in the backend, then reloads the app."
            onClick={() => requestActionConfirm('importMemory')}
            disabled={!!workingAction}
          >
            {workingAction === 'importMemory' ? 'Clearing…' : 'Clear import memory'}
          </Button>
        </div>
        <div style={{ height: 1, background: 'var(--border)' }} />
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 600 }}>Reset to first-run</div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3 }}>
              {authEnabled
                ? 'Turns sign-in protection off and deletes every user (passwords, 2FA, and recovery codes included), then reloads to the welcome screen.'
                : 'Deletes every user, then reloads to the welcome screen.'}
            </div>
          </div>
          <Button
            small
            variant="ghost"
            title="Turns sign-in protection off (if on), deletes every user, then reloads the app to the first-run welcome screen."
            onClick={() => requestActionConfirm('profiles')}
            disabled={!!workingAction}
          >
            {workingAction === 'profiles' ? 'Resetting…' : 'Reset to first-run'}
          </Button>
        </div>
      </div>
      {message ? (
        <div style={{ fontSize: 12, color: 'var(--muted)' }}>{message}</div>
      ) : null}
      {error ? (
        <div style={{ fontSize: 12, color: 'var(--danger)' }}>{error}</div>
      ) : null}
    </Card>
  )
}

function SyncLogRow({ entry }) {
  // Degrade gracefully if a timestamp can't be parsed (e.g. a pre-fix malformed value) — show the raw
  // string rather than "Invalid Date".
  const parsedWhen = entry.started_at ? new Date(entry.started_at) : null
  const when = parsedWhen && !isNaN(parsedWhen) ? parsedWhen.toLocaleString() : (entry.started_at || '—')
  // The provider's backfill-readiness signal — Plaid's `transactions_update_status`, or SimpleFIN's
  // budget-pause marker. Read from `final_status` rather than the per-page `status_sequence`: the sequence
  // is one entry per drained page, so a walking adapter fills it with one identical value per request, and
  // where a call *ended up* is the question a reader has. The raw sequence is still recorded and still
  // travels in the pasteable support text, where a mid-drain anomaly would be the finding.
  //
  // A provider with no such concept reports nothing, so an absent status renders nothing rather than a row
  // reading `status: null` — which says "something is broken" when it in fact means "this provider does not
  // report one". An unrecognized value falls back to the raw string, kept monospace to read as the
  // uninterpreted token it is.
  const statusPhrase = finalStatusSummary(entry.final_status)
  // How many requests the pull actually spent, which for a walking adapter is the number that answers
  // "why did this take so long" — `pages` is a cursor provider's notion and reads 1 for every walk, however
  // many requests it made. Kept as the fallback for the providers where it is the true figure.
  const requests = entry.requested_windows?.length || null
  const cards = cardSummary(entry.card_counts, entry.institution)
  const skipped = skippedBreakdown(entry)
  // What the call covered: the span it actually fetched, reconciled against the depth it set out for. Two
  // separate facts, joined on one line because either alone invites the wrong conclusion — a span with no
  // target reads as complete, and a target with no span reads as achieved.
  const coverage = [windowSummary(entry.requested_windows),
  historyDepthSummary(entry.days_requested, entry.requested_windows)].filter(Boolean).join(' · ')
  // The consumable this pull spent. Always visible rather than filed under Details, because for a metered
  // provider it is the reason the row looks the way it does — a pull that stopped early and a pull that had
  // nothing left to fetch are indistinguishable without it.
  const allowance = allowanceSummary(entry.request_allowance)
  const pools = requestPoolSummary(entry.requested_windows)
  // How far back each account got on THIS call. `connection_account` holds only where each one stands now,
  // overwritten every sync, so this is the only place a past pull's reach survives — and on a walk that
  // pauses per account, "which ones actually moved" is the question the row exists to answer.
  // The provider prefix is dropped the same way the card summary drops the institution: it namespaces the
  // id and is already the row's own title, so it is the one part that identifies nothing here.
  const accountPrefix = entry.provider ? `${entry.provider}:` : null
  const reachRows = Object.entries(entry.account_counts || {})
    .filter(([, c]) => c?.reached)
    .map(([account, c]) => {
      const name = accountPrefix && account.startsWith(accountPrefix)
        ? account.slice(accountPrefix.length) : account
      return `${name} → ${syncLogDate(c.reached)}${c.history_complete ? ' (end of history)' : ''}`
    })
  // The raw fingerprints stay as the fallback: a provider whose checkpoint this cannot interpret must still
  // show *something*, since whether the token advanced is the first question a stalled sync raises.
  const checkpoint = checkpointSummary(entry.cursor_before, entry.cursor_after)
  // Collapsed always, never opened by default — including for an error row. What an error row owes the
  // reader is the error, which sits in the always-visible half; the tier below it is the provider's own
  // bookkeeping, and a row that springs open is a row that has decided the reader is debugging.
  const [showDetails, setShowDetails] = useState(false)
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '8px 10px', display: 'grid', gap: 6, fontSize: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 600, fontSize: 13 }}>{entry.institution || entry.provider || 'Connection'}</span>
        <span style={{ padding: '1px 7px', borderRadius: 999, background: 'var(--surface2)', color: 'var(--muted)' }}>{syncModeLabel(entry) || '—'}</span>
        {entry.became_complete ? (
          <span style={{ padding: '1px 7px', borderRadius: 999, background: 'color-mix(in srgb, var(--success, #16a34a) 16%, var(--surface2))', color: 'var(--success, #16a34a)' }}>backfill complete</span>
        ) : null}
        {entry.error ? (
          <span style={{ padding: '1px 7px', borderRadius: 999, background: 'color-mix(in srgb, var(--danger) 16%, var(--surface2))', color: 'var(--danger)' }}>error</span>
        ) : null}
        <span style={{ marginLeft: 'auto', color: 'var(--muted)' }}>{when}</span>
      </div>
      {/* What the sync did, in the effect vocabulary the connection card uses. First because it is the one
          line that answers "what happened", which every other line on the row only elaborates on. */}
      {statusPhrase ? (
        <div style={{ color: 'var(--text)' }}>{statusPhrase}</div>
      ) : entry.final_status ? (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={{ color: 'var(--muted)' }}>status:</span>
          <span style={{ fontFamily: 'monospace', fontSize: 11, padding: '1px 6px', borderRadius: 4, background: 'var(--surface2)' }}>{entry.final_status}</span>
        </div>
      ) : null}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', color: 'var(--muted)' }}>
        <span>added <b style={{ color: 'var(--text)' }}>{entry.added}</b></span>
        <span>updated <b style={{ color: 'var(--text)' }}>{entry.updated}</b></span>
        <span>removed <b style={{ color: 'var(--text)' }}>{entry.removed}</b></span>
        <span>skipped <b style={{ color: 'var(--text)' }}>{entry.skipped}</b></span>
        {/* Label first, like every other count on this row. The old `21 requests` put the number first,
            which read as a different kind of fact than the four figures beside it. */}
        {requests
          ? <span>requests <b style={{ color: 'var(--text)' }}>{requests}</b></span>
          : <span>pages <b style={{ color: 'var(--text)' }}>{entry.pages}</b></span>}
      </div>
      {/* The skip total split into the three unrelated events it folds together, as the same `OutcomeChip`s
          the connection card uses for these facts — the card deep-links here, so the two must not drift in
          wording or in which of them reads as a problem. */}
      {skipped ? (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          {skipped.map(b => (
            <OutcomeChip key={b.key} label={b.label} count={b.count} tone={b.tone} title={b.title} />
          ))}
        </div>
      ) : null}
      {coverage ? (
        <div style={{ color: 'var(--muted)' }}>{coverage}</div>
      ) : null}
      {allowance ? (
        <div style={{ color: 'var(--muted)' }}>
          allowance: <span style={{ color: 'var(--text)' }}>{allowance}</span>
        </div>
      ) : null}
      {/* Where the rows went. A sync files each row under its own transaction month, so one pull lands on
          as many cards as it spans — and the Import/Export page shows one card at a time, which makes an
          `added` total that matches no visible card read as rows having gone missing. */}
      {cards ? (
        <div style={{ color: 'var(--muted)' }}>
          rows filed on <span style={{ color: 'var(--text)' }}>{cards}</span>
        </div>
      ) : null}
      {entry.error ? (
        <div style={{ color: 'var(--danger)', fontFamily: 'monospace', fontSize: 11, wordBreak: 'break-word' }}>{entry.error}</div>
      ) : null}
      {/* Warnings are the bank-level ones the connection card also shows, so they stay in the always-visible
          half: they are the reader's to act on. Advisories are the ones nobody can act on (what the provider
          said about our request shape, and rows that had nowhere to be imported) — this log is still their
          only home, but that home is the tier below. */}
      {(entry.warnings || []).map((w, i) => (
        <div key={`w${i}`} style={{ color: 'var(--warning)', fontSize: 11, wordBreak: 'break-word' }}>⚠ {w}</div>
      ))}
      {/* The provider's own bookkeeping, behind a toggle. Everything above answers a question about the
          user's data; everything below answers one about the sync machinery, and mixing the two at one
          visual weight is what made a routine budget-paused walk read as a wall of alarming output. */}
      <div>
        <button
          onClick={() => setShowDetails(v => !v)}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', fontSize: 11, fontWeight: 600, padding: '2px 0', display: 'inline-flex', alignItems: 'center', gap: 6 }}
        >
          <span style={{ fontSize: 9 }}>{showDetails ? '▾' : '▸'}</span>
          Details
        </button>
      </div>
      {showDetails ? (
        <div style={{ display: 'grid', gap: 6, paddingLeft: 15 }}>
          {/* Which bucket paid for each request. Below the fold because the headline figure is how many
              requests the pull spent; this answers the follow-up, which only a stuck connection asks. */}
          {pools ? <div style={{ color: 'var(--muted)', fontSize: 11 }}>requests: {pools}</div> : null}
          {reachRows.length ? (
            <div style={{ color: 'var(--muted)', fontSize: 11 }}>
              reached: {reachRows.join(' · ')}
            </div>
          ) : null}
          {checkpoint ? (
            <div style={{ color: 'var(--muted)', fontSize: 11 }}>{checkpoint}</div>
          ) : (
            <div style={{ color: 'var(--muted)', fontFamily: 'monospace', fontSize: 11 }}>
              cursor {entry.cursor_before || 'none'} → {entry.cursor_after || 'none'}
            </div>
          )}
          {/* `×N` is how many of the call's requests drew the same remark — on a windowed history walk,
              "every one of them" reads very differently from "one". */}
          {(entry.advisories || []).map((a, i) => (
            <div key={`a${i}`} style={{ color: 'var(--muted)', fontSize: 11, wordBreak: 'break-word' }}>
              {a.message}{a.count > 1 ? <b style={{ color: 'var(--text)' }}> ×{a.count}</b> : null}
              {/* The request that drew it. Kept out of the message so the same remark from every window of a
                  walk stays one counted entry; shown as "first:" alongside a count, since with several
                  occurrences this names one of them rather than all. */}
              {a.context ? (
                <span style={{ opacity: 0.75 }}> ({a.count > 1 ? 'first: ' : ''}{a.context})</span>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

// Plain-text rendering of the visible log, for pasting into a bug report or a support thread. Everything
// here is already non-identifying at the source — cursors are stored as fingerprints (length + leading
// slice, never the token) and the table holds no transaction data — so this needs no redaction pass of its
// own. Keep it that way: anything added to a log row shows up here too.
function syncLogAsText(entries, scopeLabel) {
  const lines = [`Luma connection sync log${scopeLabel ? ` — ${scopeLabel}` : ''} (${entries.length} calls, newest first)`, '']
  for (const e of entries) {
    lines.push(`${e.started_at || '?'}  ${e.institution || e.provider || 'connection'} [${e.provider || '?'}] ${e.mode || '?'}`)
    const requests = e.requested_windows?.length
    // Raw throughout, including the day count the rendered row states as a duration: this is the artifact
    // someone debugs from, and a derived figure is a worse starting point than the value it came from.
    // The skip buckets are printed under their own keys rather than the rendered labels, and every bucket
    // the row carries is printed — including ones this build does not know about, so a log pasted from a
    // newer version is not silently trimmed on its way into a bug report.
    const skips = Object.entries(e.skipped_breakdown || {}).map(([k, v]) => `${k} ${v}`).join(', ')
    lines.push(`  added ${e.added} · updated ${e.updated} · removed ${e.removed} · skipped ${e.skipped}`
      + (skips ? ` (${skips})` : '')
      + ` · ${requests ? `${requests} request(s)` : `pages ${e.pages}`} · asked for ${e.days_requested ?? '—'} days`)
    const cards = cardSummary(e.card_counts, e.institution)
    if (cards) lines.push(`  rows filed on ${cards}`)
    // The *full* per-page sequence, unlike the rendered row, which shows only where the call ended up. This
    // text exists to be read by someone debugging, and the one thing the sequence holds over `final_status`
    // is a mid-drain anomaly — a status regressing, or a value nobody expected — which is visible only with
    // every page's entry in order. Statuses the provider never reported are still dropped: a walking adapter
    // emits `null` on most pages, and rendering those would bury the transitions this line exists to show.
    // The completion marker shared this line, so it is kept on its own rather than lost along with them.
    const statuses = (e.status_sequence || []).filter(s => s != null)
    const state = [
      statuses.length ? `status ${statuses.join(' → ')}` : null,
      e.became_complete ? 'backfill complete' : null,
    ].filter(Boolean)
    if (state.length) lines.push(`  ${state.join(' · ')}`)
    const checkpoint = [windowSummary(e.requested_windows), checkpointSummary(e.cursor_before, e.cursor_after)]
      .filter(Boolean).join(' · ')
    if (checkpoint) lines.push(`  ${checkpoint}`)
    // Raw pool levels, not the interpreted line: whoever reads this is checking our accounting against the
    // provider's, and the fractional token counts are the thing being checked.
    if (e.request_allowance?.pools) {
      const pools = Object.entries(e.request_allowance.pools).map(([k, v]) => `${k}=${v}`).join(', ')
      lines.push(`  allowance: capacity ${e.request_allowance.capacity}`
        + ` · +${e.request_allowance.refill_per_hour}/hr · pools {${pools}}`)
    }
    for (const [account, c] of Object.entries(e.account_counts || {})) {
      if (!c?.reached) continue
      lines.push(`  reached ${account} → ${c.reached}${c.history_complete ? ' (complete)' : ''}`)
    }
    // The raw fingerprints stay in the pasteable copy even when the line above interpreted them: this text
    // exists to be read by someone debugging, for whom "the token did not advance" is the finding, and an
    // interpretation is a worse artifact than the value it was derived from.
    lines.push(`  cursor ${e.cursor_before || 'none'} → ${e.cursor_after || 'none'}`)
    if (e.error) lines.push(`  ERROR: ${e.error}`)
    for (const w of e.warnings || []) lines.push(`  WARNING: ${w}`)
    for (const a of e.advisories || []) {
      const times = a.count > 1 ? ` (×${a.count})` : ''
      const where = a.context ? ` [${a.count > 1 ? 'first: ' : ''}${a.context}]` : ''
      lines.push(`  note: ${a.message}${times}${where}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

function ConnectionSyncLogSection({ initialConnectionId = '' }) {
  // Read-only viewer over connection_sync_log. It answers the two questions a connection can't answer
  // about itself: "did this sync fetch everything?" (the status sequence — a full historical backfill vs.
  // a stop at the ~30-day Initial Update) and "why did nothing arrive?" (the warnings and advisories,
  // which for the second reason are recorded nowhere else).
  const [entries, setEntries] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [clearing, setClearing] = useState(false)
  const [copied, setCopied] = useState(false)
  // Which connections the list is scoped to — seeded by the deep link from a connection card, then
  // adjustable here with the pills below. Filtered server-side: the retention window is bounded but its
  // rows are not small (a deep walk records one entry per request), so a filtered view has no reason to
  // ship the whole buffer. Empty means no filter, which is what makes "no pill pressed" show everything.
  const [connectionIds, setConnectionIds] = useState(initialConnectionId ? [initialConnectionId] : [])
  // Rows per connection *in the buffer*, from the same response and deliberately unfiltered — these label
  // and size the pills, so they have to keep describing every connection while some are filtered out.
  // Also the source of the labels: they come from the log's own denormalized columns, so a connection the
  // user has since disconnected keeps a named, clickable pill instead of losing it with its connection row.
  const [counts, setCounts] = useState([])

  useEffect(() => { setConnectionIds(initialConnectionId ? [initialConnectionId] : []) }, [initialConnectionId])

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await api.getSyncDiagnostics(200, connectionIds)
      setEntries(res.entries || [])
      setCounts(res.counts || [])
    } catch (e) {
      setError(e.message || 'Could not load the sync log.')
      setEntries([])
    } finally {
      setLoading(false)
    }
  }, [connectionIds])

  useEffect(() => { load() }, [load])

  // Whether the load has run long enough to be worth saying so. See `useBusyIndicator`: the work is
  // never delayed, only the announcement of it.
  const busy = useBusyIndicator(loading)

  async function clearLog() {
    setClearing(true)
    setError('')
    try {
      await api.clearSyncDiagnostics()
      setEntries([])
    } catch (e) {
      setError(e.message || 'Could not clear the sync log.')
    } finally {
      setClearing(false)
    }
  }

  const selected = new Set(connectionIds)
  const scopeLabel = counts
    .filter(c => selected.has(c.connection_id))
    .map(c => c.institution || c.provider || 'this connection')
    .join(', ')

  function togglePill(id) {
    setConnectionIds(prev => (prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]))
  }

  async function copyForSupport() {
    try {
      await navigator.clipboard.writeText(syncLogAsText(entries || [], scopeLabel))
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (e) {
      setError(e.message || 'Could not copy the log.')
    }
  }

  return (
    <Card style={{ display: 'grid', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.6, maxWidth: 560 }}>
          One row per connection per sync call — how much arrived, whether the full history was fetched or
          the pull stopped early, and anything the provider or the import reported along the way. This is
          the place to look when a connection brings in nothing, or less than expected.
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {/* `disabled` follows the raw flag — a button must stop accepting presses the instant the work
              starts — while the *label* waits for `useBusyIndicator`, so a load too quick to read never
              repaints it. Clicking a filter pill reloads the list, and this button relabelling itself for
              10ms each time read as the panel twitching rather than as anything being reported. */}
          <Button small variant="ghost" onClick={load} disabled={loading}>{busy ? 'Loading…' : 'Refresh'}</Button>
          <Button small variant="ghost" onClick={copyForSupport} disabled={!(entries && entries.length)}
            title="Copy this log as text, to paste into a bug report. Contains no transaction data and no credentials.">
            {copied ? 'Copied' : 'Copy for support'}
          </Button>
          <Button small variant="ghost" onClick={clearLog} disabled={clearing || !(entries && entries.length)}>{clearing ? 'Clearing…' : 'Clear log'}</Button>
        </div>
      </div>
      {/* One pill per connection that has rows here, replacing the old "Showing only X" banner rather than
          sitting beside it — two controls for one filter can disagree, and the banner could only ever say
          what the deep link had chosen. Only connections present in the log are offered: a pill that
          filters to nothing is a dead end, and the log's own columns name them even after a disconnect. */}
      {/* A single connection needs no pill — it would filter to what is already on screen. But an active
          filter always renders the row, so a deep link to a connection with no rows yet still offers a
          way back to everything instead of stranding the user on an empty list. */}
      {counts.length > 1 || connectionIds.length ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          {counts.map(c => {
            const on = selected.has(c.connection_id)
            return (
              <button
                key={c.connection_id}
                type="button"
                aria-pressed={on}
                onClick={() => togglePill(c.connection_id)}
                title={on
                  ? `Showing ${c.institution}. Click to stop filtering by it.`
                  : `Show only ${c.institution}${connectionIds.length ? ' as well' : ''}.`}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  padding: '3px 10px', borderRadius: 99, fontSize: 12, cursor: 'pointer',
                  border: `1px solid ${on ? 'var(--accent)' : 'var(--border)'}`,
                  background: on ? 'color-mix(in srgb, var(--accent) 14%, var(--surface2))' : 'var(--surface2)',
                  color: on ? 'var(--text)' : 'var(--muted)',
                  fontWeight: on ? 600 : 400,
                }}
              >
                {c.institution}
                {/* Rows this log is holding for the connection, not syncs it has ever run: the table is a
                    ring buffer, so this is a count of what clicking would show. */}
                <span style={{ fontVariantNumeric: 'tabular-nums', opacity: 0.7 }}>{c.count}</span>
              </button>
            )
          })}
          {connectionIds.length ? (
            <button
              type="button"
              onClick={() => setConnectionIds([])}
              /* "Clear filters", not "Show all": with every pill selected the list is already showing
                 everything, so a control promising to change that would be describing nothing. What it
                 does in both states is empty the selection. */
              style={{ background: 'none', border: 'none', padding: '0 4px', color: 'var(--accent2)', cursor: 'pointer', fontSize: 12, textDecoration: 'underline' }}
            >
              Clear filters
            </button>
          ) : null}
        </div>
      ) : null}
      {error ? <div style={{ fontSize: 12, color: 'var(--danger)' }}>{error}</div> : null}
      {entries && entries.length === 0 && !loading ? (
        <div style={{ fontSize: 13, color: 'var(--muted)' }}>
          {connectionIds.length
            ? `No sync calls recorded for ${scopeLabel || 'this connection'} yet.`
            : 'No sync calls recorded yet. Run a sync from Accounts → Connections, then Refresh here.'}
        </div>
      ) : null}
      {entries && entries.length ? (
        <div style={{ display: 'grid', gap: 8, maxHeight: 480, overflowY: 'auto' }}>
          {entries.map(e => <SyncLogRow key={e.id} entry={e} />)}
        </div>
      ) : null}
    </Card>
  )
}

function RulesTrashSection() {
  // Trashed categorization rules (from the Rules page delete / stale-rule cleanup). Restore brings a rule
  // back to active (refused if an active rule now shares its matcher); purge removes it for good.
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [workingId, setWorkingId] = useState('')
  const [emptying, setEmptying] = useState(false)
  const [error, setError] = useState('')
  const [confirmEmpty, setConfirmEmpty] = useState(false)

  async function load() {
    setLoading(true)
    try {
      setItems(await api.getRuleTrash())
      setError('')
    } catch (err) {
      setError(err.message || 'Failed to load rules trash')
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [])

  async function restore(id) {
    setWorkingId(id); setError('')
    try { await api.restoreRule(id); await load() }
    catch (err) { setError(err.message || 'Failed to restore rule') }
    finally { setWorkingId('') }
  }
  async function purge(id) {
    setWorkingId(id); setError('')
    try { await api.purgeRule(id); await load() }
    catch (err) { setError(err.message || 'Failed to remove rule') }
    finally { setWorkingId('') }
  }
  async function emptyTrash() {
    setConfirmEmpty(false); setEmptying(true); setError('')
    try { await api.purgeAllTrashedRules(); await load() }
    catch (err) { setError(err.message || 'Failed to empty rules trash') }
    finally { setEmptying(false) }
  }

  return (
    <>
      {confirmEmpty ? (
        <AppConfirmDialog
          title="Empty rules trash?"
          description="This permanently deletes every trashed rule. Their past categorizations stay as they are; the rules themselves can’t be restored afterward."
          confirmLabel="Empty rules trash"
          confirmVariant="danger"
          borderColor="color-mix(in srgb, var(--danger) 35%, var(--border))"
          onConfirm={emptyTrash}
          onCancel={() => setConfirmEmpty(false)}
          width="min(620px, 100%)"
        />
      ) : null}

      <Card style={{ display: 'grid', gap: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.6, maxWidth: 620 }}>
            Rules removed from the Rules page (or by the stale-rule cleanup) can be restored here, or removed for good.
          </div>
          <Button small variant="ghost" onClick={() => setConfirmEmpty(true)} disabled={emptying || loading || items.length === 0}>
            {emptying ? 'Emptying…' : 'Empty rules trash'}
          </Button>
        </div>
        {error ? <div style={{ fontSize: 12, color: 'var(--danger)' }}>{error}</div> : null}
        {loading && items.length === 0 ? <Spinner /> : items.length === 0 ? (
          <EmptyState message="No trashed rules." />
        ) : (
          <div style={{ border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
            {items.map((rule, index) => {
              const clauses = rule.clauses && rule.clauses.length ? rule.clauses : [rule.keyword]
              return (
                <div key={rule.id} style={{
                  display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 16, alignItems: 'center',
                  padding: '10px 14px', borderTop: index === 0 ? 'none' : '1px solid var(--border)', background: 'var(--surface2)',
                }}>
                  <div style={{ minWidth: 0, fontSize: 13, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '2px 6px' }}>
                    {clauses.map((c, i) => (
                      <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        {i > 0 ? <span style={{ color: 'var(--muted)', fontWeight: 400 }}>and</span> : null}
                        <span style={{ fontFamily: 'monospace', fontWeight: 500 }}>{c}</span>
                      </span>
                    ))}
                    {rule.category_name ? <span style={{ color: 'var(--muted)' }}>→ {rule.category_name}</span> : null}
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                    <Button small variant="ghost" onClick={() => restore(rule.id)} disabled={workingId === rule.id}>Restore</Button>
                    <Button small variant="ghost" onClick={() => purge(rule.id)} disabled={workingId === rule.id}
                      style={{ color: 'var(--danger)' }}>Remove</Button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </Card>
    </>
  )
}


function DistinctAccountPairsSection() {
  /*
   * The "these two accounts are different physical accounts" assertions, and the one place they can be
   * seen and undone.
   *
   * Each one permanently switches off cross-account duplicate detection between its pair, so it is
   * exactly the kind of durable, invisible decision that has to be inspectable. It was not: the
   * assertion could only be made as a side effect of clicking Keep on a flagged transaction, and these
   * endpoints existed with no screen calling them — so a user could suppress detection between two
   * accounts without knowing they had, and had no way to look or reverse it.
   *
   * Forgetting one is deliberately not destructive: it only re-enables checking. Rows the user already
   * resolved individually stay resolved; what comes back is future detection, plus any match the
   * assertion had been suppressing.
   */
  const [pairs, setPairs] = useState([])
  const [loading, setLoading] = useState(true)
  const [workingKey, setWorkingKey] = useState('')
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const resp = await api.getDistinctAccountPairs()
      setPairs(resp.pairs || [])
      setError('')
    } catch (err) {
      setError(err.message || 'Failed to load account pairs')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  async function forget(pair) {
    const key = `${pair.account_id_low}:${pair.account_id_high}`
    setWorkingKey(key)
    setError('')
    try {
      await api.forgetDistinctAccountPair(pair.account_id_low, pair.account_id_high)
      notifyAccountsChanged()
      await load()
    } catch (err) {
      setError(err.message || 'Failed to forget the assertion')
    } finally {
      setWorkingKey('')
    }
  }

  const label = (name, displayName, mask) => {
    const base = (displayName || '').trim() || (name || '').trim() || 'Account'
    return mask ? `${base} ···${mask}` : base
  }

  return (
    <Card style={{ display: 'grid', gap: 14 }}>
      <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.6, maxWidth: 620 }}>
        Pairs you have said are different real-world accounts. Imports stop checking for duplicate
        transactions between them. Forgetting a pair turns that checking back on — it does not undo
        decisions already made about individual transactions.
      </div>
      {error ? <div style={{ fontSize: 13, color: 'var(--danger)' }}>{error}</div> : null}
      {loading && pairs.length === 0 ? <Spinner /> : pairs.length === 0 ? (
        <EmptyState message="No account pairs have been marked as distinct." />
      ) : (
        <div style={{ border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
          {pairs.map((pair, index) => {
            const key = `${pair.account_id_low}:${pair.account_id_high}`
            return (
              <div
                key={key}
                style={{
                  display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 16,
                  alignItems: 'center', padding: '12px 14px',
                  borderTop: index === 0 ? 'none' : '1px solid var(--border)',
                  background: 'var(--surface2)',
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 600 }}>
                    {label(pair.account_low_name, pair.account_low_display_name, pair.account_low_mask)}
                    <span style={{ color: 'var(--muted)', fontWeight: 400 }}> and </span>
                    {label(pair.account_high_name, pair.account_high_display_name, pair.account_high_mask)}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
                    Marked distinct {formatDate(String(pair.asserted_at || '').slice(0, 10)) || 'recently'}.
                  </div>
                </div>
                <Button small variant="ghost" disabled={!!workingKey} onClick={() => forget(pair)}>
                  {workingKey === key ? 'Forgetting…' : 'Forget'}
                </Button>
              </div>
            )
          })}
        </div>
      )}
    </Card>
  )
}


function TrashSection() {
  /*
   * The account trash keeps reversible account cleanup separate from the irreversible final delete.
   * Restoring just makes the hidden child account visible again; emptying the trash is the one-way step
   * that folds historical references into the parent and removes the old account record for good.
   */
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [workingId, setWorkingId] = useState('')
  const [emptying, setEmptying] = useState(false)
  const [error, setError] = useState('')
  const [confirmEmpty, setConfirmEmpty] = useState(false)

  async function load() {
    setLoading(true)
    try {
      const rows = await api.getTrashedAccounts()
      setItems(rows)
      setError('')
    } catch (err) {
      setError(err.message || 'Failed to load trash')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  async function restoreItem(accountId) {
    setWorkingId(accountId)
    setError('')
    try {
      await api.restoreAccount(accountId)
      await load()
    } catch (err) {
      setError(err.message || 'Failed to restore account')
    } finally {
      setWorkingId('')
    }
  }

  async function emptyTrash() {
    setConfirmEmpty(false)
    setEmptying(true)
    setError('')
    try {
      await api.emptyAccountTrash()
      await load()
    } catch (err) {
      setError(err.message || 'Failed to empty trash')
    } finally {
      setEmptying(false)
    }
  }

  return (
    <>
      {confirmEmpty ? (
        <AppConfirmDialog
          title="Empty trash?"
          description="This permanently removes the trashed account records. Any linked history will be folded into the parent account and can’t be restored afterward."
          confirmLabel="Empty trash"
          confirmVariant="danger"
          borderColor="color-mix(in srgb, var(--danger) 35%, var(--border))"
          onConfirm={emptyTrash}
          onCancel={() => setConfirmEmpty(false)}
          width="min(620px, 100%)"
        />
      ) : null}

      <Card style={{ display: 'grid', gap: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.6, maxWidth: 620 }}>
            Merged child accounts can be hidden here first and only removed permanently when you empty the trash.
          </div>
          <Button
            small
            variant="ghost"
            onClick={() => setConfirmEmpty(true)}
            disabled={emptying || loading || items.length === 0}
          >
            {emptying ? 'Emptying…' : 'Empty trash'}
          </Button>
        </div>

        {loading && items.length === 0 ? <Spinner /> : items.length === 0 ? (
          <EmptyState message="Nothing in trash." />
        ) : (
          <div style={{ border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
            {items.map((item, index) => (
              <div
                key={item.id}
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'minmax(0, 1fr) auto',
                  gap: 16,
                  alignItems: 'center',
                  padding: '12px 14px',
                  borderTop: index === 0 ? 'none' : '1px solid var(--border)',
                  background: 'var(--surface2)',
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {item.name}
                  </div>
                  <div style={{ marginTop: 4, fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>
                    {item.parent_display_name || item.parent_name ? `Grouped under ${item.parent_display_name || item.parent_name}. ` : ''}
                    {item.owner_name ? `${item.owner_name} · ` : ''}
                    Trashed {item.trashed_at || 'recently'}.
                  </div>
                </div>
                <Button
                  small
                  onClick={() => restoreItem(item.id)}
                  disabled={workingId === item.id || emptying}
                >
                  {workingId === item.id ? 'Restoring…' : 'Restore'}
                </Button>
              </div>
            ))}
          </div>
        )}

        {error ? (
          <div style={{ fontSize: 12, color: 'var(--danger)' }}>{error}</div>
        ) : null}
      </Card>
    </>
  )
}

// Whether a trashed transaction was removed by import reconciliation (an Amazon merge or per-copy
// discard) rather than deleted directly by the user — the discriminator between the two
// transaction-trash sections below. Module-level so the filter identities are stable.
const isReconRemoval = (item) =>
  item.dedupe_resolved_by === 'amazon_merge' || item.dedupe_resolved_by === 'amazon_discard'
const isDirectDelete = (item) => !isReconRemoval(item)

// Timeframe options for the Empty-trash chooser. Values match backend/routers/transactions.py
// `_TRASH_OLDER_THAN`; the cutoff is measured on `trashed_at` (age in the trash). `all` empties the
// whole section — the button's long-standing meaning — and `ago` is the human phrase for the confirm copy.
const TRASH_TIMEFRAMES = [
  { value: 'all', label: 'Everything', ago: null },
  { value: '1m', label: 'Older than 1 month', ago: '1 month' },
  { value: '3m', label: 'Older than 3 months', ago: '3 months' },
  { value: '6m', label: 'Older than 6 months', ago: '6 months' },
  { value: '1y', label: 'Older than 1 year', ago: '1 year' },
]

// The "how much to erase" radio group shown inside the Empty-trash confirm dialog. Defaults to
// Everything; narrower picks purge only rows trashed at least that long ago.
function TrashTimeframeChooser({ value, onChange, disabled, name }) {
  return (
    <div role="radiogroup" aria-label="How much to erase" style={{ display: 'grid', gap: 6, marginTop: 6 }}>
      {TRASH_TIMEFRAMES.map(tf => {
        const selected = value === tf.value
        return (
          <label
            key={tf.value}
            style={{
              display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px',
              border: `1px solid ${selected ? 'var(--accent)' : 'var(--border)'}`, borderRadius: 10,
              cursor: disabled ? 'default' : 'pointer', fontSize: 14,
              background: selected ? 'color-mix(in srgb, var(--accent) 10%, transparent)' : 'var(--surface2)',
            }}
          >
            <input type="radio" name={name} value={tf.value} checked={selected} disabled={disabled}
              onChange={() => onChange(tf.value)} />
            {tf.label}
          </label>
        )
      })}
    </div>
  )
}

// Confirm-dialog body for emptying a transaction-trash section: an extent line reflecting the chosen
// timeframe, then the section-specific `note` (its sibling-protection + irreversibility caveats).
// `noun` names the section's rows ("deleted transaction", "removed duplicate copy").
function trashEmptyDescription(timeframe, noun, note) {
  const tf = TRASH_TIMEFRAMES.find(t => t.value === timeframe) || TRASH_TIMEFRAMES[0]
  const extent = tf.ago
    ? `This permanently removes every ${noun} trashed more than ${tf.ago} ago.`
    : `This permanently removes every ${noun} listed here.`
  return `${extent} ${note}`
}

// Load / restore / empty plumbing shared by the two transaction-trash sections. `filter` selects the
// section's slice of the trash; `scope` keeps its Empty button from deleting the other section's rows.
function useTrashedTransactions(filter, scope) {
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [workingId, setWorkingId] = useState('')
  const [emptying, setEmptying] = useState(false)
  const [error, setError] = useState('')
  const [confirmEmpty, setConfirmEmpty] = useState(false)
  const [timeframe, setTimeframe] = useState('all')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const rows = await api.getTrashedTransactions()
      setItems((Array.isArray(rows) ? rows : []).filter(filter))
      setError('')
    } catch (err) {
      setError(err.message || 'Failed to load trashed transactions')
    } finally {
      setLoading(false)
    }
  }, [filter])

  useEffect(() => { load() }, [load])

  async function restoreItem(txnId) {
    setWorkingId(txnId)
    setError('')
    try {
      await txnMutations.restoreTransaction(txnId)
      await load()
    } catch (err) {
      setError(err.message || 'Failed to restore transaction')
    } finally {
      setWorkingId('')
    }
  }

  // Open the confirm dialog, always starting the chooser back at Everything so a narrow pick from a
  // previous empty doesn't silently carry over into the next one.
  function openConfirm() {
    setTimeframe('all')
    setConfirmEmpty(true)
  }

  async function emptyTrash() {
    setConfirmEmpty(false)
    setEmptying(true)
    setError('')
    try {
      await api.emptyTransactionTrash(scope, timeframe)
      await load()
    } catch (err) {
      setError(err.message || 'Failed to empty trash')
    } finally {
      setEmptying(false)
    }
  }

  return { items, loading, workingId, emptying, error, confirmEmpty, setConfirmEmpty, openConfirm, timeframe, setTimeframe, restoreItem, emptyTrash }
}

// One trashed transaction, shared by both sections (they differ only in list structure around it).
function TrashedTxnRow({ item, first = false, working, emptying, onRestore }) {
  const merchant = item.display_name || item.merchant_name || item.raw_name || '—'
  const account = item.account_display_name || item.account_name || '—'
  const amount = Number(item.amount) || 0
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1fr) auto auto',
        gap: 16,
        alignItems: 'center',
        padding: '10px 14px',
        borderTop: first ? 'none' : '1px solid var(--border)',
        background: 'var(--surface2)',
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {merchant}
        </div>
        <div style={{ marginTop: 2, fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>
          {item.date} · {account}{item.category_name ? ` · ${item.category_name}` : ''} · Trashed {item.trashed_at || 'recently'}
        </div>
      </div>
      <div style={{ fontSize: 13, fontWeight: 600, color: amount < 0 ? 'var(--success)' : 'var(--text)', whiteSpace: 'nowrap' }}>
        {amount < 0 ? '+' : ''}{amount.toFixed(2)}
      </div>
      <Button small onClick={() => onRestore(item.id)} disabled={working === item.id || emptying}>
        {working === item.id ? 'Restoring…' : 'Restore'}
      </Button>
    </div>
  )
}

function TransactionsTrashSection() {
  // Transactions deleted directly (the transactions page, detail panels, bulk edit) — the import
  // source isn't meaningful for these, so it's a flat list. Duplicate copies removed by import
  // reconciliation live in the sibling DuplicateTransactionsTrashSection. Restoration just clears
  // the `trashed_at` flag; emptying drops this section's records permanently.
  const t = useTrashedTransactions(isDirectDelete, 'deleted')

  return (
    <>
      {t.confirmEmpty ? (
        <AppConfirmDialog
          title="Empty transaction trash?"
          description={trashEmptyDescription(t.timeframe, 'deleted transaction', 'Removed duplicates have their own section and are not touched. Restored history will not be recoverable afterward.')}
          confirmLabel="Empty trash"
          confirmVariant="danger"
          borderColor="color-mix(in srgb, var(--danger) 35%, var(--border))"
          onConfirm={t.emptyTrash}
          onCancel={() => t.setConfirmEmpty(false)}
          width="min(620px, 100%)"
        >
          <TrashTimeframeChooser name="empty-deleted-trash" value={t.timeframe} onChange={t.setTimeframe} />
        </AppConfirmDialog>
      ) : null}

      <Card style={{ display: 'grid', gap: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.6, maxWidth: 620 }}>
            Transactions you&apos;ve sent to the trash live here until you restore them or empty the trash.
          </div>
          <Button
            small
            variant="ghost"
            onClick={t.openConfirm}
            disabled={t.emptying || t.loading || t.items.length === 0}
          >
            {t.emptying ? 'Emptying…' : 'Empty trash'}
          </Button>
        </div>

        {t.loading && t.items.length === 0 ? <Spinner /> : t.items.length === 0 ? (
          <EmptyState message="No transactions in trash." />
        ) : (
          <div style={{ border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
            {t.items.map((item, index) => (
              <TrashedTxnRow key={item.id} item={item} first={index === 0}
                working={t.workingId} emptying={t.emptying} onRestore={t.restoreItem} />
            ))}
          </div>
        )}

        {t.error ? (
          <div style={{ fontSize: 12, color: 'var(--danger)' }}>{t.error}</div>
        ) : null}
      </Card>
    </>
  )
}

function DuplicateTransactionsTrashSection() {
  // Duplicate charge copies removed by import reconciliation (Merge → keep one / per-copy Discard),
  // organized by the file each copy came from — that provenance is the whole reason these sit apart
  // from ordinary deletes. Groups collapse for scanning; a lone file starts open. Restore brings a
  // copy back, and the reconciliation report simply re-derives its grouping.
  const t = useTrashedTransactions(isReconRemoval, 'duplicates')
  const [openGroups, setOpenGroups] = useState(null)   // null = default (a lone group starts open)

  const groups = []
  const byFile = new Map()
  for (const item of t.items) {   // items arrive most-recently-trashed first; rows keep that order
    const label = item.source_filename || 'Unknown file'
    if (!byFile.has(label)) { byFile.set(label, []); groups.push(label) }
    byFile.get(label).push(item)
  }
  const effectiveOpen = openGroups ?? new Set(groups.length === 1 ? groups : [])
  const toggleGroup = (label) => {
    const next = new Set(effectiveOpen)
    if (next.has(label)) next.delete(label)
    else next.add(label)
    setOpenGroups(next)
  }

  return (
    <>
      {t.confirmEmpty ? (
        <AppConfirmDialog
          title="Empty removed-duplicates trash?"
          description={trashEmptyDescription(t.timeframe, 'removed duplicate copy', 'Deleted transactions have their own section and are not touched. The record of what was merged or discarded goes with them.')}
          confirmLabel="Empty trash"
          confirmVariant="danger"
          borderColor="color-mix(in srgb, var(--danger) 35%, var(--border))"
          onConfirm={t.emptyTrash}
          onCancel={() => t.setConfirmEmpty(false)}
          width="min(620px, 100%)"
        >
          <TrashTimeframeChooser name="empty-duplicates-trash" value={t.timeframe} onChange={t.setTimeframe} />
        </AppConfirmDialog>
      ) : null}

      <Card style={{ display: 'grid', gap: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.6, maxWidth: 620 }}>
            Duplicate charge copies removed on the Amazon reconciliation report (Merge → keep one, or a
            per-copy Discard), grouped by the file they were imported from. Restore brings a copy back.
          </div>
          <Button
            small
            variant="ghost"
            onClick={t.openConfirm}
            disabled={t.emptying || t.loading || t.items.length === 0}
          >
            {t.emptying ? 'Emptying…' : 'Empty trash'}
          </Button>
        </div>

        {t.loading && t.items.length === 0 ? <Spinner /> : t.items.length === 0 ? (
          <EmptyState message="No removed duplicates in trash." />
        ) : groups.map(label => {
          const open = effectiveOpen.has(label)
          const rows = byFile.get(label)
          return (
            <div key={label} style={{ border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
              <button
                type="button"
                onClick={() => toggleGroup(label)}
                style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '9px 14px', background: 'var(--surface)', border: 'none', cursor: 'pointer', color: 'var(--text)', fontSize: 12.5, textAlign: 'left' }}
              >
                <span style={{ color: 'var(--muted)' }}>{open ? '▾' : '▸'}</span>
                <span style={{ fontWeight: 600 }}>{label}</span>
                <span style={{ color: 'var(--muted)', fontWeight: 400 }}>({rows.length})</span>
              </button>
              {open ? rows.map(item => (
                <TrashedTxnRow key={item.id} item={item}
                  working={t.workingId} emptying={t.emptying} onRestore={t.restoreItem} />
              )) : null}
            </div>
          )
        })}

        {t.error ? (
          <div style={{ fontSize: 12, color: 'var(--danger)' }}>{t.error}</div>
        ) : null}
      </Card>
    </>
  )
}

function AboutRow({ label, value, help = '' }) {
  return (
    <div style={{ display: 'grid', gap: 4 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 600 }}>{value}</div>
      {help ? (
        <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.55 }}>
          {help}
        </div>
      ) : null}
    </div>
  )
}

function AboutSection({ dbInstanceId }) {
  return (
    <Card style={{ padding: 20 }}>
      <div style={{ display: 'grid', gap: 18 }}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 700 }}>{APP_NAME}</div>
          <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4, lineHeight: 1.6 }}>
            Self-hosted personal finance tracker.
          </div>
        </div>

        {/* alignItems:start keeps each column top-aligned; without it a short cell (Version — no help
            caption) stretches to the tallest cell's height and its value drifts to the middle. */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 18, alignItems: 'start' }}>
          <AboutRow
            label="Version"
            value={`v${APP_VERSION}`}
          />
          <AboutRow
            label="License"
            value="GNU AGPL v3.0 or later"
            help="SPDX identifier: AGPL-3.0-or-later."
          />
          <AboutRow
            label="Instance ID"
            value={dbInstanceId || 'Unavailable'}
            help="Unique identifier for this database. Backups are stamped with it, so restoring a backup from a different database warns before overwriting."
          />
        </div>
      </div>
    </Card>
  )
}

// Compact segmented chooser for the color theme. Writes the choice straight through the preference
// store; ThemeController (App.jsx) reacts to the change and applies it to <html>, so this stays a
// pure selection control. Built inline (no shared segmented primitive exists yet); extract to ui.jsx
// if a second one appears.
function ThemeSection() {
  const [themeChoice, setThemeChoice] = useUserPreference(THEME_PREF_KEY, THEME_SYSTEM)
  return (
    <div role="radiogroup" aria-label="Color theme" style={{ display: 'inline-flex', gap: 4, padding: 4, background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 10 }}>
      {THEME_CHOICES.map(choice => {
        const selected = themeChoice === choice
        return (
          <button
            key={choice}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => setThemeChoice(choice)}
            style={{
              minWidth: 76,
              padding: '6px 14px',
              borderRadius: 7,
              border: 'none',
              cursor: 'pointer',
              fontSize: 13,
              fontWeight: 600,
              background: selected ? 'var(--accent)' : 'transparent',
              color: selected ? '#fff' : 'var(--muted)',
              transition: 'background 0.12s, color 0.12s',
            }}
          >
            {THEME_LABELS[choice]}
          </button>
        )
      })}
    </div>
  )
}

function CurrencySection() {
  // The ledger holds one currency at a time, and this is it. Nothing about the stored data changes when
  // it does — no amount is converted or rewritten — which is exactly why the change needs confirming
  // rather than blocking: it silently relabels every historical figure, and only the user can tell a
  // correction from a mistake. It is equally cheap to reverse, and the dialog says so.
  const [state, setState] = useState(null)
  const [selected, setSelected] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [pendingChange, setPendingChange] = useState(null)

  useEffect(() => {
    let cancelled = false
    api.getLedgerCurrency()
      .then(result => {
        if (cancelled) return
        setState(result)
        setSelected(result?.code || DEFAULT_LEDGER_CURRENCY)
      })
      .catch(err => { if (!cancelled) setError(err?.message || 'Could not read the currency setting.') })
    return () => { cancelled = true }
  }, [])

  async function save(code, confirm = false) {
    setSaving(true)
    setError('')
    try {
      const result = await api.setLedgerCurrency(code, confirm)
      setState(result)
      setSelected(result.code)
      setPendingChange(null)
      applyLedgerCurrency(result.code)
      // Reloaded rather than re-rendered. The money formatters read the symbol at call time from a shared
      // config object, so every amount already on screen was formatted with the old one and nothing tells
      // those components to run again. A reload is honest about what changed — every figure in the app —
      // and is cheaper than making a global display constant reactive everywhere it is read.
      window.location.reload()
    } catch (err) {
      setSaving(false)
      const detail = err?.detail
      if (detail?.code === 'currency_change_needs_confirmation') {
        setPendingChange(detail)
        return
      }
      setError(err?.message || 'Could not save the currency.')
    }
  }

  if (!state) {
    return error
      ? <div style={{ fontSize: 13, color: 'var(--danger)' }}>{error}</div>
      : <Spinner />
  }

  const symbol = currencySymbolFor(selected)
  const options = state.common || []
  // A code the user set that is not on the shortlist still has to be selectable, or saving anything else
  // would silently drop it. The list is a convenience, never a whitelist.
  const known = options.some(o => o.code === selected)

  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <select
          name="ledger-currency"
          value={selected}
          disabled={saving}
          onChange={e => setSelected(e.target.value)}
          style={{ ...getFormControlStyle(), width: 'auto', minWidth: 220 }}
        >
          {!known ? <option value={selected}>{selected}</option> : null}
          {options.map(o => (
            <option key={o.code} value={o.code}>{o.code} — {o.label}</option>
          ))}
        </select>
        <span style={{ fontSize: 13, color: 'var(--muted)' }}>
          Amounts show as <strong style={{ color: 'var(--text)' }}>{symbol}1,234.56</strong>
        </span>
        <Button
          small
          disabled={saving || selected === state.code}
          onClick={() => save(selected)}
        >
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
      <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.55 }}>
        Every amount is stored as a plain number, so this sets what those numbers <em>mean</em> and how
        they are shown — it does not convert anything. Transactions from a connected data source whose
        account is held in a different currency are not imported.
      </div>
      {error ? <div style={{ fontSize: 12, color: 'var(--danger)' }}>{error}</div> : null}

      {pendingChange ? (
        <AppConfirmDialog
          title={`Switch this ledger to ${pendingChange.to}?`}
          description={pendingChange.message}
          confirmLabel={`Switch to ${pendingChange.to}`}
          confirmVariant="danger"
          borderColor="color-mix(in srgb, var(--danger) 35%, var(--border))"
          onConfirm={() => save(pendingChange.to, true)}
          onCancel={() => { setPendingChange(null); setSelected(state.code) }}
          width="min(560px, 100%)"
        />
      ) : null}
    </div>
  )
}

export default function Settings() {
  const {
    authEnabled,
    currentUser,
    passwordPolicy,
    securityProfile,
    dataProviderIntended,
    developerOptionsEnabled,
    dbInstanceId,
    activeLocalProfile,
    setSecurityProfile,
    setPasswordPolicy,
    setDataProviderIntended,
  } = useAppSession()
  // Section open/closed state is a single user preference, read and written straight through the
  // context — no local mirror, no load/save effects, no localStorage, so there is nothing to drift.
  const [sectionOpenState, setSectionOpenState] = useUserPreference(SETTINGS_SECTIONS_PREF_KEY, EMPTY_SECTION_STATE)
  const settingsScrollRef = useRef(null)

  // Deep link from elsewhere in the app: `?section=<key>` opens that section on arrival (a link landing on
  // a collapsed card has not actually taken the user anywhere) and `?connection=<id>` scopes the sync log
  // to one connection. Captured once, so clearing the filter or re-collapsing the section afterwards
  // sticks instead of the URL springing it back. Opening writes through the normal section preference
  // rather than overriding the render: the section then behaves like any other, and "open" survives as
  // the user's state — which is right, since they just asked to look at it.
  const [searchParams] = useSearchParams()
  const [deepLink] = useState(() => ({
    section: searchParams.get('section') || '',
    connectionId: searchParams.get('connection') || '',
  }))
  const deepLinkSection = deepLink.section
  useEffect(() => {
    if (deepLinkSection) setSectionOpenState(prev => ({ ...prev, [deepLinkSection]: true }))
  }, [deepLinkSection, setSectionOpenState])

  function bindSection(sectionKey, defaultCollapsed = true) {
    const isOpen = sectionOpenState[sectionKey] ?? !defaultCollapsed
    return {
      open: isOpen,
      onOpenChange: value => setSectionOpenState(prev => ({ ...prev, [sectionKey]: value })),
    }
  }

  const canManageEnvironment = !authEnabled || currentUser?.role === 'admin'

  return (
    <div data-browser-context-passthrough="true" style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ padding: '24px 28px 0', flexShrink: 0 }}>
        <div style={{ width: SETTINGS_CONTENT_WIDTH, margin: '0 auto' }}>
          <PageHeader title="Settings" />
        </div>
      </div>

      <div data-browser-context-passthrough="true" ref={settingsScrollRef} style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 28px 24px' }}>
        <div style={{ width: SETTINGS_CONTENT_WIDTH, margin: '0 auto' }}>

          <StickySection
            title="Appearance"
            description="Choose your color theme."
            scrollContainerRef={settingsScrollRef}
            {...bindSection('appearance')}
          >
            <ThemeSection />
          </StickySection>

          <StickySection
            title="Currency"
            description="The currency this ledger's amounts are in."
            scrollContainerRef={settingsScrollRef}
            {...bindSection('currency')}
          >
            <CurrencySection />
          </StickySection>

          {/* Section key stays 'environment' through the rename so an existing expanded/collapsed
              preference is not silently reset. */}
          {canManageEnvironment && (
            <StickySection
              title="Configuration"
              scrollContainerRef={settingsScrollRef}
              actions={<FeatureExplainer topic="configuration" placement="bottom-left" />}
              {...bindSection('environment')}
            >
              <ConfigurationSection authEnabled={authEnabled} currentUser={currentUser} />
            </StickySection>
          )}

          <StickySection
            title="Intended usage"
            description={`How you'll run ${APP_NAME}, and whether you'll connect a bank or data provider.`}
            actions={<FeatureExplainer topic="data-and-backups" placement="bottom-left" />}
            scrollContainerRef={settingsScrollRef}
            {...bindSection('intendedUsage')}
          >
            <IntendedUsageSection
              authEnabled={authEnabled}
              securityProfile={securityProfile}
              dataProviderIntended={dataProviderIntended}
              passwordPolicy={passwordPolicy}
              onProfileChange={value => setSecurityProfile?.(value)}
              onDataProviderChange={value => setDataProviderIntended?.(value)}
            />
          </StickySection>

          {!authEnabled && (
            <StickySection
              title="Sign-in protection"
              description="Enable login when you want passwords, 2FA, or multiple sign-in accounts for the same installation."
              scrollContainerRef={settingsScrollRef}
              {...bindSection('signInProtection')}
            >
              <AuthModeSection passwordPolicy={passwordPolicy} activeLocalProfile={activeLocalProfile} />
            </StickySection>
          )}

          {authEnabled && (
            <StickySection
              title="Account security"
              description="Manage password requirements and authenticator-based sign-in protection."
              actions={<FeatureExplainer topic="account-security" placement="bottom-left" />}
              scrollContainerRef={settingsScrollRef}
              {...bindSection('accountSecurity')}
            >
              <AccountSecuritySection passwordPolicy={passwordPolicy} onPasswordPolicyChange={setPasswordPolicy} />
            </StickySection>
          )}

          {authEnabled && (
            <StickySection
              title="User management"
              description={`Manage who can sign in.`}
              scrollContainerRef={settingsScrollRef}
              {...bindSection('userManagement')}
            >
              <UserAdminSection passwordPolicy={passwordPolicy} />
            </StickySection>
          )}

          {authEnabled && currentUser?.role === 'admin' && (
            <StickySection
              title="Sign-in protection"
              description="Turn off login for this installation (accounts and passwords are kept)."
              scrollContainerRef={settingsScrollRef}
              {...bindSection('disableSignInProtection')}
            >
              <DisableAuthSection />
            </StickySection>
          )}

          {developerOptionsEnabled && (
            <StickySection
              title="Developer options"
              description="Useful tools for developers and testing workflows."
              scrollContainerRef={settingsScrollRef}
              {...bindSection('developerOptions')}
            >
              <DeveloperOptionsSection authEnabled={authEnabled} />
            </StickySection>
          )}

          {/* Deliberately NOT behind developer options (unlike the destructive tools above): this is the
              only in-app answer to "why did this connection import nothing?", and gating it meant nothing
              was even recorded until someone set an env var and reproduced the problem. */}
          <StickySection
            title="Connection sync log"
            description="What each data connection did on every sync — how much arrived, whether the full history was fetched, and anything the provider reported."
            scrollContainerRef={settingsScrollRef}
            {...bindSection('connectionSyncLog')}
          >
            <ConnectionSyncLogSection initialConnectionId={deepLink.connectionId} />
          </StickySection>

          <StickySection
            title="Distinct account pairs"
            description="Accounts you have declared to be different from one another, so imports stop looking for duplicate transactions between them."
            scrollContainerRef={settingsScrollRef}
            {...bindSection('distinctAccountPairs')}
          >
            <DistinctAccountPairsSection />
          </StickySection>

          <StickySection
            title="Transaction tags"
            description="Create the lightweight labels that show on transaction rows and can be applied by rules."
            actions={<FeatureExplainer topic="tags" placement="bottom-left" />}
            scrollContainerRef={settingsScrollRef}
            {...bindSection('transactionTags')}
          >
            <TransactionTagsSection />
          </StickySection>

          <StickySection
            title="Trash"
            description="Restore merged child accounts or trashed transactions before you permanently remove them."
            scrollContainerRef={settingsScrollRef}
            {...bindSection('trash')}
          >
            <div style={{ display: 'grid', gap: 18 }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>
                  Accounts
                </div>
                <TrashSection />
              </div>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>
                  Transactions
                </div>
                <TransactionsTrashSection />
              </div>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>
                  Duplicate transactions
                </div>
                <DuplicateTransactionsTrashSection />
              </div>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>
                  Rules
                </div>
                <RulesTrashSection />
              </div>
            </div>
          </StickySection>

          <StickySection
            title="About"
            description={`Version and installation details.`}
            scrollContainerRef={settingsScrollRef}
            {...bindSection('about')}
          >
            <AboutSection dbInstanceId={dbInstanceId} />
          </StickySection>
        </div>
      </div>
    </div>
  )
}
