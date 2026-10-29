// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * The filter chip for each stored thing a chip can name. The FilterBar picker builds its chips here, and a
 * saved filter rebuilds its chips here when it is applied, so a chip saved before a rename shows the name
 * the picker would show today.
 */

export const accountSelection = a => ({ type: 'account', id: a.id, label: `${a.name}${a.mask ? ` ···${a.mask}` : ''}` })
export const groupSelection = g => ({ type: 'group', id: g.id, label: g.name })
export const categorySelection = c => ({ type: 'category', id: c.id, label: c.name })
export const ownerSelection = o => ({ type: 'owner', id: o.id, label: o.name })
export const tagSelection = t => ({ type: 'tag', id: t.id, label: t.name, color: t.color })
export const attributeSelection = a => ({ type: 'attribute', id: a.key, label: a.label })
