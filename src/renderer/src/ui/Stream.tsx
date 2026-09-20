import { useEffect, useRef, useState } from 'react'
import type { StreamStatus } from '../../../shared/types.js'
import type { StreamStats } from '../stream/connection.js'

/** Phases where we are still working toward a picture. */
const CONNECTING: StreamStatus['phase'][] = [
  'authorizing',
  'requesting-session',
  'provisioning',
  'negotiating',
  'connecting',
]

export function Stream({
  stream,
  status,
  stats,
  onDisconnect,
}: {
  stream: MediaStream | null
  status: StreamStatus
  stats: StreamStats | null
  onDisconnect: () => void
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [showHud, setShowHud] = useState(false)

  useEffect(() => {
    const video = videoRef.current
    if (video && stream && video.srcObject !== stream) {
      video.srcObject = stream
      // Autoplay is allowed here because the stream is user-initiated, but a
      // rejected play() would otherwise leave a permanently black window.
      video.play().catch((err) => console.warn('Video play was blocked', err))
    }
  }, [stream])

  const connecting = CONNECTING.includes(status.phase)
  const failed = status.phase === 'failed'

  return (
    <div className="stage">
      <video ref={videoRef} className="video" playsInline autoPlay />

      {(connecting || status.phase === 'reconnecting' || failed) && (
        <div className="overlay">
          <div className="card">
            {!failed && <div className="spinner" aria-hidden />}
            <h2>{failed ? 'Connection failed' : status.detail || 'Connecting'}</h2>
            {!failed && <p className="muted small">{phaseLabel(status.phase)}</p>}
            {status.error && <p className="error">{status.error}</p>}
            {status.reconnects > 0 && !failed && (
              <p className="muted small">Reconnect attempt {status.reconnects} of 5</p>
            )}
            <button className="ghost" onClick={onDisconnect}>
              {failed ? 'Back to consoles' : 'Cancel'}
            </button>
          </div>
        </div>
      )}

      <div className="stream-bar">
        <span className={`badge ${status.phase === 'streaming' ? 'good' : 'warn'}`}>
          {status.phase === 'streaming' ? 'Streaming' : status.detail || status.phase}
        </span>
        {stats && status.phase === 'streaming' && (
          <span className="muted small">
            {stats.fps} fps · {stats.rttMs} ms · {stats.bitrateKbps} kbps
          </span>
        )}
        <div className="spacer" />
        <button className="ghost" onClick={() => setShowHud((v) => !v)} aria-pressed={showHud}>
          Stats
        </button>
        <button className="ghost" onClick={onDisconnect}>
          Disconnect
        </button>
      </div>

      {showHud && stats && (
        <div className="hud">
          <Row label="Resolution" value={stats.resolution} />
          <Row label="Codec" value={stats.codec} />
          <Row label="Frame rate" value={`${stats.fps} fps`} />
          <Row label="Bitrate" value={`${stats.bitrateKbps} kbps`} />
          <Row label="Round trip" value={`${stats.rttMs} ms`} />
          <Row label="Jitter" value={`${stats.jitterMs} ms`} />
          <Row label="Packets lost" value={String(stats.packetsLost)} />
          <Row label="Reconnects" value={String(status.reconnects)} />
        </div>
      )}
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="hud-row">
      <span className="muted">{label}</span>
      <span>{value}</span>
    </div>
  )
}

function phaseLabel(phase: StreamStatus['phase']): string {
  switch (phase) {
    case 'requesting-session':
      return 'Step 1 of 4 — requesting a session'
    case 'provisioning':
      return 'Step 2 of 4 — waking the console'
    case 'negotiating':
      return 'Step 3 of 4 — negotiating media'
    case 'connecting':
      return 'Step 4 of 4 — finding a network route'
    case 'reconnecting':
      return 'Recovering the connection'
    default:
      return ''
  }
}
