// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from 'react'
import HelpTopicDialog from './HelpTopicDialog.jsx'

/*
 * Hosts the in-place help viewer for a single explainer: `openTopic(id)` opens the portal'd
 * dialog above everything (see HelpTopicDialog), and `viewerNode` is rendered by the caller so
 * the portal mounts within its tree. Each FeatureExplainer / ContextualExplainer owns one.
 */
export function useHelpTopicViewer() {
  const [openId, setOpenId] = useState(null)
  const viewerNode = openId
    ? <HelpTopicDialog topicId={openId} onClose={() => setOpenId(null)} />
    : null
  return { openTopic: setOpenId, viewerNode }
}
