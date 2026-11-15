// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Toggle } from '../ui.jsx'
import { useShowAdminFeaturesPreference } from '../../lib/adminFeatures.js'

export default function AdminFeaturesSection() {
  const [showAdminFeatures, setShowAdminFeatures] = useShowAdminFeaturesPreference()
  return (
    <Toggle
      checked={showAdminFeatures !== false}
      onChange={setShowAdminFeatures}
      label="Show administration features"
    />
  )
}
