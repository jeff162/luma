// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createContext, useContext } from 'react'

/*
 * When a topic body is rendered inside the in-place help viewer dialog (rather than on the
 * standalone /help route), its `<HelpLink>` cross-links should switch the dialog's topic in
 * place instead of routing the page behind it. The viewer provides a `navigate(topicId)` fn
 * here; outside the viewer this context is null and HelpLink falls back to normal routing.
 *
 * Kept in its own tiny module (no other imports) so HelpLink and the viewer can both depend on
 * it without an import cycle through the content registry.
 */
export const HelpNavContext = createContext(null)

export function useHelpNav() {
  return useContext(HelpNavContext)
}
