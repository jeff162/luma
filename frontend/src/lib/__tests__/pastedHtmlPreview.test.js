// @vitest-environment jsdom

// The preview document a pasted email is shown in before it is attached. jsdom enforces no policy and
// loads nothing, so these tests pin the *document* the frame is given; that the policy and the removals
// actually stop requests and navigation was established in real Chromium, Firefox and WebKit.

import { describe, it, expect } from 'vitest'
import { buildPastedHtmlPreview, PREVIEW_CONTENT_SECURITY_POLICY } from '../pastedHtmlPreview.js'

function parse(html) {
  return new DOMParser().parseFromString(html, 'text/html')
}

const EMAIL = `<html><head>
  <meta http-equiv="refresh" content="0;url=https://tracker.example/r">
  <meta http-equiv="Content-Security-Policy" content="default-src *">
  <link rel="dns-prefetch" href="https://tracker.example">
</head><body>
  <script>fetch('https://tracker.example/s')</script>
  <table><tr><td>Brake pads</td><td>$249.50</td></tr></table>
  <a href="https://shop.example/order/1">View order</a>
  <svg><a xlink:href="https://shop.example/svg"><text>svg link</text></a></svg>
</body></html>`

describe('buildPastedHtmlPreview', () => {
  it("puts the stored document's policy first in the head, and no other policy", () => {
    const doc = parse(buildPastedHtmlPreview(EMAIL))
    const policies = doc.querySelectorAll('meta[http-equiv="Content-Security-Policy"]')
    // A pasted policy could only narrow ours, but one left in would make the frame's rules depend on the
    // email; ours has to precede everything, since a policy applies only to what is parsed after it.
    expect(policies).toHaveLength(1)
    expect(policies[0].getAttribute('content')).toBe(PREVIEW_CONTENT_SECURITY_POLICY)
    expect(doc.head.firstElementChild).toBe(policies[0])
    expect(PREVIEW_CONTENT_SECURITY_POLICY).toBe("default-src 'none'")
  })

  it('removes what could navigate the frame or reach out ahead of the policy', () => {
    const doc = parse(buildPastedHtmlPreview(EMAIL))
    expect(doc.querySelector('meta[http-equiv="refresh"]')).toBeNull()
    expect(doc.querySelector('link')).toBeNull()
    expect(doc.querySelector('script')).toBeNull()
    expect(doc.querySelector('[href]')).toBeNull()
    expect(doc.querySelectorAll('*').length).toBeGreaterThan(0)
    expect([...doc.querySelectorAll('*')].some(el => el.hasAttribute('xlink:href'))).toBe(false)
  })

  it('keeps the content the preview exists to show', () => {
    const doc = parse(buildPastedHtmlPreview(EMAIL))
    expect([...doc.querySelectorAll('td')].map(td => td.textContent)).toEqual(['Brake pads', '$249.50'])
    expect(doc.querySelector('a').textContent).toBe('View order')
  })

  it('wraps a bare clipboard fragment in a whole document', () => {
    // What a clipboard offers is often a fragment with no <head> of its own to put the policy in.
    const doc = parse(buildPastedHtmlPreview('<td>$350.00</td>'))
    expect(doc.head.firstElementChild.getAttribute('http-equiv')).toBe('Content-Security-Policy')
  })
})
