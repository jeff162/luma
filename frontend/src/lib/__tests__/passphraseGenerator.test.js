import { describe, expect, it } from 'vitest'
import wordListText from '../effLargeWordlist.txt?raw'
import { WORD_LIST_SIZE, composePassphrase, parseWordList, randomIndex, suggestPassphrase } from '../passphraseGenerator.js'

// A generator that hands out the given 32-bit values in order.
const scripted = values => ({ getRandomValues: array => { array[0] = values.shift(); return array } })

describe('suggested passphrases', () => {
  it('redraws a value past the last whole multiple of n rather than folding it onto the low indexes', () => {
    // 2^32 mod 7776 = 2560, so the top 2560 values would otherwise land on indexes 0–2559 a second time.
    const limit = Math.floor(0x100000000 / WORD_LIST_SIZE) * WORD_LIST_SIZE
    expect(randomIndex(WORD_LIST_SIZE, scripted([limit, 0xffffffff, limit - 1]))).toBe((limit - 1) % WORD_LIST_SIZE)
  })

  it('joins six words from the list with hyphens', () => {
    const words = parseWordList(wordListText)
    expect(composePassphrase(words, undefined, scripted([0, 1, 2, 7773, 7774, 7775])))
      .toBe('abacus-abdomen-abdominal-zoologist-zoology-zoom')
  })

  it('redraws until the field’s own rule is met', async () => {
    let asked = 0
    const passphrase = await suggestPassphrase({ fits: () => ++asked > 3 })
    expect(asked).toBe(4)
    expect(passphrase.length).toBeGreaterThanOrEqual(23)
  })
})
