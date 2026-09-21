import { useEffect, useRef, useState } from 'react'
import type { StreamStatus } from '@shared/types.js'
import type { StreamStats } from '@core/stream/connection.js'
import type { LogLine } from '../adapters/client.js'
import { TouchPad } from './TouchPad.js'

const CONNECTING: StreamStatus['phase'][] = [
  'authorizing',
  'waking',
  'requesting-session',
  'provisioning',
  'negotiating',
  'connecting',
]

export function Stream({
  stream,
  status,
  stats,
  logs,
  onDisconnect,
  onReconnectController,
}: {
  stream: MediaStream | null
  status: StreamStatus
  stats: StreamStats | null
  logs: LogLine[]
  onDisconnect: () => void
  onReconnectController: () => void
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [showControls, setShowControls] = useState(true)
  const [showMenu, setShowMenu] = useState(false)
  const [showLog, setShowLog] = useState(false)

  useEffect(() => {
    const video = videoRef.current
    if (!video || !stream) return
    if (video.srcObject !== stream) {
      video.srcObject = stream
      // iOS blocks autoplay far more aggressively than desktop; a rejected
      // play() is the difference between a black screen and a stream, so it
      // must be visible rather than swallowed.
      video.play().catch((err) => console.warn('play() rejected', err))
    }
  }, [stream])

  const connecting = CONNECTING.includes(status.phase)
  const failed = status.phase === 'failed'
  const live = status.phase === 'streaming'

  return (
    <div className="stage">
      {/* playsInline is mandatory: without it iOS takes the video fullscreen
          in its own player and the touch controls become unreachable. */}
      <video ref={videoRef} className="video" playsInline autoPlay muted={false} />

      {(connecting || status.phase === 'reconnecting' || failed) && (
        <div className="overlay">
          <div className="card">
            {!failed && <div className="spinner" />}
            <h2>{status.detail || (failed ? 'Connection failed' : 'Connecting')}</h2>
            {status.error && <p className={failed ? 'guidance' : 'error'}>{status.error}</p>}
            <button className="ghost" onClick={onDisconnect}>
              {failed ? 'Back' : 'Cancel'}
            </button>
          </div>
        </div>
      )}

      {live && <TouchPad visible={showControls} />}

      {/* A small always-present handle; the full menu is hidden so it cannot
          obscure the game. */}
      <button className="menu-tab" onClick={() => setShowMenu((v) => !v)}>
        {showMenu ? '×' : '⋯'}
      </button>

      {showMenu && (
        <div className="menu-sheet">
          <div className="menu-row">
            <span className={`badge ${live ? 'good' : 'warn'}`}>
              {live ? 'Streaming' : status.detail || status.phase}
            </span>
            {stats && live && (
              <span className="muted small">
                {stats.fps} fps · {stats.rttMs} ms · {stats.bitrateKbps} kbps
              </span>
            )}
          </div>
          <div className="menu-actions">
            <button className="ghost" onClick={() => setShowControls((v) => !v)}>
              {showControls ? 'Hide controls' : 'Show controls'}
            </button>
            <button className="ghost" onClick={onReconnectController}>
              Re-pair
            </button>
            <button className="ghost" onClick={() => setShowLog((v) => !v)}>
              Diagnostics
            </button>
            <button className="ghost danger" onClick={onDisconnect}>
              Disconnect
            </button>
          </div>
          {showLog && (
            <div className="log">
              {logs.slice(-120).map((line, i) => (
                <div key={i} className={`log-line ${line.level}`}>
                  <span className="muted">{line.scope}</span> {line.message}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
