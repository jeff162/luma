// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState, useEffect, useRef, useId } from 'react'
import { api } from '../../lib/api.js'
import { NEW_SECRET_PROPS } from '../../lib/sensitiveFields.js'
import SoleVaultMemberWarning from '../SoleVaultMemberWarning.jsx'
import { useSoleVaultMember } from '../../lib/useSoleVaultMember.js'
import { Card, Button, Spinner, FieldIssue, FormLabel, SectionEyebrow, getFormControlStyle, PasswordInput, AppConfirmDialog, Tooltip } from '../ui.jsx'
import { passwordIssue, passwordPolicyHelpText, passwordShortfall } from '../../lib/passwordPolicy.js'

export default function UserAdminSection({ passwordPolicy }) {
  const fieldIdBase = useId()
  const [viewer, setViewer] = useState(null)
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [savingUserId, setSavingUserId] = useState(null)
  const [deletingUserId, setDeletingUserId] = useState(null)
  const [editingUserId, setEditingUserId] = useState(null)
  const [pendingDeleteUser, setPendingDeleteUser] = useState(null)
  const deletingSoleVaultMember = useSoleVaultMember(pendingDeleteUser?.id, () => api.listUsers().then(r => r.users))
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

  // What each form would refuse on, checked as it is typed (`lib/passwordPolicy.js`) and shown both under
  // the fields and on the greyed button. A blank password when editing means "keep the current one".
  const createIssue = !form.username.trim() ? 'Enter a username.'
    : passwordIssue({ password: form.password, policy: passwordPolicy })
  const editIssue = !editForm.username.trim() ? 'Enter a username.'
    : !editForm.display_name.trim() ? 'Enter a display name.'
      : passwordIssue({ password: editForm.password, policy: passwordPolicy, optional: true })

  async function handleCreate(e) {
    e.preventDefault()
    // Guarded on the same issue the button is, so Enter can never submit what the button refuses.
    if (createIssue || creating) return
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
        >
          {deletingSoleVaultMember ? (
            <SoleVaultMemberWarning name={pendingDeleteUser.display_name || pendingDeleteUser.username} />
          ) : null}
        </AppConfirmDialog>
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
            <FormLabel style={{ marginBottom: 4 }}>Password</FormLabel>
            <PasswordInput aria-label="Password" value={form.password} onChange={value => { setError(''); setForm(prev => ({ ...prev, password: value })) }} style={inputStyle} {...NEW_SECRET_PROPS} />
          </div>
          <div>
            <FormLabel htmlFor={`${fieldIdBase}-create-role`} style={{ marginBottom: 4 }}>Role</FormLabel>
            <select id={`${fieldIdBase}-create-role`} name="settings-create-user-role" value={form.role} onChange={e => setForm(prev => ({ ...prev, role: e.target.value }))} style={{ ...inputStyle, cursor: 'pointer' }}>
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </select>
          </div>
          <Tooltip content={createIssue && !creating ? createIssue : ''} align="right">
            <Button small type="submit" disabled={creating || !!createIssue}>
              {creating ? 'Creating...' : 'Add user'}
            </Button>
          </Tooltip>
        </form>
        {/* The live note sits in this line rather than under the password field: the row above aligns its
            fields to the bottom, so a note inside the password's cell would lift that one input out of
            line with the rest. */}
        <div style={{ padding: '10px 16px', color: 'var(--muted)', fontSize: 12, borderBottom: '1px solid var(--border)', display: 'grid', gap: 4 }}>
          <div>Password policy: {passwordPolicyHelpText(passwordPolicy)}</div>
          <FieldIssue>{passwordShortfall(form.password, passwordPolicy)}</FieldIssue>
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
                  <FormLabel style={{ marginBottom: 4 }}>New password</FormLabel>
                  <PasswordInput aria-label="New password" value={editForm.password} onChange={value => { setError(''); setEditForm(prev => ({ ...prev, password: value })) }} placeholder="Leave blank to keep current" style={inputStyle} {...NEW_SECRET_PROPS} />
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
              <FieldIssue style={{ marginTop: -8 }}>{passwordShortfall(editForm.password, passwordPolicy)}</FieldIssue>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={editForm.must_change_password}
                  onChange={e => setEditForm(prev => ({ ...prev, must_change_password: e.target.checked }))}
                />
                Require a password change at next sign-in
              </label>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <Tooltip content={editIssue && savingUserId !== user.id ? editIssue : ''} align="right">
                  <Button
                    small
                    onClick={() => handleSaveUser(user.id)}
                    disabled={savingUserId === user.id || !!editIssue}
                  >
                    {savingUserId === user.id ? 'Saving...' : 'Save changes'}
                  </Button>
                </Tooltip>
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
