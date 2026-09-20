/**
 * Persisted user settings.
 *
 * Plain JSON in the app's data directory — none of this is sensitive, and
 * keeping it readable means a bad value can be corrected by hand rather than
 * requiring a reinstall. Unknown or malformed contents fall back to defaults
 * instead of preventing the app from starting.
 */
import { app } from 'electron'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { log } from './logger.js'
import {
  sanitiseSettings,
  DEFAULT_PERSISTED,
  type PersistedState,
} from '../shared/settings-schema.js'

export type { PersistedState }

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

let cached: PersistedState | null = null

export function loadSettings(): PersistedState {
  if (cached) return cached
  const path = settingsPath()
  if (!existsSync(path)) {
    cached = { ...DEFAULT_PERSISTED }
    return cached
  }
  try {
    cached = sanitiseSettings(JSON.parse(readFileSync(path, 'utf8')))
  } catch (err) {
    log.warn('settings', `Could not read settings, using defaults: ${String(err)}`)
    cached = { ...DEFAULT_PERSISTED }
  }
  return cached
}

export function saveSettings(next: Partial<PersistedState>): PersistedState {
  const merged = sanitiseSettings({ ...loadSettings(), ...next })
  cached = merged
  try {
    const path = settingsPath()
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(merged, null, 2))
  } catch (err) {
    // A failed write must not stop the user doing what they were doing.
    log.warn('settings', `Could not save settings: ${String(err)}`)
  }
  return merged
}
