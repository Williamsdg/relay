/**
 * Persisted auth state.
 *
 * Holds the proof key and MSA refresh token so a returning user is signed in
 * silently. Contents are encrypted with Electron's safeStorage (backed by the
 * macOS Keychain); if the OS declines to provide encryption we refuse to write
 * plaintext credentials to disk and simply re-prompt for sign-in next launch.
 */
import { app, safeStorage } from 'electron'
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { log } from '../logger.js'
import type { AuthArtifacts } from './flow.js'

function storePath(): string {
  return join(app.getPath('userData'), 'auth.bin')
}

export function saveArtifacts(artifacts: AuthArtifacts): void {
  if (!safeStorage.isEncryptionAvailable()) {
    log.warn('auth', 'OS encryption unavailable — not persisting credentials')
    return
  }
  const path = storePath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, safeStorage.encryptString(JSON.stringify(artifacts)))
  log.info('auth', 'Credentials saved to the system keychain')
}

export function loadArtifacts(): AuthArtifacts | null {
  const path = storePath()
  if (!existsSync(path)) return null
  if (!safeStorage.isEncryptionAvailable()) return null
  try {
    const parsed = JSON.parse(safeStorage.decryptString(readFileSync(path)))
    if (!parsed?.refreshToken || !parsed?.proofKeyPem || !parsed?.deviceId) {
      log.warn('auth', 'Stored credentials are incomplete — discarding')
      return null
    }
    return parsed as AuthArtifacts
  } catch (err) {
    // A keychain rotation or a partial write leaves an undecryptable blob.
    // Treat it as "signed out" rather than wedging every future launch.
    log.warn('auth', `Could not read stored credentials: ${String(err)}`)
    return null
  }
}

export function clearArtifacts(): void {
  const path = storePath()
  if (existsSync(path)) unlinkSync(path)
  log.info('auth', 'Stored credentials cleared')
}
