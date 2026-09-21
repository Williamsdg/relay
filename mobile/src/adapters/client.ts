/**
 * The iOS equivalent of the desktop main process.
 *
 * On desktop the protocol runs in a separate Node process and the UI talks to
 * it over IPC. Here there is no second process, so the same core code runs
 * in-page and this class holds the state IPC used to hold. Nothing about the
 * protocol differs — only where it executes.
 */
import { App } from '@capacitor/app'
import { Browser } from '@capacitor/browser'
import { createHttp } from '@core/http.js'
import { createAuth, REDIRECT_URI, XBOXLIVE_RELYING_PARTY } from '@core/auth.js'
import type { AuthArtifacts, XstsToken } from '@core/auth.js'
import { createXhome, type StreamingSession } from '@core/xhome.js'
import { createXccs } from '@core/xccs.js'
import type { StreamBackend, SessionStartResult } from '@core/stream/backend.js'
import type { LogLevel } from '@core/ports.js'
import type { SessionHandle, XboxConsole, RemoteIceCandidate } from '@shared/types.js'
import { nativeHttp } from './http.js'
import { keychainStore } from './store.js'

const CREDENTIAL_KEY = 'relay.auth'

export interface LogLine {
  ts: number
  level: LogLevel
  scope: string
  message: string
}

export class SignInCancelled extends Error {
  constructor() {
    super('Sign-in was cancelled')
    this.name = 'SignInCancelled'
  }
}

export class RelayClient implements StreamBackend {
  private readonly lines: LogLine[] = []
  private listeners = new Set<(line: LogLine) => void>()

  private http = createHttp(nativeHttp, (level, scope, message) =>
    this.log(level, scope, message),
  )
  private auth = createAuth(this.http, (l, s, m) => this.log(l, s, m))
  private xhome = createXhome(this.http, (l, s, m) => this.log(l, s, m))
  private xccs = createXccs(this.http, (l, s, m) => this.log(l, s, m))

  private artifacts: AuthArtifacts | null = null
  private xsts: XstsToken | null = null
  private web: XstsToken | null = null
  private streaming: StreamingSession | null = null
  private handle: SessionHandle | null = null

  log(level: LogLevel, scope: string, message: string): void {
    const line: LogLine = { ts: Date.now(), level, scope, message }
    this.lines.push(line)
    if (this.lines.length > 2000) this.lines.shift()
    console.log(`[${scope}] ${message}`)
    for (const listener of this.listeners) listener(line)
  }

  history(): LogLine[] {
    return [...this.lines]
  }

  onLog(listener: (line: LogLine) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  get gamertag(): string {
    return this.xsts?.gamertag ?? ''
  }

  /** Silent sign-in from stored credentials. Returns whether it succeeded. */
  async restore(): Promise<boolean> {
    const raw = await keychainStore.get(CREDENTIAL_KEY)
    if (!raw) return false
    try {
      const stored = JSON.parse(raw) as AuthArtifacts
      const result = await this.auth.completeFromRefreshToken(stored)
      this.xsts = result.xsts
      this.artifacts = result.artifacts
      await keychainStore.set(CREDENTIAL_KEY, JSON.stringify(result.artifacts))
      return true
    } catch (err) {
      // A revoked or rotated refresh token is normal; fall back to sign-in
      // rather than presenting a broken session.
      this.log('warn', 'auth', `Silent sign-in failed: ${String(err)}`)
      await keychainStore.remove(CREDENTIAL_KEY)
      return false
    }
  }

  /**
   * Interactive sign-in.
   *
   * The Microsoft page is opened in the system browser rather than an in-app
   * WebView — Microsoft blocks embedded WebViews for sign-in, and the system
   * browser also shares an existing session so most users never retype a
   * password. Its success redirect targets a custom scheme that only this app
   * claims, which is how the code comes back.
   */
  async signIn(): Promise<void> {
    const begun = await this.auth.beginSignIn()

    const code = await new Promise<string>((resolve, reject) => {
      let settled = false
      const finish = (fn: () => void) => {
        if (settled) return
        settled = true
        void listener.then((l) => l.remove())
        void Browser.close().catch(() => undefined)
        fn()
      }

      const listener = App.addListener('appUrlOpen', ({ url }) => {
        if (!url.startsWith(REDIRECT_URI)) return
        const query = new URLSearchParams(url.split('?')[1] ?? '')
        const error = query.get('error')
        if (error) {
          finish(() => reject(new Error(`Microsoft returned "${error}"`)))
          return
        }
        const returned = query.get('code')
        const state = query.get('state')
        if (!returned) {
          finish(() => reject(new Error('The sign-in redirect carried no authorization code')))
          return
        }
        // Guards against a redirect belonging to a different attempt.
        if (state && state !== begun.pkce.state) {
          finish(() => reject(new Error('The sign-in response did not match this request')))
          return
        }
        finish(() => resolve(returned))
      })

      void Browser.open({ url: begun.loginUrl, presentationStyle: 'popover' })
      // If the user swipes the browser away, nothing else will ever resolve.
      void Browser.addListener('browserFinished', () => {
        if (!settled) finish(() => reject(new SignInCancelled()))
      })
    })

    const result = await this.auth.completeSignIn(
      begun.key,
      begun.deviceId,
      begun.pkce,
      begun.deviceToken,
      code,
    )
    this.xsts = result.xsts
    this.artifacts = result.artifacts
    await keychainStore.set(CREDENTIAL_KEY, JSON.stringify(result.artifacts))
  }

  async signOut(): Promise<void> {
    if (this.streaming && this.handle) {
      await this.xhome.stopSession(this.streaming, this.handle)
    }
    this.artifacts = this.xsts = this.web = this.streaming = this.handle = null
    await keychainStore.remove(CREDENTIAL_KEY)
  }

  /** Refresh the streaming token when it ages out, so a long idle never 401s. */
  private async ensureStreaming(): Promise<StreamingSession> {
    if (this.streaming && Date.now() < this.streaming.expiresAt) return this.streaming
    if (!this.xsts || !this.artifacts) throw new Error('Not signed in')

    if (new Date(this.xsts.notAfter).getTime() <= Date.now() + 60_000) {
      const result = await this.auth.completeFromRefreshToken(this.artifacts)
      this.xsts = result.xsts
      this.artifacts = result.artifacts
      await keychainStore.set(CREDENTIAL_KEY, JSON.stringify(result.artifacts))
    }
    this.streaming = await this.xhome.loginToStreaming(this.xsts.token)
    return this.streaming
  }

  private async ensureWebToken(): Promise<XstsToken> {
    if (this.web && new Date(this.web.notAfter).getTime() > Date.now() + 60_000) return this.web
    if (!this.artifacts) throw new Error('Not signed in')
    const result = await this.auth.completeFromRefreshToken(
      this.artifacts,
      XBOXLIVE_RELYING_PARTY,
    )
    this.web = result.xsts
    return this.web
  }

  async listConsoles(): Promise<XboxConsole[]> {
    return this.xhome.listConsoles(await this.ensureStreaming())
  }

  async powerOff(serverId: string): Promise<void> {
    await this.xccs.powerOff(await this.ensureWebToken(), serverId)
  }

  // ---- StreamBackend ----

  async startSession(opts: {
    serverId: string
    width: number
    height: number
  }): Promise<SessionStartResult> {
    const streaming = await this.ensureStreaming()

    // Never leave an orphan session: the service caps concurrent sessions per
    // console, and a stale one blocks the next connect.
    if (this.handle) {
      await this.xhome.stopSession(streaming, this.handle)
      this.handle = null
    }

    const handle = await this.xhome.startSession(streaming, opts)
    await this.xhome.waitForProvisioned(streaming, handle)
    const config = await this.xhome.getConfiguration(streaming, handle)
    handle.keepAlivePulseInSeconds = config.keepAlivePulseInSeconds ?? 300
    this.handle = handle
    return { handle, config }
  }

  async exchangeSdp(offerSdp: string) {
    if (!this.streaming || !this.handle) throw new Error('No active session')
    return this.xhome.exchangeSdp(this.streaming, this.handle, offerSdp)
  }

  async exchangeIce(candidates: RTCIceCandidateInit[]): Promise<RemoteIceCandidate[]> {
    if (!this.streaming || !this.handle) throw new Error('No active session')
    return this.xhome.exchangeIce(this.streaming, this.handle, candidates)
  }

  async keepalive(): Promise<void> {
    if (!this.streaming || !this.handle) return
    await this.xhome.sendKeepalive(this.streaming, this.handle)
  }

  async stopSession(): Promise<void> {
    if (this.streaming && this.handle) {
      await this.xhome.stopSession(this.streaming, this.handle)
    }
    this.handle = null
  }

  async ensureConsoleOn(serverId: string): Promise<boolean> {
    try {
      return await this.xccs.wakeAndWait(await this.ensureWebToken(), serverId)
    } catch (err) {
      this.log('warn', 'xccs', `Auto-wake failed: ${String(err)}`)
      return false
    }
  }
}
