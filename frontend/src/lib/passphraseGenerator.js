// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// Suggested passphrases and passwords: words drawn uniformly at random from the EFF large word list, joined
// by hyphens. The list is public, and that costs nothing — the strength is in the draw, log2(7776) ≈ 12.9
// bits a word. A vault passphrase takes six, about 77 bits: every guess at one has to go through scrypt,
// which puts that out of reach. A sign-in password takes four, about 52 bits, because guessing it means
// asking the server, which allows a handful of tries per account every few minutes; four also clear the
// "Strong" policy's estimator. Words are what someone with no password manager can type back reliably.
//
// The list is loaded on first use rather than bundled into the page, since most sessions never ask for one.

export const SUGGESTED_PASSPHRASE_WORDS = 6
export const SUGGESTED_PASSWORD_WORDS = 4
export const WORD_LIST_SIZE = 7776
const SEPARATOR = '-'

export function parseWordList(text) {
  return text.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'))
}

let wordsPromise = null
function loadWords() {
  wordsPromise ??= import('./effLargeWordlist.txt?raw').then(module => {
    const words = parseWordList(module.default)
    // A truncated or duplicated list would still produce passphrases that look right while carrying less
    // than the strength stated above, so a list of the wrong shape is refused rather than used.
    if (words.length !== WORD_LIST_SIZE || new Set(words).size !== WORD_LIST_SIZE) {
      throw new Error('The passphrase word list is incomplete.')
    }
    return words
  })
  wordsPromise.catch(() => { wordsPromise = null })  // a failed chunk load may succeed on the next ask
  return wordsPromise
}

// A uniform index in [0, n) from the platform's cryptographic generator. Draws past the largest multiple
// of n are thrown away and redrawn, because taking a 32-bit value modulo n would otherwise favor the
// lowest indexes whenever 2^32 is not a multiple of n.
export function randomIndex(n, random = globalThis.crypto) {
  const limit = Math.floor(0x100000000 / n) * n
  const draw = new Uint32Array(1)
  for (;;) {
    random.getRandomValues(draw)
    if (draw[0] < limit) return draw[0] % n
  }
}

export function composePassphrase(words, count = SUGGESTED_PASSPHRASE_WORDS, random = globalThis.crypto) {
  return Array.from({ length: count }, () => words[randomIndex(words.length, random)]).join(SEPARATOR)
}

// `fits` is the field's own rule (the vault floor, for a vault passphrase). Six words always clear the
// current floor on length; redrawing covers the distinct-character rule, which an unlucky draw of short
// words could in principle miss, and does so without skewing the choice among the passphrases that fit.
export async function suggestPassphrase({ count = SUGGESTED_PASSPHRASE_WORDS, fits = () => true } = {}) {
  const words = await loadWords()
  for (let attempt = 0; attempt < 100; attempt++) {
    const passphrase = composePassphrase(words, count)
    if (fits(passphrase)) return passphrase
  }
  throw new Error('No suggested passphrase met the requirements.')
}
