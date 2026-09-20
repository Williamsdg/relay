/**
 * xHome REST client — console discovery and streaming-session lifecycle.
 *
 * Everything here runs in the main process rather than the renderer. That is
 * deliberate: these hosts send no CORS headers, so a renderer-side fetch would
 * be blocked outright, and keeping the gsToken out of the web context means a
 * compromised page cannot exfiltrate it.
 */
import { requestJson, requestJsonOptional, request, HttpError } from '../http.js'
import { log, redact } from '../logger.js'
import type { XboxConsole, SessionHandle, RemoteIceCandidate } from '../../shared/types.js'

const LOGIN_URL = 'https://xhome.gssv-play-prod.xboxlive.com/v2/login/user'

/**
 * Identifies the client to the service. The console decides which stream
 * profiles to offer partly from this, so it mirrors what the desktop Xbox app
 * sends rather than announcing an unknown client.
 */
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

export interface StreamingSession {
  gsToken: string
  baseUri: string
  expiresAt: number
}

/** Trade the gssv XSTS token for a streaming token plus a regional endpoint. */
export async function loginToStreaming(xstsToken: string): Promise<StreamingSession> {
  log.info('xhome', 'Logging in to the streaming service')
  const res = await requestJson<{
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

  log.info('xhome', `Region ${region.name} at ${region.baseUri}; token ${redact(res.gsToken)}`)
  return {
    gsToken: res.gsToken,
    baseUri: region.baseUri.replace(/\/$/, ''),
    // Refresh a minute early so a long session never streams on a dead token.
    expiresAt: Date.now() + (res.durationInSeconds - 60) * 1000,
  }
}

function authHeaders(session: StreamingSession): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Authorization: `Bearer ${session.gsToken}`,
  }
}

interface RawServer {
  serverId: string
  deviceName?: string
  consoleType?: string
  powerState?: string
  isLocal?: boolean
}

/**
 * List the consoles on this account.
 *
 * The regional endpoint is authoritative, but its path has moved between
 * service versions, so we try the known versions in order and fall back rather
 * than failing outright on a 404.
 */
export async function listConsoles(session: StreamingSession): Promise<XboxConsole[]> {
  const paths = ['/v6/servers/home', '/v5/servers/home', '/v4/servers/home']
  let lastErr: unknown
  for (const path of paths) {
    try {
      const res = await requestJson<{ results?: RawServer[] }>(
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
      log.info(
        'xhome',
        `Found ${consoles.length} console(s) via ${path}: ` +
          consoles.map((c) => `${c.name} [${c.consoleType}] power=${c.powerState}`).join('; '),
      )
      return consoles
    } catch (err) {
      lastErr = err
      if (err instanceof HttpError && err.status === 404) {
        log.debug('xhome', `${path} not available on this region, trying older version`)
        continue
      }
      throw err
    }
  }
  throw lastErr
}

export interface StartSessionOptions {
  serverId: string
  width: number
  height: number
}

/** Ask the service to provision a streaming session against a console. */
export async function startSession(
  session: StreamingSession,
  opts: StartSessionOptions,
): Promise<SessionHandle> {
  log.info('xhome', `Requesting a session on ${opts.serverId}`)
  const res = await requestJson<{ sessionId: string; sessionPath: string; state: string }>(
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
  log.info('xhome', `Session ${res.sessionId} created (${res.state})`)
  return {
    sessionId: res.sessionId,
    sessionPath: res.sessionPath,
    baseUri: session.baseUri,
    keepAlivePulseInSeconds: 300,
  }
}

const sessionUrl = (h: SessionHandle, suffix = '') =>
  `${h.baseUri}/v5/sessions/home/${h.sessionId}${suffix}`

export interface SessionState {
  state: string
  errorDetails?: { code?: string | null; message?: string | null }
}

export async function getSessionState(
  session: StreamingSession,
  handle: SessionHandle,
): Promise<SessionState | undefined> {
  return requestJsonOptional<SessionState>(sessionUrl(handle, '/state'), {
    headers: authHeaders(session),
    scope: 'xhome',
    retries: 1,
  })
}

/**
 * Block until the session is Provisioned.
 *
 * A console waking from standby legitimately takes a while, so the deadline is
 * generous — but a Failed state short-circuits immediately with the service's
 * own error text instead of spinning until timeout.
 */
export async function waitForProvisioned(
  session: StreamingSession,
  handle: SessionHandle,
  opts: { timeoutMs?: number; onState?: (state: string) => void } = {},
): Promise<void> {
  const { timeoutMs = 120_000, onState } = opts
  const deadline = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < deadline) {
    const status = await getSessionState(session, handle)
    if (!status) {
      await new Promise((r) => setTimeout(r, 1000))
      continue
    }
    const { state, errorDetails } = status
    if (state !== last) {
      last = state
      log.info('xhome', `Session state: ${state}`)
      onState?.(state)
    }
    if (state === 'Provisioned') return
    if (state === 'Failed' || errorDetails?.code) {
      throw new Error(
        errorDetails?.message || errorDetails?.code || 'The console refused the session',
      )
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error(
    `The console never became ready (stuck at "${last || 'unknown'}" after ${timeoutMs / 1000}s)`,
  )
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

export async function getConfiguration(
  session: StreamingSession,
  handle: SessionHandle,
): Promise<SessionConfiguration> {
  return requestJson<SessionConfiguration>(sessionUrl(handle, '/configuration'), {
    headers: authHeaders(session),
    scope: 'xhome',
  })
}

/** Channel versions we support. The server picks within these bounds. */
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

/**
 * SDP and ICE both use the same shape: POST the local half, then poll GET until
 * the server's half appears in `exchangeResponse`. Neither POST returns the
 * answer directly.
 */
async function pollExchange(
  session: StreamingSession,
  handle: SessionHandle,
  suffix: string,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const res = await requestJsonOptional<{
      exchangeResponse?: string
      errorDetails?: { code?: string | null; message?: string | null }
    }>(sessionUrl(handle, suffix), { headers: authHeaders(session), scope: 'xhome', retries: 1 })

    // The service answers with an empty body until the console has replied.
    // That is the normal "still waiting" signal, not an error.
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

export async function exchangeSdp(
  session: StreamingSession,
  handle: SessionHandle,
  offerSdp: string,
): Promise<{ sdp: string; versions: Record<string, number> }> {
  log.info('webrtc', 'Sending SDP offer')
  await request(sessionUrl(handle, '/sdp'), {
    method: 'POST',
    headers: authHeaders(session),
    body: JSON.stringify({
      messageType: 'offer',
      sdp: offerSdp,
      configuration: CHANNEL_CONFIG,
    }),
    scope: 'xhome',
  })

  const raw = await pollExchange(session, handle, '/sdp', 30_000)
  const parsed = JSON.parse(raw) as Record<string, unknown>
  if (parsed.status && parsed.status !== 'success') {
    throw new Error(`The console rejected the SDP offer: ${String(parsed.status)}`)
  }
  if (typeof parsed.sdp !== 'string') throw new Error('SDP answer was missing from the response')

  const versions: Record<string, number> = {}
  for (const name of ['chat', 'control', 'input', 'message']) {
    if (typeof parsed[name] === 'number') versions[name] = parsed[name] as number
  }
  log.info('webrtc', `SDP answer received; channel versions ${JSON.stringify(versions)}`)
  return { sdp: parsed.sdp, versions }
}

export async function exchangeIce(
  session: StreamingSession,
  handle: SessionHandle,
  candidates: RTCIceCandidateInit[],
): Promise<RemoteIceCandidate[]> {
  log.info('webrtc', `Sending ${candidates.length} ICE candidate(s)`)
  await request(sessionUrl(handle, '/ice'), {
    method: 'POST',
    headers: authHeaders(session),
    body: JSON.stringify({ messageType: 'iceCandidate', candidate: candidates }),
    scope: 'xhome',
  })

  const raw = await pollExchange(session, handle, '/ice', 30_000)
  const parsed = JSON.parse(raw) as unknown
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { candidates?: unknown[] })?.candidates)
      ? (parsed as { candidates: unknown[] }).candidates
      : []

  let skipped = 0
  const remote = (list as Array<Record<string, unknown>>)
    .filter((c) => {
      if (typeof c.candidate !== 'string' || !c.candidate) return false
      // The server terminates its list with a marker that is not a candidate;
      // handing it to addIceCandidate throws and aborts the whole batch.
      if (c.candidate === 'a=end-of-candidates') return false
      // Occasionally a UDP candidate arrives carrying a tcptype attribute.
      // It is malformed, Chromium rejects it, and it is never the one that
      // would have connected.
      if (c.candidate.includes('UDP') && c.candidate.includes('tcptype')) {
        skipped += 1
        return false
      }
      return true
    })
    .map(
      (c): RemoteIceCandidate => ({
        // Candidates arrive in SDP attribute form ("a=candidate:..."), but
        // RTCIceCandidate wants the bare value.
        candidate: (c.candidate as string).replace(/^a=/, ''),
        sdpMid: (c.sdpMid as string | null) ?? null,
        sdpMLineIndex:
          c.sdpMLineIndex === null || c.sdpMLineIndex === undefined
            ? null
            : Number(c.sdpMLineIndex),
      }),
    )
  log.info(
    'webrtc',
    `Received ${remote.length} usable remote ICE candidate(s)` +
      (skipped ? ` (${skipped} malformed skipped)` : ''),
  )
  return remote
}

export async function sendKeepalive(
  session: StreamingSession,
  handle: SessionHandle,
): Promise<void> {
  await request(sessionUrl(handle, '/keepalive'), {
    method: 'POST',
    headers: authHeaders(session),
    body: '{}',
    scope: 'xhome',
    retries: 1,
  })
}

export async function stopSession(
  session: StreamingSession,
  handle: SessionHandle,
): Promise<void> {
  try {
    await request(sessionUrl(handle), {
      method: 'DELETE',
      headers: authHeaders(session),
      scope: 'xhome',
      retries: 0,
    })
    log.info('xhome', `Session ${handle.sessionId} stopped`)
  } catch (err) {
    // Best-effort: the session expires on its own, and failing to tear it down
    // must never block the user from starting a new one.
    log.warn('xhome', `Could not stop session cleanly: ${String(err)}`)
  }
}
