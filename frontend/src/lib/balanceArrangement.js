// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { balanceTypeColor, balanceTypeLabel, groupByType } from './balanceTotals.js'
import { formatSignedMoneyAmount } from './moneyDisplay.js'
import { buildTableShare } from './transactionShare.js'

/*
 * The Balances table's arrangement: the user's own layout of the account table, saved as one preference
 * per user covering every account. It is layout only: the charts keep one group per type however the table
 * is split.
 *
 * What is saved is a list of sections, each `{ id, type, note, accounts, collapsed }`, `accounts` being
 * account ids in order. The id is a section's identity, so its note and collapsed state stay with it
 * whichever account heads it. The list always describes a table that can be drawn:
 *
 * - A section holds accounts of its own type only, since its subtotal adds a Change column that runs in
 *   each type's own direction (`describeBalanceChange`).
 * - A section is never merged with a neighbour, even one of its type, and one left with no accounts is
 *   removed.
 * - The owner filters only leave rows out. An account not shown keeps its place, and a drop is placed
 *   beside the shown rows it fell between (`after` the one above, or failing that `before` the one below).
 *   Only an account that no longer exists loses its place: one missing from the server's list of every
 *   account (`existing_account_ids`, which no filter narrows).
 * - An account the list does not hold yet, or one whose type has changed, joins the end of the last section
 *   of its type, or a new section at the end when its type has none.
 *
 * With nothing saved the arrangement is the table grouped by type (`groupByType`), one section per type, its
 * accounts in the order the server sends them (by name).
 */
export const BALANCE_ARRANGEMENT_PREF_KEY = 'ui.dashboard.balanceArrangement'

export function makeSectionId() {
  return `bs_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

// A section created while resolving takes its type as its id. That is unique: such a section is only created
// for a type that has none, and a section's type never changes.
function section(id, type, accounts) {
  return { id, type, note: '', accounts, collapsed: false }
}

export function defaultArrangement(accounts) {
  return groupByType(accounts).map(group => section(group.type, group.type, group.accounts.map(a => a.account_id)))
}

/*
 * The saved arrangement brought up to date with the accounts shown and `existingIds`, the ids of every
 * account that exists (without them every saved place is kept, rather than every one lost): `arrangement`,
 * the list to save from on the next change, and `sections`, the ones to draw, each with its label, colour
 * and shown accounts.
 */
export function resolveArrangement(saved, accounts, existingIds) {
  const shown = new Map(accounts.map(a => [a.account_id, a]))
  const arrangement = Array.isArray(saved)
    ? fromSaved(saved, accounts, shown, existingIds ? new Set(existingIds) : null)
    : defaultArrangement(accounts)
  const sections = arrangement
    .map(s => ({
      ...s,
      label: balanceTypeLabel(s.type),
      color: balanceTypeColor(s.type),
      accounts: s.accounts.map(id => shown.get(id)).filter(Boolean),
    }))
    .filter(s => s.accounts.length)
  return { arrangement, sections }
}

function fromSaved(saved, accounts, shown, existing) {
  const placed = new Set()
  const ids = new Set()
  const sections = []
  for (const s of saved) {
    if (!s || typeof s.id !== 'string' || ids.has(s.id) || typeof s.type !== 'string' || !Array.isArray(s.accounts)) continue
    const held = s.accounts.filter(id => {
      const account = shown.get(id)
      if (placed.has(id) || (existing && !existing.has(id)) || (account && account.type !== s.type)) return false
      placed.add(id)
      return true
    })
    if (!held.length) continue
    ids.add(s.id)
    sections.push({ id: s.id, type: s.type, note: typeof s.note === 'string' ? s.note : '', accounts: held, collapsed: !!s.collapsed })
  }
  for (const account of accounts) {
    if (placed.has(account.account_id)) continue
    placed.add(account.account_id)
    const home = sections.findLast(s => s.type === account.type)
    if (home) home.accounts = [...home.accounts, account.account_id]
    else sections.push(section(account.type, account.type, [account.account_id]))
  }
  return sections
}

// Where a drop lands in `list`: after the shown item above it, or failing that before the one below, or at
// the end.
function dropIndex(list, { after, before }) {
  if (after != null && list.includes(after)) return list.indexOf(after) + 1
  if (before != null && list.includes(before)) return list.indexOf(before)
  return list.length
}

export function setSectionCollapsed(arrangement, sectionId, collapsed) {
  return arrangement.map(s => (s.id === sectionId ? { ...s, collapsed } : s))
}

export function setSectionNote(arrangement, sectionId, note) {
  return arrangement.map(s => (s.id === sectionId ? { ...s, note: note.trim() } : s))
}

/*
 * An account moved by a drop. `drop` is either `{ section, after, before }`, among a section's rows (`after`
 * and `before` account ids, both absent for its end), or `{ after, before }` with no section, between
 * sections (section ids), which starts a new section of the account's type there.
 *
 * Among its own type's rows the account joins that section at that place. Among another type's rows it
 * splits the section: the upper part keeps its id, note and state, the account starts a section of its own
 * type, and the lower part takes a new id, open and with no note. At either end of that section there is
 * nothing to split, and the section stays whole beside the new one.
 *
 * An account alone in its section, dropped between sections just above or below it, would only replace the
 * section with a new one that had lost its note, so that drop changes nothing.
 */
export function moveAccount(arrangement, accountId, drop, newId = makeSectionId) {
  const from = arrangement.find(s => s.accounts.includes(accountId))
  if (!from || drop.after === accountId || drop.before === accountId) return arrangement
  if (drop.section == null && from.accounts.length === 1
    && dropIndex(arrangement.filter(s => s !== from).map(s => s.id), drop) === arrangement.indexOf(from)) {
    return arrangement
  }
  const sections = arrangement.map(s => (s === from ? { ...s, accounts: s.accounts.filter(id => id !== accountId) } : s))
  if (drop.section == null) {
    sections.splice(dropIndex(sections.map(s => s.id), drop), 0, section(newId(), from.type, [accountId]))
    return sections.filter(s => s.accounts.length)
  }
  const index = sections.findIndex(s => s.id === drop.section)
  if (index < 0) return arrangement
  const target = sections[index]
  const at = dropIndex(target.accounts, drop)
  if (target.type === from.type) {
    sections[index] = { ...target, accounts: [...target.accounts.slice(0, at), accountId, ...target.accounts.slice(at)] }
  } else if (at === 0 || at === target.accounts.length) {
    return moveAccount(arrangement, accountId, at ? { after: target.id } : { before: target.id }, newId)
  } else {
    sections.splice(index, 1,
      { ...target, accounts: target.accounts.slice(0, at) },
      section(newId(), from.type, [accountId]),
      section(newId(), target.type, target.accounts.slice(at)))
  }
  return sections.filter(s => s.accounts.length)
}

// Whether two arrangements describe the same table, so a drop that would change nothing is not offered.
export function sameArrangement(a, b) {
  return a === b || JSON.stringify(a) === JSON.stringify(b)
}

// A section moved by its heading, which drops only between sections: `drop` is `{ after, before }`, section ids.
export function moveSection(arrangement, sectionId, drop) {
  const moved = arrangement.find(s => s.id === sectionId)
  if (!moved || drop.after === sectionId || drop.before === sectionId) return arrangement
  const sections = arrangement.filter(s => s !== moved)
  sections.splice(dropIndex(sections.map(s => s.id), drop), 0, moved)
  return sections
}

// A type's shown accounts in the arranged order, across every section of the type: the drilled table's rows.
export function arrangedAccountsOfType(sections, type) {
  return sections.filter(s => s.type === type).flatMap(s => s.accounts)
}

/*
 * Where a drag over the table would drop, from the rows as laid out in edit mode, where every section is
 * open. `layout` is the sections in order, each `{ id, type, top, bottom, headingBottom, rows }`: the top of
 * its heading, the bottom of its last row, and its rows' `{ id, top, bottom }`, all on one vertical axis with
 * `y`. Each returns `{ drop, line, indented, newSection }`: the drop for `moveAccount` or `moveSection`, the
 * position of the line that marks it, whether that line is indented with a section's rows, and whether the
 * drop starts a new section.
 *
 * An account over a section's rows lands between the two nearest it, and goes on landing at the section's
 * end until about half a row past it; below that, and above the first section, it lands between sections.
 * Over another type's rows it splits that section, so it starts a new section there too.
 */
export function accountDropAt(layout, y, accountType) {
  for (let i = 0; i < layout.length; i++) {
    const s = layout[i]
    const next = layout[i + 1]
    const headingMid = (s.top + s.headingBottom) / 2
    if (i === 0 && y < headingMid) return { drop: { before: s.id }, line: s.top - 3, indented: false, newSection: true }
    const rowHeight = s.rows.length ? (s.bottom - s.rows[0].top) / s.rows.length : s.bottom - s.top
    if (y <= s.bottom + rowHeight / 2) {
      const index = s.rows.findIndex(row => (row.top + row.bottom) / 2 > y)
      const above = index < 0 ? s.rows[s.rows.length - 1] : s.rows[index - 1]
      const below = index < 0 ? null : s.rows[index]
      return {
        drop: { section: s.id, after: above?.id, before: below?.id },
        line: below ? ((above ? above.bottom : s.headingBottom) + below.top) / 2 : next ? (s.bottom + next.top) / 2 : s.bottom + 6,
        indented: true,
        newSection: s.type !== accountType,
      }
    }
    if (!next || y < (next.top + next.headingBottom) / 2) {
      return { drop: { after: s.id }, line: next ? (s.bottom + next.top) / 2 : s.bottom + rowHeight, indented: false, newSection: true }
    }
  }
  return null
}

// A section dragged by its heading lands between the sections nearest the pointer.
export function sectionDropAt(layout, y) {
  const index = layout.findIndex(s => (s.top + s.bottom) / 2 > y)
  if (index < 0) {
    const last = layout[layout.length - 1]
    return last ? { drop: { after: last.id }, line: last.bottom + 3, indented: false, newSection: false } : null
  }
  const s = layout[index]
  const line = index ? (layout[index - 1].bottom + s.top) / 2 : s.top - 3
  return { drop: { before: s.id }, line, indented: false, newSection: false }
}

/*
 * The Balances table as copied (`copyShare`), for a document or a spreadsheet alike: one row per account in
 * the arranged order, its section's heading as its type, and the balance columns only (`columns` as the
 * table takes them). A Change figure is an arrow and an amount, which reads well and is no use in a
 * spreadsheet, while a balance keeps its sign in both. There is no subtotal row, so a column can be summed,
 * and so a collapsed section's accounts are included: nothing else would stand for them.
 */
export function balanceTableCopy(sections, columns) {
  const figures = columns.filter(col => !col.change)
  const heading = section => (section.note ? `${section.label} · ${section.note}` : section.label)
  return buildTableShare(
    [{ label: 'Type' }, { label: 'Account' }, ...figures.map(col => ({ label: col.label, align: 'right', numeric: true }))],
    sections.flatMap(section => section.accounts.map(account => [
      heading(section),
      account.name,
      ...figures.map(col => {
        const value = col.of(account)
        return value == null ? '' : formatSignedMoneyAmount(value)
      }),
    ])),
  )
}
