// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * Telling a split *transaction* row from one of its expanded *part* rows.
 *
 * A category-scoped list asks the server for the expanded row source, which yields one row per
 * allocation carrying the part's category and amount — but the transaction's own `is_split`, since the
 * flag is a property of the purchase. A renderer keying on `is_split` alone therefore treats a single
 * $10 allocation as the whole $250 split: it labels the row "Split (2)" and hovers the entire
 * allocation set, on a row whose amount is one part's. `split_part_id` (projected by the seam, see
 * backend/services/txn_splits.py) is the field that separates the two cases, and these helpers are
 * where that test is written down once.
 *
 * The unexpanded ledger is unaffected: nothing matched a part there, so `split_part_id` is null and a
 * split still renders once, at its full amount, as "Split (N)".
 */

/** Is this row one expanded allocation rather than a whole transaction? */
export function isSplitPartRow(txn) {
  return Boolean(txn?.is_split && txn?.split_part_id)
}

/** The key a windowed list identifies this row by.
 *
 * `id` alone is not one when the rows are expanded: two allocations of the same transaction may name
 * the same category — the split rules permit it, since parts record items and two items bought together
 * can classify alike — and would then arrive as two rows with one key. The virtualizer caches heights
 * and React reconciles children by key, so the pair collapses into one item. Two parts alike in
 * category *and* amount are not even distinguishable by value, so the part id is the only honest answer.
 */
export function transactionRowKey(txn) {
  return isSplitPartRow(txn) ? `${txn.id}:${txn.split_part_id}` : txn.id
}

/** The label of the allocation this part row is, or '' — a whole transaction, or a part left unlabelled.
 *
 * Found among the row's own `split_parts` by `split_part_id`, which the list payload already carries, so
 * showing it costs no request.
 */
export function splitPartLabel(txn) {
  if (!isSplitPartRow(txn)) return ''
  return (txn.split_parts || []).find(part => part.id === txn.split_part_id)?.label || ''
}

/** What the whole transaction behind a part row looks like: `{ partCount, total }`.
 *
 * `total` is summed from the allocations rather than read off the row, because an expanded row's
 * `amount` is the part's. The sum is exact — the split invariant is that the parts add up to the
 * transaction — so this needs no extra field from the server. Returns `total: null` when the row
 * arrived without its parts, so callers can fall back rather than print a confident 0.
 */
export function splitPartSummary(txn) {
  const parts = txn?.split_parts || []
  if (!parts.length) return { partCount: txn?.split_part_count || 0, total: null }
  const total = parts.reduce((sum, part) => sum + (Number(part.amount) || 0), 0)
  return { partCount: txn?.split_part_count || parts.length, total: Math.round(total * 100) / 100 }
}

/** This row as the transaction it belongs to, for anything that needs the purchase rather than the part.
 *
 * The split editor is the case: it reconciles the allocations against `txn.amount`, and an expanded row
 * carries the part's. Handed one straight it would show a $10 transaction whose parts sum to $250 and
 * refuse to save. Only the amount is restored — the row is split, so the editor loads the allocations
 * from the server and never reads the retained `category_id` the seam has substituted.
 */
export function wholeTransactionRow(txn) {
  if (!isSplitPartRow(txn)) return txn
  const { total } = splitPartSummary(txn)
  return total == null ? txn : { ...txn, amount: total, split_part_id: null }
}

/** The categories a whole split touches, as one cell: `Groceries / Hardware`.
 *
 * For a copied or shared list, which is read by a person: a split row's own `category_name` is the
 * category it carried *before* it was split (kept only so un-splitting can restore it), so printing that
 * names a category the transaction is no longer in. Naming all of them says what actually happened.
 *
 * Repeats collapse, because two items in one category is an ordinary split rather than something the
 * reader needs told twice, and a name containing the separator is quoted so the list stays readable as
 * a list. Order is the items' own, matching the split editor and the row's hover.
 *
 * Empty when the row is not a whole split, or arrived without its allocations — the caller then says
 * whatever it says for an ordinary row.
 */
export function splitCategoryNames(txn) {
  if (!txn?.is_split || isSplitPartRow(txn)) return ''
  const names = []
  for (const part of txn.split_parts || []) {
    const name = part?.category_name || 'Uncategorized'
    if (!names.includes(name)) names.push(name)
  }
  return names.map(name => (name.includes('/') ? `"${name}"` : name)).join(' / ')
}
