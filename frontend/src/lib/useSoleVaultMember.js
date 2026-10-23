// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef, useState } from 'react'

// Deleting the only user who can open the credential vault resets it (`crypto_service.remove_vault_member`),
// so each user-deletion confirmation says so before the fact. Asked when the confirmation opens rather than
// read from the list behind it, so access granted or set since that list loaded is counted. `loadPeople`
// resolves to the users or identities, each carrying `sole_vault_member`.
export function useSoleVaultMember(userId, loadPeople) {
  const load = useRef(loadPeople)
  load.current = loadPeople
  const [answer, setAnswer] = useState(null)
  useEffect(() => {
    if (!userId) return undefined
    let alive = true
    load.current()
      .then(people => {
        if (alive) setAnswer({ userId, sole: !!people?.find(p => p.id === userId)?.sole_vault_member })
      })
      .catch(() => {})
    return () => { alive = false }
  }, [userId])
  return !!userId && answer?.userId === userId && answer.sole
}
