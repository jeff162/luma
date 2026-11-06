// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useRef, useState } from 'react'
import { buildPastedHtmlPreview, serializeEditedPreview } from '../lib/pastedHtmlPreview.js'
import { namePastedFile, pastedTextFile } from '../lib/pastedDocuments.js'
import { Button } from './ui.jsx'
import FileInput from './FileInput.jsx'
import { PICKER_IDS } from '../lib/filePicker.js'

/*
 * Where a document is added: one box that takes a drop or a paste, with Browse… beside it.
 *
 * **One box, not a drop zone above a paste box.** Adding a document is occasional and this sits on every
 * transaction's panel, so two full-width targets were a lot of standing space for it. They combine because a
 * textarea can take a dropped file as well as a paste — while the reverse cannot hold: a paste reaches only a
 * focused editable element, and browsers offer right-click Paste only on one, so the box has to be a real
 * textarea (`ui-patterns.md` → *Dropping and pasting files*). What a textarea cannot do is open the file
 * picker on click, since a click there has to place the caret; that is why Browse… is its own button. The
 * shared `DropZone` is not used for the same reason: its whole surface is a click-to-browse button.
 *
 * **Attaching is one seam with four ways in.** A dropped file, a browsed one, a pasted image and pasted text
 * all end at `upload(file)`. A pasted image has nothing to review, so it goes straight up like a dropped
 * file. Text lands in the box first — a receipt pasted out of an email arrives wrapped in signature and
 * quoting — and a paste carrying real markup is shown as formatted, in a sandboxed preview, because that is
 * what will be stored. The preview is editable in place, so an email's signature and quoting can be cut without
 * losing its table; Convert to plain text trades the layout for text in the box, and Discard and return to
 * HTML takes that back. Every paste is named `documentation.<ext>` (see `lib/pastedDocuments.js`).
 *
 * **Uploads are shown per file, not as one busy flag.** Several files can be dropped at once and each
 * settles on its own; a failure names its file, since "that didn't work" is not actionable when three
 * things were dropped together.
 *
 * `actions` renders after Browse…, for the host's own ways in (a transaction's picker of stored documents), and
 * `commitLabel` names what keeping a reviewed paste does there.
 */
export default function DocumentAttachTarget({ upload, onUploaded, actions = null, commitLabel = 'Attach' }) {
  const inputRef = useRef(null)
  const [uploads, setUploads] = useState([])
  const [pastedText, setPastedText] = useState('')
  const [richPaste, setRichPaste] = useState(null)
  // Set while a formatted paste is being edited as plain text; `richPaste` is kept so it can be returned to.
  const [plainMode, setPlainMode] = useState(false)
  const frameRef = useRef(null)
  // Whether the preview has been edited in place. Unedited, the paste itself is what is stored.
  const frameEdited = useRef(false)
  const [dragOver, setDragOver] = useState(false)

  async function uploadFiles(files) {
    for (const file of files) {
      const key = `${file.name}-${Date.now()}-${Math.random()}`
      setUploads(prev => [...prev, { key, name: file.name, error: null }])
      try {
        const result = await upload(file)
        setUploads(prev => prev.filter(u => u.key !== key))
        await onUploaded?.(result, { file, batchSize: files.length })
      } catch (err) {
        setUploads(prev => prev.map(u => (u.key === key ? { ...u, error: err.message || 'Upload failed' } : u)))
      }
    }
  }

  // An image has nothing to review, so it uploads at once; text is left in the box (or previewed, when it
  // carries markup) to be looked at first.
  function handlePaste(event) {
    const files = Array.from(event.clipboardData?.files || [])
    if (files.length) {
      event.preventDefault()
      uploadFiles(files.map(namePastedFile))
      return
    }
    // A receipt copied out of an email carries its table as `text/html`, and the plain flavour a textarea
    // receives is that table flattened — every cell on its own line, so an amount ends up under the thing
    // it is the price of rather than beside it. So a paste with real markup is shown *as formatted* and
    // attached as such, rather than described: a note saying "the layout you cannot see will be kept"
    // left no way to know what was about to be stored.
    const html = event.clipboardData?.getData?.('text/html') || ''
    const plain = event.clipboardData?.getData?.('text/plain') || ''
    // Only when the rich flavour actually carries markup — a `text/html` flavour that is the same words
    // again would render as a web page while preserving no layout. And only into an empty box: pasting into
    // text already being edited is an insertion into that text, left to the browser.
    if (plainMode || pastedText.trim() || !plain || !/<[a-z!/]/i.test(html)) return
    event.preventDefault()
    frameEdited.current = false
    setRichPaste({ html, plain, preview: buildPastedHtmlPreview(html) })
  }

  // `designMode` makes the whole preview editable. The frame is same-origin so its edits can be read back;
  // it still runs no script, which is what keeps that safe (`lib/pastedHtmlPreview.js`).
  function enableFrameEditing() {
    const doc = frameRef.current?.contentDocument
    if (!doc) return
    doc.designMode = 'on'
    doc.addEventListener('input', () => { frameEdited.current = true })
  }

  // The edited preview, less the policy the preview added — the stored copy is served under its own.
  function currentHtml() {
    const doc = frameRef.current?.contentDocument
    if (!frameEdited.current || !doc) return richPaste.html
    return serializeEditedPreview(doc)
  }

  // Only a drag carrying files is claimed. A dragged text selection is left to the textarea, which inserts
  // it like a paste of its plain flavour — the box then holds it for review like any other text.
  function carriesFiles(event) {
    return Array.from(event.dataTransfer?.types || []).includes('Files')
  }

  // Edits to plain text have no counterpart in the markup, so this is one-way; returning discards them.
  // Edits already made in place carry over, both into the text and into the version returned to.
  function convertToPlainText() {
    const doc = frameRef.current?.contentDocument
    if (frameEdited.current && doc) {
      const html = currentHtml()
      setPastedText(doc.body.innerText ?? doc.body.textContent)
      setRichPaste({ ...richPaste, html, preview: buildPastedHtmlPreview(html) })
      frameEdited.current = false
    } else {
      setPastedText(richPaste.plain)
    }
    setPlainMode(true)
  }

  function returnToFormatted() {
    setPastedText('')
    setPlainMode(false)
  }

  function discardPaste() {
    setPastedText('')
    setRichPaste(null)
    setPlainMode(false)
    frameEdited.current = false
  }

  async function attachPaste() {
    let file
    if (richPaste && !plainMode) {
      file = pastedTextFile(currentHtml(), 'text/html')
    } else {
      const body = pastedText.trim()
      if (!body) return
      file = pastedTextFile(body)
    }
    discardPaste()
    await uploadFiles([file])
  }

  const reviewing = !!richPaste || !!pastedText.trim()

  return (
    <div style={{ display: 'grid', gap: 6 }}>
      {uploads.map(item => (
        <div key={item.key} style={{ fontSize: 12, color: item.error ? 'var(--danger)' : 'var(--muted)' }}>
          {item.error ? `${item.name} — ${item.error}` : `Uploading ${item.name}…`}
        </div>
      ))}

      {richPaste && !plainMode ? (
        // `sandbox` with only `allow-same-origin`: no scripts, so the same origin that lets its edits be read
        // back gives the pasted markup nothing to act with. The document it is given carries the rest of the
        // protection — see `lib/pastedHtmlPreview.js`. The white ground is the page an email is written
        // against; the frame is otherwise transparent, and unstyled black text on a dark theme's panel would
        // be unreadable.
        <iframe
          ref={frameRef}
          sandbox="allow-same-origin"
          srcDoc={richPaste.preview}
          onLoad={enableFrameEditing}
          aria-label="Preview of the pasted receipt"
          style={{
            width: '100%', height: 260, boxSizing: 'border-box',
            border: '1px solid var(--border)', borderRadius: 6, background: '#fff',
          }}
        />
      ) : (
        <textarea
          aria-label="Drop or paste a document"
          value={pastedText}
          onChange={e => setPastedText(e.target.value)}
          onPaste={handlePaste}
          onDragOver={e => {
            if (!carriesFiles(e)) return
            e.preventDefault()
            setDragOver(true)
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={e => {
            setDragOver(false)
            const files = Array.from(e.dataTransfer?.files || [])
            if (!files.length) return
            e.preventDefault()
            uploadFiles(files)
          }}
          placeholder="Drop or paste a receipt, invoice or saved email (.eml) here"
          rows={pastedText ? 5 : 2}
          style={{
            width: '100%', boxSizing: 'border-box', resize: 'vertical',
            background: dragOver ? 'color-mix(in srgb, var(--accent) 6%, var(--surface2))' : 'var(--surface2)',
            color: 'var(--text)',
            border: `1.5px dashed ${dragOver ? 'var(--accent)' : 'var(--border)'}`,
            borderRadius: 6, padding: '6px 8px', fontSize: 13, fontFamily: 'inherit', outline: 'none',
          }}
        />
      )}

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
        {reviewing ? (
          <>
            <Button variant="secondary" size="compact" onClick={discardPaste}>Discard</Button>
            {richPaste && !plainMode && (
              <Button variant="secondary" size="compact" onClick={convertToPlainText}>
                Convert to plain text
              </Button>
            )}
            {plainMode && (
              <Button variant="secondary" size="compact" onClick={returnToFormatted}>
                Discard and return to HTML
              </Button>
            )}
            <Button size="compact" onClick={attachPaste}>{commitLabel}</Button>
          </>
        ) : (
          <>
            <Button variant="secondary" size="compact" onClick={() => inputRef.current?.click()}>
              Browse…
            </Button>
            {actions}
          </>
        )}
      </div>
      <FileInput
        ref={inputRef}
        pickerId={PICKER_IDS.documents}
        accept="application/pdf,image/*,text/plain,text/html,message/rfc822,.eml"
        multiple
        hidden
        onChange={e => {
          uploadFiles(Array.from(e.target.files || []))
          // Cleared so choosing the same file twice in a row still fires a change event — otherwise a
          // failed upload cannot be retried by picking the identical file again.
          e.target.value = ''
        }}
      />
    </div>
  )
}
