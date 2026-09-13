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
 * - **Scripts and origin are the iframe's `sandbox` attribute's job** (the host renders it with no tokens),
 *   since a `<meta>` policy cannot carry the `sandbox` directive.
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
  doc.querySelectorAll('[href], [xlink\\:href]').forEach(element => {
    element.removeAttribute('href')
    element.removeAttribute('xlink:href')
  })
  const policy = doc.createElement('meta')
  policy.setAttribute('http-equiv', 'Content-Security-Policy')
  policy.setAttribute('content', PREVIEW_CONTENT_SECURITY_POLICY)
  doc.head.prepend(policy)
  return `<!doctype html>${doc.documentElement.outerHTML}`
}
