// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * Showing pasted email markup before it is attached, under the same rules it will be viewed by afterwards.
 *
 * A stored document is safe to render because the server sends it with a sandbox CSP
 * (`backend/routers/documents.py`). A paste that has not been attached yet has no URL to carry that header,
 * so the preview rebuilds the same protection on the client:
 *
 * - **The policy is the server's own, `default-src 'none'`**, delivered as a `<meta>` at the head of the
 *   frame's document. It blocks every subresource — including the tracking images an email carries, which
 *   would otherwise fire the moment the preview drew — and it blocks inline styles too, exactly as the
 *   stored document's header does. That is deliberate: the preview's promise is that what is shown is what
 *   will be attached, so it must not look better than the stored copy will.
 * - **Scripts are the iframe's `sandbox` attribute's job**, since a `<meta>` policy cannot carry the
 *   `sandbox` directive. The host grants it `allow-same-origin` and nothing else, so the preview can be
 *   edited in place and the edits read back. Same origin is safe only *because* no script runs there: it
 *   must never be combined with `allow-scripts`, which would let the markup reach the app — or remove its
 *   own sandbox.
 * - **Navigation is the one thing neither covers.** A sandboxed frame may still navigate *itself*, so a
 *   `<meta http-equiv="refresh">` or a clicked link would load a remote page inside the panel. Pasted
 *   `<meta>` elements and every `href` are removed for that reason, and `<link>` too, which some browsers
 *   act on (DNS prefetch) ahead of any policy. Scripts are dropped as well, though the sandbox already stops
 *   them, because they have nothing to contribute to a picture of a receipt.
 *
 * Parsing goes through `DOMParser`, whose documents are inert — nothing in them runs or loads — so the
 * markup is never live in the app's own page at any point.
 */

export const PREVIEW_CONTENT_SECURITY_POLICY = "default-src 'none'"

export function buildPastedHtmlPreview(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  doc.querySelectorAll('meta, link, script').forEach(element => element.remove())
  // `*|` because an SVG link's `xlink:href` is `href` in the XLink namespace, which a plain attribute
  // selector does not match — `[xlink\:href]` names an attribute that does not exist, and matched nothing.
  doc.querySelectorAll('[*|href]').forEach(element => {
    for (const attribute of [...element.attributes]) {
      if (attribute.localName === 'href') element.removeAttributeNode(attribute)
    }
  })
  const policy = doc.createElement('meta')
  policy.setAttribute('http-equiv', 'Content-Security-Policy')
  policy.setAttribute('content', PREVIEW_CONTENT_SECURITY_POLICY)
  doc.head.prepend(policy)
  return `<!doctype html>${doc.documentElement.outerHTML}`
}

// An edited preview as it is to be stored: the policy `buildPastedHtmlPreview` added is taken out again, since
// the stored copy is served under the server's own header and the next preview adds its own.
export function serializeEditedPreview(doc) {
  const root = doc.documentElement.cloneNode(true)
  root.querySelectorAll('meta[http-equiv="Content-Security-Policy"]').forEach(element => element.remove())
  return `<!doctype html>${root.outerHTML}`
}
