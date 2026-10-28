// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useState } from 'react'
import { api } from '../../lib/api.js'
import { APP_NAME } from '../../lib/appConfig.js'
import { AppDialog, Button, Input, Select, Toggle } from '../ui.jsx'
import FeatureExplainer from '../../help/FeatureExplainer.jsx'
import ServerFolderPicker from './ServerFolderPicker.jsx'

// Where a data source's watched folder is set.
//
// Separate from the data-source form rather than a section inside it, because these settings save
// through their own endpoint: naming a directory is a statement about the *server's* filesystem, so it
// needs an administrator once sign-in protection is on, while the rest of a data source does not. One
// form spanning both would half-save for everyone else.
//
// The copy carries the one thing that is reliably misread — the folder is on the machine running the
// app, which is the same machine only in the desktop case — and says plainly what the purge setting
// deletes, since it is the only part of this that removes anything outside the app's own data.
//
// A server only watches folders its operator has named in WATCH_FOLDER_ROOTS. Where none are named the
// dialog says so before anything is typed, since the refusal is otherwise met only on Save; the path
// field stays editable so a folder saved earlier can still be cleared.

const PURGE_OPTIONS = [
  { value: 'never', label: 'Keep every file' },
  { value: 'after_days', label: 'Delete after a number of days' },
  { value: 'on_import', label: 'Delete as soon as it is imported' },
]

export default function WatchedFolderDialog({ profile, canEdit, onClose, onSaved }) {
  const [folder, setFolder] = useState(profile?.watch_dir || '')
  const [enabled, setEnabled] = useState(!!profile?.watch_enabled)
  const [purgeMode, setPurgeMode] = useState(profile?.watch_purge_mode || 'never')
  const [purgeDays, setPurgeDays] = useState(String(profile?.watch_purge_days ?? 30))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [browsing, setBrowsing] = useState(false)
  // What the field held when Browse was pressed. Navigating writes into the field as it goes, so
  // abandoning the browse has to put back what was there rather than leave it wherever the walk ended.
  const [folderBeforeBrowse, setFolderBeforeBrowse] = useState('')

  // Asked of the server once, through the picker's own starting listing: `false` only where this server
  // watches no folder at all.
  const [watchingEnabled, setWatchingEnabled] = useState(true)
  const [serverNotice, setServerNotice] = useState('')
  useEffect(() => {
    let live = true
    api.browseServerDirectories('', profile?.id)
      .then(result => {
        if (!live || result?.watching_enabled !== false) return
        setWatchingEnabled(false)
        setServerNotice(result.notice || '')
      })
      .catch(() => { })
    return () => { live = false }
  }, [profile?.id])

  const trimmedFolder = folder.trim()

  async function save() {
    setSaving(true)
    setError('')
    try {
      await api.updateImportProfileWatch(profile.id, {
        watch_dir: trimmedFolder,
        watch_enabled: !!trimmedFolder && enabled,
        watch_purge_mode: purgeMode,
        watch_purge_days: parseInt(purgeDays, 10) || 30,
      })
      await onSaved?.()
      onClose()
    } catch (e) {
      setError(e?.message || 'Could not save this folder.')
      setSaving(false)
    }
  }

  return (
    <AppDialog
      title={`Watched folder — ${profile?.name || ''}`}
      description="Files placed in this folder are imported without opening the import page."
      onClose={onClose}
      actions={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={save} disabled={saving || !canEdit}>{saving ? 'Saving…' : 'Save'}</Button>
        </>
      }
    >
      <div style={{ display: 'grid', gap: 14 }}>
        <div style={{ display: 'grid', gap: 6 }}>
          <label htmlFor="watch-folder-path" style={{ fontSize: 12, color: 'var(--muted)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            Folder
            <FeatureExplainer topic="watched-folders" placement="bottom-left" />
          </label>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Input
              id="watch-folder-path"
              value={folder}
              onChange={setFolder}
              placeholder="/home/me/statements"
              aria-label="Watched folder path"
              disabled={!canEdit}
              style={{ flex: 1, minWidth: 0 }}
            />
            {/* Typing stays the primary control: a share the picker cannot walk to, or a path already
                in hand, should not have to come through it. */}
            <Button
              variant="secondary"
              onClick={() => { setFolderBeforeBrowse(folder); setBrowsing(true) }}
              disabled={!canEdit || browsing || !watchingEnabled}
            >
              Browse&hellip;
            </Button>
          </div>
          {browsing ? (
            <ServerFolderPicker
              path={folder}
              profileId={profile?.id}
              onPathChange={setFolder}
              onDone={() => setBrowsing(false)}
              onCancel={() => { setFolder(folderBeforeBrowse); setBrowsing(false) }}
            />
          ) : null}
          {serverNotice ? (
            <div style={{ fontSize: 12, color: 'var(--danger)', lineHeight: 1.5 }}>{serverNotice}</div>
          ) : null}
          <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>
            The folder is read on the machine running {APP_NAME}, which is not necessarily the machine
            this page is open on &mdash; <strong>Browse</strong> shows that machine&apos;s folders, not
            this one&apos;s. Leave it empty to stop watching altogether.
          </div>
        </div>

        <Toggle
          checked={!!trimmedFolder && enabled}
          onChange={setEnabled}
          disabled={!canEdit || !trimmedFolder}
          label="Import files from this folder"
          ariaLabel="Import files from this folder"
        />

        <div style={{ display: 'grid', gap: 6 }}>
          <label htmlFor="watch-purge-mode" style={{ fontSize: 12, color: 'var(--muted)' }}>Once a file is imported</label>
          <Select
            id="watch-purge-mode"
            value={purgeMode}
            onChange={setPurgeMode}
            options={PURGE_OPTIONS}
            disabled={!canEdit}
          />
          {purgeMode === 'after_days' ? (
            <Input
              value={purgeDays}
              onChange={setPurgeDays}
              type="number"
              min={1}
              aria-label="Days to keep an imported file"
              style={{ maxWidth: 140 }}
              disabled={!canEdit}
            />
          ) : null}
          {purgeMode !== 'never' ? (
            <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>
              Only a file whose contents still match what was imported from it is deleted, so a file
              replaced under the same name is left alone. A file that cannot be deleted is reported
              rather than passed over.
            </div>
          ) : null}
        </div>

        {!canEdit ? (
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>
            Choosing a folder on the server needs an admin.
          </div>
        ) : null}
        {error ? <div style={{ fontSize: 12, color: 'var(--danger)' }}>{error}</div> : null}
      </div>
    </AppDialog>
  )
}
