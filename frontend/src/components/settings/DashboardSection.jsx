// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Toggle } from '../ui.jsx'
import { useBalancesHiddenWhenEmpty } from '../../lib/balancesFrame.js'

export default function DashboardSection() {
  const [hiddenWhenEmpty, setHiddenWhenEmpty] = useBalancesHiddenWhenEmpty()
  return (
    <Toggle
      checked={!hiddenWhenEmpty}
      onChange={shown => setHiddenWhenEmpty(!shown)}
      label="Enable display of the Balances Page"
    />
  )
}
