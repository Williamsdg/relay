import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AuthState,
  LogLine,
  StreamStatus,
  XboxConsole,
  StreamSettings,
} from '../../shared/types.js'
import { DEFAULT_SETTINGS } from '../../shared/types.js'
import { ConnectionManager, type StreamStats } from './stream/connection.js'
import { SignIn } from './ui/SignIn.js'
import { ConsoleList } from './ui/ConsoleList.js'
import { Stream } from './ui/Stream.js'
import { Diagnostics } from './ui/Diagnostics.js'

const IDLE_STATUS: StreamStatus = { phase: 'idle', detail: '', reconnects: 0 }

export default function App() {
  const [auth, setAuth] = useState<AuthState>({ status: 'signing-in', step: 'Restoring session' })
  const [consoles, setConsoles] = useState<XboxConsole[]>([])
  const [consolesError, setConsolesError] = useState<string | null>(null)
  const [loadingConsoles, setLoadingConsoles] = useState(false)
  const [status, setStatus] = useState<StreamStatus>(IDLE_STATUS)
  const [stats, setStats] = useState<StreamStats | null>(null)
  const [stream, setStream] = useState<MediaStream | null>(null)
  const [logs, setLogs] = useState<LogLine[]>([])
  const [showDiagnostics, setShowDiagnostics] = useState(false)
  const [settings] = useState<StreamSettings>(DEFAULT_SETTINGS)

  const connection = useRef<ConnectionManager | null>(null)

  // Drain the main-process log into the diagnostics panel.
  useEffect(() => {
    void window.relay.log.history().then(setLogs)
    return window.relay.log.onLine((line) => {
      setLogs((prev) => [...prev.slice(-1999), line])
    })
  }, [])

  // Silent sign-in on launch — a returning user should land on their consoles.
  useEffect(() => {
    void window.relay.auth.restore().then(setAuth)
  }, [])

  const loadConsoles = useCallback(async () => {
    setLoadingConsoles(true)
    setConsolesError(null)
    try {
      setConsoles(await window.relay.consoles.list())
    } catch (err) {
      setConsolesError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoadingConsoles(false)
    }
  }, [])

  useEffect(() => {
    if (auth.status === 'signed-in') void loadConsoles()
  }, [auth.status, loadConsoles])

  const connect = useCallback(
    async (target: XboxConsole) => {
      const manager = new ConnectionManager(settings, {
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
    setStatus(IDLE_STATUS)
  }, [])

  const signIn = useCallback(async () => {
    setAuth({ status: 'signing-in', step: 'Waiting for Microsoft sign-in' })
    setAuth(await window.relay.auth.signIn())
  }, [])

  const signOut = useCallback(async () => {
    await disconnect()
    setAuth(await window.relay.auth.signOut())
    setConsoles([])
  }, [disconnect])

  const streaming = status.phase !== 'idle' && status.phase !== 'stopped'

  const body = useMemo(() => {
    if (streaming) {
      return (
        <Stream
          stream={stream}
          status={status}
          stats={stats}
          onDisconnect={disconnect}
        />
      )
    }
    if (auth.status === 'signed-in') {
      return (
        <ConsoleList
          consoles={consoles}
          loading={loadingConsoles}
          error={consolesError}
          onRefresh={loadConsoles}
          onConnect={connect}
        />
      )
    }
    return <SignIn auth={auth} onSignIn={signIn} />
  }, [
    streaming,
    stream,
    status,
    stats,
    disconnect,
    auth,
    consoles,
    loadingConsoles,
    consolesError,
    loadConsoles,
    connect,
    signIn,
  ])

  return (
    <div className="app">
      <header className="titlebar">
        <span className="brand">Relay</span>
        {auth.status === 'signed-in' && (
          <span className="gamertag">{auth.gamertag}</span>
        )}
        <div className="spacer" />
        <button
          className="ghost"
          onClick={() => setShowDiagnostics((v) => !v)}
          aria-pressed={showDiagnostics}
        >
          Diagnostics
        </button>
        {auth.status === 'signed-in' && (
          <button className="ghost" onClick={signOut}>
            Sign out
          </button>
        )}
      </header>

      <main className="content">{body}</main>

      {showDiagnostics && (
        <Diagnostics logs={logs} onClose={() => setShowDiagnostics(false)} />
      )}
    </div>
  )
}
