/**
 * Turning service errors into something a person can act on.
 *
 * The streaming service reports most problems as an opaque internal string
 * ("Xccs : ErrorCallingWNS : ..."). Two things matter about each one: whether
 * retrying could ever help, and what the user should actually do about it.
 * Retrying a permanent condition is the exact behaviour this app exists to
 * avoid, so classification lives here and both processes use it.
 */

export interface ClassifiedError {
  /** Short headline for the UI. */
  title: string
  /** What to do about it, when we know. */
  guidance?: string
  /** False when retrying cannot possibly help. */
  retryable: boolean
  /** The original text, always kept for the diagnostics log. */
  raw: string
}

/** Electron wraps IPC rejections; strip the wrapper so the real text shows. */
export function unwrapIpcError(message: string): string {
  return message
    .replace(/^Error invoking remote method '[^']+':\s*/, '')
    .replace(/^(Error|TypeError):\s*/, '')
    .trim()
}

export function classifyError(input: string): ClassifiedError {
  const raw = unwrapIpcError(input)

  // The console never registered with the streaming service, so there is
  // nothing for it to push a start command to.
  if (/WaitingForServerToRegister|ErrorCallingWNS/i.test(raw)) {
    return {
      title: 'Your Xbox isn’t reachable',
      guidance:
        'The streaming service could not reach the console. On the Xbox: turn it on, then go to ' +
        'Settings → Devices & connections → Remote features and make sure “Enable remote features” ' +
        'is checked and Power mode is set to Instant-on. Leave it on for a minute so it registers, ' +
        'then try again.',
      retryable: false,
      raw,
    }
  }

  if (/ConsoleNotAvailable|ServerNotAvailable|NotFound/i.test(raw)) {
    return {
      title: 'The console is not available',
      guidance:
        'It may be off, offline, or already streaming to another device. Check that it is powered ' +
        'on and connected to the network.',
      retryable: false,
      raw,
    }
  }

  if (/SessionLimitExceeded|TooManySessions|Conflict/i.test(raw)) {
    return {
      title: 'The console is already streaming',
      guidance:
        'Another device has an active Remote Play session. Close it, or sign out of Remote Play ' +
        'there, then try again.',
      retryable: false,
      raw,
    }
  }

  if (/NoEntitlement|Forbidden|Unauthorized|403|401/i.test(raw)) {
    return {
      title: 'Xbox refused the request',
      guidance: 'Your sign-in may have expired. Sign out and back in.',
      retryable: false,
      raw,
    }
  }

  if (/RegionNotSupported|OfferingNotAvailable/i.test(raw)) {
    return {
      title: 'Remote Play is unavailable for this account',
      guidance: 'The streaming service did not offer a region for this account.',
      retryable: false,
      raw,
    }
  }

  // Transport-level trouble genuinely can clear on its own.
  return { title: raw || 'Connection failed', retryable: true, raw }
}
