import { useCallback, useEffect, useRef, useState } from 'react'
import type { StreamStatus } from '../../../shared/types.js'
import type { StreamStats } from '../../../core/stream/connection.js'
import { attachKeyboard, DEFAULT_KEYBOARD_OPTIONS } from '../stream/keyboard.js'
import { virtualPad } from '../../../core/stream/virtualPad.js'
import { ControlPad } from './ControlPad.js'

/** Phases where we are still working toward a picture. */
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
  onDisconnect,
  onReconnectController,
}: {
  stream: MediaStream | null
  status: StreamStatus
  stats: StreamStats | null
  onDisconnect: () => void
  onReconnectController: () => void
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [showHud, setShowHud] = useState(false)
  const [showPad, setShowPad] = useState(false)
  const [keyboardOn, setKeyboardOn] = useState(false)
  const [muted, setMuted] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)

  useEffect(() => {
    const video = videoRef.current
    if (!video || !stream) return

    const note = (m: string) => window.relay.log.write('info', 'video', m)

    if (video.srcObject !== stream) {
      video.srcObject = stream
      note(`attached stream with ${stream.getVideoTracks().length} video track(s)`)
      // Autoplay is allowed here because the stream is user-initiated, but a
      // rejected play() would otherwise leave a permanently black window with
      // no other symptom, so it must be reported rather than swallowed.
      video.play().then(
        () => note('playback started'),
        (err) => window.relay.log.write('error', 'video', `play() rejected: ${String(err)}`),
      )
    }

    // These are the difference between "no video arrived" and "video arrived
    // but is not being painted" — indistinguishable on a black screen.
    const onMeta = () => note(`metadata: ${video.videoWidth}x${video.videoHeight}`)
    const onResize = () => note(`resized: ${video.videoWidth}x${video.videoHeight}`)
    const onPlaying = () => note('element reports playing')
    const onStalled = () => window.relay.log.write('warn', 'video', 'element stalled')
    video.addEventListener('loadedmetadata', onMeta)
    video.addEventListener('resize', onResize)
    video.addEventListener('playing', onPlaying)
    video.addEventListener('stalled', onStalled)
    return () => {
      video.removeEventListener('loadedmetadata', onMeta)
      video.removeEventListener('resize', onResize)
      video.removeEventListener('playing', onPlaying)
      video.removeEventListener('stalled', onStalled)
    }
  }, [stream])

  // Keyboard control is opt-in: while it is on, keys drive the console instead
  // of the app, so it must never be a surprise.
  useEffect(() => {
    if (!keyboardOn) return
    const video = videoRef.current
    if (!video) return
    window.relay.log.write('info', 'input', 'keyboard control enabled')
    const detach = attachKeyboard(video, DEFAULT_KEYBOARD_OPTIONS)
    return () => {
      detach()
      window.relay.log.write('info', 'input', 'keyboard control disabled')
    }
  }, [keyboardOn])

  // Never leave a virtual button latched when the view goes away.
  useEffect(() => () => virtualPad.reset(), [])

  const toggleMute = useCallback(() => {
    const video = videoRef.current
    if (!video) return
    video.muted = !video.muted
    setMuted(video.muted)
  }, [])

  const toggleFullscreen = useCallback(async () => {
    setFullscreen(await window.relay.window.toggleFullscreen())
  }, [])

  const screenshot = useCallback(async () => {
    const video = videoRef.current
    if (!video || !video.videoWidth) return
    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    canvas.getContext('2d')?.drawImage(video, 0, 0)
    const path = await window.relay.window.saveImage(canvas.toDataURL('image/png'))
    if (path) window.relay.log.write('info', 'app', `screenshot saved to ${path}`)
  }, [])

  const connecting = CONNECTING.includes(status.phase)
  const failed = status.phase === 'failed'
  const live = status.phase === 'streaming'

  return (
    <div className="stage">
      <video ref={videoRef} className="video" playsInline autoPlay />

      {(connecting || status.phase === 'reconnecting' || failed) && (
        <div className="overlay">
          <div className="card">
            {!failed && <div className="spinner" aria-hidden />}
            <h2>{status.detail || (failed ? 'Connection failed' : 'Connecting')}</h2>
            {!failed && <p className="muted small">{phaseLabel(status.phase)}</p>}
            {status.error && <p className={failed ? 'guidance' : 'error'}>{status.error}</p>}
            {status.reconnects > 0 && !failed && (
              <p className="muted small">Reconnect attempt {status.reconnects} of 5</p>
            )}
            <button className="ghost" onClick={onDisconnect}>
              {failed ? 'Back to consoles' : 'Cancel'}
            </button>
          </div>
        </div>
      )}

      {showPad && live && <ControlPad onClose={() => setShowPad(false)} />}

      <div className="stream-bar">
        <span className={`badge ${live ? 'good' : 'warn'}`}>
          {live ? 'Streaming' : status.detail || status.phase}
        </span>
        {stats && live && (
          <span className="muted small">
            {stats.fps} fps · {stats.rttMs} ms · {stats.bitrateKbps} kbps
          </span>
        )}
        <div className="spacer" />

        <button
          className="ghost"
          onClick={() => setShowPad((v) => !v)}
          aria-pressed={showPad}
          disabled={!live}
          title="On-screen controller, including the Xbox button"
        >
          Controller
        </button>
        <button
          className="ghost"
          onClick={() => setKeyboardOn((v) => !v)}
          aria-pressed={keyboardOn}
          disabled={!live}
          title="Use the keyboard and mouse as a controller"
        >
          Keyboard
        </button>
        <button className="ghost" onClick={toggleMute} aria-pressed={muted} disabled={!live}>
          {muted ? 'Unmute' : 'Mute'}
        </button>
        <button
          className="ghost"
          onClick={onReconnectController}
          disabled={!live}
          title="Re-present the controller — use when a game ignores input"
        >
          Re-pair
        </button>
        <button className="ghost" onClick={screenshot} disabled={!live}>
          Shot
        </button>
        <button className="ghost" onClick={toggleFullscreen} aria-pressed={fullscreen}>
          {fullscreen ? 'Exit full screen' : 'Full screen'}
        </button>
        <button className="ghost" onClick={() => setShowHud((v) => !v)} aria-pressed={showHud}>
          Stats
        </button>
        <button className="ghost" onClick={onDisconnect}>
          Disconnect
        </button>
      </div>

      {keyboardOn && live && (
        <div className="keyhint muted small">
          WASD move · mouse look (click to capture, Esc to release) · Space A · F B · R X · C Y ·
          Q/E bumpers · Shift LT · G RT · Enter Menu · Home Xbox
        </div>
      )}

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
          <Row label="Input" value={stats.input} />
          <Row label="Controllers" value={stats.controllers} />
          <Row label="Network path" value={stats.path} />
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
    case 'waking':
      return 'Waking the console — this can take up to a minute'
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
