// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// Topic bodies are authored as raw <p>/<ol>/<h4>; normalize the browser-default margins/indent so
// the spacing reads consistently wherever a body is rendered — both the standalone /help page and
// the in-place help viewer dialog use this so the two never diverge.
export const HELP_BODY_CSS = `
  .help-body p { margin: 0 0 12px; }
  .help-body > :last-child { margin-bottom: 0; }
  .help-body ol, .help-body ul { margin: 0 0 12px; padding-left: 22px; display: grid; gap: 8px; }
  .help-body li { margin: 0; padding-left: 4px; }
  .help-body h4 { margin: 18px 0 8px; font-size: 14px; }
  .help-body strong { color: var(--text); }
`
