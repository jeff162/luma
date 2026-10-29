// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * The backup history's entries, as the Backup / Restore page lists them and as the Settings trash lists
 * the ones moved there.
 *
 * One entry per backup, newest first, on two lines so it fits the card at any width: when, who and how
 * big, then the file and what it holds. The documents share is the figure that says whether documents are
 * becoming the bulk of a backup. A filename too long for the card is cut short with the whole of it on
 * hover; the details after it wrap rather than push it out.
 *
 * Where the backup was a plain download, the server recorded it before the browser saved it and cannot see
 * the save, so an entry can name a file that was never kept, or kept under another name (a second backup on
 * one day is usually saved as `… (1).zip`). The `⋯` menu corrects the one and trashes the other.
 */

import { useState } from 'react'
import { ActionMenu, ActionMenuButton } from '../ActionMenu.jsx'
import TransientTextInput from '../TransientTextInput.jsx'
import { formatTimestamp } from '../../lib/utils.js'
import { formatBytes } from '../../lib/storageFormat.js'

const MUTED = { fontSize: 12, color: 'var(--muted)' }

function entryDetails(row) {
  const parts = (row.ledger_bytes || 0) + (row.accounts_bytes || 0) + (row.documents_bytes || 0)
  const percent = parts && row.documents_bytes ? (row.documents_bytes / parts) * 100 : 0
  const share = !percent ? '' : percent < 1 ? '<1%' : `~${Math.min(100, Math.round(percent))}%`
  return [
    row.document_count == null ? null
      : row.document_count === 0 ? 'no documents'
        : `documents ${formatBytes(row.documents_bytes)}${share ? ` (${share})` : ''}`,
    row.encrypted == null ? null
      : !row.encrypted ? 'unencrypted'
        : row.key_labels?.length ? `encryption keys: ${row.key_labels.join(', ')}` : 'encrypted',
    row.restored_at ? `this system was built from this on ${formatTimestamp(row.restored_at)}` : null,
  ].filter(Boolean)
}

// One entry. `filename` replaces the filename's place on the second line (the editor, while editing), and
// `actions` sits at the entry's right.
export function BackupHistoryEntry({ row, first = false, filename, actions }) {
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 12, alignItems: 'center',
      padding: '8px 0', fontSize: 13, borderTop: first ? 'none' : '1px solid var(--border)',
    }}>
      <div style={{ display: 'grid', gap: 2, minWidth: 0 }}>
        <div>
          <strong style={{ fontWeight: 600 }}>{formatTimestamp(row.made_at) || 'Unknown date'}</strong>
          {row.made_by ? ` · ${row.made_by}` : ''}
          {row.total_bytes != null ? ` · ${formatBytes(row.total_bytes)}` : ''}
        </div>
        <div style={{ ...MUTED, display: 'flex', flexWrap: 'wrap', columnGap: 6, minWidth: 0 }}>
          {filename ?? (row.filename ? (
            <span title={row.filename} style={{ maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {row.filename}
            </span>
          ) : null)}
          {entryDetails(row).map(detail => <span key={detail}>· {detail}</span>)}
          {/* Only when there were credentials to carry and they were held back. */}
          {row.credentials_left_out
            ? <span style={{ color: 'var(--warning, #d97706)' }}>· credentials omitted</span>
            : null}
        </div>
      </div>
      {actions ?? <span />}
    </div>
  )
}

// The live history. `onRename(id, filename)` and `onTrash(id)` report to the host, which saves and
// reloads; a rejected rename keeps the editor open with what was typed.
export function BackupHistoryList({ rows, onRename, onTrash }) {
  const [menu, setMenu] = useState(null)
  const [editing, setEditing] = useState(null)

  async function commit() {
    const name = editing.draft.trim()
    const row = rows.find(r => r.id === editing.id)
    if (!name || name === row?.filename) {
      setEditing(null)
      return
    }
    try {
      await onRename(editing.id, name)
      setEditing(null)
    } catch {
      // The host shows the error; the draft stays for another try.
    }
  }

  return (
    <div style={{ display: 'grid' }}>
      {rows.map((row, index) => (
        <BackupHistoryEntry
          key={row.id}
          row={row}
          first={index === 0}
          filename={editing?.id === row.id ? (
            <TransientTextInput
              aria-label="Filename"
              value={editing.draft}
              onChange={draft => setEditing(prev => ({ ...prev, draft }))}
              onCommit={commit}
              onCancel={() => setEditing(null)}
              restoreOnEscape
              style={{
                flex: '1 1 260px', minWidth: 0, fontSize: 12, padding: '2px 6px', borderRadius: 4,
                border: '1px solid var(--accent)', background: 'var(--surface)', color: 'var(--text)',
              }}
            />
          ) : undefined}
          actions={(
            <ActionMenuButton
              open={menu?.row.id === row.id}
              title="Actions for this backup"
              onOpen={anchorElement => setMenu({ row, anchorElement })}
            />
          )}
        />
      ))}
      {menu ? (
        <ActionMenu
          anchorElement={menu.anchorElement}
          onClose={() => setMenu(null)}
          items={[
            { label: 'Edit filename', onClick: () => setEditing({ id: menu.row.id, draft: menu.row.filename || '' }) },
            { label: 'Move to trash', onClick: () => onTrash(menu.row.id) },
          ]}
        />
      ) : null}
    </div>
  )
}
