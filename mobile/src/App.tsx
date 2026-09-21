import { useCallback, useEffect, useRef, useState } from 'react'
import { ConnectionManager, type StreamStats } from '@core/stream/connection.js'
import { DEFAULT_SETTINGS, type StreamSettings, type StreamStatus, type XboxConsole } from '@shared/types.js'
import { RelayClient, SignInCancelled, type LogLine } from './adapters/client.js'
import { preferences } from './adapters/store.js'
import { SignIn } from './ui/SignIn.js'
import { ConsoleList } from './ui/ConsoleList.js'
import { Stream } from './ui/Stream.js'

const IDLE: StreamStatus = { phase: 'idle', detail: '', reconnects: 0 }

/** One client for the app's lifetime; it holds the auth and session state. */
const client = new RelayClient()

export default function App() {
  const [ready, setReady] = useState(false)
  const [signedIn, setSignedIn] = useState(false)
  const [signingIn, setSigningIn] = useState(false)
  const [authError, setAuthError] = useState<string | null>(null)

  const [consoles, setConsoles] = useState<XboxConsole[]>([])
  const [consoleError, setConsoleError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const [status, setStatus] = useState<StreamStatus>(IDLE)
  const [stats, setStats] = useState<StreamStats | null>(null)
  const [stream, setStream] = useState<MediaStream | null>(null)
  const [logs, setLogs] = useState<LogLine[]>([])
  const [settings, setSettings] = useState<StreamSettings>(DEFAULT_SETTINGS)

  const connection = useRef<ConnectionManager | null>(null)

  useEffect(() => client.onLog((line) => setLogs((prev) => [...prev.slice(-999), line])), [])

  useEffect(() => {
    void (async () => {
      setSettings(await preferences.get('settings', DEFAULT_SETTINGS))
      setSignedIn(await client.restore())
      setReady(true)
    })()
  }, [])

  const loadConsoles = useCallback(async () => {
    setLoading(true)
    setConsoleError(null)
    try {
      setConsoles(await client.listConsoles())
    } catch (err) {
      setConsoleError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (signedIn) void loadConsoles()
  }, [signedIn, loadConsoles])

  const signIn = useCallback(async () => {
    setSigningIn(true)
    setAuthError(null)
    try {
      await client.signIn()
      setSignedIn(true)
    } catch (err) {
      if (!(err instanceof SignInCancelled)) {
        setAuthError(err instanceof Error ? err.message : String(err))
      }
    } finally {
      setSigningIn(false)
    }
  }, [])

  const connect = useCallback(
    async (target: XboxConsole) => {
      const manager = new ConnectionManager(settings, client, {
        onStatus: setStatus,
        onStats: setStats,
        onStream: setStream,
      })
      connection.current = manager
      setStatus({ phase: 'requesting-session', detail: 'Starting', reconnects: 0 })
      await manager.start(target.serverId)
    },
    [settings],
  )

  const disconnect = useCallback(async () => {
    await connection.current?.stop()
    connection.current = null
    setStream(null)
    setStats(null)
    setStatus(IDLE)
  }, [])

  const updateSettings = useCallback((next: StreamSettings) => {
    setSettings(next)
    void preferences.set('settings', next)
  }, [])

  if (!ready) {
    return (
      <div className="boot">
        <div className="spinner" />
      </div>
    )
  }

  if (status.phase !== 'idle' && status.phase !== 'stopped') {
    return (
      <Stream
        stream={stream}
        status={status}
        stats={stats}
        logs={logs}
        onDisconnect={disconnect}
        onReconnectController={() => connection.current?.reconnectController()}
      />
    )
  }

  if (!signedIn) {
    return <SignIn busy={signingIn} error={authError} onSignIn={signIn} />
  }

  return (
    <ConsoleList
      consoles={consoles}
      loading={loading}
      error={consoleError}
      gamertag={client.gamertag}
      settings={settings}
      onSettingsChange={updateSettings}
      onRefresh={loadConsoles}
      onConnect={connect}
      onSignOut={async () => {
        await client.signOut()
        setSignedIn(false)
        setConsoles([])
      }}
    />
  )
}
