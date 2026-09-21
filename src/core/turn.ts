/**
 * Relay (TURN) configuration.
 *
 * Away from home both ends are usually behind NAT with no direct path. A relay
 * forwards the stream in that case. Two ways to supply one:
 *
 *  - Cloudflare Realtime, which mints short-lived credentials on demand from a
 *    long-lived key. Nothing to host, and generous free usage.
 *  - Any TURN server with static credentials, such as self-hosted coturn.
 *
 * Credential minting deliberately lives here rather than in the UI: the API
 * token is a secret, and on desktop this runs in the main process so the web
 * context never holds it.
 */
import type { HttpApi } from './http.js'
import type { Logger } from './ports.js'
import type { TurnServer } from '../shared/types.js'

const CLOUDFLARE_ENDPOINT = 'https://rtc.live.cloudflare.com/v1/turn/keys'

/** Long enough to outlast a play session, so credentials never expire mid-game. */
const CREDENTIAL_TTL_SECONDS = 86_400

interface CloudflareIceResponse {
  iceServers?: Array<{
    urls?: string | string[]
    username?: string
    credential?: string
  }>
}

/**
 * Ask Cloudflare for credentials. Returns servers in the shape
 * RTCPeerConnection expects.
 */
export async function fetchCloudflareIceServers(
  http: HttpApi,
  keyId: string,
  apiToken: string,
  log: Logger,
): Promise<RTCIceServer[]> {
  log('info', 'turn', 'Requesting relay credentials from Cloudflare')
  const res = await http.requestJson<CloudflareIceResponse>(
    `${CLOUDFLARE_ENDPOINT}/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ttl: CREDENTIAL_TTL_SECONDS }),
      scope: 'turn',
      retries: 1,
    },
  )

  const servers: RTCIceServer[] = []
  for (const entry of res.iceServers ?? []) {
    if (!entry.urls) continue
    servers.push(
      entry.username
        ? { urls: entry.urls, username: entry.username, credential: entry.credential }
        : { urls: entry.urls },
    )
  }
  if (servers.length === 0) {
    throw new Error('Cloudflare returned no relay servers — check the key ID and token')
  }

  const relayCount = servers.filter((s) => s.username).length
  log('info', 'turn', `Cloudflare returned ${servers.length} server(s), ${relayCount} relayed`)
  return servers
}

/** Resolve whatever relay the user configured into concrete ICE servers. */
export async function resolveIceServers(
  http: HttpApi,
  turn: TurnServer | undefined,
  log: Logger,
): Promise<RTCIceServer[]> {
  if (!turn) return []

  if (turn.provider === 'cloudflare') {
    if (!turn.keyId || !turn.apiToken) return []
    try {
      return await fetchCloudflareIceServers(http, turn.keyId, turn.apiToken, log)
    } catch (err) {
      // A relay that cannot be reached must not stop a connection that might
      // still succeed directly.
      log('error', 'turn', `Could not get relay credentials: ${String(err)}`)
      return []
    }
  }

  if (!turn.url) return []
  return [{ urls: turn.url, username: turn.username, credential: turn.credential }]
}
