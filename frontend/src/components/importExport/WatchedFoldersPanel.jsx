// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../../lib/api.js'
import { formatTimestamp } from '../../lib/utils.js'
import { Button, Card } from '../ui.jsx'
import FeatureExplainer from '../../help/FeatureExplainer.jsx'

// What the watched folders are doing, and what they could not take on their own.
//
// The panel is the only surface an unattended import needs beyond the ones that already exist: a file
// it took produced an ordinary import card in the history below, with every review it carries. What it
// *refused* has nowhere else to appear, so that is what this lists — one row per file, each answered
// the same way, by opening it in the import flow that can ask the questions the scan could not.
//
// Entering the page runs the watermark-gated scan rather than an unconditional one, so arriving here
// twice in a minute costs one directory listing rather than two. **Check now** is the unconditional
// form, for the case the cadence does not cover: the file was downloaded thirty seconds ago.

const STATE_LABELS = {
  parked: 'Needs a look',
  error: 'Import failed',
  purge_failed: 'Not deleted',
  duplicate: 'Already imported',
  imported: 'Imported',
  dismissed: 'Put away',
}

export default function WatchedFoldersPanel({ onOpenFile, onImported }) {
  const [status, setStatus] = useState(null)
  const [scanning, setScanning] = useState(false)
  const [opening, setOpening] = useState('')

  const refresh = useCallback(() => api.getWatchStatus().then(setStatus).catch(() => { }), [])

  // The scan below must run once per mount, and a host is free to pass a fresh arrow on every render —
  // holding the callback in a ref keeps that a rendering detail rather than a re-scan trigger.
  const onImportedRef = useRef(onImported)
  onImportedRef.current = onImported

  useEffect(() => {
    // The page-entry trigger. A no-op when a scan already ran within the hour, which is what makes it
    // safe to fire on every visit; the status read that follows costs nothing either way.
    let live = true
    api.autoScanWatchedFolders()
      .then(result => { if (live && result?.sources?.some(source => source.imported)) onImportedRef.current?.() })
      .catch(() => { })
      .finally(() => { if (live) refresh() })
    return () => { live = false }
  }, [refresh])

  async function checkNow() {
    setScanning(true)
    try {
      const result = await api.scanWatchedFolders()
      if (result?.sources?.some(source => source.imported)) onImported?.()
    } catch { /* the status below is the report; a failed scan leaves the last one on screen */ }
    await refresh()
    setScanning(false)
  }

  async function openInImportFlow(file) {
    setOpening(file.id)
    try {
      const text = await api.getWatchedFileText(file.id)
      await onOpenFile?.(new File([text], file.filename, { type: 'text/csv' }), file.profile_id)
    } finally {
      setOpening('')
    }
  }

  async function dismiss(file) {
    await api.dismissWatchedFile(file.id).catch(() => { })
    await refresh()
  }

  const sources = (status?.sources || []).filter(source => source.watch_dir)
  if (!sources.length) return null

  const waiting = (status?.files || []).filter(
    file => file.state === 'parked' || file.state === 'error' || file.state === 'purge_failed',
  )

  return (
    <Card style={{ padding: 16, display: 'grid', gap: 12, marginBottom: 20 }}>
      {/* The action sits against the title rather than against the card's far edge: pushed right by a
          `space-between`, it read as belonging to the page instead of to this panel. Beside the heading
          rather than under the source list, because that list grows and shrinks with the number of
          watched folders and a control anchored below it would move every time one is added. */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 15, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            Watched folders
            <FeatureExplainer topic="watched-folders" placement="bottom-left" />
          </span>
          <button
            type="button"
            onClick={checkNow}
            disabled={scanning}
            style={{
              background: 'none', border: '1px solid var(--border)', borderRadius: 999,
              color: 'var(--muted)', cursor: scanning ? 'default' : 'pointer',
              fontSize: 12, padding: '2px 10px', opacity: scanning ? 0.6 : 1,
            }}
          >
            {scanning ? 'Checking…' : 'Check now'}
          </button>
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
          {status?.last_scan_at ? `Last checked ${formatTimestamp(status.last_scan_at)}` : 'Not checked yet'}
        </div>
      </div>

      <div style={{ display: 'grid', gap: 4 }}>
        {sources.map(source => (
          <div key={source.id} style={{ fontSize: 12, color: 'var(--muted)', wordBreak: 'break-all' }}>
            <span style={{ color: 'var(--text)' }}>{source.name}</span>
            {' — '}
            {source.watch_enabled ? source.watch_dir : `${source.watch_dir} (paused)`}
            {source.watch_notice ? <span style={{ color: 'var(--danger)' }}> · {source.watch_notice}</span> : null}
          </div>
        ))}
      </div>

      {waiting.length ? (
        <div style={{ display: 'grid', gap: 8 }}>
          <div style={{ fontSize: 12, fontWeight: 600 }}>
            {/* "Waiting", not "available": the count also carries a file that errored and one whose
                post-import delete failed, neither of which can be imported. Each row states its own
                state and reason, so the heading only has to be a true count. */}
            {waiting.length} {waiting.length === 1 ? 'file' : 'files'} waiting
          </div>
          {waiting.map(file => (
            <div
              key={file.id}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                gap: 12, flexWrap: 'wrap',
                border: '1px solid var(--border)', borderRadius: 8, padding: '8px 10px',
                background: 'var(--surface2)',
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13, wordBreak: 'break-all' }}>{file.filename}</div>
                <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
                  {STATE_LABELS[file.state] || file.state}{file.reason ? ` · ${file.reason}` : ''}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                {file.state === 'purge_failed' ? null : (
                  <Button small onClick={() => openInImportFlow(file)} disabled={opening === file.id}>
                    {opening === file.id ? 'Opening…' : 'Import…'}
                  </Button>
                )}
                <Button variant="ghost" small onClick={() => dismiss(file)}>Dismiss</Button>
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </Card>
  )
}
