/**
 * xHome REST client — console discovery and streaming-session lifecycle.
 *
 * Platform-agnostic. The one hard requirement is that the injected HTTP client
 * is not subject to CORS: these hosts send no CORS headers, so a plain
 * in-page fetch is blocked outright on every platform.
 */
import type { HttpApi } from './http.js'
import { HttpError } from './http.js'
import type { Logger } from './ports.js'
import type { XboxConsole, SessionHandle, RemoteIceCandidate } from '../shared/types.js'

const LOGIN_URL = 'https://xhome.gssv-play-prod.xboxlive.com/v2/login/user'

export interface StreamingSession {
  gsToken: string
  baseUri: string
  expiresAt: number
}

export interface SessionConfiguration {
  keepAlivePulseInSeconds?: number
  serverDetails?: {
    ipAddress?: string
    port?: number
    iceExchangePath?: string
    stunServerAddress?: string | null
  }
}

/** Identifies the client; the console picks stream profiles partly from this. */
function deviceInfo(width: number, height: number): string {
  return JSON.stringify({
    appInfo: {
      env: {
        clientAppId: 'Microsoft.GamingApp',
        clientAppType: 'native',
        clientAppVersion: '2203.1001.4.0',
        clientSdkVersion: '8.5.2',
        httpEnvironment: 'prod',
        sdkInstallId: '',
      },
    },
    dev: {
      hw: { make: 'Microsoft', model: 'Surface Pro', sdktype: 'native' },
      os: { name: 'Windows 11', ver: '22631.2715', platform: 'desktop' },
      displayInfo: {
        dimensions: { widthInPixels: width, heightInPixels: height },
        pixelDensity: { dpiX: 1, dpiY: 1 },
      },
    },
  })
}

/** Channel versions we support; the server picks within these bounds. */
const CHANNEL_CONFIG = {
  chatConfiguration: {
    bytesPerSample: 2,
    expectedClipDurationMs: 20,
    format: { codec: 'opus', container: 'webm' },
    numChannels: 1,
    sampleFrequencyHz: 24000,
  },
  chat: { minVersion: 1, maxVersion: 1 },
  control: { minVersion: 1, maxVersion: 3 },
  input: { minVersion: 1, maxVersion: 8 },
  message: { minVersion: 1, maxVersion: 1 },
}

interface RawServer {
  serverId: string
  deviceName?: string
  consoleType?: string
  powerState?: string
  isLocal?: boolean
}

export function createXhome(http: HttpApi, log: Logger) {
  const authHeaders = (session: StreamingSession): Record<string, string> => ({
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Authorization: `Bearer ${session.gsToken}`,
  })

  const sessionUrl = (h: SessionHandle, suffix = '') =>
    `${h.baseUri}/v5/sessions/home/${h.sessionId}${suffix}`

  /** Trade the gssv XSTS token for a streaming token and a regional endpoint. */
  async function loginToStreaming(xstsToken: string): Promise<StreamingSession> {
    log('info', 'xhome', 'Logging in to the streaming service')
    const res = await http.requestJson<{
      gsToken: string
      durationInSeconds: number
      offeringSettings: { regions: Array<{ name: string; baseUri: string }> }
    }>(LOGIN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store, must-revalidate, no-cache',
        'x-gssv-client': 'XboxComBrowser',
      },
      body: JSON.stringify({ token: xstsToken, offeringId: 'xhome' }),
      scope: 'xhome',
    })

    const region = res.offeringSettings?.regions?.[0]
    if (!region?.baseUri) throw new Error('Streaming login returned no usable region')
    log('info', 'xhome', `Region ${region.name} at ${region.baseUri}`)
    return {
      gsToken: res.gsToken,
      baseUri: region.baseUri.replace(/\/$/, ''),
      // Refresh a minute early so a long session never streams on a dead token.
      expiresAt: Date.now() + (res.durationInSeconds - 60) * 1000,
    }
  }

  /** The server path has moved between versions, so try newest first. */
  async function listConsoles(session: StreamingSession): Promise<XboxConsole[]> {
    const paths = ['/v6/servers/home', '/v5/servers/home', '/v4/servers/home']
    let lastErr: unknown
    for (const path of paths) {
      try {
        const res = await http.requestJson<{ results?: RawServer[] }>(
          `${session.baseUri}${path}?type=Home`,
          { headers: authHeaders(session), scope: 'xhome', retries: 1 },
        )
        const consoles = (res.results ?? []).map(
          (s): XboxConsole => ({
            serverId: s.serverId,
            name: s.deviceName || 'Xbox',
            consoleType: s.consoleType || 'Unknown',
            powerState: s.powerState || 'Unknown',
            isLocal: s.isLocal,
          }),
        )
        log(
          'info',
          'xhome',
          `Found ${consoles.length} console(s) via ${path}: ` +
            consoles.map((c) => `${c.name} [${c.consoleType}] power=${c.powerState}`).join('; '),
        )
        return consoles
      } catch (err) {
        lastErr = err
        if (err instanceof HttpError && err.status === 404) continue
        throw err
      }
    }
    throw lastErr
  }

  async function startSession(
    session: StreamingSession,
    opts: { serverId: string; width: number; height: number },
  ): Promise<SessionHandle> {
    log('info', 'xhome', `Requesting a session on ${opts.serverId}`)
    const res = await http.requestJson<{ sessionId: string; sessionPath: string; state: string }>(
      `${session.baseUri}/v5/sessions/home/play`,
      {
        method: 'POST',
        headers: {
          ...authHeaders(session),
          'X-MS-Device-Info': deviceInfo(opts.width, opts.height),
        },
        body: JSON.stringify({
          clientSessionId: '',
          titleId: '',
          systemUpdateGroup: '',
          settings: {
            nanoVersion: 'V3;WebrtcTransport.dll',
            enableTextToSpeech: false,
            highContrast: 0,
            locale: 'en-US',
            // Must stay false: the console rejects StartStreamingSessionV2
            // outright when this claims ICE. The direct address the service
            // returns in serverDetails is the intended path instead.
            useIceConnection: false,
            timezoneOffsetMinutes: -new Date().getTimezoneOffset(),
            sdkType: 'web',
            osName: 'windows',
          },
          serverId: opts.serverId,
          fallbackRegionNames: [],
        }),
        scope: 'xhome',
      },
    )
    log('info', 'xhome', `Session ${res.sessionId} created (${res.state})`)
    return {
      sessionId: res.sessionId,
      sessionPath: res.sessionPath,
      baseUri: session.baseUri,
      keepAlivePulseInSeconds: 300,
    }
  }

  /**
   * Block until the session is Provisioned. A console waking from standby
   * legitimately takes a while, but a Failed state short-circuits with the
   * service's own error rather than spinning until timeout.
   */
  async function waitForProvisioned(
    session: StreamingSession,
    handle: SessionHandle,
    opts: { timeoutMs?: number; onState?: (state: string) => void } = {},
  ): Promise<void> {
    const { timeoutMs = 120_000, onState } = opts
    const deadline = Date.now() + timeoutMs
    let last = ''
    while (Date.now() < deadline) {
      const status = await http.requestJsonOptional<{
        state: string
        errorDetails?: { code?: string | null; message?: string | null }
      }>(sessionUrl(handle, '/state'), {
        headers: authHeaders(session),
        scope: 'xhome',
        retries: 1,
      })
      if (!status) {
        await new Promise((r) => setTimeout(r, 1000))
        continue
      }
      if (status.state !== last) {
        last = status.state
        log('info', 'xhome', `Session state: ${last}`)
        onState?.(last)
      }
      if (status.state === 'Provisioned') return
      if (status.state === 'Failed' || status.errorDetails?.code) {
        throw new Error(
          status.errorDetails?.message ||
            status.errorDetails?.code ||
            'The console refused the session',
        )
      }
      await new Promise((r) => setTimeout(r, 1000))
    }
    throw new Error(
      `The console never became ready (stuck at "${last || 'unknown'}" after ${timeoutMs / 1000}s)`,
    )
  }

  async function getConfiguration(
    session: StreamingSession,
    handle: SessionHandle,
  ): Promise<SessionConfiguration> {
    const config = await http.requestJson<SessionConfiguration>(
      sessionUrl(handle, '/configuration'),
      { headers: authHeaders(session), scope: 'xhome' },
    )
    const d = config.serverDetails
    log(
      'info',
      'xhome',
      `Server details: address=${d?.ipAddress ?? 'none'}:${d?.port ?? '?'} ` +
        `stun=${d?.stunServerAddress ?? 'none offered'}`,
    )
    return config
  }

  /**
   * SDP and ICE share a shape: POST the local half, then poll GET until the
   * server's half appears. Neither POST returns the answer, and an empty body
   * means "not answered yet" rather than an error.
   */
  async function pollExchange(
    session: StreamingSession,
    handle: SessionHandle,
    suffix: string,
    timeoutMs: number,
  ): Promise<string> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const res = await http.requestJsonOptional<{
        exchangeResponse?: string
        errorDetails?: { code?: string | null; message?: string | null }
      }>(sessionUrl(handle, suffix), {
        headers: authHeaders(session),
        scope: 'xhome',
        retries: 1,
      })
      if (res) {
        if (res.errorDetails?.code) {
          throw new Error(res.errorDetails.message || res.errorDetails.code)
        }
        if (res.exchangeResponse) return res.exchangeResponse
      }
      await new Promise((r) => setTimeout(r, 500))
    }
    throw new Error(`The console never answered the ${suffix.replace('/', '')} exchange`)
  }

  async function exchangeSdp(
    session: StreamingSession,
    handle: SessionHandle,
    offerSdp: string,
  ): Promise<{ sdp: string; versions: Record<string, number> }> {
    log('info', 'webrtc', 'Sending SDP offer')
    await http.request(sessionUrl(handle, '/sdp'), {
      method: 'POST',
      headers: authHeaders(session),
      body: JSON.stringify({
        messageType: 'offer',
        sdp: offerSdp,
        configuration: CHANNEL_CONFIG,
      }),
      scope: 'xhome',
    })

    const parsed = JSON.parse(await pollExchange(session, handle, '/sdp', 30_000)) as Record<
      string,
      unknown
    >
    if (parsed.status && parsed.status !== 'success') {
      throw new Error(`The console rejected the SDP offer: ${String(parsed.status)}`)
    }
    if (typeof parsed.sdp !== 'string') throw new Error('SDP answer was missing from the response')

    const versions: Record<string, number> = {}
    for (const name of ['chat', 'control', 'input', 'message']) {
      if (typeof parsed[name] === 'number') versions[name] = parsed[name] as number
    }
    log('info', 'webrtc', `SDP answer received; channel versions ${JSON.stringify(versions)}`)
    return { sdp: parsed.sdp, versions }
  }

  async function exchangeIce(
    session: StreamingSession,
    handle: SessionHandle,
    candidates: RTCIceCandidateInit[],
  ): Promise<RemoteIceCandidate[]> {
    log('info', 'webrtc', `Sending ${candidates.length} ICE candidate(s)`)
    await http.request(sessionUrl(handle, '/ice'), {
      method: 'POST',
      headers: authHeaders(session),
      body: JSON.stringify({ messageType: 'iceCandidate', candidate: candidates }),
      scope: 'xhome',
    })

    const parsed = JSON.parse(await pollExchange(session, handle, '/ice', 30_000)) as unknown
    const list = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as { candidates?: unknown[] })?.candidates)
        ? (parsed as { candidates: unknown[] }).candidates
        : []

    let skipped = 0
    const remote = (list as Array<Record<string, unknown>>)
      .filter((c) => {
        if (typeof c.candidate !== 'string' || !c.candidate) return false
        // A terminator, not a candidate; addIceCandidate throws on it.
        if (c.candidate === 'a=end-of-candidates') return false
        // Malformed: a UDP candidate carrying a tcptype attribute.
        if (c.candidate.includes('UDP') && c.candidate.includes('tcptype')) {
          skipped += 1
          return false
        }
        return true
      })
      .map(
        (c): RemoteIceCandidate => ({
          // Candidates arrive in SDP attribute form; RTCIceCandidate wants the bare value.
          candidate: (c.candidate as string).replace(/^a=/, ''),
          sdpMid: (c.sdpMid as string | null) ?? null,
          sdpMLineIndex:
            c.sdpMLineIndex === null || c.sdpMLineIndex === undefined
              ? null
              : Number(c.sdpMLineIndex),
        }),
      )
    const types = new Map<string, number>()
    for (const c of remote) {
      const m = /\btyp\s+(\w+)/.exec(c.candidate)
      const t = m ? m[1] : 'unknown'
      // An IPv6 candidate can bypass NAT entirely, so the family matters as
      // much as the type when working out why nothing connects.
      const family = c.candidate.includes(':') && /\s[0-9a-f]*:[0-9a-f:]+\s/i.test(c.candidate)
        ? 'v6'
        : 'v4'
      const key = `${t}/${family}`
      types.set(key, (types.get(key) ?? 0) + 1)
    }
    log(
      'info',
      'webrtc',
      `Received ${remote.length} usable remote ICE candidate(s): ` +
        ([...types].map(([t, n]) => `${t}\u00d7${n}`).join(' ') || 'none') +
        (skipped ? ` (${skipped} malformed skipped)` : ''),
    )
    return remote
  }

  async function sendKeepalive(
    session: StreamingSession,
    handle: SessionHandle,
  ): Promise<void> {
    await http.request(sessionUrl(handle, '/keepalive'), {
      method: 'POST',
      headers: authHeaders(session),
      body: '{}',
      scope: 'xhome',
      retries: 1,
    })
  }

  async function stopSession(
    session: StreamingSession,
    handle: SessionHandle,
  ): Promise<void> {
    try {
      await http.request(sessionUrl(handle), {
        method: 'DELETE',
        headers: authHeaders(session),
        scope: 'xhome',
        retries: 0,
      })
      log('info', 'xhome', `Session ${handle.sessionId} stopped`)
    } catch (err) {
      // Best effort: the session expires anyway, and failing to tear it down
      // must never block starting a new one.
      log('warn', 'xhome', `Could not stop session cleanly: ${String(err)}`)
    }
  }

  return {
    loginToStreaming,
    listConsoles,
    startSession,
    waitForProvisioned,
    getConfiguration,
    exchangeSdp,
    exchangeIce,
    sendKeepalive,
    stopSession,
  }
}
