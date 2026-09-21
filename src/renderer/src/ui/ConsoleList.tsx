import { useState } from 'react'
import type { XboxConsole, StreamSettings } from '../../../shared/types.js'
import { RelaySettings } from './RelaySettings.js'

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
  lastConsoleId,
}: {
  consoles: XboxConsole[]
  loading: boolean
  error: string | null
  onRefresh: () => void
  onConnect: (target: XboxConsole) => void
  settings: StreamSettings
  onSettingsChange: (next: StreamSettings) => void
  lastConsoleId?: string
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
          {[...consoles]
            .sort((a, b) =>
              a.serverId === lastConsoleId ? -1 : b.serverId === lastConsoleId ? 1 : 0,
            )
            .map((c) => {
            const power = powerLabel(c.powerState)
            const off = c.powerState === 'Off'
            return (
              <li key={c.serverId}>
                <div className="console-info">
                  <span className="console-name">{c.name}</span>
                  <span className={`badge ${power.tone}`}>{power.text}</span>
                  <span className="muted small">
                    {c.consoleType}
                    {c.serverId === lastConsoleId ? ' · last used' : ''}
                  </span>
                </div>
                <PowerButton target={c} onDone={onRefresh} />
                <button className="primary" onClick={() => onConnect(c)} disabled={off}>
                  {off ? 'Unavailable' : 'Connect'}
                </button>
              </li>
            )
          })}
        </ul>

        <div className="settings-row">
          <label className="field">
            <span className="muted small">Stream quality</span>
            <select
              value={settings.resolution}
              onChange={(e) =>
                onSettingsChange({
                  ...settings,
                  resolution: Number(e.target.value) as 720 | 1080 | 1440,
                })
              }
            >
              <option value={720}>720p — lowest latency</option>
              <option value={1080}>1080p — balanced</option>
              <option value={1440}>1440p — sharpest</option>
            </select>
          </label>
          <label className="field">
            <span className="muted small">Stall timeout</span>
            <select
              value={settings.stallTimeoutSeconds}
              onChange={(e) =>
                onSettingsChange({
                  ...settings,
                  stallTimeoutSeconds: Number(e.target.value),
                })
              }
            >
              <option value={0}>Off</option>
              <option value={5}>5 seconds</option>
              <option value={8}>8 seconds</option>
              <option value={15}>15 seconds</option>
            </select>
          </label>
        </div>

        <label className="toggle">
          <input
            type="checkbox"
            checked={settings.autoReconnect}
            onChange={(e) => onSettingsChange({ ...settings, autoReconnect: e.target.checked })}
          />
          <span>
            Reconnect automatically if the stream drops
            <span className="muted small block">
              Recovers from a dropped connection or a stalled picture, up to five attempts.
            </span>
          </span>
        </label>

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

        <RelaySettings settings={settings} onChange={onSettingsChange} />

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
