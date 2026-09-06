// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// Backup recipients: the RSA public keys an encrypted backup is sealed to, and the generator that
// produces one for someone who has no key of their own.
//
// It lives beside the backup controls rather than in Settings because it is used by nothing else — the
// "Generate encrypted backup" button is disabled without an enabled recipient here, and a precondition
// two pages away from the action it gates reads as unrelated configuration.
//
// **The list leads; the two ways to add one sit under it as buttons opening dialogs.** Adding is
// occasional and reading the list is not, so the forms are not worth the standing vertical space — and
// keeping them in dialogs is what lets each own its own name field, which matters more than it sounds:
// a shared one silently attaches the name typed for one flow to a key created by the other.
//
// **The generator stores nothing, and the ordering is the safety property.** The endpoint returns a
// keypair and creates no recipient; the dialog adds one only after the user confirms they have saved the
// private key. The reverse order would let a recipient exist whose private key was never kept — backups
// sealed to a key nobody holds, discovered on the day they are needed. The private half lives in dialog
// state for exactly as long as that takes and is dropped when the dialog closes.

import { useState, useEffect, useRef, useId } from 'react'
import { api, saveBlob } from '../../lib/api.js'
import {
  Card, Button, COMPACT_ACTION_BTN_STYLE, Spinner, Input, AppDialog, AppConfirmDialog,
  Tooltip, getFormControlStyle,
} from '../ui.jsx'
import { useTransientTextEdit } from '../../lib/uiInteractions.js'
import TransientTextInput from '../TransientTextInput.jsx'
import { SENSITIVE_FIELD_PROPS } from '../../lib/sensitiveFields.js'
import { APP_NAME } from '../../lib/appConfig.js'

/** Whether a typed name collides with one already saved. Mirrors the server's comparison exactly —
 *  trimmed and case-insensitive — because a client check that disagrees with the server either blocks a
 *  name the server would take or waves through one it will refuse. */
function isNameTaken(existingNames, label) {
  const candidate = label.trim().toLowerCase()
  if (!candidate) return false
  return (existingNames || []).some(name => (name || '').trim().toLowerCase() === candidate)
}

export function BackupRecipients({ onRecipientsChange }) {
  const [recipients, setRecipients] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [pendingDeleteRecipient, setPendingDeleteRecipient] = useState(null)
  const [addOpen, setAddOpen] = useState(false)
  const [generateOpen, setGenerateOpen] = useState(false)

  async function load() {
    setLoading(true)
    try {
      setRecipients(await api.getBackupRecipients())
      setError('')
    } catch (err) {
      setError(err.message || 'Failed to load backup recipients')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  // The page hosting this decides whether "Generate encrypted backup" is available, and that answer
  // changes the moment a recipient is added, toggled or removed *here*. Reporting the list up on every
  // change is what keeps the two in step now that they share a page — otherwise adding a key leaves the
  // button that needs it disabled until a reload. Held in a ref so a caller passing an inline arrow does
  // not re-run this on every render of theirs.
  const reportRef = useRef(onRecipientsChange)
  reportRef.current = onRecipientsChange
  useEffect(() => { reportRef.current?.(recipients) }, [recipients])

  // Names in use, for the dialogs to check a typed name against as it is typed. The server enforces the
  // rule (this list is a client copy, and a second tab could add a name behind it); what this buys is
  // catching it at the moment the name is *chosen* rather than at the moment it is used. In the
  // generator that difference is the whole point: finding out after generating means having already
  // downloaded a key file named for a name that cannot be kept.
  // `?.` because this map is over data from the network and runs during render: one unexpected entry
  // would otherwise throw and take the whole page down, rather than costing one name from the check.
  const existingNames = recipients.map(recipient => recipient?.label)

  // The public key is held here, so this is where it is retrievable from — and there is one real use for
  // it: adding the same recipient to another install, which is a paste-the-public-key job. Not needed for
  // recovery, since a PKCS8 private key already contains its public half (`openssl rsa -in key.pem
  // -pubout` reproduces it) — which is also why the generator hands over the private key alone.
  //
  // `.pem` rather than `.pub`: this is SPKI PEM, and `.pub` reads as an OpenSSH key, which is a different
  // format entirely. It also pairs on sight with the `-private-key.pem` the generator saves.
  function exportPublicKey(recipient) {
    const stem = (recipient.label || 'backup-key').trim().replace(/[^A-Za-z0-9._-]+/g, '-')
    saveBlob(
      new Blob([recipient.public_key || ''], { type: 'application/x-pem-file' }),
      `${stem}-public-key.pem`,
    )
  }

  function recipientAdded(created) {
    setRecipients(prev => [created, ...prev])
    setError('')
  }

  async function toggleRecipient(recipient) {
    try {
      const updated = await api.updateBackupRecipient(recipient.id, { enabled: !recipient.enabled })
      setRecipients(prev => prev.map(item => item.id === recipient.id ? updated : item))
    } catch (err) {
      setError(err.message || 'Failed to update recipient')
    }
  }

  async function removeRecipient(recipient) {
    setPendingDeleteRecipient(null)
    try {
      await api.deleteBackupRecipient(recipient.id)
      setRecipients(prev => prev.filter(item => item.id !== recipient.id))
    } catch (err) {
      setError(err.message || 'Failed to delete recipient')
    }
  }

  return (
    <>
      {pendingDeleteRecipient ? (
        <AppConfirmDialog
          title="Delete backup key?"
          description={`Delete backup key "${pendingDeleteRecipient.label}"? Backups already encrypted to it stay readable with its private key.`}
          confirmLabel="Delete"
          confirmVariant="danger"
          borderColor="color-mix(in srgb, var(--danger) 35%, var(--border))"
          onConfirm={() => removeRecipient(pendingDeleteRecipient)}
          onCancel={() => setPendingDeleteRecipient(null)}
          width="min(500px, 100%)"
        />
      ) : null}

      {addOpen ? (
        <AddRecipientDialog
          existingNames={existingNames}
          onAdded={recipientAdded}
          onClose={() => setAddOpen(false)}
        />
      ) : null}

      {generateOpen ? (
        <GenerateKeypairDialog
          existingNames={existingNames}
          onAdded={recipientAdded}
          onClose={() => setGenerateOpen(false)}
        />
      ) : null}

      <Card style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ padding: '14px 16px', color: 'var(--muted)', fontSize: 13 }}>
          RSA public keys used to encrypt backup files. The corresponding private key is
          provided as part of a restore; only public keys are stored.
        </div>

        {error && (
          <div style={{ padding: '10px 16px', color: 'var(--danger)', fontSize: 13, borderTop: '1px solid var(--border)' }}>
            {error}
          </div>
        )}

        {loading && recipients.length === 0 ? <Spinner /> : recipients.length === 0 ? (
          <div style={{ padding: '18px 16px', color: 'var(--muted)', fontSize: 13, borderTop: '1px solid var(--border)' }}>
            No backup keys yet — add a public key or generate a key pair to enable encrypted backups.
          </div>
        ) : (
          recipients.map(recipient => (
            <div
              key={recipient.id}
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr 120px auto 40px',
                gap: 10,
                padding: '12px 16px',
                alignItems: 'center',
                borderTop: '1px solid var(--border)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 }}>
                <EditableRecipientLabel
                  recipient={recipient}
                  onCommit={async next => {
                    try {
                      const updated = await api.updateBackupRecipient(recipient.id, { label: next })
                      setRecipients(prev => prev.map(item => item.id === recipient.id ? updated : item))
                      setError('')
                    } catch (err) {
                      setError(err.message || 'Failed to update recipient')
                      throw err
                    }
                  }}
                />
                <div style={{ fontSize: 10, color: 'var(--muted)', fontFamily: 'monospace', lineHeight: 1.2, wordBreak: 'break-all', minWidth: 0 }}>
                  {recipient.fingerprint}
                </div>
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--muted)', cursor: 'pointer' }}>
                <input
                  name={`backup-recipient-enabled-${recipient.id}`}
                  type="checkbox"
                  checked={!!recipient.enabled}
                  onChange={() => toggleRecipient(recipient)}
                />
                Enabled
              </label>
              {/* The house style for a repeated per-row action: quiet enough to read as a row control
                  rather than as the surface's verb, which here is generating or adding a key. */}
              <Button
                style={COMPACT_ACTION_BTN_STYLE}
                variant="ghost"
                onClick={() => exportPublicKey(recipient)}
                title="Save this public key, to add the same key on another install"
              >
                Export
              </Button>
              <button
                type="button"
                aria-label={`Delete backup key ${recipient.label}`}
                onClick={() => setPendingDeleteRecipient(recipient)}
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'var(--danger)',
                  cursor: 'pointer',
                  fontSize: 16,
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

        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', padding: 16, borderTop: '1px solid var(--border)' }}>
          <Button small variant="ghost" onClick={() => setAddOpen(true)}>Add a key</Button>
          <Button small variant="ghost" onClick={() => setGenerateOpen(true)}>Generate a key pair</Button>
        </div>
      </Card>
    </>
  )
}

/** Bring an existing public key: paste it, drop a file on it, or browse for one. */
function AddRecipientDialog({ existingNames, onAdded, onClose }) {
  const fieldIdBase = useId()
  const fileInputRef = useRef(null)
  const [label, setLabel] = useState('')
  const [publicKey, setPublicKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const inputStyle = { ...getFormControlStyle({ size: 'md', surface: 'base' }), width: '100%' }
  const nameTaken = isNameTaken(existingNames, label)

  async function loadPublicKeyFile(file) {
    if (!file) return
    try {
      const text = await file.text()
      setPublicKey(text)
      // The filename is a better first guess at a name than an empty box, and it is only a default.
      setLabel(prev => prev || file.name.replace(/\.[^.]+$/, ''))
      setError('')
    } catch {
      setError('Failed to read public key file')
    }
  }

  async function handleDrop(e) {
    e.preventDefault()
    const file = e.dataTransfer.files?.[0]
    if (file) {
      await loadPublicKeyFile(file)
      return
    }
    const text = e.dataTransfer.getData('text/plain')
    if (text) setPublicKey(text.trim())
  }

  async function submit() {
    setSaving(true)
    setError('')
    try {
      onAdded(await api.createBackupRecipient({ label: label.trim(), public_key: publicKey.trim() }))
      onClose()
    } catch (err) {
      setError(err.message || 'Failed to save backup recipient')
      setSaving(false)
    }
  }

  return (
    <AppDialog
      title="Add a backup key"
      description="Paste or drop an RSA public key. The matching private key is what will read those backups back, so it has to be one you hold."
      onClose={onClose}
      actions={<>
        <Button variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
        <Button onClick={submit} disabled={saving || nameTaken || !label.trim() || !publicKey.trim()}>
          {saving ? 'Saving…' : 'Add key'}
        </Button>
      </>}
    >
      <div style={{ display: 'grid', gap: 10 }}>
        <Input
          id={`${fieldIdBase}-label`}
          value={label}
          onChange={setLabel}
          placeholder="Key name (e.g. Home NAS)"
          aria-label="Backup key name"
        />
        {nameTaken ? (
          <div style={{ fontSize: 12, color: 'var(--danger)' }}>
            A backup key named &ldquo;{label.trim()}&rdquo; already exists.
          </div>
        ) : null}
        <input
          ref={fileInputRef}
          type="file"
          accept=".pub,.pem,.txt,.key"
          onChange={e => loadPublicKeyFile(e.target.files?.[0])}
          style={{ display: 'none' }}
        />
        {!publicKey.trim() ? (
          <div
            onClick={() => fileInputRef.current?.click()}
            onDragOver={e => e.preventDefault()}
            onDrop={handleDrop}
            style={{
              border: '2px dashed var(--border)',
              borderRadius: 12,
              padding: '32px 24px',
              textAlign: 'center',
              cursor: 'pointer',
              background: 'var(--surface2)',
            }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--accent)' }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)' }}
          >
            <div style={{ fontSize: 32, marginBottom: 12 }}>📂</div>
            <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 6 }}>
              Drop an RSA public key file here, or click to browse
            </div>
            <div style={{ fontSize: 13, color: 'var(--muted)' }}>RSA public keys only.</div>
          </div>
        ) : (
          <textarea
            id={`${fieldIdBase}-public-key`}
            value={publicKey}
            onChange={e => setPublicKey(e.target.value)}
            rows={5}
            onDragOver={e => e.preventDefault()}
            onDrop={handleDrop}
            aria-label="Backup key public key"
            style={{ ...inputStyle, minHeight: 120, resize: 'vertical', fontFamily: 'monospace', borderRadius: 10, lineHeight: 1.5 }}
          />
        )}
        {error && <div style={{ fontSize: 13, color: 'var(--danger)' }}>{error}</div>}
      </div>
    </AppDialog>
  )
}

/** Make a key pair here, for someone with no key of their own. Two steps in one dialog: name it and
 *  generate, then save the private half before the recipient is created. */
function GenerateKeypairDialog({ existingNames, onAdded, onClose }) {
  const fieldIdBase = useId()
  const [label, setLabel] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [confirmPassphrase, setConfirmPassphrase] = useState('')
  const [generating, setGenerating] = useState(false)
  const [generated, setGenerated] = useState(null)
  const [savedAcknowledged, setSavedAcknowledged] = useState(false)
  const [copied, setCopied] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const inputStyle = { ...getFormControlStyle({ size: 'md', surface: 'base' }), width: '100%' }
  // A typo here produces a perfectly valid key file that cannot be opened, and says nothing about it
  // until a restore months later — so the passphrase is confirmed before it is used, as the vault's own
  // set-passphrase flow does. An empty passphrase is a deliberate choice and needs no confirmation.
  const passphraseReady = !passphrase || passphrase === confirmPassphrase
  // Checked before generating, not after: the name is locked once a key exists, so a collision found at
  // "add recipient" would mean discarding a key the user has already been told to save.
  const nameTaken = isNameTaken(existingNames, label)

  async function generate() {
    setGenerating(true)
    setError('')
    try {
      setGenerated(await api.generateBackupKeypair({ passphrase: passphrase || null }))
    } catch (err) {
      setError(err.message || 'Could not generate a key pair')
    } finally {
      setGenerating(false)
    }
  }

  function downloadPrivateKey() {
    const stem = (label.trim() || 'luma-backup').replace(/[^A-Za-z0-9._-]+/g, '-')
    saveBlob(new Blob([generated.private_key], { type: 'application/x-pem-file' }), `${stem}-private-key.pem`)
    setSavedAcknowledged(true)
  }

  async function copyPrivateKey() {
    try {
      await navigator.clipboard.writeText(generated.private_key)
      setCopied(true)
      setSavedAcknowledged(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setError('Could not reach the clipboard — select the key above and copy it manually.')
    }
  }

  async function addRecipient() {
    setSaving(true)
    setError('')
    try {
      onAdded(await api.createBackupRecipient({ label: label.trim(), public_key: generated.public_key }))
      onClose()
    } catch (err) {
      setError(err.message || 'Failed to save backup recipient')
      setSaving(false)
    }
  }

  return (
    <AppDialog
      title="Generate a key pair"
      description={generated
        ? 'Save the private key before adding it — this is the only copy.'
        : `${APP_NAME} will generate an RSA key pair. The public key is saved here as the backup key; the private key is shown once and never stored.`}
      onClose={onClose}
      borderColor={generated ? 'var(--warning)' : 'var(--border)'}
      actions={<>
        <Button variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
        {generated ? (
          <Tooltip content={savedAcknowledged ? '' : 'Download or copy the private key first'}>
            <Button
              onClick={addRecipient}
              disabled={!savedAcknowledged || saving || !label.trim()}
            >
              {saving ? 'Adding…' : 'Create key'}
            </Button>
          </Tooltip>
        ) : (
          <Button onClick={generate} disabled={generating || nameTaken || !label.trim() || !passphraseReady}>
            {generating ? 'Generating…' : 'Generate'}
          </Button>
        )}
      </>}
    >
      <div style={{ display: 'grid', gap: 12 }}>
        <Input
          id={`${fieldIdBase}-label`}
          value={label}
          onChange={setLabel}
          placeholder="Key name (e.g. Offsite drive)"
          aria-label="Backup key name"
          disabled={!!generated}
        />
        {nameTaken ? (
          <div style={{ fontSize: 12, color: 'var(--danger)' }}>
            A backup key named &ldquo;{label.trim()}&rdquo; already exists.
          </div>
        ) : null}
        {!generated ? (
          <>
            <Input
              type="password"
              value={passphrase}
              onChange={setPassphrase}
              placeholder="Passphrase for the key file (optional)"
              aria-label="Passphrase for the generated key file"
              {...SENSITIVE_FIELD_PROPS}
            />
            {passphrase ? (
              <Input
                type="password"
                value={confirmPassphrase}
                onChange={setConfirmPassphrase}
                placeholder="Confirm passphrase"
                aria-label="Confirm the passphrase for the generated key file"
                {...SENSITIVE_FIELD_PROPS}
              />
            ) : null}
            {passphrase && confirmPassphrase && passphrase !== confirmPassphrase ? (
              <div style={{ fontSize: 12, color: 'var(--danger)' }}>The passphrases do not match.</div>
            ) : null}
            <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>
              A passphrase protects the key file if it is ever seen by someone else. It does not protect
              against losing it — and it is a second thing to remember, since the file cannot be used
              without it.
            </div>
          </>
        ) : (
          <div style={{
            display: 'grid',
            gap: 10,
            padding: '12px 14px',
            borderRadius: 10,
            background: 'color-mix(in srgb, var(--warning) 10%, var(--surface2))',
            border: '1px solid var(--warning)',
          }}>
            <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>
              This is the only copy — it was not stored anywhere. Without it, every backup encrypted to
              this key is permanently unreadable, and there is no reset.
              {generated.encrypted
                ? ' The file is protected by the passphrase you entered, which is needed to use it at restore time.'
                : ' The file is unencrypted, so store it somewhere already protected.'}
            </div>
            <textarea
              readOnly
              value={generated.private_key}
              rows={6}
              aria-label="Generated private key"
              style={{ ...inputStyle, minHeight: 120, resize: 'vertical', fontFamily: 'monospace', fontSize: 11, lineHeight: 1.4, borderRadius: 10 }}
            />
            <div style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'monospace', wordBreak: 'break-all' }}>
              {generated.fingerprint}
            </div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <Button small onClick={downloadPrivateKey}>Download private key</Button>
              <Button small variant="ghost" onClick={copyPrivateKey}>{copied ? 'Copied' : 'Copy'}</Button>
            </div>
          </div>
        )}
        {error && <div style={{ fontSize: 13, color: 'var(--danger)' }}>{error}</div>}
      </div>
    </AppDialog>
  )
}

function EditableRecipientLabel({ recipient, onCommit }) {
  const {
    editing,
    draft,
    setDraft,
    beginEdit,
    cancelEdit,
    commitEdit,
  } = useTransientTextEdit(recipient.label || '', { onCommit })

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
      onClick={() => beginEdit(recipient.label || '')}
      style={{
        background: 'var(--surface2)',
        color: 'var(--text)',
        border: '1px solid var(--border)',
        borderRadius: 999,
        padding: '4px 10px',
        fontSize: 13,
        fontWeight: 600,
        lineHeight: 1.2,
        whiteSpace: 'nowrap',
        cursor: 'text',
      }}
    >
      {recipient.label}
    </button>
  )
}
