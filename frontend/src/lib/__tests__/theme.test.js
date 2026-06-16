import { describe, it, expect } from 'vitest'
import { resolveEffectiveTheme, normalizeThemeChoice } from '../theme.js'

describe('resolveEffectiveTheme', () => {
  it('applies every explicit palette as-is regardless of the OS hint', () => {
    for (const palette of ['light', 'soft', 'dim', 'dark']) {
      expect(resolveEffectiveTheme(palette, true)).toBe(palette)
      expect(resolveEffectiveTheme(palette, false)).toBe(palette)
    }
  })

  it('follows the OS hint for system (to the plain light/dark ends)', () => {
    expect(resolveEffectiveTheme('system', true)).toBe('dark')
    expect(resolveEffectiveTheme('system', false)).toBe('light')
  })

  it('treats unknown/empty choices as system', () => {
    expect(resolveEffectiveTheme(undefined, true)).toBe('dark')
    expect(resolveEffectiveTheme(null, false)).toBe('light')
    expect(resolveEffectiveTheme('sepia', true)).toBe('dark')
  })
})

describe('normalizeThemeChoice', () => {
  it('passes through valid choices and defaults the rest to system', () => {
    for (const choice of ['light', 'soft', 'dim', 'dark', 'system']) {
      expect(normalizeThemeChoice(choice)).toBe(choice)
    }
    expect(normalizeThemeChoice('nonsense')).toBe('system')
    expect(normalizeThemeChoice(undefined)).toBe('system')
  })
})
