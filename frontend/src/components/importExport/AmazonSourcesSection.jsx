// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useId, useState } from 'react'
import { api } from '../../lib/api.js'
import { formatTimestamp } from '../../lib/utils.js'
import { AppConfirmDialog, AppDialog, Button, Input, Toggle, IconButton } from '../ui.jsx'
import { SOURCE_ROW_GRID_COLUMNS, TRUNCATED_CELL_STYLE } from '../../lib/importExport/constants.js'
import FeatureExplainer from '../../help/FeatureExplainer.jsx'
import WatchedFolderDialog from './WatchedFolderDialog.jsx'
import AmazonAccountPicker from './AmazonAccountPicker.jsx'
import WatchPausedPill from './WatchPausedPill.jsx'

// Amazon in the data-source list.
//
// Amazon needs no column mapping — an AZAD export is recognized by its own header — so what a saved
// Amazon source holds is which Amazon account its files import into, and optionally a folder on the
// server to watch. That is why these rows are here rather than in the CSV mapping manager: the fields
// are a small subset of a data source's, and the CSV editor has nothing to show for one.
//
// Several sources are the point. Two people's order history lands in two Amazon accounts, and with a
// folder each (or one folder and a filename pattern each) the exports sort themselves out.

const labelStyle = { fontSize: 10, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }
const cellValueStyle = { fontSize: 12, color: 'var(--muted)' }
// The same geometry the CSV data-source rows use, from the shared constant rather than a copy of it —
// these rows sit in the same list, so their columns have to be the same columns.
const ROW_GRID = {
  display: 'grid', gridTemplateColumns: SOURCE_ROW_GRID_COLUMNS, columnGap: 12,
  padding: '10px 16px', alignItems: 'center', fontSize: 13, borderBottom: '1px solid var(--border)',
}
// Matching the bare row actions beside it (Folder / Edit); a `Button` here was visibly heavier than
// every other control on the row.
// What a source's folder setting amounts to. Whether it is *switched on* is not in here: that rides
// the label above as a pill, where the cell's truncation cannot clip it.
function folderSummary(profile) {
  return profile.watch_dir || 'No folder watched'
}

function AmazonSourceEditor({ profile, accounts, onClose, onSaved, onAccountCreated }) {
  const [name, setName] = useState(profile?.name || '')
  const [accountId, setAccountId] = useState(profile?.account_id || '')
  const [pattern, setPattern] = useState(profile?.filename_pattern || '')
  const [categorize, setCategorize] = useState(profile ? !!profile.apply_categorization : true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const fieldPrefix = useId()

  const save = async () => {
    setSaving(true); setError('')
    const body = { name: name.trim(), account_id: accountId || null, filename_pattern: pattern.trim(), apply_categorization: categorize }
    try {
      if (profile) await api.updateAmazonProfile(profile.id, body)
      else await api.createAmazonProfile(body)
      await onSaved()
      onClose()
    } catch (e) {
      setError(e?.message || 'Could not save this source.')
    } finally { setSaving(false) }
  }

  return (
    <AppDialog
      title={profile ? 'Edit Amazon source' : 'Add Amazon source'}
      onClose={onClose}
      width="min(520px, 100%)"
      actions={(
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
          {/* The account is required, not optional: a source saved without one takes no file — its
              watched folder parks every export it finds, with no sign here that it would. */}
          <Button onClick={save} disabled={saving || !name.trim() || !accountId}>{saving ? 'Saving…' : 'Save'}</Button>
        </>
      )}
    >
      <div style={{ display: 'grid', gap: 14 }}>
        <div style={{ display: 'grid', gap: 4, fontSize: 13 }}>
          <label htmlFor={`${fieldPrefix}-name`}>Name</label>
          <Input id={`${fieldPrefix}-name`} value={name} onChange={setName} placeholder="Amazon — household" />
        </div>
        <div style={{ display: 'grid', gap: 4, fontSize: 13 }}>
          <label htmlFor={`${fieldPrefix}-account`}>Import into account</label>
          {/* The same picker the import form shows, so a source can be set up before the account it
              imports into exists — which is the order it happens in the first time. */}
          <AmazonAccountPicker
            id={`${fieldPrefix}-account`}
            accounts={accounts}
            value={accountId}
            onChange={setAccountId}
            onCreated={onAccountCreated}
            onError={setError}
          />
        </div>
        <div style={{ display: 'grid', gap: 4, fontSize: 13 }}>
          <label htmlFor={`${fieldPrefix}-pattern`}>Filename contains</label>
          <Input id={`${fieldPrefix}-pattern`} value={pattern} onChange={setPattern} placeholder="optional" />
          <span style={{ fontSize: 11, color: 'var(--muted)' }}>
            Selects this source when a matching file is dropped, and limits which files are taken from a
            shared folder. Leave empty to take every Amazon export in the folder.
          </span>
        </div>
        <Toggle checked={categorize} onChange={setCategorize} label="Apply my rules to imported orders" />
        {error ? <div style={{ color: 'var(--danger)', fontSize: 12 }}>{error}</div> : null}
      </div>
    </AppDialog>
  )
}

export default function AmazonSourcesSection({ batches = [] }) {
  const [profiles, setProfiles] = useState([])
  const [accounts, setAccounts] = useState([])
  const [editing, setEditing] = useState(null)      // { profile } | { profile: null } for a new one
  const [watchProfile, setWatchProfile] = useState(null)
  const [pendingDelete, setPendingDelete] = useState(null)
  // Naming a server folder needs an admin once sign-in protection is on; assumed allowed until the
  // status says otherwise, as the CSV manager does, so an admin never sees the refusal flash past.
  const [canSetWatchFolder, setCanSetWatchFolder] = useState(true)

  const load = useCallback(async () => {
    const [profileResult, accountList] = await Promise.all([
      api.getAmazonProfiles().catch(() => ({ profiles: [] })),
      api.getAccounts({ include_children: true }).catch(() => []),
    ])
    setProfiles(profileResult?.profiles || [])
    setAccounts((accountList || []).filter(a => (a.type || '').toLowerCase() === 'amazon'))
  }, [])
  useEffect(() => { load() }, [load])
  useEffect(() => {
    api.getAuthStatus()
      .then(status => setCanSetWatchFolder(!status?.auth_enabled || status?.user?.role === 'admin'))
      .catch(() => { })
  }, [])

  const amazonBatches = batches.filter(b => b.source_kind === 'marketplace:amazon')
  const lastUsed = amazonBatches.map(b => b.imported_at || '').sort().pop() || ''
  // Per-source counts come from the cards' own `profile_id`; cards imported before this source existed
  // (or by a drop that named none) are counted on the vendor line instead of being attributed to one.
  const countFor = id => amazonBatches.filter(b => b.profile_id === id).length

  return (
    <>
      <div style={ROW_GRID}>
        <div>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 500 }}>
            Amazon
            <FeatureExplainer topic="amazon-import" placement="bottom-left" />
          </div>
          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
            Order history exported by the AZAD browser extension
          </div>
        </div>
        <div style={{ display: 'grid', gap: 2 }}>
          <span style={labelStyle}>Last used</span>
          <span style={cellValueStyle}>{formatTimestamp(lastUsed) || 'Never used'}</span>
        </div>
        <div style={{ display: 'grid', gap: 2 }}>
          <span style={labelStyle}>Imported</span>
          <span style={cellValueStyle}>
            {amazonBatches.length} {amazonBatches.length === 1 ? 'file' : 'files'}
          </span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Button size="compact" variant="quiet" onClick={() => setEditing({ profile: null })}>
            + New Amazon source
          </Button>
        </div>
      </div>

      {profiles.map(profile => (
        <div key={profile.id} style={{ ...ROW_GRID, paddingLeft: 40 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 500, ...TRUNCATED_CELL_STYLE }} title={profile.name}>{profile.name}</div>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2, ...TRUNCATED_CELL_STYLE }}>
              {profile.account_name || 'No account set'}
              {profile.filename_pattern ? ` · files containing “${profile.filename_pattern}”` : ''}
            </div>
          </div>
          <div style={{ display: 'grid', gap: 2, minWidth: 0 }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={labelStyle}>Watched folder</span>
              {profile.watch_dir && !profile.watch_enabled ? <WatchPausedPill /> : null}
            </span>
            <span style={{ ...cellValueStyle, ...TRUNCATED_CELL_STYLE }}
              title={profile.watch_notice || folderSummary(profile)}>
              {folderSummary(profile)}
            </span>
          </div>
          <div style={{ display: 'grid', gap: 2 }}>
            <span style={labelStyle}>Imported</span>
            <span style={cellValueStyle}>
              {countFor(profile.id)} {countFor(profile.id) === 1 ? 'file' : 'files'}
            </span>
          </div>
          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', alignItems: 'center' }}>
            <Button size="compact" variant="quiet" onClick={() => setWatchProfile(profile)}>Folder</Button>
            <Button size="compact" variant="quiet" onClick={() => setEditing({ profile })}>Edit</Button>
            <IconButton tone="danger" onClick={() => setPendingDelete(profile)} aria-label={`Delete ${profile.name}`}>
              ×
            </IconButton>
          </div>
        </div>
      ))}

      {editing ? (
        <AmazonSourceEditor profile={editing.profile} accounts={accounts} onClose={() => setEditing(null)}
          onSaved={load} onAccountCreated={load} />
      ) : null}
      {watchProfile ? (
        <WatchedFolderDialog profile={watchProfile} canEdit={canSetWatchFolder}
          onClose={() => setWatchProfile(null)} onSaved={load} />
      ) : null}
      {pendingDelete ? (
        <AppConfirmDialog
          title={`Delete “${pendingDelete.name}”?`}
          // Said plainly because the reverse is what a reader fears: a data source is settings, and the
          // cards and transactions its imports produced are not part of it.
          description="The files it has imported stay in the import history, and so do their transactions. Only the saved settings and its watched folder are removed."
          confirmLabel="Delete"
          confirmVariant="danger"
          onCancel={() => setPendingDelete(null)}
          onConfirm={async () => {
            await api.deleteAmazonProfile(pendingDelete.id).catch(() => { })
            setPendingDelete(null)
            await load()
          }}
        />
      ) : null}
    </>
  )
}
