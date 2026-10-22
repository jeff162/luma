// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// Spreading a split's unallocated remainder across its parts in proportion to what each already holds —
// the usual way tax and shipping get folded into item prices typed in before them.
//
// Worked in whole cents, and the cents rounding leaves over go one each to the parts rounding shorted
// most (largest remainder), so the result always adds up to the transaction exactly. Rounding each share
// on its own would leave a penny over or short often enough to keep Save unavailable for no visible
// reason.

// Takes the parts' amounts as numbers and the remainder to spread (negative when the parts are over).
// Returns the new amounts, or null when there is nothing to weigh by: no part holds an amount, or the
// amounts cancel to zero. A part holding nothing stays at zero.
export function distributeRemainder(amounts, remainder) {
  const weights = amounts.map(a => Math.round(a * 100))
  const weightTotal = weights.reduce((sum, w) => sum + w, 0)
  if (weightTotal === 0) return null
  const target = weightTotal + Math.round(remainder * 100)
  const exact = weights.map(w => (w * target) / weightTotal)
  const cents = exact.map(Math.floor)
  let leftover = target - cents.reduce((sum, c) => sum + c, 0)
  // Ties go to the earlier part, so the same input always lands the same way.
  const order = exact
    .map((value, i) => ({ i, fraction: value - cents[i] }))
    .filter(({ i }) => weights[i] !== 0)
    .sort((a, b) => b.fraction - a.fraction || a.i - b.i)
  for (const { i } of order) {
    if (leftover <= 0) break
    cents[i] += 1
    leftover -= 1
  }
  return cents.map(c => c / 100)
}
