// @vitest-environment jsdom

// The chip's one non-obvious job: an opaque provider id is not a name, and showing it as one tells the
// reader nothing about where their transactions went. The stored label cannot be rewritten — it is
// matched against each row's evidence — so the card renders around it.

import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { SourceAccountChip } from '../importExport/SourceAccountChip.jsx'

afterEach(cleanup)

describe('an opaque provider id', () => {
  const RAW = 'P3yXMk4aBwhbL7qZKEx1s1ov5kmx1pC357x31'

  it('is replaced by the account the rows landed in', async () => {
    render(<SourceAccountChip label={RAW} mappedLabel="Plaid Credit Card" count={1} />)
    expect(screen.getByText('Plaid Credit Card')).toBeTruthy()
    expect(screen.queryByText(new RegExp(RAW.slice(0, 12)))).toBeNull()
  })

  it('keeps the id reachable rather than discarding it', async () => {
    // It is still the truth about this card, and the only thing that ties the row back to the provider.
    const { container } = render(
      <SourceAccountChip label={RAW} mappedLabel="Plaid Credit Card" count={1} />,
    )
    expect(container.querySelector('[title]').getAttribute('title')).toContain(RAW)
  })

  it('is shown as-is when there is nothing better to say', async () => {
    // A skipped account has no destination, so substituting one would invent information.
    render(<SourceAccountChip label={RAW} skipped />)
    expect(screen.getByText(new RegExp(RAW.slice(0, 12)))).toBeTruthy()
  })
})

describe('a real account label', () => {
  it('still shows the source → destination mapping', async () => {
    // The substitution must not swallow the ordinary case, which is the whole point of the chip: what
    // the source called the account, and where its rows went.
    render(<SourceAccountChip label="Plaid Checking ···0000" mappedLabel="Everyday Checking" count={4} />)
    expect(screen.getByText(/Plaid Checking/)).toBeTruthy()
    expect(screen.getByText(/Everyday Checking/)).toBeTruthy()
  })

  it('is not mistaken for an id because it happens to be long', async () => {
    // The detection is by shape, and a long human name carries spaces where an id does not. Asserted on
    // the title rather than the visible text, which the chip truncates by design.
    const { container } = render(
      <SourceAccountChip label="Harborline Premier Interest Checking" mappedLabel="Checking" count={2} />,
    )
    expect(container.querySelector('[title]').getAttribute('title'))
      .toBe('Harborline Premier Interest Checking → Checking')
  })
})
