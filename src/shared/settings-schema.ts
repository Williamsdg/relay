/**
 * Validation for persisted settings.
 *
 * Pure and dependency-free so it can be exercised directly: a stale or
 * hand-edited settings file must never be able to stop the app starting, and
 * that guarantee is only worth anything if it is tested.
 */
import { DEFAULT_SETTINGS, type StreamSettings } from './types.js'

export interface PersistedState extends StreamSettings {
  /** Server id of the console used last, so it can be offered first. */
  lastConsoleId?: string
}

export const DEFAULT_PERSISTED: PersistedState = { ...DEFAULT_SETTINGS }

/** Keep only values of the expected shape, falling back per-field. */
export function sanitiseSettings(raw: unknown): PersistedState {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_PERSISTED }
  const input = raw as Record<string, unknown>
  const next: PersistedState = { ...DEFAULT_PERSISTED }

  if (input.resolution === 720 || input.resolution === 1080 || input.resolution === 1440) {
    next.resolution = input.resolution
  }
  if (
    typeof input.pollingRate === 'number' &&
    input.pollingRate >= 10 &&
    input.pollingRate <= 250
  ) {
    next.pollingRate = input.pollingRate
  }
  // Explicit booleans only: `false` is a real choice, not a missing value.
  if (typeof input.autoReconnect === 'boolean') next.autoReconnect = input.autoReconnect
  if (typeof input.autoWake === 'boolean') next.autoWake = input.autoWake
  if (
    typeof input.stallTimeoutSeconds === 'number' &&
    input.stallTimeoutSeconds >= 0 &&
    input.stallTimeoutSeconds <= 120
  ) {
    next.stallTimeoutSeconds = input.stallTimeoutSeconds
  }
  if (typeof input.lastConsoleId === 'string' && input.lastConsoleId) {
    next.lastConsoleId = input.lastConsoleId
  }

  const turn = input.turn as Record<string, unknown> | undefined
  // A half-filled relay is worse than none: it would be offered to ICE, fail
  // to authenticate, and look like a network fault.
  if (
    turn &&
    typeof turn.url === 'string' &&
    turn.url.trim() &&
    typeof turn.username === 'string' &&
    typeof turn.credential === 'string'
  ) {
    next.turn = {
      url: turn.url.trim(),
      username: turn.username,
      credential: turn.credential,
      forceRelay: turn.forceRelay === true,
    }
  }
  return next
}
