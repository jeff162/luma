// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef, useState } from 'react'
import { api } from '../../lib/api.js'
import { Button, EmptyState, Spinner } from '../ui.jsx'

// Walking the folders on the machine running the app, to fill in a watched folder's path.
//
// It browses the *server's* filesystem through an endpoint, not the viewer's through the browser. The
// browser's own directory pickers (`webkitdirectory`, `showDirectoryPicker`) choose on the machine the
// page is open on and hand back relative names, so neither can produce the absolute server path this
// field means — and there is no native dialog to fall back on either, since even the desktop build
// serves itself to the system browser rather than running in a shell of its own.
//
// It is an inline panel rather than a dialog because it is opened from inside one, and a dialog over a
// dialog is the thing that reliably goes wrong.
//
// **There is one path, and it lives in the caller's field.** The picker is *controlled*: navigating
// writes the folder into that field and the field is what the picker lists. An earlier version kept a
// current-path readout of its own beside the field, and the two together were the whole problem — with
// the live path somewhere other than the field, the field read as a leftover and nothing suggested it
// could be typed into. Watching it fill in as folders are clicked is what says it can.

const rowStyle = {
  display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
  padding: '5px 8px', borderRadius: 6, border: '1px solid transparent', background: 'none',
  color: 'var(--text)', fontSize: 13, cursor: 'pointer',
}

// Fixed, not a maximum: a list sized to its contents re-laid the dialog out on every click, which moved
// the next folder out from under the pointer. `scrollbar-gutter` keeps the names still when a short
// folder follows a long one. Matches the height the list settled at in use.
const LIST_HEIGHT = 220

// A typed path re-lists, so the listing waits for the typing to stop. Long enough not to fire per
// keystroke, short enough that a pasted path lists before anyone reaches for a button.
const TYPING_SETTLE_MS = 400

const mutedLineStyle = { fontSize: 13, color: 'var(--muted)', padding: '4px 2px' }

// `EmptyState` centres its message horizontally and owns the muted type; this centres it in the
// reserved height as well, so the region does not read as a list that starts blank at the top.
function CentredEmptyState({ message }) {
  return (
    <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <EmptyState message={message} />
    </div>
  )
}

export default function ServerFolderPicker({ path, profileId, onPathChange, onDone, onCancel }) {
  const [listing, setListing] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [showHidden, setShowHidden] = useState(false)
  // Which request's answer is still wanted: typing produces overlapping listings, and the last one
  // asked for is the one the panel is showing, whatever order they come back in.
  const requestToken = useRef(0)

  const trimmed = (path || '').trim()
  useEffect(() => {
    const token = ++requestToken.current
    if (!trimmed) {
      setListing(null); setError(''); setLoading(false)
      return undefined
    }
    setLoading(true)
    const timer = setTimeout(() => {
      api.browseServerDirectories(trimmed, profileId)
        .then(result => {
          if (requestToken.current !== token) return
          setListing(result); setError('')
        })
        .catch(e => {
          if (requestToken.current !== token) return
          setError(e?.message || 'This folder could not be read.'); setListing(null)
        })
        .finally(() => { if (requestToken.current === token) setLoading(false) })
    }, TYPING_SETTLE_MS)
    return () => clearTimeout(timer)
  }, [trimmed, profileId])

  // Roots survive a listing that failed, so the way out of a bad path is still on screen.
  const [roots, setRoots] = useState([])
  useEffect(() => {
    api.browseServerDirectories('').then(r => setRoots(r?.roots || [])).catch(() => { })
  }, [])

  const entries = (listing?.entries || []).filter(entry => showHidden || !entry.hidden)
  const hiddenCount = (listing?.entries || []).length - entries.length
  // The files this folder would import for this source. *Which* files that is belongs to the server,
  // which filters on the same table the scan does — this only renders what it is handed.
  const files = listing?.files || []
  const fileCount = Number(listing?.file_count || 0)
  const nothingHere = entries.length === 0 && files.length === 0

  return (
    <div style={{
      display: 'grid', gap: 8, padding: 10, borderRadius: 8,
      border: '1px solid var(--border)', background: 'var(--surface2)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>Start in:</span>
        <Button variant="secondary" onClick={() => onPathChange(listing?.parent || '')}
          disabled={loading || !listing?.parent}>↑ Up</Button>
        {roots.map(root => (
          <Button key={root.path} variant="secondary" onClick={() => onPathChange(root.path)}>
            {root.label}
          </Button>
        ))}
      </div>

      {/* The height is reserved whether or not there is anything to put in it, so picking the first
          starting place does not grow the dialog under the pointer. What varies is only whether the
          region is *drawn*: with no path it has no border and no fill, because a bordered, filled box
          holding a line of text is indistinguishable from the text field above it. */}
      <div style={{
        height: LIST_HEIGHT, overflowY: 'auto', scrollbarGutter: 'stable', borderRadius: 6,
        ...(trimmed
          ? { border: '1px solid var(--border)', background: 'var(--surface)' }
          : { border: '1px solid transparent', background: 'none' }),
      }}>
        {!trimmed ? (
          // Instruction rather than a report of emptiness — and the only thing that says the field
          // above can be typed into.
          <CentredEmptyState message="Pick a starting place, or type a path above." />
        ) : (
          <>
          {loading ? (
            <div style={{ padding: 12 }}><Spinner /></div>
          ) : error ? (
            <div style={mutedLineStyle}>{error}</div>
          ) : listing?.notice ? (
            <div style={mutedLineStyle}>{listing.notice}</div>
          ) : nothingHere ? (
            // A bare region would read equally as "still loading" and "failed"; one faint word says
            // which it is without making a sentence of nothing.
            <CentredEmptyState message={<em>empty</em>} />
          ) : (
            <>
              {entries.map(entry => (
                <button
                  key={entry.path}
                  type="button"
                  style={{ ...rowStyle, opacity: entry.hidden ? 0.7 : 1 }}
                  onClick={() => onPathChange(entry.path)}
                  onMouseEnter={e => { e.currentTarget.style.background = 'var(--surface2)' }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'none' }}
                >
                  <span aria-hidden="true">📁</span>
                  <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {entry.name}
                  </span>
                </button>
              ))}
              {/* The files are there to be read, not chosen: a folder is picked, never a file. So they
                  are plain rows under the folders rather than buttons — nothing to focus, nothing that
                  looks clickable and then is not. */}
              {files.map(file => (
                <div key={file.name} style={{ ...rowStyle, cursor: 'default', color: 'var(--muted)' }}>
                  <span aria-hidden="true">📄</span>
                  <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {file.name}
                  </span>
                </div>
              ))}
            </>
          )}
          </>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {/* What makes the choice answerable without leaving the picker: the folder is the right one
            because the exports are in it, which the path alone does not say. */}
        {/* The files sort below the folders, so in a folder with many subfolders they are under the
            fold — the count answers at a glance what the list answers on scrolling. Worded without
            naming a format, since which formats count is the server's to say and is expected to grow. */}
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>
          {trimmed && !loading && !error && !listing?.notice
            ? (fileCount > 0
              ? `${fileCount} importable ${fileCount === 1 ? 'file' : 'files'} in this folder`
              : 'No importable files in this folder')
            : ''}
          {listing?.truncated ? ' · too many to list them all — type the path instead' : ''}
        </span>
        {hiddenCount > 0 ? (
          <Button variant="secondary" onClick={() => setShowHidden(true)}>Show {hiddenCount} hidden</Button>
        ) : null}
        <span style={{ flex: 1 }} />
        {/* The dialog has a Cancel of its own, so these say which one they are to anyone who cannot
            see that they sit inside the picker. */}
        <Button variant="secondary" onClick={onCancel} aria-label="Cancel choosing a folder">Cancel</Button>
        <Button onClick={onDone} aria-label="Done choosing a folder">Done</Button>
      </div>
    </div>
  )
}
