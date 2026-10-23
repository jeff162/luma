// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useRef, useState } from 'react'
import FileInput from './FileInput.jsx'

/*
 * The shared click-or-drop file target.
 *
 * Several surfaces have wanted "a dashed box you can click or drop files onto" — the CSV import upload
 * stage, the Amazon import, and attaching a document to a transaction — and `ui-patterns.md` asks for
 * drop zones to look and behave alike. What is shared here is deliberately only the *target*: the hover and
 * drag-over affordance, click-to-browse, and handing the caller a `FileList`. Everything about what the
 * files then mean stays with the caller, which is why the CSV stage (entangled with data-source
 * detection and a chooser rendered inside its own zone) keeps its own and is not forced through this.
 * Documents left it too, for a paste box that also takes drops — a click there has to place the caret,
 * so the whole surface cannot be a browse button (`DocumentAttachTarget`). The Amazon import was its
 * last user and now takes its files from the CSV stage's zone, so nothing mounts this at present; it
 * stays as the target the next plain file drop should use.
 *
 * `children` is the label, so a caller can say what it wants dropped rather than being handed generic
 * copy — the one thing these zones genuinely disagree about. `pickerId` names what the files are for, so
 * the picker reopens where the last ones came from (`FileInput`).
 */
export default function DropZone({
  onFiles,
  pickerId,
  accept,
  multiple = false,
  disabled = false,
  title,
  padding = '30px 16px',
  children,
}) {
  const inputRef = useRef(null)
  const [dragOver, setDragOver] = useState(false)

  function handleFiles(fileList) {
    if (!fileList?.length) return
    onFiles(multiple ? Array.from(fileList) : [fileList[0]])
  }

  return (
    <div
      // A button rather than a bare div: this is a click target, so it has to be reachable and operable
      // without a mouse. The file input below is the only thing that can actually open a picker, which
      // is why the visible control delegates to it rather than being one.
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled || undefined}
      title={title}
      onClick={() => { if (!disabled) inputRef.current?.click() }}
      onKeyDown={e => {
        if (disabled) return
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          inputRef.current?.click()
        }
      }}
      onDragOver={e => { if (!disabled) { e.preventDefault(); setDragOver(true) } }}
      onDragLeave={() => setDragOver(false)}
      onDrop={e => {
        e.preventDefault()
        setDragOver(false)
        if (!disabled) handleFiles(e.dataTransfer?.files)
      }}
      style={{
        border: `1.5px dashed ${dragOver && !disabled ? 'var(--accent)' : 'var(--border)'}`,
        borderRadius: 8,
        padding,
        textAlign: 'center',
        cursor: disabled ? 'not-allowed' : 'pointer',
        background: dragOver && !disabled ? 'color-mix(in srgb, var(--accent) 6%, transparent)' : 'transparent',
        color: 'var(--muted)',
        fontSize: 13,
        opacity: disabled ? 0.6 : 1,
      }}
    >
      {children}
      <FileInput
        ref={inputRef}
        pickerId={pickerId}
        accept={accept}
        multiple={multiple}
        hidden
        onChange={e => {
          handleFiles(e.target.files)
          // Cleared so choosing the same file twice in a row still fires a change event — otherwise a
          // failed upload cannot be retried by picking the identical file again.
          e.target.value = ''
        }}
      />
    </div>
  )
}
