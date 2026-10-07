// Emits `third-party-licenses.txt` into the build: every npm package whose code ended up in the bundle,
// with the license text that package ships, plus third-party material carried in the source tree itself.
//
// Built from the bundle rather than from package.json, because what a license obliges is decided by what
// is *conveyed*: a dev dependency never reaches a user, and a runtime dependency pulls in packages of its
// own that no manifest here names. Most of these licenses (MIT, BSD, ISC, Apache) require their notice to
// travel with every copy, and minification strips the comments that would otherwise have carried it — so
// without this file the built interface ships none of them.
//
// A package that ships no license file of its own takes one from `scripts/license-texts/<name>.txt`, whose
// leading `#` lines say where the text came from. One with neither fails the build rather than being left
// out: a package missing from this file is one the build is out of compliance with, and nothing else would
// say so.

import fs from 'node:fs'
import path from 'node:path'

const LICENSE_FILE = /^(licen[cs]e|copying|notice)([-._].*)?$/i

// The package directory a bundled module belongs to, or null for the project's own source. Resolved from
// the last `node_modules` segment, so a package nested inside another's resolves to itself. A virtual
// module the bundler injects (`\0vite/preload-helper.js`, `\0rolldown/runtime.js`) is that tool's own code
// shipped in the bundle, so it counts as the package its first segment names.
function packageDirOf(moduleId, root) {
  const file = moduleId.replace(/^\0/, '').split('?')[0]
  const parts = file.split(/[\\/]/)
  const at = parts.lastIndexOf('node_modules')
  if (at === -1 && moduleId.startsWith('\0')) {
    const dir = path.join(root, 'node_modules', parts[0])
    return fs.existsSync(path.join(dir, 'package.json')) ? dir : null
  }
  if (at === -1 || at + 1 >= parts.length) return null
  const nameParts = parts[at + 1].startsWith('@') ? 2 : 1
  return parts.slice(0, at + 1 + nameParts).join(path.sep)
}

function licenseOf(manifest) {
  const value = manifest.license ?? manifest.licenses
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(v => (typeof v === 'string' ? v : v?.type)).filter(Boolean).join(' OR ')
  return value?.type || ''
}

function sourceOf(manifest) {
  const repo = typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url
  return manifest.homepage || repo || `https://www.npmjs.com/package/${manifest.name}`
}

// A file's leading `#` comment block and whatever follows it. Both a vendored file (see
// `src/lib/effLargeWordlist.txt`) and a supplied license text state their provenance this way, so it is
// read from that one place rather than restated here.
function splitHeader(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n')
  const at = lines.findIndex(line => !line.startsWith('#'))
  const end = at === -1 ? lines.length : at
  return {
    header: lines.slice(0, end).map(line => line.replace(/^# ?/, '')).join('\n').trim(),
    body: lines.slice(end).join('\n').trim(),
  }
}

function packageEntry(dir, supplementDir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
  const files = fs.readdirSync(dir).filter(name => LICENSE_FILE.test(name) && fs.statSync(path.join(dir, name)).isFile()).sort()
  const texts = files.map(name => ({ name, text: fs.readFileSync(path.join(dir, name), 'utf8').trim() }))
  const supplement = path.join(supplementDir, `${manifest.name.replace('/', '__')}.txt`)
  if (!texts.length && fs.existsSync(supplement)) {
    const { header, body } = splitHeader(supplement)
    texts.push({ name: 'supplied license text', text: `${header}\n\n${body}` })
  }
  return { name: manifest.name, version: manifest.version, license: licenseOf(manifest), source: sourceOf(manifest), texts }
}

// A vendored file declares its own license the way a package's manifest does, with an SPDX identifier in
// the header block that is already its notice. Read rather than configured, so the claim lives in one
// place; it is also what lists the file in the summary that heads the combined notices of a packaged
// build, which reads each entry's `License:` line.
const SPDX_LICENSE = /^SPDX-License-Identifier: *(.+)$/m

function vendoredEntry({ file, name }) {
  const { header } = splitHeader(file)
  const declared = header.match(SPDX_LICENSE)
  return {
    name,
    version: '',
    license: declared ? declared[1].trim() : '',
    source: '',
    texts: [{ name: path.basename(file), text: header }],
  }
}

function render(entries) {
  const rule = '-'.repeat(78)
  const out = [
    'Third-party software in the Luma web interface',
    '',
    'The packages and other material included in this build of the web interface, each with the',
    'license text it ships. Generated from the bundle at build time.',
  ]
  for (const e of entries) {
    out.push('', rule, `${e.name}${e.version ? ` ${e.version}` : ''}`)
    if (e.license) out.push(`License: ${e.license}`)
    if (e.source) out.push(`Source: ${e.source}`)
    for (const t of e.texts) out.push('', ...(e.texts.length > 1 ? [`[${t.name}]`] : []), t.text)
  }
  return `${out.join('\n')}\n`
}

export function thirdPartyNotices({
  fileName = 'third-party-licenses.txt',
  vendored = [],
  supplementDir = path.join(import.meta.dirname, 'license-texts'),
  root = path.join(import.meta.dirname, '..'),
} = {}) {
  return {
    name: 'third-party-notices',
    apply: 'build',
    generateBundle(_options, bundle) {
      const moduleIds = Object.values(bundle).flatMap(output => (output.type === 'chunk' ? Object.keys(output.modules) : []))
      const dirs = new Set(moduleIds.map(id => packageDirOf(id, root)).filter(Boolean))
      const packages = [...dirs].map(dir => packageEntry(dir, supplementDir))
      const withoutText = packages.filter(p => !p.texts.length)
      if (withoutText.length) {
        this.error(
          `Bundled package(s) ship no license text: ${withoutText.map(p => `${p.name} (${p.license || 'no license declared'})`).join(', ')}. `
          + `Add the upstream text as scripts/license-texts/<name>.txt, with a leading # line saying where it came from.`,
        )
      }
      const seen = new Set()
      const unique = packages
        .filter(p => !seen.has(`${p.name}@${p.version}`) && seen.add(`${p.name}@${p.version}`))
        .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
      const bundledFiles = new Set(moduleIds.map(id => path.resolve(id.replace(/^\0/, '').split('?')[0])))
      const carried = vendored.filter(v => bundledFiles.has(path.resolve(v.file))).map(vendoredEntry)
      this.emitFile({ type: 'asset', fileName, source: render([...unique, ...carried]) })
    },
  }
}
