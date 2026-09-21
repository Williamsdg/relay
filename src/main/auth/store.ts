/**
 * Persisted auth state, encrypted with Electron's safeStorage (macOS Keychain).
 */
import { app } from 'electron'
import { createPrivateKey } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { log } from '../logger.js'
import { createSecureStore } from '../adapter.js'
import type { AuthArtifacts } from '../../core/auth.js'

const KEY = 'auth'

function pathFor(key: string): string {
  return join(app.getPath('userData'), `${key}.bin`)
}

const store = createSecureStore(
  (key) => {
    const path = pathFor(key)
    return existsSync(path) ? readFileSync(path) : null
  },
  (key, value) => {
    const path = pathFor(key)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, value)
  },
  (key) => {
    const path = pathFor(key)
    if (existsSync(path)) unlinkSync(path)
  },
)

export async function saveArtifacts(artifacts: AuthArtifacts): Promise<void> {
  await store.set(KEY, JSON.stringify(artifacts))
  log.info('auth', 'Credentials saved to the system keychain')
}

export async function loadArtifacts(): Promise<AuthArtifacts | null> {
  const raw = await store.get(KEY)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (!parsed?.refreshToken || !parsed?.deviceId) {
      log.warn('auth', 'Stored credentials are incomplete — discarding')
      return null
    }

    // Older builds stored the proof key as a PEM. The key itself is perfectly
    // good; only the encoding is not portable to other platforms, so convert
    // it rather than making the user sign in again.
    if (!parsed.proofKeyJwk && typeof parsed.proofKeyPem === 'string') {
      try {
        const jwk = createPrivateKey(parsed.proofKeyPem).export({ format: 'jwk' })
        const migrated: AuthArtifacts = {
          proofKeyJwk: jwk as JsonWebKey,
          deviceId: parsed.deviceId,
          refreshToken: parsed.refreshToken,
        }
        await saveArtifacts(migrated)
        log.info('auth', 'Migrated stored proof key from PEM to JWK')
        return migrated
      } catch (err) {
        log.warn('auth', `Could not migrate the stored proof key: ${String(err)}`)
        return null
      }
    }

    if (!parsed.proofKeyJwk) return null
    return parsed as AuthArtifacts
  } catch (err) {
    log.warn('auth', `Could not read stored credentials: ${String(err)}`)
    return null
  }
}

export async function clearArtifacts(): Promise<void> {
  await store.remove(KEY)
  log.info('auth', 'Stored credentials cleared')
}

const RELAY_TOKEN_KEY = 'relay-token'

/**
 * The relay API token lives in the keychain rather than settings.json.
 * It grants access to the user's Cloudflare account, so it gets the same
 * treatment as the Xbox refresh token.
 */
export async function saveRelayToken(token: string): Promise<void> {
  if (!token) {
    await store.remove(RELAY_TOKEN_KEY)
    return
  }
  await store.set(RELAY_TOKEN_KEY, token)
  log.info('settings', 'Relay token saved to the system keychain')
}

export async function loadRelayToken(): Promise<string | null> {
  return store.get(RELAY_TOKEN_KEY)
}
