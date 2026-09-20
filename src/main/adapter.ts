/**
 * Desktop implementations of the core ports.
 *
 * The core protocol code is platform-agnostic; this is the Electron-specific
 * half. An iOS build supplies its own equivalents (Capacitor HTTP, the iOS
 * keychain) and shares everything else.
 */
import { safeStorage } from 'electron'
import { log } from './logger.js'
import type { HttpClient, Logger, SecureStore } from '../core/ports.js'

/**
 * Node's fetch is not subject to CORS, which is the whole requirement: the
 * Xbox hosts send no CORS headers, so this must run outside a web context.
 */
export const httpClient: HttpClient = async (url, req = {}) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), req.timeoutMs ?? 15_000)
  try {
    const res = await fetch(url, {
      method: req.method ?? 'GET',
      headers: req.headers,
      body: req.body,
      signal: controller.signal,
    })
    const headers: Record<string, string> = {}
    res.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value
    })
    return { status: res.status, text: await res.text(), headers }
  } finally {
    clearTimeout(timer)
  }
}

export const logger: Logger = (level, scope, message) => log[level](scope, message)

/**
 * Credentials in the macOS Keychain via safeStorage. If the OS declines to
 * provide encryption we refuse to write plaintext credentials to disk and the
 * user simply signs in again next launch.
 */
export function createSecureStore(readFile: (k: string) => Buffer | null,
                                  writeFile: (k: string, v: Buffer) => void,
                                  removeFile: (k: string) => void): SecureStore {
  return {
    async get(key) {
      if (!safeStorage.isEncryptionAvailable()) return null
      const raw = readFile(key)
      if (!raw) return null
      try {
        return safeStorage.decryptString(raw)
      } catch {
        // A keychain rotation leaves an undecryptable blob. Treat it as signed
        // out rather than wedging every future launch.
        return null
      }
    },
    async set(key, value) {
      if (!safeStorage.isEncryptionAvailable()) {
        log.warn('auth', 'OS encryption unavailable — not persisting credentials')
        return
      }
      writeFile(key, safeStorage.encryptString(value))
    },
    async remove(key) {
      removeFile(key)
    },
  }
}
