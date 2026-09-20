/**
 * Recovery policy for a dropped or stalled stream.
 *
 * Pure so the behaviour can be asserted rather than hoped for: this is the
 * part of the app that only runs when something has already gone wrong, which
 * is exactly when it is hardest to observe.
 */

/** Attempts before we stop and tell the user, rather than looping forever. */
export const MAX_RECONNECT_ATTEMPTS = 5

/** Longest gap between attempts; beyond this the wait is worse than the fault. */
export const MAX_BACKOFF_MS = 8000

/**
 * Delay before reconnect attempt `attempt` (1-based).
 *
 * Doubling gives a quick first retry for a blip while backing off enough that
 * a console which is genuinely gone is not hammered.
 */
export function reconnectDelayMs(attempt: number): number {
  if (attempt < 1) return 0
  return Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (attempt - 1))
}

export function canRetry(attemptsSoFar: number, autoReconnect: boolean): boolean {
  return autoReconnect && attemptsSoFar < MAX_RECONNECT_ATTEMPTS
}

/**
 * Whether a stream that reports "connected" has actually stopped producing
 * video. Frame count rather than connection state is the signal, because the
 * transport frequently stays healthy while decoding has stopped.
 */
export function hasStalled(
  msSinceLastFrame: number,
  stallTimeoutSeconds: number,
): boolean {
  if (stallTimeoutSeconds <= 0) return false // watchdog disabled
  return msSinceLastFrame > stallTimeoutSeconds * 1000
}
