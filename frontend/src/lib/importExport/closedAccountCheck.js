// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// A mapping to a closed account is not taken as answered for a file with rows dated after the close: the
// later rows may belong to the account that replaced it, which only the person importing can say. Such a row
// shows as undecided, noting the account and its close date. Choosing the closed account again answers it for
// this import; the source keeps pointing there, so the next file with later rows asks again. Older rows are
// the closed account's own statements and need no question. The watched-folder scan parks the same files
// (`watch.py` → `_late_on_closed`); `docs/data-model.md` → *Closing an account*.

import { useEffect, useMemo, useState } from 'react'

import { api } from '../api.js'

const LATEST_DATES_DEBOUNCE_MS = 250

// `{account id → the last day it could have a row on time}`: the earlier of its own close date and its
// group's, for every account closed either way.
export function accountCloseDates(accounts) {
  const list = accounts || []
  const byId = new Map(list.map(account => [account?.id, account]))
  const dates = new Map()
  for (const account of list) {
    const own = account?.closed_on || ''
    const group = byId.get(account?.parent_account_id)?.closed_on || ''
    const closedOn = own && group ? (own < group ? own : group) : (own || group)
    if (closedOn) dates.set(account.id, closedOn)
  }
  return dates
}

// The account map with every entry that rests on a closed account the file outlasts made undecided, carrying
// `closedNote` so the row can say why. Entries the person chose in this import (`closedConfirmed`) are left
// alone. Returns the same object when nothing changes, so it can run inside a state update.
export function applyClosedAccountCheck(accountMap, latestByValue, closeDates) {
  if (!latestByValue || !closeDates.size) return accountMap
  let next = accountMap
  for (const [value, entry] of Object.entries(accountMap || {})) {
    if (!entry || entry.skip || entry.createNew || entry.closedConfirmed) continue
    const closedOn = closeDates.get(entry.accountId)
    if (!closedOn || !(String(latestByValue[value] || '') > closedOn)) continue
    if (next === accountMap) next = { ...accountMap }
    next[value] = { ...entry, accountId: '', closedNote: { accountId: entry.accountId, closedOn } }
  }
  return next
}

// The latest date each account value carries across `files`, as the import reads dates
// (`POST /import-export/preview/account-dates`), or null until it is known. Keyed `''` for a file with no
// account column. A failed request answers null, which leaves every mapping as it is.
export function useLatestAccountDates({ files, accountColumn, dateColumn, dateFormat, skipRows }) {
  const [latest, setLatest] = useState(null)
  const params = useMemo(
    () => (files?.length && dateColumn ? { accountColumn: accountColumn || '', dateColumn, dateFormat, skipRows } : null),
    [files, accountColumn, dateColumn, dateFormat, skipRows],
  )

  useEffect(() => {
    setLatest(null)
    if (!params) return undefined
    let cancelled = false
    const timer = setTimeout(async () => {
      try {
        const results = await Promise.all(files.map(file => api.previewAccountDates(file, params)))
        const merged = {}
        for (const result of results) {
          for (const [value, day] of Object.entries(result?.latest || {})) {
            if (!merged[value] || day > merged[value]) merged[value] = day
          }
        }
        if (!cancelled) setLatest(merged)
      } catch {
        if (!cancelled) setLatest(null)
      }
    }, LATEST_DATES_DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [files, params])

  return latest
}
