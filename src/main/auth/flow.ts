/**
 * The Xbox auth chain for game streaming.
 *
 * Remote Play is not reachable with a plain Xbox Live token: the `gssv` relying
 * party demands a token carrying device and title claims, which only the SISU
 * flow issues. The full sequence:
 *
 *   1. generate a P-256 proof key (see ./crypto)
 *   2. device.auth.xboxlive.com/device/authenticate  -> DeviceToken
 *   3. sisu.xboxlive.com/authenticate                -> MSA login URL (PKCE)
 *   4. user signs in; we capture ?code= from the redirect
 *   5. login.live.com/oauth20_token.srf              -> access + refresh token
 *   6. sisu.xboxlive.com/authorize                   -> User + Title + Device tokens
 *   7. xsts.auth.xboxlive.com/xsts/authorize         -> XSTS token for gssv
 *
 * Steps 2, 3, 6 and 7 must carry a `Signature` header made with the proof key.
 *
 * On relaunch we skip 2-4 entirely: the refresh token replays step 5 onward,
 * so a returning user never sees the Microsoft login page again until their
 * refresh token is genuinely revoked.
 */
import { randomUUID, createHash, randomBytes } from 'node:crypto'
import { requestJson, HttpError } from '../http.js'
import { log, redact } from '../logger.js'
import { signRequest, generateProofKey, proofKeyFromPem, type ProofKeyPair } from './crypto.js'

/** The Xbox mobile app's identity — the one Microsoft authorises for streaming. */
export const APP_ID = '000000004c20a908'
export const TITLE_ID = '328178078'
export const REDIRECT_URI = `ms-xal-${APP_ID}://auth`
export const SCOPE = 'service::user.auth.xboxlive.com::MBI_SSL'
export const GSSV_RELYING_PARTY = 'http://gssv.xboxlive.com/'

const XBL_HEADERS = {
  'x-xbl-contract-version': '1',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store, must-revalidate, no-cache',
  Accept: 'application/json',
}

export interface XstsToken {
  token: string
  userHash: string
  gamertag: string
  xuid: string
  notAfter: string
}

export interface AuthArtifacts {
  proofKeyPem: string
  deviceId: string
  refreshToken: string
}

interface XblTokenResponse {
  IssueInstant: string
  NotAfter: string
  Token: string
  DisplayClaims?: { xui?: Array<Record<string, string>> }
}

/**
 * SISU is inconsistent about token shapes: some fields come back as a bare
 * JWT string, others as an object wrapping one. Treat every field as either.
 */
type MaybeWrappedToken = string | { Token?: string } | undefined

interface SisuAuthorizeResponse {
  DeviceToken: MaybeWrappedToken
  TitleToken: MaybeWrappedToken
  UserToken: MaybeWrappedToken
  AuthorizationToken: MaybeWrappedToken
}

/**
 * Pull the JWT out of whichever shape arrived.
 *
 * This matters more than it looks: reading `.Token` off a string yields
 * undefined, JSON.stringify then drops the field entirely, and the service
 * rejects the request with a bare 400 that names nothing.
 */
function tokenValue(value: MaybeWrappedToken, field: string): string {
  const token = typeof value === 'string' ? value : value?.Token
  if (!token) throw new Error(`SISU returned no usable ${field}`)
  return token
}

/** Describe a response's shape for the log without leaking token material. */
function describeShape(res: Record<string, unknown>): string {
  return Object.entries(res)
    .map(([k, v]) => {
      if (typeof v === 'string') return `${k}:string(${v.length})`
      if (v && typeof v === 'object') {
        const inner = v as Record<string, unknown>
        return `${k}:object{${Object.keys(inner).join(',')}}`
      }
      return `${k}:${typeof v}`
    })
    .join(' ')
}

function base64Url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** PKCE pair — SISU requires S256, plain is rejected. */
export function createPkce() {
  const verifier = base64Url(randomBytes(32))
  const challenge = base64Url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge, state: base64Url(randomBytes(16)) }
}

/** POST to a signed Xbox Live auth endpoint. */
async function signedPost<T>(
  key: ProofKeyPair,
  url: string,
  payload: unknown,
  scope: string,
): Promise<T> {
  const body = JSON.stringify(payload)
  const signature = signRequest(key, 'POST', url, body)
  return requestJson<T>(url, {
    method: 'POST',
    headers: { ...XBL_HEADERS, Signature: signature },
    body,
    scope,
  })
}

/** Step 2 — register this machine as a device and get a DeviceToken. */
export async function getDeviceToken(key: ProofKeyPair, deviceId: string): Promise<string> {
  log.info('auth', 'Requesting device token')
  const res = await signedPost<XblTokenResponse>(
    key,
    'https://device.auth.xboxlive.com/device/authenticate',
    {
      Properties: {
        AuthMethod: 'ProofOfPossession',
        Id: `{${deviceId}}`,
        DeviceType: 'Android',
        SerialNumber: `{${randomUUID()}}`,
        Version: '15.0',
        ProofKey: key.jwk,
      },
      RelyingParty: 'http://auth.xboxlive.com',
      TokenType: 'JWT',
    },
    'auth.device',
  )
  log.info('auth', `Device token acquired (${redact(res.Token)})`)
  return res.Token
}

/** Step 3 — ask SISU where to send the user to sign in. */
export async function startSisuAuth(
  key: ProofKeyPair,
  deviceToken: string,
  pkce: ReturnType<typeof createPkce>,
): Promise<{ loginUrl: string; sessionId: string }> {
  log.info('auth', 'Starting SISU authentication')
  const res = await signedPost<{ MsaOauthRedirect: string; SessionId: string }>(
    key,
    'https://sisu.xboxlive.com/authenticate',
    {
      AppId: APP_ID,
      TitleId: TITLE_ID,
      RedirectUri: REDIRECT_URI,
      DeviceToken: deviceToken,
      Sandbox: 'RETAIL',
      TokenType: 'code',
      Offers: [SCOPE],
      Query: {
        display: 'android_phone',
        code_challenge: pkce.challenge,
        code_challenge_method: 'S256',
        state: pkce.state,
      },
    },
    'auth.sisu',
  )
  return { loginUrl: res.MsaOauthRedirect, sessionId: res.SessionId }
}

interface OAuthTokens {
  access_token: string
  refresh_token: string
  expires_in: number
}

/** Step 5 — trade the authorization code for access + refresh tokens. */
export async function exchangeCode(code: string, verifier: string): Promise<OAuthTokens> {
  log.info('auth', 'Exchanging authorization code')
  return requestJson<OAuthTokens>('https://login.live.com/oauth20_token.srf', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: APP_ID,
      code,
      code_verifier: verifier,
      grant_type: 'authorization_code',
      redirect_uri: REDIRECT_URI,
      scope: SCOPE,
    }).toString(),
    scope: 'auth.oauth',
  })
}

/** Silent path on relaunch — no browser window, no user interaction. */
export async function refreshAccessToken(refreshToken: string): Promise<OAuthTokens> {
  log.info('auth', 'Refreshing access token')
  return requestJson<OAuthTokens>('https://login.live.com/oauth20_token.srf', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: APP_ID,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
      redirect_uri: REDIRECT_URI,
      scope: SCOPE,
    }).toString(),
    scope: 'auth.oauth',
  })
}

/** Step 6 — exchange the MSA access token for Xbox user/title/device tokens. */
export async function sisuAuthorize(
  key: ProofKeyPair,
  accessToken: string,
  deviceToken: string,
  relyingParty?: string,
): Promise<SisuAuthorizeResponse> {
  log.info('auth', `Authorizing with SISU${relyingParty ? ` for ${relyingParty}` : ''}`)
  const payload: Record<string, unknown> = {
    AccessToken: `t=${accessToken}`,
    AppId: APP_ID,
    DeviceToken: deviceToken,
    Sandbox: 'RETAIL',
    SiteName: 'user.auth.xboxlive.com',
    UseModernGamertag: true,
    ProofKey: key.jwk,
  }
  // Asking SISU directly for a relying party makes it mint the authorization
  // token itself, skipping the separate XSTS exchange.
  if (relyingParty) payload.RelyingParty = relyingParty

  const res = await signedPost<SisuAuthorizeResponse>(
    key,
    'https://sisu.xboxlive.com/authorize',
    payload,
    'auth.sisu',
  )
  log.debug('auth', `SISU response shape: ${describeShape(res as unknown as Record<string, unknown>)}`)
  return res
}

/** Step 7 — the streaming token. `relyingParty` selects which service it opens. */
export async function getXstsToken(
  key: ProofKeyPair,
  tokens: SisuAuthorizeResponse,
  relyingParty = GSSV_RELYING_PARTY,
): Promise<XstsToken> {
  log.info('auth', `Requesting XSTS token for ${relyingParty}`)
  const props = {
    SandboxId: 'RETAIL',
    DeviceToken: tokenValue(tokens.DeviceToken, 'DeviceToken'),
    TitleToken: tokenValue(tokens.TitleToken, 'TitleToken'),
    UserTokens: [tokenValue(tokens.UserToken, 'UserToken')],
  }
  log.debug(
    'auth',
    `XSTS request: Device=${redact(props.DeviceToken)} Title=${redact(props.TitleToken)} ` +
      `User=${redact(props.UserTokens[0])}`,
  )
  let res: XblTokenResponse
  try {
    res = await signedPost<XblTokenResponse>(
      key,
      'https://xsts.auth.xboxlive.com/xsts/authorize',
      {
        Properties: props,
        RelyingParty: relyingParty,
        TokenType: 'JWT',
      },
      'auth.xsts',
    )
  } catch (err) {
    throw new Error(explainXstsFailure(err))
  }
  const claims = res.DisplayClaims?.xui?.[0] ?? {}
  const token: XstsToken = {
    token: res.Token,
    userHash: claims.uhs ?? '',
    gamertag: claims.gtg ?? '',
    xuid: claims.xid ?? '',
    notAfter: res.NotAfter,
  }
  log.info('auth', `XSTS token for ${token.gamertag || 'account'} valid until ${token.notAfter}`)
  return token
}

/**
 * Microsoft returns account problems as an opaque `XErr` number inside a 401.
 * Surfacing the real meaning turns "sign-in failed" into something actionable.
 */
function explainXstsFailure(err: unknown): string {
  if (!(err instanceof HttpError)) return err instanceof Error ? err.message : String(err)
  let xerr: number | undefined
  try {
    xerr = JSON.parse(err.body)?.XErr
  } catch {
    /* body was not JSON */
  }
  const known: Record<number, string> = {
    0x8015dc03: 'This account has an enforcement ban. Resolve it at xbox.com.',
    0x8015dc05: 'A parental restriction is blocking this account.',
    0x8015dc09: 'This Microsoft account has no Xbox profile. Create one at xbox.com.',
    0x8015dc0a: 'The Xbox Terms of Use have not been accepted. Sign in at xbox.com once.',
    0x8015dc0b: 'Xbox Live is not available in this account’s country/region.',
    0x8015dc0c: 'This account needs age verification at xbox.com.',
    0x8015dc0e: 'This child account is not in a family group.',
    0x8015dc13: 'This account must change its gamertag before it can be used.',
    0x8015dc22: 'The user token expired. Sign in again.',
    0x8015dc26: 'The user token was rejected. Sign in again.',
    0x8015dc31: 'Xbox authentication is currently having an outage. Try again shortly.',
    0x8015dc32: 'Xbox authentication is currently having an outage. Try again shortly.',
  }
  if (xerr && known[xerr]) return known[xerr]
  if (xerr) return `Xbox rejected the sign-in (XErr 0x${xerr.toString(16)}).`
  return err.message
}

export interface SignInResult {
  xsts: XstsToken
  artifacts: AuthArtifacts
}

/** Build our token record from a SISU AuthorizationToken. */
function xstsFromAuthorizationToken(value: MaybeWrappedToken): XstsToken {
  const token = tokenValue(value, 'AuthorizationToken')
  const wrapper = (typeof value === 'object' ? value : {}) as XblTokenResponse
  const claims = wrapper.DisplayClaims?.xui?.[0] ?? {}
  return {
    token,
    userHash: claims.uhs ?? '',
    gamertag: claims.gtg ?? '',
    xuid: claims.xid ?? '',
    notAfter: wrapper.NotAfter ?? new Date(Date.now() + 8 * 3600_000).toISOString(),
  }
}

/**
 * Get a streaming token, by whichever route this account's tenant accepts.
 *
 * The documented path is SISU authorize followed by a separate XSTS exchange.
 * Some accounts reject that exchange outright, but will hand back an
 * authorization token if SISU is asked for the relying party directly. Try the
 * documented path first and fall back rather than dead-ending on a bare 400.
 */
export async function acquireStreamingToken(
  key: ProofKeyPair,
  accessToken: string,
  deviceToken: string,
): Promise<XstsToken> {
  const tokens = await sisuAuthorize(key, accessToken, deviceToken)
  try {
    return await getXstsToken(key, tokens)
  } catch (err) {
    log.warn('auth', `XSTS exchange failed (${String(err)}); asking SISU directly`)
    const direct = await sisuAuthorize(key, accessToken, deviceToken, GSSV_RELYING_PARTY)
    const xsts = xstsFromAuthorizationToken(direct.AuthorizationToken)
    log.info('auth', `Streaming token obtained via SISU for ${xsts.gamertag || 'account'}`)
    return xsts
  }
}

/**
 * Complete the chain from an MSA refresh token. Used both right after an
 * interactive login and on every subsequent launch.
 */
export async function completeFromRefreshToken(
  artifacts: AuthArtifacts,
): Promise<SignInResult> {
  const key = proofKeyFromPem(artifacts.proofKeyPem)
  const oauth = await refreshAccessToken(artifacts.refreshToken)
  const deviceToken = await getDeviceToken(key, artifacts.deviceId)
  const xsts = await acquireStreamingToken(key, oauth.access_token, deviceToken)
  return {
    xsts,
    artifacts: { ...artifacts, refreshToken: oauth.refresh_token || artifacts.refreshToken },
  }
}

/** Fresh keys + device identity for a first-time interactive sign-in. */
export function newIdentity(): { key: ProofKeyPair; deviceId: string } {
  return { key: generateProofKey(), deviceId: randomUUID() }
}
