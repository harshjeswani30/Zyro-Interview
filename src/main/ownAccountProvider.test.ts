import { describe, expect, it } from 'vitest'
import { isOwnAccountProvider } from './ownAccountProvider'

describe('isOwnAccountProvider', () => {
  it('accepts the four supported own-account providers', () => {
    expect(isOwnAccountProvider('chatgpt')).toBe(true)
    expect(isOwnAccountProvider('claude')).toBe(true)
    expect(isOwnAccountProvider('gemini')).toBe(true)
    expect(isOwnAccountProvider('glm')).toBe(true)
  })

  it('rejects unknown provider ids', () => {
    expect(isOwnAccountProvider('grok')).toBe(false)
    expect(isOwnAccountProvider('GLM')).toBe(false)
    expect(isOwnAccountProvider('')).toBe(false)
  })

  it('rejects non-string values', () => {
    expect(isOwnAccountProvider(undefined)).toBe(false)
    expect(isOwnAccountProvider(null)).toBe(false)
    expect(isOwnAccountProvider(42)).toBe(false)
  })
})
