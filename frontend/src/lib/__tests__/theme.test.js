import { describe, it, expect } from 'vitest'
import { resolveEffectiveTheme, normalizeThemeChoice } from '../theme.js'

describe('resolveEffectiveTheme', () => {
  it('honors explicit light/dark regardless of the OS hint', () => {
    expect(resolveEffectiveTheme('light', true)).toBe('light')
    expect(resolveEffectiveTheme('light', false)).toBe('light')
    expect(resolveEffectiveTheme('dark', true)).toBe('dark')
    expect(resolveEffectiveTheme('dark', false)).toBe('dark')
  })

  it('follows the OS hint for system', () => {
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
    expect(normalizeThemeChoice('light')).toBe('light')
    expect(normalizeThemeChoice('dark')).toBe('dark')
    expect(normalizeThemeChoice('system')).toBe('system')
    expect(normalizeThemeChoice('nonsense')).toBe('system')
    expect(normalizeThemeChoice(undefined)).toBe('system')
  })
})
