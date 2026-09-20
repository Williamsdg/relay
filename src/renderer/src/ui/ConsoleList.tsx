import { useState } from 'react'
import type { XboxConsole, StreamSettings } from '../../../shared/types.js'

function powerLabel(state: string): { text: string; tone: string } {
  switch (state) {
    case 'On':
      return { text: 'On', tone: 'good' }
    case 'ConnectedStandby':
      return { text: 'Standby — will wake', tone: 'warn' }
    case 'Off':
      return { text: 'Off', tone: 'bad' }
    default:
      return { text: state, tone: 'muted' }
  }
}

export function ConsoleList({
  consoles,
  loading,
  error,
  onRefresh,
  onConnect,
  settings,
  onSettingsChange,
}: {
  consoles: XboxConsole[]
  loading: boolean
  error: string | null
  onRefresh: () => void
  onConnect: (target: XboxConsole) => void
  settings: StreamSettings
  onSettingsChange: (next: StreamSettings) => void
}) {
  return (
    <div className="centered">
      <div className="card wide">
        <div className="card-head">
          <h1>Your consoles</h1>
          <button className="ghost" onClick={onRefresh} disabled={loading}>
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>

        {error && <p className="error">{error}</p>}

        {!error && !loading && consoles.length === 0 && (
          <p className="muted">
            No consoles found on this account. Make sure the console has Remote Features enabled
            under Settings → Devices &amp; connections → Remote features.
          </p>
        )}

        <ul className="console-list">
          {consoles.map((c) => {
            const power = powerLabel(c.powerState)
            const off = c.powerState === 'Off'
            return (
              <li key={c.serverId}>
                <div className="console-info">
                  <span className="console-name">{c.name}</span>
                  <span className={`badge ${power.tone}`}>{power.text}</span>
                  <span className="muted small">{c.consoleType}</span>
                </div>
                <PowerButton target={c} onDone={onRefresh} />
                <button className="primary" onClick={() => onConnect(c)} disabled={off}>
                  {off ? 'Unavailable' : 'Connect'}
                </button>
              </li>
            )
          })}
        </ul>

        <label className="toggle">
          <input
            type="checkbox"
            checked={settings.autoWake}
            onChange={(e) => onSettingsChange({ ...settings, autoWake: e.target.checked })}
          />
          <span>
            Turn the console on automatically when connecting
            <span className="muted small block">
              Sends a wake command and waits for it to boot before starting the stream.
            </span>
          </span>
        </label>

        {consoles.some((c) => c.powerState === 'Off') && (
          <p className="muted small">
            A console showing “Off” has instant-on disabled, so it cannot be woken remotely.
          </p>
        )}
      </div>
    </div>
  )
}

/**
 * Power control for one console.
 *
 * The command service only confirms that it accepted the request, not that the
 * console obeyed, so the button reports "Sent" and leaves it to a refresh to
 * show the real power state rather than pretending to know.
 */
function PowerButton({ target, onDone }: { target: XboxConsole; onDone: () => void }) {
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)
  const isOn = target.powerState === 'On'

  const run = async () => {
    setBusy(true)
    try {
      if (isOn) await window.relay.consoles.powerOff(target.serverId)
      else await window.relay.consoles.powerOn(target.serverId)
      setSent(true)
      // Give the console a moment to act before asking for its new state.
      setTimeout(onDone, 4000)
    } catch (err) {
      window.relay.log.write('error', 'xccs', String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <button className="ghost" onClick={run} disabled={busy}>
      {busy ? 'Sending…' : sent ? 'Sent' : isOn ? 'Turn off' : 'Turn on'}
    </button>
  )
}
