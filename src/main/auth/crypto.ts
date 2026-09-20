/**
 * Proof-key generation and request signing for Xbox Live auth endpoints.
 *
 * Xbox's auth services use proof-of-possession: we generate a P-256 keypair,
 * hand the public half over as a JWK ("ProofKey") when asking for a token, and
 * from then on sign every request to those endpoints with the private half.
 *
 * The exact byte layout below is Microsoft's documented signature policy
 * (Version 1, no extra headers, unbounded body):
 *
 *   <policy version: uint32 BE> 00
 *   <timestamp: windows filetime, uint64 BE> 00
 *   <HTTP method, uppercase ASCII> 00
 *   <absolute path + query> 00
 *   <Authorization header value, or empty> 00
 *   <body bytes> 00
 *
 * SHA-256 + ECDSA over that stream, signature in raw r||s form (NOT DER).
 * The `Signature` header is base64(version || timestamp || rawSignature).
 *
 * Getting any of this wrong yields an opaque HTTP 403 from the service, so the
 * layout is encoded here once and reused by every signed call.
 */
import {
  createPrivateKey,
  createSign,
  generateKeyPairSync,
  type KeyObject,
} from 'node:crypto'

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

export interface ProofKeyPair {
  privateKey: KeyObject
  jwk: ProofKeyJwk
  /** PKCS#8 PEM, so the key can be persisted and restored across launches. */
  privatePem: string
}

/** Windows FILETIME: 100-nanosecond ticks since 1601-01-01 UTC. */
function windowsFileTime(date = new Date()): bigint {
  return BigInt(date.getTime()) * 10_000n + FILETIME_EPOCH_OFFSET
}

function jwkFromPrivateKey(privateKey: KeyObject): ProofKeyJwk {
  const jwk = privateKey.export({ format: 'jwk' }) as { x?: string; y?: string }
  if (!jwk.x || !jwk.y) throw new Error('proof key export is missing EC coordinates')
  // Node emits base64url without padding, which is what the service expects.
  return { use: 'sig', alg: 'ES256', kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }
}

export function generateProofKey(): ProofKeyPair {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  return {
    privateKey,
    jwk: jwkFromPrivateKey(privateKey),
    privatePem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
  }
}

export function proofKeyFromPem(pem: string): ProofKeyPair {
  const privateKey = createPrivateKey(pem)
  return { privateKey, jwk: jwkFromPrivateKey(privateKey), privatePem: pem }
}

/**
 * Build the `Signature` header for a request.
 *
 * `url` must be the full request URL; only its path + query is signed.
 * `authorization` is the Authorization header value if the request carries one —
 * it is always part of the signed stream, as an empty string when absent.
 */
export function signRequest(
  key: ProofKeyPair,
  method: string,
  url: string,
  body: string | Buffer,
  authorization = '',
): string {
  const { pathname, search } = new URL(url)
  const pathAndQuery = `${pathname}${search}`
  const timestamp = windowsFileTime()

  const version = Buffer.alloc(4)
  version.writeUInt32BE(POLICY_VERSION, 0)

  const ts = Buffer.alloc(8)
  ts.writeBigUInt64BE(timestamp, 0)

  const nul = Buffer.from([0])
  const bodyBuf = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8')

  const stream = Buffer.concat([
    version,
    nul,
    ts,
    nul,
    Buffer.from(method.toUpperCase(), 'ascii'),
    nul,
    Buffer.from(pathAndQuery, 'ascii'),
    nul,
    Buffer.from(authorization, 'ascii'),
    nul,
    bodyBuf,
    nul,
  ])

  const signer = createSign('SHA256')
  signer.update(stream)
  signer.end()
  // ieee-p1363 gives raw r||s (64 bytes for P-256); the service rejects DER.
  const raw = signer.sign({ key: key.privateKey, dsaEncoding: 'ieee-p1363' })

  return Buffer.concat([version, ts, raw]).toString('base64')
}
