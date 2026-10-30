// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { SegmentedToggle } from '../ui.jsx'
import { DISPLAY_SIZE_CHOICES } from '../../lib/displaySize.js'
import { useDisplaySize } from '../../lib/useDisplaySize.js'

const OPTIONS = DISPLAY_SIZE_CHOICES.map(size => ({ value: size, label: `${size}%` }))

// The whole app drawn smaller or larger on this kind of screen (`lib/useDisplaySize.js`); a choice
// applies at once.
export default function DisplaySizeSection() {
  const [displaySize, setDisplaySize] = useDisplaySize()
  return (
    <SegmentedToggle
      size="compact"
      ariaLabel="Display size"
      value={displaySize}
      options={OPTIONS}
      onChange={setDisplaySize}
    />
  )
}
