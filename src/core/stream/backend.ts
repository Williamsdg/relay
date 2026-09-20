/**
 * What the connection manager needs from its host.
 *
 * On desktop these calls cross an IPC bridge to the Electron main process; on
 * iOS the same operations run in-process against the core client directly.
 * Keeping the manager written against this interface means the WebRTC
 * negotiation, input loop, reconnect policy and stall watchdog are shared
 * rather than reimplemented per platform.
 */
import type { SessionHandle, RemoteIceCandidate } from '../../shared/types.js'
import type { LogLevel } from '../ports.js'

export interface SessionStartResult {
  handle: SessionHandle
  config: {
    keepAlivePulseInSeconds?: number
    serverDetails?: {
      ipAddress?: string
      port?: number
      stunServerAddress?: string | null
    }
  }
}

export interface StreamBackend {
  startSession(opts: {
    serverId: string
    width: number
    height: number
  }): Promise<SessionStartResult>
  exchangeSdp(offerSdp: string): Promise<{ sdp: string; versions: Record<string, number> }>
  exchangeIce(candidates: RTCIceCandidateInit[]): Promise<RemoteIceCandidate[]>
  keepalive(): Promise<void>
  stopSession(): Promise<void>
  /** Wake the console; resolves to whether it reported On. */
  ensureConsoleOn(serverId: string): Promise<boolean>
  log(level: LogLevel, scope: string, message: string): void
}
