import type { XboxConsole } from '../../../shared/types.js'

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
}: {
  consoles: XboxConsole[]
  loading: boolean
  error: string | null
  onRefresh: () => void
  onConnect: (target: XboxConsole) => void
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
                <button className="primary" onClick={() => onConnect(c)} disabled={off}>
                  {off ? 'Unavailable' : 'Connect'}
                </button>
              </li>
            )
          })}
        </ul>

        {consoles.some((c) => c.powerState === 'Off') && (
          <p className="muted small">
            A console showing “Off” has instant-on disabled, so it cannot be woken remotely.
          </p>
        )}
      </div>
    </div>
  )
}
