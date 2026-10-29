// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// Small confirmation/choice dialogs for the import flow, each driven entirely by
// props from ImportTab:
//   - DataSourceMismatchDialog: a saved profile's header signature differs from
//     the dropped file; offers continue / change source / cancel, with an inline
//     data-source chooser sub-state. Continuing is not a one-off override: the
//     source takes this file's columns once the import completes, and the mapping
//     screen marks which ones changed (see run_import_parsed).
//   - CompatibleBatchAttachDialog: a just-saved profile looks compatible with
//     existing uncategorized imports; offers to attach them or leave them.
//   - PossibleAccountMatchChooserDialog: a source account being given a NEW account looks like one or
//     more accounts that already exist; pick one and map to it or nest under it, or keep separate from
//     all of them.

import { useEffect, useRef, useState } from 'react'
import {
  Button,
  DialogActions,
  FloatingPanel,
  FloatingPanelHeader,
  OverlayBackdrop,
  Tooltip,
} from '../ui.jsx'
import { DataSourcePill } from './importPresentational.jsx'
import { formatImportBatchTimestamp } from '../../lib/importExport/importDraft.js'

export function DataSourceMismatchDialog({
  profileName,
  chooserOpen = false,
  profiles = [],
  selectedProfileId = '',
  fileHeaderFingerprint = '',
  onSelectProfile,
  onSelectTemporaryDraft,
  onCloseChooser,
  onConfirm,
  onCancel,
  onChangeDataSource,
}) {
  if (!profileName) return null
  return (
    <OverlayBackdrop zIndex={1200} tint="rgba(15, 23, 42, 0.38)">
      <FloatingPanel style={{ width: 'min(560px, 100%)' }}>
        <FloatingPanelHeader style={{ padding: '16px 20px' }}>
          <div>
            {chooserOpen ? (
              <>
                <div style={{ fontSize: 16, fontWeight: 600 }}>Choose a different data source</div>
                <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4, lineHeight: 1.5 }}>
                  Choose a different data source or skip using a data source with this file.
                </div>
              </>
            ) : (
              <>
                <div style={{ fontSize: 16, fontWeight: 600 }}>The file header has changed</div>
                <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4, lineHeight: 1.5 }}>
                  The <span style={{ color: 'var(--text)', fontWeight: 600 }}>{profileName}</span> data source maps a
                  different set of columns. Continuing updates the data source based on the file
                  being imported. The changes will be indicated on the mapping screen.
                </div>
              </>
            )}
          </div>
        </FloatingPanelHeader>
        {chooserOpen ? (
          <>
            <div style={{ padding: 20, display: 'grid', gap: 12 }}>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, justifyContent: 'center' }}>
                <DataSourcePill
                  label="Skip"
                  selected={!selectedProfileId}
                  onClick={onSelectTemporaryDraft}
                  title="Use a temporary draft for this file"
                />
                {profiles.map(profile => (
                  <DataSourcePill
                    key={profile.id}
                    label={profile.name}
                    selected={selectedProfileId === profile.id}
                    onClick={() => onSelectProfile?.(profile.id)}
                    title="Use this saved data source"
                    likelyMatch={
                      !!fileHeaderFingerprint &&
                      !!profile.header_fingerprint &&
                      profile.header_fingerprint === fileHeaderFingerprint
                    }
                  />
                ))}
              </div>
              {profiles.length === 0 ? (
                <div style={{ fontSize: 12, color: 'var(--muted)', textAlign: 'center' }}>
                  No saved data sources are available yet.
                </div>
              ) : null}
            </div>
            <DialogActions>
              <Button variant="secondary" onClick={onCloseChooser}>
                Back
              </Button>
            </DialogActions>
          </>
        ) : (
          <DialogActions>
            <Button variant="secondary" onClick={onCancel}>
              Cancel
            </Button>
            <Button variant="secondary" onClick={onChangeDataSource}>
              Change data source
            </Button>
            <Button variant="secondary" onClick={onConfirm}>
              Continue
            </Button>
          </DialogActions>
        )}
      </FloatingPanel>
    </OverlayBackdrop >
  )
}

// The dropped file's header matches more than one saved data source, so we can't pick automatically;
// the user chooses which to apply (or a temporary draft). Every listed profile is a genuine header
// match, so they all carry the likely-match marker.
export function MultipleSourceMatchDialog({
  matches = [],
  fileHeaderFingerprint = '',
  onSelectProfile,
  onSelectTemporaryDraft,
  onCancel,
}) {
  if (!matches.length) return null
  return (
    <OverlayBackdrop zIndex={1200} tint="rgba(15, 23, 42, 0.38)">
      <FloatingPanel style={{ width: 'min(560px, 100%)' }}>
        <FloatingPanelHeader style={{ padding: '16px 20px' }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 600 }}>Which data source?</div>
            <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4, lineHeight: 1.5 }}>
              This file matches more than one saved data source. Pick the one to use, or skip to use a temporary draft.
            </div>
          </div>
        </FloatingPanelHeader>
        <div style={{ padding: 20, display: 'grid', gap: 12 }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, justifyContent: 'center' }}>
            {matches.map(profile => (
              <DataSourcePill
                key={profile.id}
                label={profile.name}
                selected={false}
                onClick={() => onSelectProfile?.(profile.id)}
                title="Use this saved data source"
                likelyMatch={
                  !!fileHeaderFingerprint &&
                  !!profile.header_fingerprint &&
                  profile.header_fingerprint === fileHeaderFingerprint
                }
              />
            ))}
            <DataSourcePill
              label="Skip"
              selected={false}
              onClick={onSelectTemporaryDraft}
              title="Use a temporary draft for this file"
              showMarker={false}
            />
          </div>
        </div>
        <DialogActions>
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
        </DialogActions>
      </FloatingPanel>
    </OverlayBackdrop>
  )
}

// The selected files span more than one data source. Multi-file import handles one source at a time,
// so this shows each detected source with its files and lets the user pick which source to import now.
export function MultiFileSourceChooserDialog({ groups = [], unreadable = [], onPickGroup, onCancel }) {
  if (!groups.length) return null
  return (
    <OverlayBackdrop zIndex={1200} tint="rgba(15, 23, 42, 0.38)">
      <FloatingPanel style={{ width: 'min(620px, 100%)' }}>
        <FloatingPanelHeader style={{ padding: '16px 20px' }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 600 }}>These files are from different data sources</div>
            <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4, lineHeight: 1.5 }}>
              Files are imported one source at a time. Pick the source to import now — you can re-run for the others.
            </div>
          </div>
        </FloatingPanelHeader>
        <div style={{ padding: 20, display: 'grid', gap: 12, maxHeight: '55vh', overflowY: 'auto' }}>
          {groups.map(group => (
            <button
              key={group.key}
              type="button"
              onClick={() => onPickGroup?.(group)}
              style={{
                textAlign: 'left', border: '1px solid var(--border)', borderRadius: 8,
                padding: '12px 14px', background: 'var(--surface)', cursor: 'pointer', display: 'grid', gap: 6,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>
                  {group.label}{group.ambiguous ? ' (choose which saved source next)' : ''}
                </span>
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                  {group.files.length} file{group.files.length === 1 ? '' : 's'}
                </span>
              </div>
              <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {group.files.map(entry => entry.file.name).join(', ')}
              </div>
            </button>
          ))}
          {unreadable.length ? (
            <div style={{ fontSize: 12, color: 'var(--danger)', lineHeight: 1.5 }}>
              Could not read: {unreadable.join(', ')}
            </div>
          ) : null}
        </div>
        <DialogActions>
          <Button variant="secondary" onClick={onCancel}>Cancel</Button>
        </DialogActions>
      </FloatingPanel>
    </OverlayBackdrop>
  )
}

export function CompatibleBatchAttachDialog({ prompt, onConfirm, onCancel, attaching = false }) {
  if (!prompt) return null
  const batches = Array.isArray(prompt.batches) ? prompt.batches : []
  return (
    <OverlayBackdrop zIndex={1200} tint="rgba(15, 23, 42, 0.38)">
      <FloatingPanel style={{ width: 'min(640px, 100%)' }}>
        <FloatingPanelHeader style={{ padding: '16px 20px' }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 600 }}>Attach compatible unknown imports?</div>
            <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4, lineHeight: 1.5 }}>
              <span style={{ color: 'var(--text)', fontWeight: 600 }}>{prompt.profileName}</span> looks compatible with {batches.length} uncategorized import{batches.length === 1 ? '' : 's'}.
            </div>
          </div>
        </FloatingPanelHeader>
        <div style={{ padding: 20, display: 'grid', gap: 14 }}>
          <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.55 }}>
            Attach these imports now so they move under the saved data source? You can still leave them under unknown data source and undo or re-import them later instead.
          </div>
          <div style={{
            maxHeight: 240,
            overflowY: 'auto',
            border: '1px solid var(--border)',
            borderRadius: 12,
            background: 'color-mix(in srgb, var(--surface2) 72%, var(--surface))',
          }}>
            {batches.map(batch => (
              <div key={batch.id} style={{ padding: '10px 12px', borderBottom: '1px solid color-mix(in srgb, var(--border) 72%, transparent)' }}>
                <div style={{ fontSize: 13, fontWeight: 500 }}>{batch.filename}</div>
                <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3 }}>
                  {formatImportBatchTimestamp(batch.imported_at)} · {batch.row_count} rows
                </div>
              </div>
            ))}
          </div>
        </div>
        <DialogActions>
          <Button variant="secondary" onClick={onCancel} disabled={attaching}>
            Leave separate
          </Button>
          <Button onClick={onConfirm} disabled={attaching}>
            {attaching ? 'Attaching…' : `Attach ${batches.length} import${batches.length === 1 ? '' : 's'}`}
          </Button>
        </DialogActions>
      </FloatingPanel>
    </OverlayBackdrop>
  )
}

/*
 * "You asked for a new account — is it one of these first?"
 *
 * Reached only by pressing the row's `+New` when the matcher found something the source could already
 * be. That entry point is what makes the picker beside it able to stay a plain picker: the question of
 * *which* account is answered there, and this dialog exists for the question that has no room in a
 * dropdown — whether a new account should be **nested under** one of the possibles.
 *
 * It is also what makes "Keep separate" honest. That button records an `account_pair_distinct` assertion
 * against every candidate listed here, and an assertion may only cover what the user was actually shown.
 * A modal cannot be missed, so this is where the showing happens.
 *
 * **The list is the possible matches, not every account.** The dialog's question is about them; anyone
 * wanting an account the matcher never proposed uses the picker, which lists them all. That is strictly
 * more than the dialog offered before, when it could only ever name the single suggested account.
 *
 * Two of the three actions need an account and are disabled until one is chosen; a single candidate
 * arrives pre-selected, so the common case is the same press count it has always been and never shows a
 * lone radio dressed up as a choice. **"Keep separate" is never disabled** — a radio group cannot be
 * cleared once set, so gating it on "nothing selected" would strand anyone who selected a candidate to
 * consider it and then decided against it, with cancelling and reopening as their only escape. A lit
 * radio is simply ignored: they declined every candidate either way, so the assertion is identical.
 */
export function PossibleAccountMatchChooserDialog({
  pending,
  onSelect,
  onCancel,
}) {
  const dialogRef = useRef(null)
  const candidates = pending?.candidates || []
  const [selectedId, setSelectedId] = useState('')

  useEffect(() => {
    dialogRef.current?.focus()
  }, [])

  // Pre-select the lone candidate, and re-run when the dialog is reopened about a different row.
  useEffect(() => {
    setSelectedId(candidates.length === 1 ? (candidates[0]?.id || '') : '')
  }, [pending])  // eslint-disable-line react-hooks/exhaustive-deps

  if (!pending) return null

  const single = candidates.length === 1 ? candidates[0] : null
  const singleLabel = single ? (single.label || single.name || 'the existing account') : ''
  const needsAccount = !selectedId

  return (
    <OverlayBackdrop
      onClick={onCancel}
      zIndex={1250}
      tint="rgba(15, 23, 42, 0.45)"
    >
      <FloatingPanel
        ref={dialogRef}
        tabIndex={-1}
        onClick={event => event.stopPropagation()}
        onKeyDownCapture={event => {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            onCancel?.()
          }
        }}
        style={{
          width: 'min(460px, calc(100% - 48px))',
          border: '1px solid color-mix(in srgb, var(--accent) 28%, var(--border))',
          padding: '18px 18px 16px',
          display: 'grid',
          gap: 12,
          outline: 'none',
        }}
      >
        <div style={{ display: 'grid', gap: 6 }}>
          <div style={{ fontSize: 16, fontWeight: 600 }}>Possible duplicate account?</div>
          <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.6 }}>
            {single
              ? <>“{pending.csvValue}” looks like it may be the same real-world account as “{singleLabel}”.</>
              : <>“{pending.csvValue}” looks like it may be the same real-world account as one of these.</>}
          </div>
        </div>

        {/* A radio group rather than per-row action buttons, so the three answers keep the full labels
            that say what they do. Buttons on every row would have to shrink to two words each and would
            multiply with the candidates; this stays three controls whether there are two possibles or
            six. */}
        <div
          role="radiogroup"
          aria-label="Possible matching accounts"
          style={{
            display: 'grid', gap: 2, border: '1px solid var(--border)', borderRadius: 8,
            padding: 4, maxHeight: 210, overflowY: 'auto',
          }}
        >
          {candidates.map(candidate => {
            const label = candidate.label || candidate.name || ''
            const checked = selectedId === candidate.id
            return (
              <label
                key={candidate.id}
                style={{
                  display: 'flex', alignItems: 'center', gap: 9, padding: '7px 9px', borderRadius: 6,
                  cursor: 'pointer', fontSize: 13, lineHeight: 1.35,
                  background: checked ? 'color-mix(in srgb, var(--accent2) 12%, var(--surface2))' : 'transparent',
                }}
              >
                <input
                  type="radio"
                  name="possible-account-match"
                  value={candidate.id}
                  checked={checked}
                  onChange={() => setSelectedId(candidate.id)}
                  style={{ flexShrink: 0, accentColor: 'var(--accent2)' }}
                />
                <span style={{ display: 'grid', gap: 1, minWidth: 0 }}>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {label}
                  </span>
                  {/* Where it is held. With mask-derived candidates the names can be unrelated, and
                      "why am I being shown this one?" is otherwise a fair question with no answer on
                      screen. Omitted when the account records no institution rather than printing a
                      blank line. */}
                  {candidate.institution ? (
                    <span style={{ fontSize: 11, color: 'var(--muted)' }}>{candidate.institution}</span>
                  ) : null}
                </span>
              </label>
            )
          })}
        </div>

        {/* All three carry equal weight. The dialog used to open only for a single strong name match, so
            emphasizing "Map to existing account" was a real recommendation; it now opens with several
            candidates — some matching on the masked digits alone, with unrelated names — and not knowing
            which is right is the whole reason it is asking. A house favourite would also be pushing back
            against the intent that opened the dialog, since the way in is pressing `+New`. The accent has
            a better home on the selected radio, which is what the user is actually manipulating. */}
        <div style={{ display: 'grid', gap: 8 }}>
          <Tooltip describeTrigger content={needsAccount ? 'Choose which account above this one is' : ''}>
            <Button
              variant="secondary"
              disabled={needsAccount}
              onClick={() => onSelect?.('map_existing', selectedId)}
            >
              Map to existing account
            </Button>
          </Tooltip>
          {/* Grouping here is a shortcut, not a distinct concept: it is the same end state as creating
              the account and then merging it on the Accounts page, in one step instead of two. A fourth
              choice — create a separate account but dedupe it against the existing one — was removed.
              It had no analogue anywhere else in the app and asserted the two were the same physical
              account while deliberately keeping them apart; "Map to existing account" says that
              properly. Don't reintroduce it. */}
          <Tooltip describeTrigger content={needsAccount ? 'Choose which account above to group the new one under' : ''}>
            <Button
              variant="secondary"
              disabled={needsAccount}
              onClick={() => onSelect?.('group_with_existing', selectedId)}
            >
              Create new account and group with existing
            </Button>
          </Tooltip>
          <Button variant="secondary" onClick={() => onSelect?.('keep_separate')}>
            {candidates.length === 1 ? 'Keep separate' : 'Keep separate from all of these'}
          </Button>
        </div>
        <DialogActions>
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
        </DialogActions>
      </FloatingPanel>
    </OverlayBackdrop>
  )
}
