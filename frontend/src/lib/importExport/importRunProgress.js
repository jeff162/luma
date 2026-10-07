// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// One file import with its row progress followed while it runs. The import is a single request that
// answers only at the end, so the run is given a name up front and a second request polls the backend's
// in-memory record of it (`GET /import-export/run-progress/{id}`) until the import's own response lands.
// `onProgress({ done, total })` fires only once the rows have started: the setup before them (reading the
// ledger for duplicate checks) has no count to show, and a poll that misses — the run not registered yet,
// or already finished — reports nothing rather than a guess. Once the import answers, a run that showed a
// count is reported complete, since the last poll usually landed short of the end.

import { api } from '../api.js'

export const IMPORT_PROGRESS_POLL_MS = 400

function newProgressId() {
  return `import-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export async function runImportWithProgress(file, config, onProgress, { pollMs = IMPORT_PROGRESS_POLL_MS } = {}) {
  const progressId = newProgressId()
  let finished = false
  let timer = null
  let lastTotal = null
  const poll = async () => {
    try {
      const progress = await api.getImportRunProgress(progressId)
      if (!finished && progress?.active && progress.total != null) {
        lastTotal = progress.total
        onProgress({ done: progress.done, total: progress.total })
      }
    } catch {
      // A failed poll only delays the next figure; the import's own request carries any real failure.
    }
    if (!finished) timer = setTimeout(poll, pollMs)
  }
  timer = setTimeout(poll, pollMs)
  try {
    const result = await api.runImport(file, config, { progressId })
    finished = true
    if (lastTotal != null) onProgress({ done: lastTotal, total: lastTotal })
    return result
  } finally {
    finished = true
    clearTimeout(timer)
  }
}
