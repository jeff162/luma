// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * Settings -> Database: whether the two databases and the attached documents' files are intact, what the
 * databases hold, and the housekeeping that gives space back. Administrators only, since a repair or a compaction locks a database for everyone.
 *
 * The check is structural (`backend/services/database_health.py`): it says whether a file is damaged, not
 * whether the ledger makes sense, and the copy never claims more. A failure always comes with its next
 * step. Where every problem is an index out of step with its table, that is the rebuild offered here,
 * which loses nothing. Anything else is a backup: the newest one made from databases that passed is named,
 * and the way to rebuild a clean file from a backup made now is spelled out, since a restore rewrites the
 * tables inside the existing file and so does not by itself mend it.
 *
 * The reading lives in `lib/useDatabaseState.js`, because the page owns the section's title and the
 * refresh sits beside it.
 *
 * A document file the server cannot open is answered apart from the databases: the files are this server's
 * own, so the fix is their owner or permissions, and no backup can be made until it is.
 */

import { useState } from 'react'
import { api } from '../../lib/api.js'
import { APP_NAME } from '../../lib/appConfig.js'
import { formatCount } from '../../lib/displayFormat.js'
import { formatBytes } from '../../lib/storageFormat.js'
import { formatTimestamp } from '../../lib/utils.js'
import { StatusPill } from '../connections/ConnectionStatus.jsx'
import { Subsection } from '../SectionListPage.jsx'
import { Button, Card, LinkButton } from '../ui.jsx'
import ImportStorageSection from '../settings/ImportStorageSection.jsx'

const DATABASES = [
  ['data', 'Financial data'],
  ['accounts', 'Users & security'],
]
// Checked with the databases, as the folder the attached files are kept in, but with no space to report.
const CHECKED = [...DATABASES, ['documents', 'Attached documents']]
const SHOWN_PROBLEMS = 5
const SHOWN_TABLES = 10
const MUTED = { fontSize: 13, color: 'var(--muted)', lineHeight: 1.55 }

function problemLines(result) {
  return [
    ...result.problems,
    ...result.orphans.map(o => `${formatCount(o.rows)} ${o.rows === 1 ? 'row' : 'rows'} in ${o.table} `
      + `${o.rows === 1 ? 'refers' : 'refer'} to a ${o.parent} row that no longer exists.`),
  ]
}

function CheckResult({ label, result, first }) {
  const lines = result ? problemLines(result) : []
  return (
    <div style={{ padding: '12px 20px', display: 'grid', gap: 6, borderTop: first ? 'none' : '1px solid var(--border)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <StatusPill tone={result?.ok ? 'accent2' : 'danger'}>{result?.ok ? 'Passed' : 'Failed'}</StatusPill>
        <span style={{ fontSize: 13, fontWeight: 600 }}>{label}</span>
      </div>
      {result?.ok ? null : (
        <div style={{ ...MUTED, display: 'grid', gap: 2 }}>
          {lines.slice(0, SHOWN_PROBLEMS).map((line, i) => <div key={i} style={{ overflowWrap: 'anywhere' }}>{line}</div>)}
          {lines.length > SHOWN_PROBLEMS ? (
            <details>
              <summary style={{ cursor: 'pointer' }}>{formatCount(lines.length - SHOWN_PROBLEMS)} more</summary>
              {lines.slice(SHOWN_PROBLEMS).map((line, i) => <div key={i} style={{ overflowWrap: 'anywhere' }}>{line}</div>)}
            </details>
          ) : null}
        </div>
      )}
    </div>
  )
}

// What to do about a failed check. `onlyIndexes` is every failing database's problems being its indexes'.
function NextStep({ onlyIndexes, anyRepairable, backups, repairing, onRepair }) {
  const passed = (backups || []).find(b => b.database_check === 'passed')
  const newest = (backups || [])[0]
  const backupSentence = passed
    ? ` The newest backup made from databases that passed their check was made ${formatTimestamp(passed.made_at)}.`
    : newest ? ` The newest backup was made ${formatTimestamp(newest.made_at)}.` : ''
  return (
    <div style={{ padding: '12px 20px', borderTop: '1px solid var(--border)', display: 'grid', gap: 10 }}>
      {onlyIndexes ? (
        <div style={MUTED}>
          Every problem found is an index out of step with its table. Rebuilding the indexes repairs that
          without losing anything.
        </div>
      ) : (
        <div style={MUTED}>
          {anyRepairable ? 'Rebuilding the indexes repairs only some of what was found. ' : ''}
          {APP_NAME} cannot repair the rest. Restoring a backup made before the problem appeared puts the
          data back.{backupSentence} Otherwise, a backup made now can be restored into a new, empty database:
          stop {APP_NAME}, move its database files aside (Startup configuration shows where they are), start
          it again and restore the backup. A backup made now may be missing rows the damage hides.
        </div>
      )}
      {anyRepairable ? (
        <div>
          <Button variant="secondary" onClick={onRepair} disabled={repairing}>
            {repairing ? 'Rebuilding indexes…' : 'Rebuild indexes'}
          </Button>
        </div>
      ) : null}
    </div>
  )
}

// What to do about document files the server cannot open: they are this server's own, so the answer is
// their owner or permissions, never a backup (which cannot be made while they stand).
function DocumentsNextStep({ result }) {
  return (
    <div style={{ padding: '12px 20px', borderTop: '1px solid var(--border)', ...MUTED }}>
      Every file in <code>{result.folder}</code> has to be readable by{' '}
      {result.server_user ? <><em>{result.server_user}</em> on the server</> : 'the server’s run-as user'}.
      Check the file and directory ownership and permissions on the server.
    </div>
  )
}

function TableList({ usage }) {
  const [showAll, setShowAll] = useState(false)
  const tables = showAll ? usage.tables : usage.tables.slice(0, SHOWN_TABLES)
  const cell = { padding: '3px 0', fontSize: 13 }
  const number = { ...cell, textAlign: 'right', fontVariantNumeric: 'tabular-nums', paddingLeft: 24 }
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <table style={{ borderCollapse: 'collapse', width: '100%', maxWidth: 520 }}>
        <thead>
          <tr style={{ color: 'var(--muted)', fontSize: 12 }}>
            <th style={{ ...cell, fontSize: 12, textAlign: 'left', fontWeight: 500 }}>Table</th>
            <th style={{ ...number, fontSize: 12, fontWeight: 500 }}>Rows</th>
            <th style={{ ...number, fontSize: 12, fontWeight: 500 }}>Size</th>
          </tr>
        </thead>
        <tbody>
          {tables.map(t => (
            <tr key={t.name} style={{ borderTop: '1px solid var(--border)' }}>
              <td style={{ ...cell, overflowWrap: 'anywhere' }}><code>{t.name}</code></td>
              <td style={number}>{formatCount(t.rows)}</td>
              <td style={number}>{t.bytes == null ? '—' : formatBytes(t.bytes)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {usage.tables.length > SHOWN_TABLES ? (
        <div style={{ fontSize: 13 }}>
          <LinkButton onClick={() => setShowAll(v => !v)}>
            {showAll ? 'Show the largest' : `Show all ${formatCount(usage.tables.length)} tables`}
          </LinkButton>
        </div>
      ) : null}
      {!usage.table_sizes_known ? (
        <div style={{ ...MUTED, fontSize: 12 }}>The SQLite in this build does not report table sizes.</div>
      ) : null}
    </div>
  )
}

function SpaceUsed({ label, usage, first, compacting, freedMessage, onCompact }) {
  return (
    <div style={{ padding: '12px 20px', display: 'grid', gap: 10, borderTop: first ? 'none' : '1px solid var(--border)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>{label}</span>
        {usage.error ? null : (
          <span style={MUTED}>
            {formatBytes(usage.file_bytes)} total size · {formatBytes(usage.wal_bytes)} write-ahead log
            · {formatBytes(usage.free_bytes)} unused
          </span>
        )}
        {onCompact && !usage.error ? (
          <Button variant="secondary" size="compact" onClick={onCompact} disabled={compacting || !usage.free_bytes}
            title={usage.free_bytes ? undefined : 'Nothing to give back'}>
            {compacting ? 'Compacting…' : 'Compact now'}
          </Button>
        ) : null}
        {freedMessage ? <span style={MUTED}>{freedMessage}</span> : null}
      </div>
      {usage.error
        ? <div style={{ fontSize: 13, color: 'var(--danger)' }}>{usage.error}</div>
        : <TableList usage={usage} />}
    </div>
  )
}

export default function DatabaseSection({ db, storage, onStorageChanged }) {
  const { state, setState, backups, error } = db
  const [repairing, setRepairing] = useState(false)
  const [compacting, setCompacting] = useState(false)
  const [freedMessage, setFreedMessage] = useState('')
  const [actionError, setActionError] = useState('')

  async function repair() {
    setRepairing(true)
    setActionError('')
    try {
      setState(await api.repairDatabaseIndexes())
    } catch (err) {
      setActionError(err?.message || 'The indexes could not be rebuilt.')
    } finally {
      setRepairing(false)
    }
  }

  async function compact() {
    setCompacting(true)
    setActionError('')
    setFreedMessage('')
    try {
      const result = await api.compactDatabase()
      setState(prev => ({ ...prev, usage: result.usage }))
      setFreedMessage(result.freed_bytes ? `Gave back ${formatBytes(result.freed_bytes)}.` : 'Nothing was given back.')
      onStorageChanged?.()
    } catch (err) {
      setActionError(err?.message || 'The database could not be compacted.')
    } finally {
      setCompacting(false)
    }
  }

  const check = state?.check
  const failing = check ? DATABASES.map(([key]) => check.databases[key]).filter(r => r && !r.ok) : []
  const documents = check?.databases.documents
  const anyRepairable = failing.some(r => r.indexes_repairable)
  const onlyIndexes = failing.length > 0 && failing.every(r => r.indexes_repairable && !r.orphans.length)

  return (
    <div style={{ display: 'grid', gap: 18 }}>
      {error ? <div role="alert" style={{ fontSize: 13, color: 'var(--danger)' }}>{error}</div> : null}
      {actionError ? <div role="alert" style={{ fontSize: 13, color: 'var(--danger)' }}>{actionError}</div> : null}
      {check ? (
        <Subsection title="Database Integrity">
          <Card style={{ padding: 0 }}>
            {CHECKED.map(([key, label], i) => check.databases[key] ? (
              <CheckResult key={key} label={label} result={check.databases[key]} first={i === 0} />
            ) : null)}
            {failing.length ? (
              <NextStep onlyIndexes={onlyIndexes} anyRepairable={anyRepairable} backups={backups}
                repairing={repairing} onRepair={repair} />
            ) : null}
            {documents && !documents.ok ? <DocumentsNextStep result={documents} /> : null}
          </Card>
          <div style={{ ...MUTED, fontSize: 12, marginTop: 6 }}>
            Checks the integrity of each file, that there are no rows which refer to a non-existent row and
            that every attached document&rsquo;s file can be read. Does not verify data consistency.
          </div>
        </Subsection>
      ) : null}
      {state?.usage ? (
        <Subsection title="Space used">
          <Card style={{ padding: 0 }}>
            {DATABASES.map(([key, label], i) => state.usage[key] ? (
              <SpaceUsed key={key} label={label} usage={state.usage[key]} first={i === 0}
                {...(key === 'data' ? { compacting, freedMessage, onCompact: compact } : {})} />
            ) : null)}
          </Card>
        </Subsection>
      ) : null}
      <Subsection title="Import storage">
        <div style={{ ...MUTED, display: 'grid', gap: 8, marginBottom: 10 }}>
          <p style={{ margin: 0 }}>
            There are various rows in an import which are omitted and others which
            are discarded by the duplicate resolution process. This data is saved to support altering
            a decision regarding duplicates and to allow importing rows which were rejected or skipped.
          </p>
          <p style={{ margin: 0 }}>
            <strong>Show import space&hellip;</strong> lists what each import holds, and <strong>Clear
            detail</strong> there clears it. Transactions are unaffected
            and the affected Import Records are flagged as cleared in the history. After freeing the space,
            duplicate decisions cannot be revisited nor can skipped or rejected rows be imported without
            re-importing the original file.
          </p><p>
            Clearing cannot be undone.
          </p>
        </div>
        <ImportStorageSection storage={storage} onChanged={() => { onStorageChanged?.(); db.load() }} />
      </Subsection>
    </div>
  )
}
