/**
 * IPC surface exposed to the renderer.
 *
 * The renderer owns WebRTC (it needs a real browser stack for that) while the
 * main process owns every credential and every REST call. The renderer never
 * sees a token — it asks main to perform exchanges on its behalf.
 */
import { ipcMain, type BrowserWindow } from 'electron'
import { log } from './logger.js'
import {
  completeFromRefreshToken,
  createPkce,
  exchangeCode,
  getDeviceToken,
  getXstsToken,
  newIdentity,
  sisuAuthorize,
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
import type { AuthState, SessionHandle, XboxConsole } from '../shared/types.js'

interface State {
  artifacts: AuthArtifacts | null
  xsts: XstsToken | null
  streaming: StreamingSession | null
  handle: SessionHandle | null
}

const state: State = { artifacts: null, xsts: null, streaming: null, handle: null }

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
    try {
      const { key, deviceId } = newIdentity()
      const pkce = createPkce()
      const deviceToken = await getDeviceToken(key, deviceId)
      const { loginUrl } = await startSisuAuth(key, deviceToken, pkce)

      const code = await promptForAuthCode(loginUrl, pkce.state)
      const oauth = await exchangeCode(code, pkce.verifier)
      const sisu = await sisuAuthorize(key, oauth.access_token, deviceToken)
      const xsts = await getXstsToken(key, sisu)

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
    }
  })

  ipcMain.handle('auth:signOut', async () => {
    if (state.streaming && state.handle) await stopSession(state.streaming, state.handle)
    state.artifacts = null
    state.xsts = null
    state.streaming = null
    state.handle = null
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

  ipcMain.handle('session:stop', async () => {
    if (state.streaming && state.handle) await stopSession(state.streaming, state.handle)
    state.handle = null
  })
}

/** Called on quit so we do not strand a session on the console. */
export async function teardown(): Promise<void> {
  if (state.streaming && state.handle) await stopSession(state.streaming, state.handle)
}
