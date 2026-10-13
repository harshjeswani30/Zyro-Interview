/**
 * The user's linked web subscriptions that answers can be tunnelled through
 * (BYOS). Kept in its own electron-free module so the type guard can be unit
 * tested and shared by the main-process IPC layer and the failover executor
 * without pulling in Electron.
 */
export type OwnAccountProvider = 'chatgpt' | 'claude' | 'gemini' | 'glm'

const OWN_ACCOUNT_PROVIDERS: readonly OwnAccountProvider[] = ['chatgpt', 'claude', 'gemini', 'glm']

/** True when `x` is one of the supported own-account provider ids. */
export function isOwnAccountProvider(x: unknown): x is OwnAccountProvider {
  return typeof x === 'string' && (OWN_ACCOUNT_PROVIDERS as readonly string[]).includes(x)
}
