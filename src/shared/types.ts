/** Types shared across main / preload / renderer. */

export type AuthState =
  | { status: 'signed-out' }
  | { status: 'signing-in'; step: string }
  | { status: 'signed-in'; gamertag: string; xuid: string }
  | { status: 'error'; message: string }

export interface XboxConsole {
  serverId: string
  name: string
  consoleType: string
  /** e.g. 'On' | 'ConnectedStandby' | 'Off' | 'Unknown' */
  powerState: string
  /** True when the console is reachable on the same LAN as this Mac. */
  isLocal?: boolean
}

/**
 * Connection phases, in the order they occur. The UI shows these verbatim so a
 * failure names the step it died on instead of a generic "can't connect".
 */
export type StreamPhase =
  | 'idle'
  | 'authorizing'
  | 'waking'
  | 'requesting-session'
  | 'provisioning'
  | 'negotiating'
  | 'connecting'
  | 'streaming'
  | 'reconnecting'
  | 'stopped'
  | 'failed'

export interface StreamStatus {
  phase: StreamPhase
  detail: string
  /** Populated on 'failed'. */
  error?: string
  /** How many automatic reconnects have happened this session. */
  reconnects: number
}

export interface SessionHandle {
  sessionId: string
  sessionPath: string
  baseUri: string
  keepAlivePulseInSeconds: number
}

export interface SdpExchange {
  sdp: string
  /** Channel version numbers the server agreed to. */
  versions: Record<string, number>
}

export interface RemoteIceCandidate {
  candidate: string
  sdpMid?: string | null
  sdpMLineIndex?: number | null
}

export interface LogLine {
  ts: number
  level: 'debug' | 'info' | 'warn' | 'error'
  scope: string
  message: string
}

export interface StreamSettings {
  /** Target vertical resolution: 720 | 1080 | 1440 */
  resolution: 720 | 1080 | 1440
  /** Input polling rate in Hz. */
  pollingRate: number
  /** Auto-reconnect when the transport drops. */
  autoReconnect: boolean
  /**
   * Seconds without a decoded video frame before the watchdog declares the
   * stream hung and forces a reconnect. 0 disables the watchdog.
   */
  stallTimeoutSeconds: number
  /** Wake the console automatically if it is in standby. */
  autoWake: boolean
}

export const DEFAULT_SETTINGS: StreamSettings = {
  resolution: 1080,
  pollingRate: 62.5,
  autoReconnect: true,
  stallTimeoutSeconds: 8,
  autoWake: true,
}
