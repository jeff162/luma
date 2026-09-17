// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// The upload-stage UI of the import flow. By default it is a plain CSV drop zone: the dropped file's
// header is matched to a saved data source automatically (handled in ImportTab), so the user does not
// pick a source up front. The explicit data-source chooser (saved profiles / "Skip" temporary draft /
// "+ New data source") is surfaced on demand — via "Choose a data source", "Change", or "Start over" —
// and is what `chooserOpen` toggles. Purely presentational: all state and handlers live in ImportTab.

import TransientTextInput from '../TransientTextInput.jsx'
import { Spinner } from '../ui.jsx'
import { DataSourcePill } from './importPresentational.jsx'
import { DEMO_IMPORT_DISABLED_MESSAGE, MANUAL_DATA_SOURCE_VALUE } from '../../lib/importExport/constants.js'
import { useBusyIndicator } from '../../lib/useBusyIndicator.js'

export function ImportUploadStage({
  chooserOpen,
  hasSelectedSource,
  onOpenChooser,
  onCloseChooser,
  uploadUsesManualDraft,
  uploadSelectionLabel,
  profiles,
  selectedUploadSource,
  selectUploadSource,
  editingSourceNameKey,
  getSourceNameEditKey,
  sourceNameDraft,
  setSourceNameDraft,
  saveSourceName,
  setEditingSourceNameKey,
  setEditingSourceDescriptionId,
  setSourceDescriptionDraft,
  showUploadSourceCreate,
  setShowUploadSourceCreate,
  uploadSourceDraftName,
  setUploadSourceDraftName,
  createUploadDataSource,
  dropRef,
  fileInputRef,
  handleDrop,
  handleFiles,
  loading,
  demoLoaded = false,
}) {
  const busy = useBusyIndicator(loading)
  const dropEnabled = !chooserOpen && !demoLoaded
  return (
    <>
      <div style={{ width: '100%', display: 'grid', gap: 18 }}>
        {!chooserOpen && hasSelectedSource ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <div style={{ fontSize: 13, color: 'var(--muted)' }}>
              Data source:{' '}
              {uploadUsesManualDraft ? (
                <span style={{
                  color: 'var(--muted)',
                  fontWeight: 500,
                  fontStyle: 'italic',
                }}>
                  temporary draft
                </span>
              ) : editingSourceNameKey === getSourceNameEditKey('upload', selectedUploadSource) ? (
                <TransientTextInput
                  value={sourceNameDraft}
                  onChange={setSourceNameDraft}
                  onCommit={() => saveSourceName(selectedUploadSource)}
                  onCancel={() => {
                    setEditingSourceNameKey('')
                    setSourceNameDraft('')
                  }}
                  restoreOnEscape
                  placeholder="Data source name"
                  style={{
                    width: 220,
                    maxWidth: '100%',
                    background: 'var(--surface2)',
                    color: 'var(--text)',
                    border: '1px solid var(--accent)',
                    borderRadius: 999,
                    padding: '4px 10px',
                    fontSize: 12,
                    fontWeight: 600,
                    outline: 'none',
                  }}
                />
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setEditingSourceDescriptionId('')
                    setSourceDescriptionDraft('')
                    setEditingSourceNameKey(getSourceNameEditKey('upload', selectedUploadSource))
                    setSourceNameDraft(uploadSelectionLabel)
                  }}
                  style={{
                    background: 'none',
                    border: 'none',
                    padding: 0,
                    margin: 0,
                    color: 'var(--text)',
                    fontWeight: 600,
                    fontSize: 13,
                    cursor: 'pointer',
                  }}
                  title="Click to rename this data source"
                >
                  {uploadSelectionLabel}
                </button>
              )}
            </div>
            <button
              type="button"
              onClick={() => onOpenChooser?.()}
              style={{
                background: 'color-mix(in srgb, var(--surface2) 82%, var(--surface))',
                border: '1px solid var(--border)',
                borderRadius: 999,
                padding: '3px 9px',
                fontSize: 11,
                color: 'var(--muted)',
                cursor: 'pointer',
                lineHeight: 1.2,
              }}
            >
              Change
            </button>
          </div>
        ) : null}

        <div style={{ width: '100%' }}>
          <div
            ref={dropRef}
            title={demoLoaded ? DEMO_IMPORT_DISABLED_MESSAGE : undefined}
            onDragOver={e => { if (dropEnabled) e.preventDefault() }}
            onDrop={dropEnabled ? handleDrop : (e => e.preventDefault())}
            onClick={() => { if (dropEnabled) fileInputRef.current?.click() }}
            style={{
              border: `2px dashed ${dropEnabled ? 'var(--border)' : 'color-mix(in srgb, var(--border) 78%, transparent)'}`,
              borderRadius: 12,
              // Sized to sit *beside* the data-connections card rather than to fill a page on its own.
              // The generous original padding is what pushed the two below each other on an ordinary
              // window: the two ways data arrives are peers, so neither may be so tall that the layout
              // has to stack them. There is still deliberate breathing room — a drop target that reads
              // as a drop target — just not a screenful of it.
              padding: '28px 24px',
              textAlign: 'center',
              cursor: demoLoaded ? 'not-allowed' : (dropEnabled ? 'pointer' : 'default'),
              background: dropEnabled ? 'var(--surface2)' : 'color-mix(in srgb, var(--surface2) 65%, var(--surface))',
              // Nothing follows this inside the stage, and the row that hosts it owns the gap below.
              marginBottom: 0,
              opacity: dropEnabled ? 1 : 0.72,
            }}
            onMouseEnter={e => {
              if (dropEnabled) e.currentTarget.style.borderColor = 'var(--accent)'
            }}
            onMouseLeave={e => {
              e.currentTarget.style.borderColor = dropEnabled ? 'var(--border)' : 'color-mix(in srgb, var(--border) 78%, transparent)'
            }}
          >
            {chooserOpen ? (
              <div
                onClick={e => e.stopPropagation()}
                style={{ display: 'grid', justifyItems: 'center', gap: 12, width: 'min(760px, 100%)', maxWidth: '100%', margin: '0 auto 28px', textAlign: 'center', cursor: 'default' }}
              >
                <div style={{ display: 'grid', gap: 6, justifyItems: 'center' }}>
                  <div style={{
                    maxWidth: 620,
                    padding: '8px 16px',
                    borderRadius: 16,
                    border: '1px solid color-mix(in srgb, var(--border) 52%, transparent)',
                    background: 'color-mix(in srgb, #000 16%, var(--surface))',
                    fontSize: 13,
                    fontWeight: 500,
                    color: 'color-mix(in srgb, var(--text) 84%, var(--muted))',
                    lineHeight: 1.45,
                  }}>
                    {demoLoaded
                      ? DEMO_IMPORT_DISABLED_MESSAGE
                      : profiles.length === 0
                        ? 'Press Skip or add a Data Source to begin'
                        : 'Select a saved data source, create a new one, or press Skip to use a temporary draft.'}
                  </div>
                </div>
                <div style={{
                  display: 'grid',
                  gap: 12,
                  width: '100%',
                  borderRadius: 12,
                  border: '1px solid var(--border)',
                  background: 'var(--surface)',
                  padding: '14px 16px',
                  boxShadow: '0 10px 30px rgba(0,0,0,0.14)',
                }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                    Available choices
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, justifyContent: 'center' }}>
                    <DataSourcePill
                      label="Skip"
                      selected={uploadUsesManualDraft}
                      onClick={() => selectUploadSource(MANUAL_DATA_SOURCE_VALUE, { persist: false })}
                      title="Use a temporary draft instead of a saved data source"
                      showMarker={false}
                    />
                    {profiles.map(profile => (
                      <DataSourcePill
                        key={profile.id}
                        label={profile.name}
                        selected={selectedUploadSource === profile.id}
                        onClick={() => selectUploadSource(profile.id)}
                        title="Use this saved data source"
                      />
                    ))}
                    {showUploadSourceCreate ? (
                      <div style={{ display: 'inline-flex', alignItems: 'center' }}>
                        <TransientTextInput
                          value={uploadSourceDraftName}
                          onChange={setUploadSourceDraftName}
                          placeholder="Data source name"
                          onCommit={createUploadDataSource}
                          onCancel={() => {
                            setShowUploadSourceCreate(false)
                            setUploadSourceDraftName('')
                          }}
                          restoreOnEscape
                          onBlurCommit={false}
                          style={{
                            minWidth: 190,
                            background: 'var(--surface2)',
                            color: 'var(--text)',
                            border: '1px solid var(--accent)',
                            borderRadius: 999,
                            padding: '8px 14px',
                            fontSize: 13,
                            outline: 'none',
                          }}
                        />
                      </div>
                    ) : (
                      <DataSourcePill
                        label="+ New data source"
                        selected={false}
                        onClick={() => setShowUploadSourceCreate(true)}
                        title="Create a saved data source"
                        showMarker={false}
                      />
                    )}
                  </div>
                  {onCloseChooser ? (
                    <button
                      type="button"
                      onClick={() => onCloseChooser()}
                      style={{
                        justifySelf: 'center',
                        background: 'none',
                        border: 'none',
                        padding: '2px 4px',
                        fontSize: 12,
                        color: 'var(--muted)',
                        cursor: 'pointer',
                      }}
                    >
                      Cancel — just drop a file
                    </button>
                  ) : null}
                </div>
              </div>
            ) : null}
            <div style={{ fontSize: 28, marginBottom: 8 }}>{chooserOpen ? '🧭' : '📂'}</div>
            {chooserOpen ? (
              <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 6 }}>
                {demoLoaded
                  ? DEMO_IMPORT_DISABLED_MESSAGE
                  : (profiles.length === 0 ? 'Create a data source or select skip to begin' : 'Choose a data source or select skip to begin')}
              </div>
            ) : (
              // The zone itself can't be the button (the "choose a data source" button sits inside it), so the
              // heading is the keyboard-reachable browse control, and where the disabled state is announced.
              <button
                type="button"
                aria-disabled={demoLoaded || undefined}
                onClick={e => { e.stopPropagation(); if (dropEnabled) fileInputRef.current?.click() }}
                style={{
                  display: 'block', margin: '0 auto 6px', padding: 0, background: 'none', border: 'none',
                  font: 'inherit', fontSize: 15, fontWeight: 600, color: 'inherit', cursor: 'inherit',
                }}
              >
                {demoLoaded ? DEMO_IMPORT_DISABLED_MESSAGE : 'Drop CSV file(s) here, or click to browse'}
              </button>
            )}
            {!chooserOpen && !hasSelectedSource && !demoLoaded ? (
              <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                The matching data source is detected automatically or {' '}
                <button
                  type="button"
                  onClick={e => { e.stopPropagation(); onOpenChooser?.() }}
                  style={{
                    background: 'none',
                    border: 'none',
                    padding: 0,
                    fontSize: 12,
                    color: 'var(--accent2)',
                    cursor: 'pointer',
                    textDecoration: 'underline',
                  }}
                >
                  choose a data source
                </button>
              </div>
            ) : null}
            <input
              ref={fileInputRef}
              id="csv-file-input"
              type="file"
              accept=".csv"
              multiple
              style={{ display: 'none' }}
              onChange={e => {
                handleFiles(e.target.files)
                e.target.value = ''
              }}
            />
          </div>
        </div>
      </div>
      {/* Additive rather than a swap, so nothing is displaced — but a parse that returns in a few
          milliseconds would still blink a spinner into the layout and out again. */}
      {busy && <Spinner />}
    </>
  )
}
