/**
 * Credential storage on iOS.
 *
 * Refresh tokens go in the iOS Keychain via a small native plugin — Capacitor
 * Preferences is backed by UserDefaults, which is neither encrypted nor
 * excluded from backups and is the wrong place for a credential. Non-secret
 * settings do use Preferences.
 */
import { registerPlugin } from '@capacitor/core'
import { Preferences } from '@capacitor/preferences'
import type { SecureStore } from '@core/ports.js'

interface KeychainPlugin {
  get(options: { key: string }): Promise<{ value: string | null }>
  set(options: { key: string; value: string }): Promise<void>
  remove(options: { key: string }): Promise<void>
}

const Keychain = registerPlugin<KeychainPlugin>('Keychain')

export const keychainStore: SecureStore = {
  async get(key) {
    try {
      const { value } = await Keychain.get({ key })
      return value ?? null
    } catch {
      // Missing item, or a keychain the OS will not unlock. Treat as signed
      // out rather than blocking startup.
      return null
    }
  },
  async set(key, value) {
    await Keychain.set({ key, value })
  },
  async remove(key) {
    await Keychain.remove({ key }).catch(() => undefined)
  },
}

/** Ordinary settings — no secrets, so Preferences is appropriate. */
export const preferences = {
  async get<T>(key: string, fallback: T): Promise<T> {
    const { value } = await Preferences.get({ key })
    if (!value) return fallback
    try {
      return JSON.parse(value) as T
    } catch {
      return fallback
    }
  },
  async set(key: string, value: unknown): Promise<void> {
    await Preferences.set({ key, value: JSON.stringify(value) })
  },
}
