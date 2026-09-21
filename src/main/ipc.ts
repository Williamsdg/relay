/**
 * IPC surface exposed to the renderer.
 *
 * The renderer owns WebRTC (it needs a real browser stack) while this process
 * owns every credential and REST call. Protocol logic lives in `src/core` and
 * is shared with the mobile build; this file is only the Electron wiring.
 */
import { ipcMain, dialog, type BrowserWindow } from 'electron'
import { writeFile } from 'node:fs/promises'
import { log, revealLogFile, logFilePath } from './logger.js'
import { loadSettings, saveSettings, type PersistedState } from './settings.js'
import { httpClient, logger } from './adapter.js'
import { createHttp } from '../core/http.js'
import { createAuth, GSSV_RELYING_PARTY, XBOXLIVE_RELYING_PARTY } from '../core/auth.js'
import type { AuthArtifacts, XstsToken } from '../core/auth.js'
import { createXhome, type StreamingSession } from '../core/xhome.js'
import { createXccs } from '../core/xccs.js'
import { resolveIceServers, fetchCloudflareIceServers } from '../core/turn.js'
import { promptForAuthCode, SignInCancelled } from './auth/browser.js'
import { loadArtifacts, saveArtifacts, clearArtifacts } from './auth/store.js'
import type { AuthState, SessionHandle, XboxConsole } from '../shared/types.js'

const http = createHttp(httpClient, logger)
const auth = createAuth(http, logger)
const xhome = createXhome(http, logger)
const xccs = createXccs(http, logger)

interface State {
  artifacts: AuthArtifacts | null
  xsts: XstsToken | null
  streaming: StreamingSession | null
  handle: SessionHandle | null
  /** Console-command token; minted on demand and reused until it expires. */
  web: XstsToken | null
}

const state: State = { artifacts: null, xsts: null, streaming: null, handle: null, web: null }

/** Guards against overlapping interactive sign-ins. */
let signInInFlight = false

function authState(): AuthState {
  if (!state.xsts) return { status: 'signed-out' }
  return { status: 'signed-in', gamertag: state.xsts.gamertag, xuid: state.xsts.xuid }
}

/**
 * Ensure we hold a valid streaming token, refreshing the chain if it aged out.
 * Called before every operation needing one, so a long idle never surfaces as
 * a mystery 401 mid-connect.
 */
async function ensureStreaming(): Promise<StreamingSession> {
  if (state.streaming && Date.now() < state.streaming.expiresAt) return state.streaming
  if (!state.xsts || !state.artifacts) throw new Error('Not signed in')

  if (new Date(state.xsts.notAfter).getTime() <= Date.now() + 60_000) {
    log.info('auth', 'Streaming token expired — refreshing silently')
    const result = await auth.completeFromRefreshToken(state.artifacts)
    state.xsts = result.xsts
    state.artifacts = result.artifacts
    await saveArtifacts(result.artifacts)
  }

  state.streaming = await xhome.loginToStreaming(state.xsts.token)
  return state.streaming
}

/** The console command service needs its own token, so fetch it lazily. */
async function ensureWebToken(): Promise<XstsToken> {
  if (state.web && new Date(state.web.notAfter).getTime() > Date.now() + 60_000) return state.web
  if (!state.artifacts) throw new Error('Not signed in')
  const result = await auth.completeFromRefreshToken(state.artifacts, XBOXLIVE_RELYING_PARTY)
  state.web = result.xsts
  return state.web
}

export function registerIpc(getWindow: () => BrowserWindow | null): void {
  log.subscribe((line) => getWindow()?.webContents.send('log', line))

  ipcMain.handle('log:history', () => log.history())
  ipcMain.handle('log:reveal', () => revealLogFile())
  ipcMain.handle('log:path', () => logFilePath())
  ipcMain.on('log:write', (_e, level: 'debug' | 'info' | 'warn' | 'error', scope: string, message: string) => {
    log[level]?.(scope, message)
  })

  ipcMain.handle('settings:get', () => loadSettings())
  ipcMain.handle('settings:set', (_e, next: Partial<PersistedState>) => saveSettings(next))

  ipcMain.handle('auth:state', () => authState())

  /** Silent restore on launch. */
  ipcMain.handle('auth:restore', async (): Promise<AuthState> => {
    const stored = await loadArtifacts()
    if (!stored) return { status: 'signed-out' }
    try {
      const result = await auth.completeFromRefreshToken(stored)
      state.xsts = result.xsts
      state.artifacts = result.artifacts
      await saveArtifacts(result.artifacts)
      return authState()
    } catch (err) {
      // A revoked or rotated refresh token is normal; fall back to sign-in
      // rather than presenting a broken session.
      log.warn('auth', `Silent sign-in failed: ${String(err)}`)
      await clearArtifacts()
      return { status: 'signed-out' }
    }
  })

  ipcMain.handle('auth:signIn', async (): Promise<AuthState> => {
    if (signInInFlight) {
      log.warn('auth', 'Sign-in already in progress — ignoring duplicate request')
      return { status: 'signing-in', step: 'Waiting for Microsoft sign-in' }
    }
    signInInFlight = true
    log.info('auth', 'Sign-in requested from the UI')
    try {
      const begun = await auth.beginSignIn()
      const code = await promptForAuthCode(begun.loginUrl, begun.pkce.state)
      const result = await auth.completeSignIn(
        begun.key,
        begun.deviceId,
        begun.pkce,
        begun.deviceToken,
        code,
      )
      state.xsts = result.xsts
      state.artifacts = result.artifacts
      await saveArtifacts(result.artifacts)
      return authState()
    } catch (err) {
      if (err instanceof SignInCancelled) return { status: 'signed-out' }
      const message = err instanceof Error ? err.message : String(err)
      log.error('auth', message)
      return { status: 'error', message }
    } finally {
      signInInFlight = false
    }
  })

  ipcMain.handle('auth:signOut', async () => {
    if (state.streaming && state.handle) await xhome.stopSession(state.streaming, state.handle)
    state.artifacts = state.xsts = state.streaming = state.handle = state.web = null
    await clearArtifacts()
    return authState()
  })

  ipcMain.handle('consoles:list', async (): Promise<XboxConsole[]> =>
    xhome.listConsoles(await ensureStreaming()),
  )

  ipcMain.handle('console:powerOff', async (_e, serverId: string) => {
    await xccs.powerOff(await ensureWebToken(), serverId)
  })

  ipcMain.handle('console:powerOn', async (_e, serverId: string) => {
    await xccs.powerOn(await ensureWebToken(), serverId)
  })

  /** Wake and wait; a false result is informational, not fatal. */
  ipcMain.handle('console:ensureOn', async (_e, serverId: string) => {
    try {
      return await xccs.wakeAndWait(await ensureWebToken(), serverId, {
        onProgress: (s) => getWindow()?.webContents.send('session:state', s),
      })
    } catch (err) {
      log.warn('xccs', `Auto-wake failed: ${String(err)}`)
      return false
    }
  })

  ipcMain.handle(
    'session:start',
    async (_e, opts: { serverId: string; width: number; height: number }) => {
      const streaming = await ensureStreaming()

      // Never leave an orphan session: the service caps concurrent sessions
      // per console, and a stale one blocks the next connect.
      if (state.handle) {
        await xhome.stopSession(streaming, state.handle)
        state.handle = null
      }

      const handle = await xhome.startSession(streaming, opts)
      await xhome.waitForProvisioned(streaming, handle, {
        onState: (s) => getWindow()?.webContents.send('session:state', s),
      })

      const config = await xhome.getConfiguration(streaming, handle)
      handle.keepAlivePulseInSeconds = config.keepAlivePulseInSeconds ?? 300
      state.handle = handle
      return { handle, config }
    },
  )

  ipcMain.handle('session:sdp', async (_e, offerSdp: string) => {
    if (!state.streaming || !state.handle) throw new Error('No active session')
    return xhome.exchangeSdp(state.streaming, state.handle, offerSdp)
  })

  ipcMain.handle('session:ice', async (_e, candidates: RTCIceCandidateInit[]) => {
    if (!state.streaming || !state.handle) throw new Error('No active session')
    return xhome.exchangeIce(state.streaming, state.handle, candidates)
  })

  ipcMain.handle('session:relayServers', async () => {
    return resolveIceServers(http, loadSettings().turn, logger)
  })

  /** Verify a relay before relying on it: mistyped credentials fail like a
   *  network fault once a session is underway. */
  ipcMain.handle('relay:test', async (_e, turn: PersistedState['turn']) => {
    if (!turn) return { ok: false, message: 'No relay configured.' }
    try {
      if (turn.provider === 'cloudflare') {
        if (!turn.keyId || !turn.apiToken) {
          return { ok: false, message: 'Both the key ID and API token are required.' }
        }
        const servers = await fetchCloudflareIceServers(http, turn.keyId, turn.apiToken, logger)
        const relayed = servers.filter((s) => s.username).length
        return {
          ok: relayed > 0,
          message:
            relayed > 0
              ? `Cloudflare issued credentials for ${relayed} relay address(es).`
              : 'Cloudflare responded but issued no relay addresses.',
        }
      }
      return { ok: true, message: 'Saved. Use "Test relay" on the connection to verify it.' }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('session:keepalive', async () => {
    if (!state.streaming || !state.handle) return
    await xhome.sendKeepalive(state.streaming, state.handle)
  })

  ipcMain.handle('session:stop', async () => {
    if (state.streaming && state.handle) await xhome.stopSession(state.streaming, state.handle)
    state.handle = null
  })

  ipcMain.handle('window:toggleFullscreen', () => {
    const win = getWindow()
    if (!win) return false
    const next = !win.isFullScreen()
    win.setFullScreen(next)
    return next
  })

  /** Save a captured frame. Returns the path written, or null if cancelled. */
  ipcMain.handle('window:saveImage', async (_e, dataUrl: string) => {
    const win = getWindow()
    if (!win) return null
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: 'Save screenshot',
      defaultPath: `relay-${stamp}.png`,
      filters: [{ name: 'PNG image', extensions: ['png'] }],
    })
    if (canceled || !filePath) return null
    await writeFile(filePath, Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64'))
    log.info('app', `Screenshot saved to ${filePath}`)
    return filePath
  })
}

/** Called on quit so we do not strand a session on the console. */
export async function teardown(): Promise<void> {
  if (state.streaming && state.handle) await xhome.stopSession(state.streaming, state.handle)
}

export { GSSV_RELYING_PARTY }
