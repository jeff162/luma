// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// Small confirmation/choice dialogs for the import flow, each driven entirely by
// props from ImportTab:
//   - DataSourceMismatchDialog: a saved profile's header signature differs from
//     the dropped file; offers OK / change source / cancel, with an inline
//     data-source chooser sub-state.
//   - CompatibleBatchAttachDialog: a just-saved profile looks compatible with
//     existing uncategorized imports; offers to attach them or leave them.
//   - DuplicateImportConfirmDialog: confirm re-importing N skipped duplicate rows.
//   - PossibleAccountMatchChooserDialog: a new CSV account value looks like an
//     existing account; pick map / group / compare-only / keep-separate.

import { useEffect, useRef } from 'react'
import {
  Button,
  DialogActions,
  FloatingPanel,
  FloatingPanelHeader,
  OverlayBackdrop,
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
                <div style={{ fontSize: 16, fontWeight: 600 }}>Mismatch detected</div>
                <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4, lineHeight: 1.5 }}>
                  <span style={{ color: 'var(--text)', fontWeight: 600 }}>{profileName}</span> has a different header signature and may not match this file.
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
            <DialogActions align="center">
              <Button variant="ghost" onClick={onCloseChooser}>
                Back
              </Button>
            </DialogActions>
          </>
        ) : (
          <DialogActions align="center">
            <Button variant="ghost" onClick={onChangeDataSource}>
              Change data source
            </Button>
            <Button variant="ghost" onClick={onConfirm}>
              OK
            </Button>
            <Button variant="ghost" onClick={onCancel}>
              Cancel
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
        <DialogActions align="center">
          <Button variant="ghost" onClick={onCancel}>
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
        <DialogActions align="center">
          <Button variant="ghost" onClick={onCancel}>Cancel</Button>
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
          <Button variant="ghost" onClick={onCancel} disabled={attaching}>
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

export function DuplicateImportConfirmDialog({
  pending,
  importing = false,
  onCancel,
  onConfirm,
}) {
  const dialogRef = useRef(null)

  useEffect(() => {
    dialogRef.current?.focus()
  }, [])

  if (!pending) return null

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
          if (event.key === 'Enter') {
            event.preventDefault()
            event.stopPropagation()
          }
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            onCancel?.()
          }
        }}
        style={{
          width: 'min(360px, calc(100% - 48px))',
          border: '1px solid color-mix(in srgb, var(--accent) 28%, var(--border))',
          padding: '18px 18px 16px',
          display: 'grid',
          gap: 10,
          outline: 'none',
        }}
      >
        <div style={{ fontSize: 16, fontWeight: 600, textAlign: 'center' }}>Confirm import?</div>
        <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.6, textAlign: 'center' }}>
          {pending.importAll
            ? `Import all ${pending.count} row${pending.count === 1 ? '' : 's'}?`
            : `Import ${pending.count} selected row${pending.count === 1 ? '' : 's'}?`}
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap', marginTop: 2 }}>
          <Button small variant="ghost" onClick={onCancel} disabled={importing}>
            Cancel
          </Button>
          <Button small variant="ghost" onClick={onConfirm} disabled={importing}>
            {importing ? 'Importing…' : 'Import duplicates'}
          </Button>
        </div>
      </FloatingPanel>
    </OverlayBackdrop>
  )
}

export function PossibleAccountMatchChooserDialog({
  pending,
  onSelect,
  onCancel,
}) {
  const dialogRef = useRef(null)

  useEffect(() => {
    dialogRef.current?.focus()
  }, [])

  if (!pending) return null

  const targetLabel = pending.targetLabel || 'the existing account'

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
            “{pending.csvValue}” looks like it may be the same real-world account as “{targetLabel}”.
          </div>
        </div>
        <div style={{ display: 'grid', gap: 8 }}>
          <Button onClick={() => onSelect?.('map_existing')}>
            Map to existing account
          </Button>
          <Button variant="ghost" onClick={() => onSelect?.('group_with_existing')}>
            Create new account and group with existing
          </Button>
          <Button variant="ghost" onClick={() => onSelect?.('duplicate_compare_only')}>
            Create new account, but use existing account for duplicate detection
          </Button>
          <Button variant="ghost" onClick={() => onSelect?.('keep_separate')}>
            Keep separate
          </Button>
        </div>
        <DialogActions>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        </DialogActions>
      </FloatingPanel>
    </OverlayBackdrop>
  )
}
