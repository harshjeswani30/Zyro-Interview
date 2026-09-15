import { safeStorage, app } from 'electron'
import { writeFileSync, readFileSync, existsSync, unlinkSync } from 'fs'
import { join } from 'path'
import { randomBytes } from 'crypto'

function getSessionFile(): string {
  return join(app.getPath('userData'), 'zyro_session.enc')
}

/**
 * Stores user session encrypted using the OS keychain (safeStorage).
 * On Windows this uses DPAPI, on macOS it uses Keychain.
 *
 * If OS encryption is unavailable we DO NOT persist at all (audit M3): a plaintext
 * file holding the refresh token is a permanent-account-access credential for
 * anyone who copies it. The session stays in memory for this run; the user
 * simply logs in again after a restart.
 */
export async function storeSecureSession(data: object): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) {
    console.warn(
      '[secureStorage] OS encryption not available — session kept in memory only, not persisted'
    )
    return
  }
  const json = JSON.stringify(data)
  const encrypted = safeStorage.encryptString(json)
  writeFileSync(getSessionFile(), encrypted)
}

/**
 * Loads and decrypts the stored session.
 * Returns null if no session exists or decryption fails.
 */
export function loadSecureSession(): Record<string, string> | null {
  try {
    if (!existsSync(getSessionFile())) return null
    const fileData = readFileSync(getSessionFile())
    if (fileData.length === 0) return null

    // Always try decryption first — safeStorage may return false before app.ready
    // but by the time setupIPC() calls this, safeStorage is guaranteed to be ready.
    if (safeStorage.isEncryptionAvailable()) {
      try {
        const decrypted = safeStorage.decryptString(fileData)
        return JSON.parse(decrypted)
      } catch {
        // Fall through to plaintext attempt
      }
    }

    // Legacy read: sessions written as plaintext by very old builds still load
    // (one last read, then the next store rewrites them encrypted). No new
    // plaintext is ever written — see storeSecureSession.
    try {
      const parsed = JSON.parse(fileData.toString())
      console.warn(
        '[secureStorage] Loaded a legacy plaintext session — it will be re-stored encrypted'
      )
      return parsed
    } catch {
      // File is corrupt/unreadable — delete it so we don't keep failing
      try {
        unlinkSync(getSessionFile())
      } catch {
        /* ignore */
      }
      return null
    }
  } catch (err) {
    console.error('[secureStorage] Failed to load session:', err)
    return null
  }
}

/**
 * Securely erases the stored session from disk.
 */
export function clearSecureSession(): void {
  try {
    if (existsSync(getSessionFile())) {
      // Overwrite with random bytes before deleting (secure erase)
      const size = readFileSync(getSessionFile()).length
      writeFileSync(getSessionFile(), randomBytes(size))
      unlinkSync(getSessionFile())
    }
  } catch (err) {
    console.error('[secureStorage] Failed to clear session:', err)
  }
}
