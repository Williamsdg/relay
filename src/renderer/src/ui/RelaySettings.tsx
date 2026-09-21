import { useState } from 'react'
import type { StreamSettings, TurnServer } from '../../../shared/types.js'

const EMPTY: TurnServer = { url: '', username: '', credential: '', forceRelay: false }

/**
 * Relay configuration.
 *
 * Playing away from home usually means both ends sit behind NAT with no
 * direct path between them. A TURN server forwards the stream in that case.
 * The test button matters: a mistyped credential fails exactly like a network
 * problem, and you do not want to discover that mid-session.
 */
export function RelaySettings({
  settings,
  onChange,
}: {
  settings: StreamSettings
  onChange: (next: StreamSettings) => void
}) {
  const turn = settings.turn ?? EMPTY
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<string | null>(null)

  const update = (patch: Partial<TurnServer>) => {
    const next = { ...turn, ...patch }
    onChange({ ...settings, turn: next.url.trim() ? next : undefined })
    setResult(null)
  }

  /**
   * Ask the browser to gather a relay candidate from this server. If one
   * arrives, the address and credentials are good and media can be relayed.
   */
  const test = async () => {
    setTesting(true)
    setResult(null)
    let pc: RTCPeerConnection | null = null
    try {
      pc = new RTCPeerConnection({
        iceServers: [{ urls: turn.url, username: turn.username, credential: turn.credential }],
        iceTransportPolicy: 'relay',
      })
      pc.createDataChannel('probe')

      const found = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 8000)
        pc!.addEventListener('icecandidate', (event) => {
          if (event.candidate?.candidate.includes('typ relay')) {
            clearTimeout(timer)
            resolve(true)
          }
          // Gathering finished with nothing relayed.
          if (!event.candidate) {
            clearTimeout(timer)
            resolve(false)
          }
        })
        pc!.addEventListener('icecandidateerror', (event) => {
          const e = event as RTCPeerConnectionIceErrorEvent
          if (e.errorCode === 401 || e.errorCode === 403) {
            clearTimeout(timer)
            resolve(false)
          }
        })
      })
      await pc.setLocalDescription(await pc.createOffer())
      setResult(
        found
          ? 'Relay works — it returned a usable address.'
          : 'No relay address came back. Check the URL, username and password, and that the port is reachable.',
      )
    } catch (err) {
      setResult(`Could not test: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      pc?.close()
      setTesting(false)
    }
  }

  return (
    <div className="relay-settings">
      <div className="section-head">
        <h2>Relay server</h2>
      </div>
      <p className="muted small">
        Needed to play away from home. Without one, Relay can only reach your console when both
        are on the same network, because neither end can be reached directly through NAT.
      </p>

      <label className="field">
        <span className="muted small">Server address</span>
        <input
          type="text"
          placeholder="turn:relay.example.com:3478"
          value={turn.url}
          onChange={(e) => update({ url: e.target.value })}
          spellCheck={false}
          autoCapitalize="off"
        />
      </label>

      <div className="settings-row">
        <label className="field">
          <span className="muted small">Username</span>
          <input
            type="text"
            value={turn.username}
            onChange={(e) => update({ username: e.target.value })}
            spellCheck={false}
            autoCapitalize="off"
          />
        </label>
        <label className="field">
          <span className="muted small">Password</span>
          <input
            type="password"
            value={turn.credential}
            onChange={(e) => update({ credential: e.target.value })}
          />
        </label>
      </div>

      <label className="toggle">
        <input
          type="checkbox"
          checked={turn.forceRelay}
          onChange={(e) => update({ forceRelay: e.target.checked })}
        />
        <span>
          Always use the relay
          <span className="muted small block">
            Skips trying a direct path. Slower, but proves the relay is working.
          </span>
        </span>
      </label>

      <button className="ghost" onClick={test} disabled={!turn.url.trim() || testing}>
        {testing ? 'Testing…' : 'Test relay'}
      </button>
      {result && (
        <p className={result.startsWith('Relay works') ? 'guidance' : 'error'}>{result}</p>
      )}
    </div>
  )
}
