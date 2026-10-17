// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { StatusPill } from '../connections/ConnectionStatus.jsx'

// "This source has a folder, and it is not importing from it." Three surfaces report that state — the
// CSV data-source rows, the Amazon source rows and the watched-folders panel — and each had said it in
// its own words (`Watching paused`, `(off)`, `(paused)`) against a toggle that says *Import files from
// this folder*.
//
// **It goes at the head of its line, never at the end.** Each of those three places truncates a long
// path with an ellipsis, so a marker after the path is the first thing clipped: on the Amazon rows the
// state was effectively invisible, readable only by hovering for the title.
//
// Nothing marks the watching state, because a badge marks the exception (`ui-patterns.md` → *Status,
// badges and timestamps*), and the quiet tone keeps it apart from the folder that cannot be read, which
// is a real fault and renders in danger colour beside it.
export default function WatchPausedPill() {
  return (
    <StatusPill small tone="muted"
      title="This folder is not being imported from. Turn it back on with Folder.">
      Paused
    </StatusPill>
  )
}
