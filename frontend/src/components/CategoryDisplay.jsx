// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Badge } from './ui.jsx'

export default function CategoryDisplay({
  id,
  name,
  emptyLabel = 'Uncategorized',
  emptyFontSize = 13,
  faceClassName,
}) {
  if (name) {
    return <Badge label={name} toneKey={id || name} className={faceClassName} />
  }

  return <span style={{ color: 'var(--muted)', fontSize: emptyFontSize }}>{emptyLabel}</span>
}
