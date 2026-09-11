// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { HELP_ANCHOR_ATTR } from './helpAnchors.js'

/*
 * A heading inside a topic body that other topics can link *to*: identical to the bare `<h4>` the
 * bodies use, plus the anchor attribute `/help/<topic>#<anchor>` links resolve against (see
 * helpAnchors.js for why it is an attribute rather than an id). Use it for any heading a
 * `<HelpLink>` addresses; the plain `<h4>` stays fine for the rest.
 *
 * `anchor` is lowercase-hyphenated like a topic id, and is part of a URL once something links to it
 * -- so renaming one breaks any link that carried it, the same as renaming a topic id.
 */
export default function HelpHeading({ anchor, children }) {
  return <h4 {...{ [HELP_ANCHOR_ATTR]: anchor }}>{children}</h4>
}
