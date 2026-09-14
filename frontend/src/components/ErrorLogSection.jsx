// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * Settings -> Error log: the errors the server recorded in its log file (`backend/app_log_file.py`), newest
 * first.
 *
 * Read when the section opens and on refresh rather than polled, because it is consulted after something
 * went wrong rather than watched. The reading lives in `lib/useErrorLog.js` rather than here, because
 * Settings owns the section's title and a refresh sits beside the title of what it reloads. Each entry is
 * one line, with its traceback folded behind a native disclosure: the message says what failed, and the
 * traceback is for whoever is asked to look into it.
 * The file's location is stated because the file holds more than this list does — warnings, and the
 * failed requests around an error — and it is what someone would be asked to send.
 */

import { formatTimestamp } from '../lib/utils.js'

export default function ErrorLogSection({ log, error }) {
  const entries = log?.entries || []
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        {log?.path ? (
          <span style={{ fontSize: 12, color: 'var(--muted)', overflowWrap: 'anywhere' }}>
            Log file: <code>{log.path}</code>
          </span>
        ) : null}
      </div>

      {error ? <div role="alert" style={{ fontSize: 13, color: 'var(--danger)' }}>{error}</div> : null}

      {log && !entries.length ? (
        <div style={{ fontSize: 13, color: 'var(--muted)' }}>No errors have been recorded.</div>
      ) : null}

      {entries.map((entry, index) => (
        <div
          key={`${entry.time}-${index}`}
          style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '8px 10px', background: 'var(--surface)' }}
        >
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>{formatTimestamp(entry.time)} · {entry.logger}</div>
          <div style={{ fontSize: 13, marginTop: 2, overflowWrap: 'anywhere' }}>{entry.message}</div>
          {entry.detail ? (
            <details style={{ marginTop: 4 }}>
              <summary style={{ fontSize: 12, color: 'var(--accent2)', cursor: 'pointer' }}>Details</summary>
              <pre style={{ fontSize: 11.5, margin: '6px 0 0', overflowX: 'auto', whiteSpace: 'pre' }}>{entry.detail}</pre>
            </details>
          ) : null}
          {/* The server cuts an enormous record before sending it; the file still holds all of it. */}
          {entry.truncated ? (
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
              Cut short here. The full text is in the log file.
            </div>
          ) : null}
        </div>
      ))}

      {log && log.total > entries.length ? (
        <div style={{ fontSize: 12, color: 'var(--muted)' }}>
          Showing the {entries.length} most recent of {log.total}.
        </div>
      ) : null}
    </div>
  )
}
