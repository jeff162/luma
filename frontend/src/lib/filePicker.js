// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// The browser's file pickers, opened so each purpose reopens in the folder last used for it.
//
// A plain `<input type="file">` opens wherever the browser last picked anything on this site, so choosing a
// backup and then a CSV statement makes the next backup restore start among the statements. The File System
// Access pickers (`showOpenFilePicker`, `showSaveFilePicker`) take an `id` and remember a folder per id,
// shared between opening and saving. They exist in Chromium only, and only in a secure context (localhost or
// HTTPS), so every caller keeps the plain path as its fallback; there, nothing is remembered per purpose.
// The browser keeps the folder to itself: the page never learns a path, only the name of the chosen file.
//
// Each purpose's id is one of `PICKER_IDS`, which is the whole list, because the browser remembers a
// limited number of ids per site and drops the oldest past that.

export const PICKER_IDS = {
  backupRestore: 'backup-restore',
  backupSave: 'backup-save',
  backupPrivateKey: 'backup-private-key',
  backupPublicKey: 'backup-public-key',
  statementImport: 'statement-import',
  amazonImport: 'amazon-import',
  documents: 'documents',
  importProfileSample: 'import-profile-sample',
}

export function canOpenWithPicker() {
  return typeof window !== 'undefined' && typeof window.showOpenFilePicker === 'function'
}

export function canSaveWithPicker() {
  return typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function'
}

function isCancel(error) {
  return error?.name === 'AbortError'
}

// An `accept` attribute as the pickers' `types`. MIME types (wildcards included) keep their own entries;
// bare extensions have no MIME type to sit under, so they share `application/octet-stream`. The picker
// still offers "All files" beside the filter, as the plain input does.
export function pickerTypes(accept) {
  const tokens = String(accept || '').split(',').map(t => t.trim().toLowerCase()).filter(Boolean)
  if (!tokens.length) return undefined
  const map = {}
  const extensions = tokens.filter(t => t.startsWith('.'))
  for (const t of tokens) if (!t.startsWith('.') && t.includes('/')) map[t] = []
  if (extensions.length) map['application/octet-stream'] = extensions
  return [{ accept: map }]
}

// Files chosen with the open picker: an array (empty when cancelled), or null when this browser has no
// picker and the caller should open its plain input instead.
export async function openFiles({ id, accept, multiple = false }) {
  if (!canOpenWithPicker()) return null
  try {
    const handles = await window.showOpenFilePicker({ id, multiple, types: pickerTypes(accept) })
    return Promise.all(handles.map(h => h.getFile()))
  } catch (error) {
    if (isCancel(error)) return []
    throw error
  }
}

// A file to save into, chosen before anything is fetched: the picker has to open while the click that
// asked for it still counts as one. Returns the handle, `undefined` when cancelled, or null when this
// browser has no picker and the caller should download instead.
export async function chooseSaveFile({ id, suggestedName, accept }) {
  if (!canSaveWithPicker()) return null
  try {
    return await window.showSaveFilePicker({ id, suggestedName, types: pickerTypes(accept) })
  } catch (error) {
    if (isCancel(error)) return undefined
    throw error
  }
}

// The save picker can leave the chosen file in place, empty, before anything is written to it, so a save
// that then fails would otherwise leave an empty file where the user expects a backup. `remove()` arrived
// later than the pickers; where it is missing the empty file stays.
export async function discardSaveFile(handle) {
  try {
    await handle.remove?.()
  } catch {
    // Nothing more can be done from the page.
  }
}
