// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { api } from '../../lib/api.js'
import { formatTimestamp } from '../../lib/utils.js'
import { Button, Card } from '../ui.jsx'
import FeatureExplainer from '../../help/FeatureExplainer.jsx'
import WatchPausedPill from './WatchPausedPill.jsx'
import RestoredFolderDecision from './RestoredFolderDecision.jsx'

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
//
// **Why the list is behind a disclosure, below the two ways data arrives.** This card reports work
// already waiting rather than another thing to start, which first put it above the file importer — but
// its height is the number of refused files, so several of them pushed the importer and the connections
// card off the top of the page. The card now follows them at full page width, and only the roll-call
// collapses: the count and anything a folder is complaining about stay on the visible line, the shape
// `DataConnectionsPanel` uses for the same problem.

const STATE_LABELS = {
  parked: 'Needs a look',
  error: 'Import failed',
  purge_failed: 'Not deleted',
  duplicate: 'Already imported',
  imported: 'Imported',
  dismissed: 'Put away',
}

// About eight one-line rows. The list scrolls past that rather than growing, because what it would push
// down is the import history — the record of everything that *did* arrive. A row whose reason wraps is
// taller, so this is a height and not a row count; the cap is deliberately generous since the card is
// opened to work through the files.
const WAITING_LIST_MAX_HEIGHT = 420
// Fixed, not `auto`: each row is its own grid, so an `auto` end track puts a row offering only
// **Dismiss** out of line with every row that also offers **Import…**.
const WAITING_ROW_ACTIONS_WIDTH = 164

// `onSourcesChanged` runs when a data source changed under the panel, so a host holding its own copy of the
// sources, as the import page does for the Data sources tab, can reload it: after a restored folder is
// answered here, and after a scan that changed a folder's notice (each scan rewrites them). A scan that
// changed none asks for nothing. The first scan after mounting has nothing to compare with, so it asks.
export default function WatchedFoldersPanel({ onOpenFile, onImported, onSourcesChanged }) {
  const [status, setStatus] = useState(null)
  const [scanning, setScanning] = useState(false)
  const [opening, setOpening] = useState('')
  // `null` means "follow the count": the card opens itself when something is waiting and stays shut when
  // nothing is, without a first visit having to be told. A click is an answer about this visit and holds
  // against a later refresh that changes the count.
  const [listOpen, setListOpen] = useState(null)

  const onSourcesChangedRef = useRef(onSourcesChanged)
  onSourcesChangedRef.current = onSourcesChanged
  const noticesRef = useRef(null)
  const refresh = useCallback(async ({ scanned = false } = {}) => {
    const next = await api.getWatchStatus().catch(() => null)
    if (!next) return
    setStatus(next)
    const notices = JSON.stringify((next.sources || []).map(source => [source.id, source.watch_notice || null]))
    if (scanned && notices !== noticesRef.current) onSourcesChangedRef.current?.()
    noticesRef.current = notices
  }, [])

  // The notice lines' buttons sit in a column just past the longest line. The column only widens while
  // the panel is mounted: answering one restored folder removes its line, and if that was the longest a
  // plain `max-content` track would pull every remaining button out from under the pointer. Read back
  // from the resolved track rather than measured from the text, so the browser's own sizing decides it.
  const noticeGridRef = useRef(null)
  const [noticeTextWidth, setNoticeTextWidth] = useState(0)
  useLayoutEffect(() => {
    const grid = noticeGridRef.current
    if (!grid) return
    const resolved = parseFloat(getComputedStyle(grid).gridTemplateColumns)
    if (Number.isFinite(resolved) && resolved > noticeTextWidth) setNoticeTextWidth(Math.ceil(resolved))
  }, [status, noticeTextWidth])

  // The scan below must run once per mount, and a host is free to pass a fresh arrow on every render —
  // holding the callback in a ref keeps that a rendering detail rather than a re-scan trigger.
  const onImportedRef = useRef(onImported)
  onImportedRef.current = onImported

  useEffect(() => {
    // The page-entry trigger. A no-op when a scan already ran within the hour, which is what makes it
    // safe to fire on every visit; the status read that follows costs nothing either way.
    let live = true
    let scanned = false
    api.autoScanWatchedFolders()
      .then(result => {
        scanned = !result?.skipped
        if (live && result?.sources?.some(source => source.imported)) onImportedRef.current?.()
      })
      .catch(() => { })
      .finally(() => { if (live) refresh({ scanned }) })
    return () => { live = false }
  }, [refresh])

  async function checkNow() {
    setScanning(true)
    try {
      const result = await api.scanWatchedFolders()
      if (result?.sources?.some(source => source.imported)) onImported?.()
    } catch { /* the status below is the report; a failed scan leaves the last one on screen */ }
    await refresh({ scanned: true })
    setScanning(false)
  }

  async function openInImportFlow(file) {
    setOpening(file.id)
    try {
      const blob = await api.getWatchedFile(file.id)
      await onOpenFile?.(new File([blob], file.filename, { type: blob.type }), file.profile_id)
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
  const open = listOpen ?? waiting.length > 0
  const noticed = sources.filter(source => source.watch_notice)

  return (
    <Card style={{ padding: 16, display: 'grid', gap: 10, marginBottom: 20 }}>
      {/* The action sits against the title rather than against the card's far edge: pushed right by a
          `space-between`, it read as belonging to the page instead of to this panel. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 15, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          Watched folders
          <FeatureExplainer topic="watched-folders" placement="bottom-left" />
        </span>
        <Button size="compact" variant="secondary" onClick={checkNow} disabled={scanning}>
          {scanning ? 'Checking…' : 'Check now'}
        </Button>
        <span style={{ fontSize: 12, color: 'var(--muted)', marginLeft: 'auto' }}>
          {status?.last_scan_at ? `Last checked ${formatTimestamp(status.last_scan_at)}` : 'Not checked yet'}
        </span>
      </div>

      {/* The disclosure names what is inside it, so the count is readable with the card shut. The file
          rows each state their own state and reason, which is why this only has to be a true count —
          "waiting", not "available", since it also carries a file that errored and one whose
          post-import delete failed, neither of which can be imported. */}
      <button
        type="button"
        onClick={() => setListOpen(!open)}
        aria-expanded={open}
        title={open ? 'Hide the watched folders and the files waiting' : 'Show the watched folders and the files waiting'}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6, justifySelf: 'start',
          background: 'none', border: 'none', padding: 0, cursor: 'pointer',
          font: 'inherit', fontSize: 12, fontWeight: 600, color: 'var(--text)',
        }}
      >
        <span aria-hidden style={{ fontSize: 10, color: 'var(--muted)' }}>{open ? '▾' : '▸'}</span>
        <span>
          {waiting.length
            ? `${waiting.length} ${waiting.length === 1 ? 'file' : 'files'} waiting`
            : 'No files waiting'}
        </span>
      </button>

      {/* A folder that cannot be read is asking for something, so it never collapses: the roll-call
          below is the routine half, and this is the half that would otherwise be hidden behind a
          disclosure nobody opened. */}
      {noticed.length ? (
        <div ref={noticeGridRef} style={{
          display: 'grid', alignItems: 'center', columnGap: 8, rowGap: 6, fontSize: 12, color: 'var(--muted)',
          // Capped below the card's width so a narrow window wraps the text rather than pushing the
          // buttons out of the card.
          gridTemplateColumns: `minmax(min(${noticeTextWidth}px, 70%), max-content) auto`,
        }}>
          {noticed.map(source => (
            <Fragment key={source.id}>
              <span>
                <span style={{ color: 'var(--text)' }}>{source.name}</span>
                {' — '}
                <span style={{ color: 'var(--danger)' }}>{source.watch_notice}</span>
              </span>
              <span><RestoredFolderDecision profile={source}
                onSettled={() => Promise.all([refresh(), onSourcesChanged?.()])} /></span>
            </Fragment>
          ))}
        </div>
      ) : null}

      {open ? (
        <div style={{ display: 'grid', gap: 8 }}>
          {waiting.length ? (
            <div style={{
              display: 'grid', gap: 8,
              maxHeight: WAITING_LIST_MAX_HEIGHT, overflowY: 'auto',
            }}>
              {waiting.map(file => (
                <div
                  key={file.id}
                  style={{
                    display: 'grid', gridTemplateColumns: `minmax(0, 1fr) ${WAITING_ROW_ACTIONS_WIDTH}px`,
                    alignItems: 'center', gap: 12,
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
                  <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                    {file.state === 'purge_failed' ? null : (
                      <Button onClick={() => openInImportFlow(file)} disabled={opening === file.id}>
                        {opening === file.id ? 'Opening…' : 'Import…'}
                      </Button>
                    )}
                    <Button variant="secondary" onClick={() => dismiss(file)}>Dismiss</Button>
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          {/* The folders themselves, read back rather than managed: setting one is the Folder button on
              the File Sources tab. Below the files because they are what the reader came for. */}
          <div style={{ display: 'grid', gap: 4, paddingTop: waiting.length ? 8 : 0, borderTop: waiting.length ? '1px solid var(--border)' : undefined }}>
            {sources.map(source => (
              <div key={source.id} style={{ fontSize: 12, color: 'var(--muted)', wordBreak: 'break-all' }}>
                <span style={{ color: 'var(--text)' }}>{source.name}</span>
                {source.watch_enabled ? null : <> <WatchPausedPill /></>}
                {' — '}
                {source.watch_dir}
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </Card>
  )
}
