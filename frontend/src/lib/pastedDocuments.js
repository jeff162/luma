// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * Names for documents that arrive by paste, which carry no useful name of their own.
 *
 * A pasted image is named by the browser — "image.png" in Chromium, "blob" or nothing elsewhere — and pasted
 * text has no file at all. Every one of them is named `documentation.<extension>`: neutral, because a paste
 * could be a receipt, an invoice or a confirmation and the name should not guess, and the extension already
 * says what kind of thing it is. The date the old names carried is not needed to tell pastes apart now that a
 * document can be renamed. A *file* that was copied and pasted keeps its own name, which is why a pasted
 * image is renamed only when its name is one of the placeholders.
 */

export const PASTED_DOCUMENT_BASENAME = 'documentation'

const IMAGE_EXTENSIONS = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/tiff': 'tif',
}

// The names browsers give clipboard image data, as opposed to a real file copied from a file manager.
function isPlaceholderName(name) {
  return !name || name === 'blob' || /^image\.[a-z0-9]+$/i.test(name)
}

// The File to upload for a pasted file: renamed when the browser only gave it a placeholder.
export function namePastedFile(file) {
  if (!isPlaceholderName(file.name)) return file
  const fromName = /\.([a-z0-9]+)$/i.exec(file.name || '')?.[1]
  const extension = IMAGE_EXTENSIONS[file.type] || fromName?.toLowerCase() || 'png'
  return new File([file], `${PASTED_DOCUMENT_BASENAME}.${extension}`, { type: file.type })
}

// Pasted text as a File: `text/plain` as it stands in the box, or the rich flavour kept as HTML.
export function pastedTextFile(content, type = 'text/plain') {
  const extension = type === 'text/html' ? 'html' : 'txt'
  return new File([content], `${PASTED_DOCUMENT_BASENAME}.${extension}`, { type })
}
