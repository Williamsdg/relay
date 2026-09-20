/**
 * The Xbox auth chain for game streaming — platform-agnostic.
 *
 * Remote Play is not reachable with a plain Xbox Live token: the `gssv`
 * relying party demands a token carrying device and title claims, which only
 * the SISU flow issues.
 *
 *   1. generate a P-256 proof key (see ./crypto)
 *   2. device.auth.xboxlive.com/device/authenticate  -> DeviceToken
 *   3. sisu.xboxlive.com/authenticate                -> MSA login URL (PKCE)
 *   4. user signs in; we capture ?code= from the redirect
 *   5. login.live.com/oauth20_token.srf              -> access + refresh token
 *   6. sisu.xboxlive.com/authorize                   -> User + Title tokens
 *   7. xsts.auth.xboxlive.com/xsts/authorize         -> XSTS token for gssv
 *
 * Steps 2, 3, 6 and 7 must carry a `Signature` header made with the proof key.
 */
import type { HttpApi } from './http.js'
import { HttpError } from './http.js'
import type { Logger } from './ports.js'
import {
  generateProofKey,
  proofKeyFromJwk,
  signRequest,
  type ProofKey,
} from './crypto.js'

/** The Xbox mobile app's identity — the one Microsoft authorises for streaming. */
export const APP_ID = '000000004c20a908'
export const TITLE_ID = '328178078'
export const REDIRECT_URI = `ms-xal-${APP_ID}://auth`
export const SCOPE = 'service::user.auth.xboxlive.com::MBI_SSL'
export const GSSV_RELYING_PARTY = 'http://gssv.xboxlive.com/'
export const XBOXLIVE_RELYING_PARTY = 'http://xboxlive.com'

const XBL_HEADERS: Record<string, string> = {
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
  /** Proof key as a JWK — portable across platforms, unlike a PEM. */
  proofKeyJwk: JsonWebKey
  deviceId: string
  refreshToken: string
}

interface XblTokenResponse {
  IssueInstant: string
  NotAfter: string
  Token: string
  DisplayClaims?: { xui?: Array<Record<string, string>> }
}

type MaybeWrappedToken = string | { Token?: string } | undefined

interface SisuAuthorizeResponse {
  DeviceToken: MaybeWrappedToken
  TitleToken: MaybeWrappedToken
  UserToken: MaybeWrappedToken
  AuthorizationToken: MaybeWrappedToken
}

export interface OAuthTokens {
  access_token: string
  refresh_token: string
  expires_in: number
}

export interface Pkce {
  verifier: string
  challenge: string
  state: string
}

function base64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n)
  globalThis.crypto.getRandomValues(out)
  return out
}

/** PKCE pair — SISU requires S256; plain is rejected. */
export async function createPkce(): Promise<Pkce> {
  const verifier = base64Url(randomBytes(32))
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(verifier),
  )
  return {
    verifier,
    challenge: base64Url(new Uint8Array(digest)),
    state: base64Url(randomBytes(16)),
  }
}

export function randomUuid(): string {
  return globalThis.crypto.randomUUID()
}

/**
 * SISU is inconsistent about token shapes — some fields are a bare JWT string,
 * others an object wrapping one. Reading `.Token` off a string yields
 * undefined, JSON.stringify then drops the field, and the service rejects the
 * request with a bare 400 that names nothing.
 */
function tokenValue(value: MaybeWrappedToken, field: string): string {
  const token = typeof value === 'string' ? value : value?.Token
  if (!token) throw new Error(`SISU returned no usable ${field}`)
  return token
}

export function createAuth(http: HttpApi, log: Logger) {
  async function signedPost<T>(
    key: ProofKey,
    url: string,
    payload: unknown,
    scope: string,
  ): Promise<T> {
    const body = JSON.stringify(payload)
    const signature = await signRequest(key, 'POST', url, body)
    return http.requestJson<T>(url, {
      method: 'POST',
      headers: { ...XBL_HEADERS, Signature: signature },
      body,
      scope,
    })
  }

  /** Step 2 — register this device and get a DeviceToken. */
  async function getDeviceToken(key: ProofKey, deviceId: string): Promise<string> {
    log('info', 'auth', 'Requesting device token')
    const res = await signedPost<XblTokenResponse>(
      key,
      'https://device.auth.xboxlive.com/device/authenticate',
      {
        Properties: {
          AuthMethod: 'ProofOfPossession',
          Id: `{${deviceId}}`,
          DeviceType: 'Android',
          SerialNumber: `{${randomUuid()}}`,
          Version: '15.0',
          ProofKey: key.jwk,
        },
        RelyingParty: 'http://auth.xboxlive.com',
        TokenType: 'JWT',
      },
      'auth.device',
    )
    log('info', 'auth', `Device token acquired (${res.Token.length} chars)`)
    return res.Token
  }

  /** Step 3 — ask SISU where to send the user to sign in. */
  async function startSisuAuth(
    key: ProofKey,
    deviceToken: string,
    pkce: Pkce,
  ): Promise<{ loginUrl: string; sessionId: string }> {
    log('info', 'auth', 'Starting SISU authentication')
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

  async function oauthToken(form: Record<string, string>): Promise<OAuthTokens> {
    return http.requestJson<OAuthTokens>('https://login.live.com/oauth20_token.srf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
      scope: 'auth.oauth',
    })
  }

  /** Step 5 — trade the authorization code for access + refresh tokens. */
  async function exchangeCode(code: string, verifier: string): Promise<OAuthTokens> {
    log('info', 'auth', 'Exchanging authorization code')
    return oauthToken({
      client_id: APP_ID,
      code,
      code_verifier: verifier,
      grant_type: 'authorization_code',
      redirect_uri: REDIRECT_URI,
      scope: SCOPE,
    })
  }

  /** Silent path on relaunch — no browser, no user interaction. */
  async function refreshAccessToken(refreshToken: string): Promise<OAuthTokens> {
    log('info', 'auth', 'Refreshing access token')
    return oauthToken({
      client_id: APP_ID,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
      redirect_uri: REDIRECT_URI,
      scope: SCOPE,
    })
  }

  /** Step 6 — exchange the MSA access token for Xbox user/title tokens. */
  async function sisuAuthorize(
    key: ProofKey,
    accessToken: string,
    deviceToken: string,
    relyingParty?: string,
  ): Promise<SisuAuthorizeResponse> {
    log('info', 'auth', `Authorizing with SISU${relyingParty ? ` for ${relyingParty}` : ''}`)
    const payload: Record<string, unknown> = {
      AccessToken: `t=${accessToken}`,
      AppId: APP_ID,
      DeviceToken: deviceToken,
      Sandbox: 'RETAIL',
      SiteName: 'user.auth.xboxlive.com',
      UseModernGamertag: true,
      ProofKey: key.jwk,
    }
    if (relyingParty) payload.RelyingParty = relyingParty
    return signedPost<SisuAuthorizeResponse>(
      key,
      'https://sisu.xboxlive.com/authorize',
      payload,
      'auth.sisu',
    )
  }

  /**
   * Microsoft returns account problems as an opaque `XErr` inside a 401.
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

  /** Step 7 — the streaming token. */
  async function getXstsToken(
    key: ProofKey,
    tokens: SisuAuthorizeResponse,
    /** SISU's authorize response carries no DeviceToken; supply the real one. */
    deviceToken: string,
    relyingParty = GSSV_RELYING_PARTY,
  ): Promise<XstsToken> {
    log('info', 'auth', `Requesting XSTS token for ${relyingParty}`)
    let res: XblTokenResponse
    try {
      res = await signedPost<XblTokenResponse>(
        key,
        'https://xsts.auth.xboxlive.com/xsts/authorize',
        {
          Properties: {
            SandboxId: 'RETAIL',
            DeviceToken: tokens.DeviceToken
              ? tokenValue(tokens.DeviceToken, 'DeviceToken')
              : deviceToken,
            TitleToken: tokenValue(tokens.TitleToken, 'TitleToken'),
            UserTokens: [tokenValue(tokens.UserToken, 'UserToken')],
          },
          RelyingParty: relyingParty,
          TokenType: 'JWT',
        },
        'auth.xsts',
      )
    } catch (err) {
      throw new Error(explainXstsFailure(err))
    }
    const claims = res.DisplayClaims?.xui?.[0] ?? {}
    return {
      token: res.Token,
      userHash: claims.uhs ?? '',
      gamertag: claims.gtg ?? '',
      xuid: claims.xid ?? '',
      notAfter: res.NotAfter,
    }
  }

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
   * Get a streaming token by whichever route this account's tenant accepts:
   * the documented XSTS exchange, falling back to asking SISU directly rather
   * than dead-ending on a bare 400.
   */
  async function acquireStreamingToken(
    key: ProofKey,
    accessToken: string,
    deviceToken: string,
    relyingParty = GSSV_RELYING_PARTY,
  ): Promise<XstsToken> {
    const tokens = await sisuAuthorize(key, accessToken, deviceToken)
    try {
      return await getXstsToken(key, tokens, deviceToken, relyingParty)
    } catch (err) {
      log('warn', 'auth', `XSTS exchange failed (${String(err)}); asking SISU directly`)
      const direct = await sisuAuthorize(key, accessToken, deviceToken, relyingParty)
      return xstsFromAuthorizationToken(direct.AuthorizationToken)
    }
  }

  /** Complete the chain from a stored refresh token — the silent path. */
  async function completeFromRefreshToken(
    artifacts: AuthArtifacts,
    relyingParty = GSSV_RELYING_PARTY,
  ): Promise<{ xsts: XstsToken; artifacts: AuthArtifacts }> {
    const key = await proofKeyFromJwk(artifacts.proofKeyJwk)
    const oauth = await refreshAccessToken(artifacts.refreshToken)
    const deviceToken = await getDeviceToken(key, artifacts.deviceId)
    const xsts = await acquireStreamingToken(key, oauth.access_token, deviceToken, relyingParty)
    return {
      xsts,
      artifacts: { ...artifacts, refreshToken: oauth.refresh_token || artifacts.refreshToken },
    }
  }

  /** Begin an interactive sign-in; the caller shows `loginUrl` and returns the code. */
  async function beginSignIn() {
    const key = await generateProofKey()
    const deviceId = randomUuid()
    const pkce = await createPkce()
    const deviceToken = await getDeviceToken(key, deviceId)
    const { loginUrl } = await startSisuAuth(key, deviceToken, pkce)
    return { key, deviceId, pkce, deviceToken, loginUrl }
  }

  /** Finish an interactive sign-in with the captured authorization code. */
  async function completeSignIn(
    key: ProofKey,
    deviceId: string,
    pkce: Pkce,
    deviceToken: string,
    code: string,
  ): Promise<{ xsts: XstsToken; artifacts: AuthArtifacts }> {
    const oauth = await exchangeCode(code, pkce.verifier)
    const xsts = await acquireStreamingToken(key, oauth.access_token, deviceToken)
    return {
      xsts,
      artifacts: {
        proofKeyJwk: key.storedJwk,
        deviceId,
        refreshToken: oauth.refresh_token,
      },
    }
  }

  return {
    beginSignIn,
    completeSignIn,
    completeFromRefreshToken,
    acquireStreamingToken,
    getDeviceToken,
    refreshAccessToken,
  }
}
