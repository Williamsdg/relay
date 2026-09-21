import { useState } from 'react'
import type { StreamSettings, TurnServer } from '../../../shared/types.js'

const EMPTY: TurnServer = {
  provider: 'cloudflare',
  keyId: '',
  apiToken: '',
  url: '',
  username: '',
  credential: '',
  forceRelay: false,
}

/**
 * Relay configuration.
 *
 * Away from home both ends are normally behind NAT with no direct path, and
 * the stream has nowhere to go. A relay forwards it.
 *
 * Cloudflare is offered first because it needs no server, is free for far more
 * hours than anyone plays, and can be set up from anywhere — which matters,
 * since the alternatives (opening the home router, or a VPN back to it) all
 * require being at home.
 */
export function RelaySettings({
  settings,
  onChange,
  hasStoredToken,
}: {
  settings: StreamSettings
  onChange: (next: StreamSettings) => void
  /** True when a token is already held in the keychain. */
  hasStoredToken: boolean
}) {
  const turn = settings.turn ?? EMPTY
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)

  const update = (patch: Partial<TurnServer>) => {
    const next = { ...turn, ...patch }
    const configured =
      next.provider === 'cloudflare'
        ? Boolean(next.keyId?.trim() && next.apiToken?.trim())
        : Boolean(next.url.trim() && next.username && next.credential)
    onChange({ ...settings, turn: configured ? next : { ...next } })
    setResult(null)
  }

  const test = async () => {
    setTesting(true)
    setResult(null)
    try {
      setResult(await window.relay.relay.test())
    } finally {
      setTesting(false)
    }
  }

  const cloudflare = turn.provider === 'cloudflare'

  return (
    <div className="relay-settings">
      <div className="section-head">
        <h2>Relay server</h2>
      </div>
      <p className="muted small">
        Needed to play away from home. Without one, Relay can only reach your console when both
        are on the same network — neither end can be reached through NAT otherwise.
      </p>

      <div className="provider-tabs">
        <button
          className={`ghost ${cloudflare ? 'selected' : ''}`}
          onClick={() => update({ provider: 'cloudflare' })}
        >
          Cloudflare
        </button>
        <button
          className={`ghost ${!cloudflare ? 'selected' : ''}`}
          onClick={() => update({ provider: 'custom' })}
        >
          Own server
        </button>
      </div>

      {cloudflare ? (
        <>
          <p className="muted small">
            Free for 1,000 GB a month — roughly 140 hours of 1080p60. Create a TURN key at
            Cloudflare dashboard → Realtime → TURN, then paste both values here.
          </p>
          <label className="field">
            <span className="muted small">TURN key ID</span>
            <input
              type="text"
              value={turn.keyId ?? ''}
              onChange={(e) => update({ keyId: e.target.value })}
              spellCheck={false}
              autoCapitalize="off"
            />
          </label>
          <label className="field">
            <span className="muted small">
              API token{hasStoredToken ? ' — saved in your keychain' : ''}
            </span>
            <input
              type="password"
              placeholder={hasStoredToken ? 'Stored — type to replace' : ''}
              value={turn.apiToken ?? ''}
              onChange={(e) => update({ apiToken: e.target.value })}
            />
          </label>
          <p className="muted small">
            The token is kept in the macOS Keychain, never in a settings file, and stays in the
            app's privileged process — it is not readable by the page that renders your stream.
          </p>
        </>
      ) : (
        <>
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
        </>
      )}

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

      <button className="ghost" onClick={test} disabled={testing}>
        {testing ? 'Testing…' : 'Test relay'}
      </button>
      {result && <p className={result.ok ? 'guidance' : 'error'}>{result.message}</p>}
    </div>
  )
}
