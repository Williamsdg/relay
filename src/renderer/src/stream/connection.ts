/**
 * Connection manager: owns the RTCPeerConnection and everything that keeps it
 * alive.
 *
 * The official client's worst habit is failing silently — a spinner that never
 * resolves, or a window that keeps showing the last decoded frame long after
 * the console stopped sending. Three mechanisms here exist to prevent that:
 *
 *  - every phase is named and surfaced, so a failure says which step died;
 *  - a stall watchdog watches `framesDecoded` rather than connection state,
 *    because WebRTC frequently reports "connected" on a stream that has
 *    actually stopped producing frames;
 *  - reconnects are automatic and bounded, tearing the session fully down and
 *    re-provisioning rather than trying to revive a dead peer connection.
 */
import type { StreamSettings, StreamStatus, StreamPhase } from '../../../shared/types.js'
import { classifyError } from '../../../shared/errors.js'
import { encodeClientMetadata, encodeGamepadFrames } from './packet.js'
import { readGamepads, isNeutral } from './gamepad.js'

export interface StreamStats {
  fps: number
  bitrateKbps: number
  rttMs: number
  packetsLost: number
  jitterMs: number
  framesDecoded: number
  resolution: string
  codec: string
}

const EMPTY_STATS: StreamStats = {
  fps: 0,
  bitrateKbps: 0,
  rttMs: 0,
  packetsLost: 0,
  jitterMs: 0,
  framesDecoded: 0,
  resolution: '—',
  codec: '—',
}

const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
]

/** Channel name -> SCTP protocol label the console expects. */
const DATA_CHANNELS: Array<{ name: string; protocol: string; ordered?: boolean }> = [
  { name: 'input', protocol: '1.0', ordered: true },
  { name: 'chat', protocol: 'chatV1' },
  { name: 'control', protocol: 'controlV1' },
  { name: 'message', protocol: 'messageV1' },
]

const RESOLUTIONS: Record<number, { width: number; height: number }> = {
  720: { width: 1280, height: 720 },
  1080: { width: 1920, height: 1080 },
  1440: { width: 2560, height: 1440 },
}

export interface ConnectionCallbacks {
  onStatus: (status: StreamStatus) => void
  onStats: (stats: StreamStats) => void
  onStream: (stream: MediaStream) => void
}

export class ConnectionManager {
  private pc: RTCPeerConnection | null = null
  private channels = new Map<string, RTCDataChannel>()
  private inputTimer: number | null = null
  private keepaliveTimer: number | null = null
  private statsTimer: number | null = null
  private sequence = 0

  private phase: StreamPhase = 'idle'
  private reconnects = 0
  private stopped = false
  private serverId = ''

  /** Watchdog bookkeeping. */
  private lastFramesDecoded = 0
  private lastFrameProgressAt = 0
  private lastStatsAt = 0
  private lastBytesReceived = 0
  private stats: StreamStats = { ...EMPTY_STATS }

  constructor(
    private readonly settings: StreamSettings,
    private readonly cb: ConnectionCallbacks,
  ) {}

  private setPhase(phase: StreamPhase, detail: string, error?: string) {
    this.phase = phase
    this.cb.onStatus({ phase, detail, error, reconnects: this.reconnects })
  }

  async start(serverId: string): Promise<void> {
    this.serverId = serverId
    this.stopped = false
    this.reconnects = 0
    await this.connect()
  }

  /** One full connect attempt, from session request to first frame. */
  private async connect(): Promise<void> {
    const { width, height } = RESOLUTIONS[this.settings.resolution] ?? RESOLUTIONS[1080]

    try {
      this.setPhase('requesting-session', 'Asking Xbox for a streaming session')
      const { handle, config } = await window.relay.session.start({
        serverId: this.serverId,
        width,
        height,
      })

      this.setPhase('negotiating', 'Negotiating the media connection')
      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })
      this.pc = pc

      // Collect candidates as they trickle in; the service takes them as one
      // batch rather than incrementally.
      const localCandidates: RTCIceCandidateInit[] = []
      pc.addEventListener('icecandidate', (event) => {
        if (event.candidate) localCandidates.push(event.candidate.toJSON())
      })

      pc.addEventListener('track', (event) => {
        if (event.streams[0]) this.cb.onStream(event.streams[0])
      })

      pc.addEventListener('connectionstatechange', () => {
        const state = pc.connectionState
        if (state === 'connected' && this.phase !== 'streaming') {
          this.lastFrameProgressAt = performance.now()
          this.setPhase('streaming', 'Connected')
        }
        if (state === 'failed' || state === 'disconnected') {
          this.handleDrop(`The connection ${state}`)
        }
      })

      // Video in, audio both ways (the console accepts mic audio on the same
      // transceiver, which is why this is sendrecv rather than recvonly).
      pc.addTransceiver('video', { direction: 'recvonly' })
      pc.addTransceiver('audio', { direction: 'sendrecv' })

      for (const spec of DATA_CHANNELS) {
        const channel = pc.createDataChannel(spec.name, {
          protocol: spec.protocol,
          ordered: spec.ordered ?? true,
        })
        channel.binaryType = 'arraybuffer'
        this.channels.set(spec.name, channel)
      }

      this.channels.get('input')?.addEventListener('open', () => this.startInputLoop())

      const offer = await pc.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: true,
      })
      await pc.setLocalDescription(offer)

      const answer = await window.relay.session.sdp(offer.sdp ?? '')
      await pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp })

      this.setPhase('connecting', 'Exchanging network routes')
      await this.waitForIceGathering(pc)

      const remote = await window.relay.session.ice(localCandidates)
      for (const candidate of remote) {
        try {
          await pc.addIceCandidate({
            candidate: candidate.candidate,
            sdpMid: candidate.sdpMid ?? undefined,
            sdpMLineIndex: candidate.sdpMLineIndex ?? undefined,
          })
        } catch (err) {
          // A single unusable candidate is normal — others still connect.
          console.warn('Rejected ICE candidate', err)
        }
      }

      this.startKeepalive(config.keepAlivePulseInSeconds ?? handle.keepAlivePulseInSeconds ?? 300)
      this.startStatsLoop()
    } catch (err) {
      if (this.stopped) return
      const classified = classifyError(err instanceof Error ? err.message : String(err))
      // Retrying something the service has already ruled out just burns the
      // attempt budget and hides the real problem behind a spinner.
      if (!classified.retryable) {
        this.teardownPeer()
        this.setPhase('failed', classified.title, classified.guidance)
        return
      }
      if (this.settings.autoReconnect && this.reconnects < 5) {
        this.handleDrop(classified.title)
      } else {
        this.setPhase('failed', 'Could not connect', classified.title)
      }
    }
  }

  /**
   * ICE gathering can legitimately never reach "complete" behind some NATs, so
   * we give it a deadline and send whatever we have.
   */
  private waitForIceGathering(pc: RTCPeerConnection, timeoutMs = 3000): Promise<void> {
    if (pc.iceGatheringState === 'complete') return Promise.resolve()
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer)
        pc.removeEventListener('icegatheringstatechange', onChange)
        resolve()
      }
      const onChange = () => {
        if (pc.iceGatheringState === 'complete') done()
      }
      const timer = setTimeout(done, timeoutMs)
      pc.addEventListener('icegatheringstatechange', onChange)
    })
  }

  /** Push gamepad state at a fixed rate while the input channel is open. */
  private startInputLoop(): void {
    const channel = this.channels.get('input')
    if (!channel) return

    this.sequence = 0
    channel.send(encodeClientMetadata(this.sequence, navigator.maxTouchPoints ?? 0))

    const intervalMs = 1000 / this.settings.pollingRate
    let sentNeutral = false

    this.inputTimer = window.setInterval(() => {
      if (channel.readyState !== 'open') return
      const frames = readGamepads()
      if (frames.length === 0) return

      // Stop resending an all-zero state once the console has it, but always
      // send the first neutral frame after activity so buttons do not stick.
      const neutral = frames.every(isNeutral)
      if (neutral && sentNeutral) return
      sentNeutral = neutral

      this.sequence += 1
      try {
        channel.send(encodeGamepadFrames(this.sequence, frames))
      } catch {
        // Buffer full or channel closing; the next tick recovers.
      }
    }, intervalMs)
  }

  /** The service drops sessions that go quiet, even mid-stream. */
  private startKeepalive(pulseSeconds: number): void {
    const intervalMs = Math.max(30, pulseSeconds / 2) * 1000
    this.keepaliveTimer = window.setInterval(() => {
      window.relay.session.keepalive().catch((err) => {
        console.warn('Keepalive failed', err)
      })
    }, intervalMs)
  }

  /**
   * Poll transport stats for the HUD, and — more importantly — watch decoded
   * frame progress. A stream that stops decoding while WebRTC still reports
   * "connected" is the classic Remote Play hang, and it is only detectable
   * here.
   */
  private startStatsLoop(): void {
    this.lastFrameProgressAt = performance.now()
    this.statsTimer = window.setInterval(async () => {
      const pc = this.pc
      if (!pc) return

      const report = await pc.getStats()
      const now = performance.now()
      let next: StreamStats = { ...this.stats }

      report.forEach((entry) => {
        if (entry.type === 'inbound-rtp' && entry.kind === 'video') {
          const framesDecoded = entry.framesDecoded ?? 0
          const bytes = entry.bytesReceived ?? 0
          const elapsed = (now - this.lastStatsAt) / 1000

          if (this.lastStatsAt && elapsed > 0) {
            next.bitrateKbps = Math.round(((bytes - this.lastBytesReceived) * 8) / elapsed / 1000)
          }
          next.fps = Math.round(entry.framesPerSecond ?? 0)
          next.packetsLost = entry.packetsLost ?? 0
          next.jitterMs = Math.round((entry.jitter ?? 0) * 1000)
          next.framesDecoded = framesDecoded
          if (entry.frameWidth && entry.frameHeight) {
            next.resolution = `${entry.frameWidth}×${entry.frameHeight}`
          }

          if (framesDecoded > this.lastFramesDecoded) {
            this.lastFramesDecoded = framesDecoded
            this.lastFrameProgressAt = now
          }
          this.lastBytesReceived = bytes
        }

        if (entry.type === 'candidate-pair' && entry.state === 'succeeded' && entry.nominated) {
          next.rttMs = Math.round((entry.currentRoundTripTime ?? 0) * 1000)
        }

        if (entry.type === 'codec' && entry.mimeType?.startsWith('video/')) {
          next.codec = entry.mimeType.replace('video/', '')
        }
      })

      this.lastStatsAt = now
      this.stats = next
      this.cb.onStats(next)

      const stallMs = this.settings.stallTimeoutSeconds * 1000
      if (
        stallMs > 0 &&
        this.phase === 'streaming' &&
        now - this.lastFrameProgressAt > stallMs
      ) {
        this.handleDrop(
          `No video for ${this.settings.stallTimeoutSeconds}s (the stream stalled)`,
        )
      }
    }, 1000)
  }

  /** Common path for every kind of loss: tear down, back off, reconnect. */
  private handleDrop(reason: string): void {
    if (this.stopped) return
    if (this.phase === 'reconnecting') return

    const classified = classifyError(reason)
    if (!classified.retryable) {
      this.teardownPeer()
      this.setPhase('failed', classified.title, classified.guidance)
      return
    }

    this.teardownPeer()

    if (!this.settings.autoReconnect) {
      this.setPhase('failed', 'Connection lost', reason)
      return
    }
    if (this.reconnects >= 5) {
      this.setPhase('failed', 'Connection lost', `${reason} — gave up after 5 attempts`)
      return
    }

    this.reconnects += 1
    const backoff = Math.min(8000, 1000 * 2 ** (this.reconnects - 1))
    this.setPhase(
      'reconnecting',
      `${reason}. Reconnecting in ${Math.round(backoff / 1000)}s (attempt ${this.reconnects}/5)`,
    )

    window.setTimeout(() => {
      if (!this.stopped) void this.connect()
    }, backoff)
  }

  /** Drop the peer connection and its timers, leaving auth/session state alone. */
  private teardownPeer(): void {
    for (const timer of [this.inputTimer, this.keepaliveTimer, this.statsTimer]) {
      if (timer !== null) window.clearInterval(timer)
    }
    this.inputTimer = this.keepaliveTimer = this.statsTimer = null

    for (const channel of this.channels.values()) {
      try {
        channel.close()
      } catch {
        /* already closing */
      }
    }
    this.channels.clear()

    if (this.pc) {
      try {
        this.pc.close()
      } catch {
        /* already closed */
      }
      this.pc = null
    }

    this.lastFramesDecoded = 0
    this.lastStatsAt = 0
    this.lastBytesReceived = 0
    this.stats = { ...EMPTY_STATS }
    this.cb.onStats(this.stats)
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.teardownPeer()
    await window.relay.session.stop().catch(() => undefined)
    this.setPhase('stopped', 'Disconnected')
  }
}
