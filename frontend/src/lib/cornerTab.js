// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * The geometry of a tab set into one corner of a card (`components/CornerTab.jsx`): placed over the card's
 * border, with its outer corner and the diagonally opposite one rounded to the card's radius. Kept apart
 * from the component so a host drawing a different control in the corner can take the geometry alone.
 */

const RADIUS_BY_CORNER = {
  // CSS order: top-left, top-right, bottom-right, bottom-left.
  'top-left': r => `${r}px 0 ${r}px 0`,
  'top-right': r => `0 ${r}px 0 ${r}px`,
  'bottom-right': r => `${r}px 0 ${r}px 0`,
  'bottom-left': r => `0 ${r}px 0 ${r}px`,
}

export function cornerTabStyle({ corner, radius }) {
  const [vertical, horizontal] = corner.split('-')
  return {
    position: 'absolute',
    [vertical]: -1,
    [horizontal]: -1,
    borderRadius: RADIUS_BY_CORNER[corner](radius),
  }
}
