import type { StreamSettings, XboxConsole } from '@shared/types.js'

function power(state: string): { text: string; tone: string } {
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
  gamertag,
  settings,
  onSettingsChange,
  onRefresh,
  onConnect,
  onSignOut,
}: {
  consoles: XboxConsole[]
  loading: boolean
  error: string | null
  gamertag: string
  settings: StreamSettings
  onSettingsChange: (next: StreamSettings) => void
  onRefresh: () => void
  onConnect: (target: XboxConsole) => void
  onSignOut: () => void
}) {
  return (
    <div className="screen">
      <header className="bar">
        <span className="brand">Relay</span>
        {gamertag && <span className="muted">{gamertag}</span>}
        <div className="spacer" />
        <button className="ghost" onClick={onSignOut}>
          Sign out
        </button>
      </header>

      <div className="scroll">
        <div className="section-head">
          <h2>Your consoles</h2>
          <button className="ghost" onClick={onRefresh} disabled={loading}>
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>

        {error && <p className="error">{error}</p>}

        {!error && !loading && consoles.length === 0 && (
          <p className="muted">
            No consoles found. On the Xbox, enable Settings → Devices &amp; connections → Remote
            features.
          </p>
        )}

        <ul className="console-list">
          {consoles.map((c) => {
            const p = power(c.powerState)
            const off = c.powerState === 'Off'
            return (
              <li key={c.serverId}>
                <div className="console-info">
                  <span className="console-name">{c.name}</span>
                  <span className={`badge ${p.tone}`}>{p.text}</span>
                </div>
                <button className="primary" onClick={() => onConnect(c)} disabled={off}>
                  {off ? 'Unavailable' : 'Play'}
                </button>
              </li>
            )
          })}
        </ul>

        <div className="section-head">
          <h2>Settings</h2>
        </div>

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

        <label className="toggle">
          <input
            type="checkbox"
            checked={settings.autoWake}
            onChange={(e) => onSettingsChange({ ...settings, autoWake: e.target.checked })}
          />
          <span>Turn the console on automatically</span>
        </label>

        <label className="toggle">
          <input
            type="checkbox"
            checked={settings.autoReconnect}
            onChange={(e) => onSettingsChange({ ...settings, autoReconnect: e.target.checked })}
          />
          <span>Reconnect automatically if the stream drops</span>
        </label>
      </div>
    </div>
  )
}
