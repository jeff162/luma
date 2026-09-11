// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { HELP_ANCHOR_CSS } from './helpAnchors.js'

// Topic bodies are authored as raw <p>/<ol>/<h4>; normalize the browser-default margins/indent so
// the spacing reads consistently wherever a body is rendered — both the standalone /help page and
// the in-place help viewer dialog use this so the two never diverge. The anchored-heading rules ride
// along for the same reason: a deep link behaves identically in both render targets.
export const HELP_BODY_CSS = `
  .help-body p { margin: 0 0 12px; }
  .help-body > :last-child { margin-bottom: 0; }
  .help-body ol, .help-body ul { margin: 0 0 12px; padding-left: 22px; display: grid; gap: 8px; }
  .help-body li { margin: 0; padding-left: 4px; }
  .help-body h4 { margin: 18px 0 8px; font-size: 14px; }
  .help-body strong { color: var(--text); }
  /* Cross-links are themed here rather than on the link itself so a body reads the same in both render
     targets: nothing else styles anchors app-wide, so a routed <Link> would otherwise fall back to the
     browser's default blue-and-visited-purple while the same link in the viewer drew in the accent. */
  .help-body a { color: var(--accent2); }
${HELP_ANCHOR_CSS}`
