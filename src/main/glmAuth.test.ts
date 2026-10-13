import { describe, expect, it } from 'vitest'
import { isGlmLoggedIn, realUserJwts, isGuestJwtValue } from './glmAuth'

/** Build a syntactically real JWT (header.payload.sig) with the given payload. */
function jwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}.sig`
}

describe('isGlmLoggedIn', () => {
  it('is false for an anonymous guest session cookie — the reported bug', () => {
    // Z.ai sets these BEFORE login; a name/substring match wrongly treated them as a login.
    expect(isGlmLoggedIn(['3f9a1c2e-guest-session-00ff'])).toBe(false)
    expect(isGlmLoggedIn(['sensorsdata2015jssdkcross', 'acw_tc=abcdef'])).toBe(false)
  })

  it('is true when a real-user JWT is present in a cookie value', () => {
    expect(isGlmLoggedIn([jwt({ id: 'u_123', email: 'a@b.com' })])).toBe(true)
  })

  it('finds a JWT embedded inside a localStorage JSON blob', () => {
    expect(isGlmLoggedIn([`{"token":"${jwt({ sub: 'u_9', phone: '99999' })}","v":1}`])).toBe(true)
  })

  it('is false for an anonymous / guest JWT', () => {
    expect(isGlmLoggedIn([jwt({ anonymous: true })])).toBe(false)
    expect(isGlmLoggedIn([jwt({ type: 'guest', sub: 'guest' })])).toBe(false)
  })

  it('rejects an id-only token with no email/phone (the real Z.ai guest token shape)', () => {
    expect(isGlmLoggedIn([jwt({ id: '56675e56-2495-4c5f-b6a5', iss: 'guest' })])).toBe(false)
  })

  it('accepts the real Z.ai logged-in token shape (email + iss user-service)', () => {
    expect(isGlmLoggedIn([jwt({ email: 'me@gmail.com', id: 'abc', iss: 'user-service', exp: 4102444800 })])).toBe(true)
  })

  it('rejects an expired real-user token (Z.ai tokens live ~1h)', () => {
    expect(isGlmLoggedIn([jwt({ email: 'me@gmail.com', exp: 1000 })])).toBe(false)
  })

  it('rejects a Z.ai GUEST token whose email is guest-<ts>@guest.com (confirmed live)', () => {
    expect(isGlmLoggedIn([jwt({ id: 'x', email: 'guest-1790875247570@guest.com', region: 'global' })])).toBe(false)
  })

  it('accepts the real logged-in token (non-guest email + iss user-service)', () => {
    expect(isGlmLoggedIn([jwt({ id: 'x', email: 'harsh@gmail.com', iss: 'user-service', region: 'global', exp: 4102444800 })])).toBe(true)
  })

  it('isGuestJwtValue flags a guest-email token only', () => {
    expect(isGuestJwtValue(jwt({ id: 'x', email: 'guest-1790875247570@guest.com', region: 'global' }))).toBe(true)
    expect(isGuestJwtValue(jwt({ id: 'x', email: 'real@gmail.com' }))).toBe(false)
    expect(isGuestJwtValue('not-a-jwt')).toBe(false)
    expect(isGuestJwtValue('')).toBe(false)
  })

  it('is false for empty / no signals', () => {
    expect(isGlmLoggedIn([])).toBe(false)
    expect(isGlmLoggedIn([''])).toBe(false)
  })
})

describe('realUserJwts', () => {
  it('returns the real-user JWT strings found in the values (for baseline diffing)', () => {
    const token = jwt({ id: 'u_1', email: 'a@b.com' })
    expect(realUserJwts([token, 'random-guest-id'])).toEqual([token])
  })

  it('returns an empty list when no real-user JWT is present', () => {
    expect(realUserJwts(['3f9a-guest-session', jwt({ anonymous: true })])).toEqual([])
    expect(realUserJwts([])).toEqual([])
  })
})

