// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { APP_NAME, APP_VERSION, CC_BY_4_URL, EFF_WORDLIST_URL, LICENSE_CANONICAL_URL, PROJECT_URL } from '../../lib/appConfig.js'
import { Card } from '../ui.jsx'
import { useUpdateCheck } from '../../lib/useUpdateCheck.js'
import { UpdateCheckControls, UpdateCheckStatus } from '../UpdateCheck.jsx'

function AboutRow({ label, value, help = '' }) {
  return (
    <div style={{ display: 'grid', gap: 4 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 600 }}>{value}</div>
      {help ? (
        <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.55 }}>
          {help}
        </div>
      ) : null}
    </div>
  )
}

// The app's own legal notice surface: who holds the copyright, under what terms, where the source is,
// and that there is no warranty. The source link is not decoration — the AGPL's network clause obliges
// anyone running a modified copy for other people to offer them the corresponding source, and this is
// where a user looks for it. The full license text stays in the repository rather than in the app; the
// license row links to it, which is what "how to view a copy of this License" asks for.
//
// **One license link, and it prefers the copy this build carries.** The local one is same-origin and
// works with no network at all, so it is the better destination whenever it exists; the canonical text
// at gnu.org stands in when a build ships without one. Two links to the same immutable text was the
// earlier arrangement and bought nothing — the AGPL never changes, so there is no fresher copy to defer
// to, and this project's *own* published copy is no more trustworthy than the file beside the binary
// (a fork edits a URL as easily as a file). Where an outward link does mean something is the FSF's
// text, which no fork controls. An earlier version went further and probed the repository to decide
// which link to show; that cost an outbound request nobody asked for on every visit to this panel,
// which contradicts the promise the README makes about network access. Both remaining links are plain
// anchors: nothing is fetched from anywhere until the user clicks.
export default function AboutSection({ dbInstanceId, bundledLicenseAvailable, buildStamp, thirdPartyNoticesScope, canManageEnvironment }) {
  const updateCheck = useUpdateCheck()
  return (
    <Card style={{ padding: 20 }}>
      <div style={{ display: 'grid', gap: 18 }}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 700 }}>{APP_NAME}</div>
          <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4, lineHeight: 1.6 }}>
            Self-hosted personal finance tracker.
          </div>
        </div>

        {/* alignItems:start keeps each column top-aligned; without it a short cell (Version — no help
            caption) stretches to the tallest cell's height and its value drifts to the middle. */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 18, alignItems: 'start' }}>
          <AboutRow
            label="Version"
            value={`v${APP_VERSION}`}
            help={updateCheck.status ? <UpdateCheckStatus status={updateCheck.status} /> : ''}
          />
          {/* The version is set by hand at release time, so every build made between two releases
              reports the same one. This row is what separates them, and what makes "has this been fixed
              since?" answerable about a build rather than about a release. Only a packaged build carries
              it: a copy run from source has its commit on hand already, and the row is left out. */}
          {buildStamp ? (
            <AboutRow
              label="Build"
              value={buildStamp}
              help="The commit this build was made from: the release it followed, and how far past it."
            />
          ) : null}
          <AboutRow
            label="License"
            value={(
              <a
                href={bundledLicenseAvailable ? '/api/app/license' : LICENSE_CANONICAL_URL}
                target="_blank"
                rel="noreferrer"
                style={{ color: 'var(--accent)' }}
              >
                GNU AGPL v3.0 or later
              </a>
            )}
            help={`© 2026 Jeffrey Orlin · SPDX identifier: AGPL-3.0-or-later. ${bundledLicenseAvailable ? 'Local text from this build.' : 'Canonical text at gnu.org.'
              }`}
          />
          <AboutRow
            label="Source"
            value={(
              <a href={PROJECT_URL} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>
                {PROJECT_URL.replace('https://', '')}
              </a>
            )}
            help="Full source, releases and issue tracker."
          />
          <AboutRow
            label="Instance ID"
            value={dbInstanceId || 'Unavailable'}
            help="Unique identifier for the database. Used to warn when restoring a backup from a different database."
          />
          {/* Where the licenses of everything else this copy carries are. A packaged build has them all in
              one file frozen in beside the LICENSE; elsewhere the generated list covers the web interface
              alone, and the row says so rather than overstating what the link holds. It is left out
              entirely where there is nothing to serve, which is a checkout whose frontend has never been
              built — the one case where a link would lead nowhere. */}
          {thirdPartyNoticesScope ? (
            <AboutRow
              label="Third-party licenses"
              value={(
                <a
                  href="/api/app/third-party-licenses"
                  target="_blank"
                  rel="noreferrer"
                  style={{ color: 'var(--accent)' }}
                >
                  Included software
                </a>
              )}
              help={thirdPartyNoticesScope === 'build'
                ? 'Every package and component in this build, with the license text each one ships.'
                : 'The packages in the web interface, with the license text each one ships. A packaged build lists the server\u2019s software too; in a checkout those dependencies are installed separately, each with its own license.'}
            />
          ) : null}
          {/* The attribution CC BY 4.0 asks for wherever the list is conveyed: creator, license with a link,
              where the material came from, and that it was modified. The same notice heads the file itself
              (lib/effLargeWordlist.txt), which is what travels in the source and the built bundle, and it
              is reproduced in the list above. */}
          <AboutRow
            label="Passphrase word list"
            value={(
              <a href={EFF_WORDLIST_URL} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>
                EFF Large Wordlist for Passphrases
              </a>
            )}
            help={(
              <>
                By the Electronic Frontier Foundation, licensed under{' '}
                <a href={CC_BY_4_URL} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>CC BY 4.0</a>.
                Used for suggested passphrases, with the dice-roll numbers removed.
              </>
            )}
          />
        </div>

        {canManageEnvironment ? <UpdateCheckControls check={updateCheck} /> : null}

        <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.6, borderTop: '1px solid var(--border)', paddingTop: 14 }}>
          Provided without warranty of any kind, to the extent permitted by applicable law. See sections
          15 and 16 of the license for the full disclaimer and limitation of liability.
        </div>
      </div>
    </Card>
  )
}
