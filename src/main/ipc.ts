/**
 * IPC surface exposed to the renderer.
 *
 * The renderer owns WebRTC (it needs a real browser stack for that) while the
 * main process owns every credential and every REST call. The renderer never
 * sees a token — it asks main to perform exchanges on its behalf.
 */
import { ipcMain, dialog, type BrowserWindow } from 'electron'
import { writeFile } from 'node:fs/promises'
import { log } from './logger.js'
import {
  acquireStreamingToken,
  acquireWebToken,
  completeFromRefreshToken,
  createPkce,
  exchangeCode,
  getDeviceToken,
  newIdentity,
  startSisuAuth,
  type AuthArtifacts,
  type XstsToken,
} from './auth/flow.js'
import { promptForAuthCode, SignInCancelled } from './auth/browser.js'
import { loadArtifacts, saveArtifacts, clearArtifacts } from './auth/store.js'
import {
  loginToStreaming,
  listConsoles,
  startSession,
  waitForProvisioned,
  getConfiguration,
  exchangeSdp,
  exchangeIce,
  sendKeepalive,
  stopSession,
  type StreamingSession,
} from './xhome/client.js'
import { powerOff, powerOn } from './xhome/xccs.js'
import type { AuthState, SessionHandle, XboxConsole } from '../shared/types.js'

interface State {
  artifacts: AuthArtifacts | null
  xsts: XstsToken | null
  streaming: StreamingSession | null
  handle: SessionHandle | null
  /** Console-command token; minted on demand and reused until it expires. */
  web: XstsToken | null
}

const state: State = {
  artifacts: null,
  xsts: null,
  streaming: null,
  handle: null,
  web: null,
}

/** The console command service needs its own token, so fetch it lazily. */
async function ensureWebToken(): Promise<XstsToken> {
  if (state.web && new Date(state.web.notAfter).getTime() > Date.now() + 60_000) {
    return state.web
  }
  if (!state.artifacts) throw new Error('Not signed in')
  state.web = await acquireWebToken(state.artifacts)
  return state.web
}

/** Guards against overlapping interactive sign-ins. */
let signInInFlight = false

function authState(): AuthState {
  if (!state.xsts) return { status: 'signed-out' }
  return { status: 'signed-in', gamertag: state.xsts.gamertag, xuid: state.xsts.xuid }
}

/**
 * Ensure we hold a valid streaming token, refreshing the whole chain if the
 * previous one aged out. Called before every operation that needs one, so a
 * long idle period never surfaces as a mystery 401 mid-connect.
 */
async function ensureStreaming(): Promise<StreamingSession> {
  if (state.streaming && Date.now() < state.streaming.expiresAt) return state.streaming
  if (!state.xsts) throw new Error('Not signed in')

  if (new Date(state.xsts.notAfter).getTime() <= Date.now() + 60_000) {
    if (!state.artifacts) throw new Error('Not signed in')
    log.info('auth', 'Streaming token expired — refreshing silently')
    const result = await completeFromRefreshToken(state.artifacts)
    state.xsts = result.xsts
    state.artifacts = result.artifacts
    saveArtifacts(result.artifacts)
  }

  state.streaming = await loginToStreaming(state.xsts.token)
  return state.streaming
}

export function registerIpc(getWindow: () => BrowserWindow | null): void {
  // Mirror every log line into the renderer's diagnostics panel.
  log.subscribe((line) => getWindow()?.webContents.send('log', line))

  ipcMain.handle('log:history', () => log.history())

  // The renderer owns WebRTC, so its events belong in the same log as the
  // REST calls; otherwise half the connection story is invisible.
  ipcMain.on('log:write', (_e, level: 'debug' | 'info' | 'warn' | 'error', scope: string, message: string) => {
    log[level]?.(scope, message)
  })

  ipcMain.handle('auth:state', () => authState())

  /** Silent restore on launch. Returns the resulting state either way. */
  ipcMain.handle('auth:restore', async (): Promise<AuthState> => {
    const stored = loadArtifacts()
    if (!stored) return { status: 'signed-out' }
    try {
      const result = await completeFromRefreshToken(stored)
      state.xsts = result.xsts
      state.artifacts = result.artifacts
      saveArtifacts(result.artifacts)
      return authState()
    } catch (err) {
      // A revoked or rotated refresh token is normal; fall back to sign-in
      // rather than presenting a broken session.
      log.warn('auth', `Silent sign-in failed: ${String(err)}`)
      clearArtifacts()
      return { status: 'signed-out' }
    }
  })

  ipcMain.handle('auth:signIn', async (): Promise<AuthState> => {
    // A second sign-in while one is already in flight would strand an orphan
    // login window and a half-finished token chain.
    if (signInInFlight) {
      log.warn('auth', 'Sign-in already in progress — ignoring duplicate request')
      return { status: 'signing-in', step: 'Waiting for Microsoft sign-in' }
    }
    signInInFlight = true
    log.info('auth', 'Sign-in requested from the UI')
    try {
      const { key, deviceId } = newIdentity()
      const pkce = createPkce()
      const deviceToken = await getDeviceToken(key, deviceId)
      const { loginUrl } = await startSisuAuth(key, deviceToken, pkce)

      const code = await promptForAuthCode(loginUrl, pkce.state)
      const oauth = await exchangeCode(code, pkce.verifier)
      const xsts = await acquireStreamingToken(key, oauth.access_token, deviceToken)

      state.xsts = xsts
      state.artifacts = {
        proofKeyPem: key.privatePem,
        deviceId,
        refreshToken: oauth.refresh_token,
      }
      saveArtifacts(state.artifacts)
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
    if (state.streaming && state.handle) await stopSession(state.streaming, state.handle)
    state.artifacts = null
    state.xsts = null
    state.streaming = null
    state.handle = null
    state.web = null
    clearArtifacts()
    return authState()
  })

  ipcMain.handle('consoles:list', async (): Promise<XboxConsole[]> => {
    return listConsoles(await ensureStreaming())
  })

  ipcMain.handle(
    'session:start',
    async (_e, opts: { serverId: string; width: number; height: number }) => {
      const streaming = await ensureStreaming()

      // Never leave an orphan session behind — the service caps concurrent
      // sessions per console, and a stale one blocks the next connect.
      if (state.handle) {
        await stopSession(streaming, state.handle)
        state.handle = null
      }

      const handle = await startSession(streaming, opts)
      await waitForProvisioned(streaming, handle, {
        onState: (s) => getWindow()?.webContents.send('session:state', s),
      })

      const config = await getConfiguration(streaming, handle)
      handle.keepAlivePulseInSeconds = config.keepAlivePulseInSeconds ?? 300
      state.handle = handle
      return { handle, config }
    },
  )

  ipcMain.handle('session:sdp', async (_e, offerSdp: string) => {
    if (!state.streaming || !state.handle) throw new Error('No active session')
    return exchangeSdp(state.streaming, state.handle, offerSdp)
  })

  ipcMain.handle('session:ice', async (_e, candidates: RTCIceCandidateInit[]) => {
    if (!state.streaming || !state.handle) throw new Error('No active session')
    return exchangeIce(state.streaming, state.handle, candidates)
  })

  ipcMain.handle('session:keepalive', async () => {
    if (!state.streaming || !state.handle) return
    await sendKeepalive(state.streaming, state.handle)
  })

  ipcMain.handle('console:powerOff', async (_e, serverId: string) => {
    await powerOff(await ensureWebToken(), serverId)
  })

  ipcMain.handle('console:powerOn', async (_e, serverId: string) => {
    await powerOn(await ensureWebToken(), serverId)
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
    const base64 = dataUrl.replace(/^data:image\/png;base64,/, '')
    await writeFile(filePath, Buffer.from(base64, 'base64'))
    log.info('app', `Screenshot saved to ${filePath}`)
    return filePath
  })

  ipcMain.handle('window:toggleFullscreen', () => {
    const win = getWindow()
    if (!win) return false
    const next = !win.isFullScreen()
    win.setFullScreen(next)
    return next
  })

  ipcMain.handle('session:stop', async () => {
    if (state.streaming && state.handle) await stopSession(state.streaming, state.handle)
    state.handle = null
  })
}

/** Called on quit so we do not strand a session on the console. */
export async function teardown(): Promise<void> {
  if (state.streaming && state.handle) await stopSession(state.streaming, state.handle)
}
