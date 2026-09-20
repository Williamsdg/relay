/**
 * Proof-key generation and request signing, on WebCrypto.
 *
 * Deliberately built on WebCrypto rather than node:crypto so the identical
 * code runs in Electron's main process and in a WKWebView on iOS. WebCrypto's
 * ECDSA also produces signatures in raw r||s form, which is exactly what Xbox
 * requires — node:crypto defaults to DER and has to be told otherwise.
 *
 * The signed byte layout is Microsoft's documented signature policy
 * (version 1, no extra headers):
 *
 *   <version: uint32 BE> 00 <windows filetime: uint64 BE> 00
 *   <METHOD> 00 <path+query> 00 <Authorization or ""> 00 <body> 00
 *
 * Any deviation yields an opaque HTTP 403, so it lives in one place.
 */

const POLICY_VERSION = 1

/** Offset between the Unix epoch and the Windows FILETIME epoch, in 100ns ticks. */
const FILETIME_EPOCH_OFFSET = 116_444_736_000_000_000n

export interface ProofKeyJwk {
  use: 'sig'
  alg: 'ES256'
  kty: 'EC'
  crv: 'P-256'
  x: string
  y: string
}

export interface ProofKey {
  privateKey: CryptoKey
  /** Public half, sent to the service as the ProofKey. */
  jwk: ProofKeyJwk
  /** Full JWK including the private component, for persistence. */
  storedJwk: JsonWebKey
}

const subtle = (): SubtleCrypto => {
  const c = globalThis.crypto
  if (!c?.subtle) throw new Error('WebCrypto is unavailable in this environment')
  return c.subtle
}

const ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256' } as const

function publicJwk(jwk: JsonWebKey): ProofKeyJwk {
  if (!jwk.x || !jwk.y) throw new Error('proof key is missing its EC coordinates')
  return { use: 'sig', alg: 'ES256', kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }
}

export async function generateProofKey(): Promise<ProofKey> {
  const pair = await subtle().generateKey(ALGORITHM, true, ['sign', 'verify'])
  const storedJwk = await subtle().exportKey('jwk', pair.privateKey)
  return { privateKey: pair.privateKey, jwk: publicJwk(storedJwk), storedJwk }
}

/** Restore a key persisted by `generateProofKey`, so sign-in survives a relaunch. */
export async function proofKeyFromJwk(storedJwk: JsonWebKey): Promise<ProofKey> {
  const privateKey = await subtle().importKey('jwk', storedJwk, ALGORITHM, true, ['sign'])
  return { privateKey, jwk: publicJwk(storedJwk), storedJwk }
}

/** Windows FILETIME: 100-nanosecond ticks since 1601-01-01 UTC. */
function windowsFileTime(date = new Date()): bigint {
  return BigInt(date.getTime()) * 10_000n + FILETIME_EPOCH_OFFSET
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(new ArrayBuffer(total))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  // btoa exists in both a WebView and modern Node.
  return btoa(binary)
}

function ascii(text: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(text.length))
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff
  return out
}

/**
 * Build the bytes that get signed. Exported so tests can assert the layout
 * directly rather than inferring it from a signature.
 */
export function buildSigningPayload(
  method: string,
  url: string,
  body: string,
  authorization: string,
  timestamp: bigint,
): Uint8Array<ArrayBuffer> {
  const { pathname, search } = new URL(url)

  const version = new Uint8Array(new ArrayBuffer(4))
  new DataView(version.buffer).setUint32(0, POLICY_VERSION, false)

  const ts = new Uint8Array(new ArrayBuffer(8))
  new DataView(ts.buffer).setBigUint64(0, timestamp, false)

  const nul = new Uint8Array(new ArrayBuffer(1))
  return concat(
    version, nul,
    ts, nul,
    ascii(method.toUpperCase()), nul,
    ascii(`${pathname}${search}`), nul,
    ascii(authorization), nul,
    new Uint8Array(new TextEncoder().encode(body)) as Uint8Array<ArrayBuffer>, nul,
  )
}

/** The `Signature` header value for a request. */
export async function signRequest(
  key: ProofKey,
  method: string,
  url: string,
  body: string,
  authorization = '',
): Promise<string> {
  const timestamp = windowsFileTime()
  const payload = buildSigningPayload(method, url, body, authorization, timestamp)

  const signature = new Uint8Array(
    await subtle().sign({ name: 'ECDSA', hash: 'SHA-256' }, key.privateKey, payload),
  )

  const header = new Uint8Array(new ArrayBuffer(12 + signature.length))
  const view = new DataView(header.buffer)
  view.setUint32(0, POLICY_VERSION, false)
  view.setBigUint64(4, timestamp, false)
  header.set(signature, 12)
  return toBase64(header)
}
