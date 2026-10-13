/**
 * Detecting a REAL logged-in Z.ai (GLM) account from the auth partition's
 * cookies + localStorage. Kept electron-free so the discriminator can be unit
 * tested. The connect window must NOT treat Z.ai's anonymous/guest session
 * (a random cookie) as a login — a plain cookie-name match did exactly that and
 * auto-closed the window before the user signed in.
 */
const JWT_RE = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.')
  if (parts.length < 2) return null
  try {
    const json = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
    const obj = JSON.parse(json)
    return obj && typeof obj === 'object' ? (obj as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/**
 * A JWT payload that belongs to a real, currently-valid signed-in user. Confirmed
 * against live Z.ai tokens: a logged-in token has a normal `email` + `iss:"user-service"`
 * and a short ~1h `exp`; the pre-login GUEST token has `email: "guest-<ts>@guest.com"`
 * and no `iss` — so a plain "@-email" is NOT enough, the guest email must be excluded.
 */
function isRealUserPayload(p: Record<string, unknown>): boolean {
  if (p.anonymous === true || p.is_guest === true || p.guest === true) return false
  // Reject an expired token — Z.ai's logged-in JWT lives only about an hour.
  if (typeof p.exp === 'number' && p.exp * 1000 < Date.now()) return false
  const email = typeof p.email === 'string' ? p.email.trim().toLowerCase() : ''
  const isGuestEmail = email.endsWith('@guest.com') || email.startsWith('guest-')
  if (email.includes('@') && !isGuestEmail) return true
  for (const claim of ['phone', 'mobile'] as const) {
    const v = p[claim]
    if (typeof v === 'string' && v.trim().length > 0) return true
    if (typeof v === 'number' && v !== 0) return true
  }
  return false
}

/**
 * The JWT strings in `values` that decode to a real authenticated user. Used by
 * the connect flow for baseline diffing: the token set present BEFORE login is
 * recorded, and a token that appears later (not in that baseline) is the login.
 */
export function realUserJwts(values: readonly string[]): string[] {
  const out: string[] = []
  for (const value of values) {
    if (!value) continue
    const matches = value.match(JWT_RE)
    if (!matches) continue
    for (const token of matches) {
      const payload = decodeJwtPayload(token)
      if (payload && isRealUserPayload(payload)) out.push(token)
    }
  }
  return out
}

/**
 * True when any cookie / localStorage value carries a JWT that decodes to a real
 * authenticated Z.ai user. Guest/anonymous sessions (random ids, or JWTs with no
 * real identity claim) return false.
 */
export function isGlmLoggedIn(values: readonly string[]): boolean {
  return realUserJwts(values).length > 0
}

/** True when `value` carries a JWT that decodes to a Z.ai GUEST account
 *  (`email` ends with @guest.com or starts with `guest-`). Used to purge guest
 *  tokens from storage so GLM is only ever used via a real account. */
export function isGuestJwtValue(value: string): boolean {
  const matches = value && value.match(JWT_RE)
  if (!matches) return false
  for (const token of matches) {
    const p = decodeJwtPayload(token)
    const email = p && typeof p.email === 'string' ? p.email.trim().toLowerCase() : ''
    if (email.endsWith('@guest.com') || email.startsWith('guest-')) return true
  }
  return false
}
