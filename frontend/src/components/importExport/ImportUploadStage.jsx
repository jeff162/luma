// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: GPL-3.0-or-later

// The upload-stage UI of the import flow: the data-source chooser (saved
// profiles / "Skip" temporary draft / "+ New data source") and the CSV drop
// zone, plus the inline rename of the selected source. Purely presentational —
// all state and handlers live in ImportTab and are passed in as props; this
// component only renders them and forwards the drop-zone / file-input refs.

import TransientTextInput from '../TransientTextInput.jsx'
import { Spinner } from '../ui.jsx'
import { DataSourcePill } from './importPresentational.jsx'
import { MANUAL_DATA_SOURCE_VALUE } from '../../lib/importExport/constants.js'

export function ImportUploadStage({
  uploadChoiceReady,
  uploadUsesManualDraft,
  uploadSelectionLabel,
  isFirstRunSourceChoice,
  profiles,
  selectedUploadSource,
  selectUploadSource,
  setSelectedUploadSource,
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
  handleFile,
  loading,
}) {
  return (
        <>
          <div style={{ width: '100%', display: 'grid', gap: 18 }}>
            {uploadChoiceReady ? (
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
                  onClick={() => {
                    setSelectedUploadSource('')
                    setShowUploadSourceCreate(false)
                    setUploadSourceDraftName('')
                  }}
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
                onDragOver={e => { if (uploadChoiceReady) e.preventDefault() }}
                onDrop={handleDrop}
                onClick={() => { if (uploadChoiceReady) fileInputRef.current?.click() }}
                style={{
                  border: `2px dashed ${uploadChoiceReady ? 'var(--border)' : 'color-mix(in srgb, var(--border) 78%, transparent)'}`,
                  borderRadius: 12,
                  padding: '48px 32px',
                  textAlign: 'center',
                  cursor: uploadChoiceReady ? 'pointer' : 'default',
                  background: uploadChoiceReady ? 'var(--surface2)' : 'color-mix(in srgb, var(--surface2) 65%, var(--surface))',
                  marginBottom: 24,
                  opacity: uploadChoiceReady ? 1 : 0.72,
                }}
                onMouseEnter={e => {
                  if (uploadChoiceReady) e.currentTarget.style.borderColor = 'var(--accent)'
                }}
                onMouseLeave={e => {
                  e.currentTarget.style.borderColor = uploadChoiceReady ? 'var(--border)' : 'color-mix(in srgb, var(--border) 78%, transparent)'
                }}
              >
                {!uploadChoiceReady ? (
                  <div style={{ display: 'grid', justifyItems: 'center', gap: 12, width: 'min(760px, 100%)', maxWidth: '100%', margin: '0 auto 28px', textAlign: 'center' }}>
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
                        {profiles.length === 0
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
                      {profiles.length > 0 ? (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, justifyContent: 'center' }}>
                          <DataSourcePill
                            label="Skip"
                            selected={uploadUsesManualDraft}
                            onClick={() => selectUploadSource(MANUAL_DATA_SOURCE_VALUE, { persist: false })}
                            title="Use a temporary draft instead of a saved data source"
                            showMarker={false}
                            emphasis={isFirstRunSourceChoice ? 'recommended' : 'normal'}
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
                              emphasis={isFirstRunSourceChoice ? 'secondary' : 'normal'}
                            />
                          )}
                        </div>
                      ) : (
                        <div style={{ display: 'grid', justifyItems: 'center', gap: 12 }}>
                          <div style={{ width: '100%', textAlign: 'center', fontSize: 13, color: 'var(--muted)' }}>
                            {'<'}<span style={{ fontStyle: 'italic' }}>empty</span>{'>'}
                          </div>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, width: '100%', justifyContent: 'center' }}>
                            <DataSourcePill
                              label="Skip"
                              selected={uploadUsesManualDraft}
                              onClick={() => selectUploadSource(MANUAL_DATA_SOURCE_VALUE, { persist: false })}
                              title="Use a temporary draft instead of a saved data source"
                              showMarker={false}
                              emphasis={isFirstRunSourceChoice ? 'recommended' : 'normal'}
                            />
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
                                emphasis={isFirstRunSourceChoice ? 'secondary' : 'normal'}
                              />
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                ) : null}
                <div style={{ fontSize: 32, marginBottom: 12 }}>{uploadChoiceReady ? '📂' : '🧭'}</div>
                <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 6 }}>
                  {uploadChoiceReady ? 'Drop a CSV file here, or click to browse' : (profiles.length === 0 ? 'Create a data source or select skip to begin' : 'Choose a data source or select skip to begin')}
                </div>
                <input
                  ref={fileInputRef}
                  id="csv-file-input"
                  type="file"
                  accept=".csv"
                  style={{ display: 'none' }}
                  onChange={e => {
                    handleFile(e.target.files[0])
                    e.target.value = ''
                  }}
                />
              </div>
            </div>
          </div>
          {loading && <Spinner />}
        </>
  )
}
