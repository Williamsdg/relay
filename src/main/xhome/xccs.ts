/**
 * Xbox Console Command Service — power and shell commands.
 *
 * This is a different service from the streaming host, on a different relying
 * party (`http://xboxlive.com`), so it needs its own token and its own auth
 * header format. Commands are delivered to the console as push notifications,
 * which means they are best-effort: a success here means the service accepted
 * the command, not that the console acted on it.
 */
import { randomUUID } from 'node:crypto'
import { requestJson } from '../http.js'
import { log } from '../logger.js'
import type { XstsToken } from '../auth/flow.js'

const BASE = 'https://xccs.xboxlive.com'

function headers(web: XstsToken): Record<string, string> {
  return {
    Authorization: `XBL3.0 x=${web.userHash};${web.token}`,
    'Accept-Language': 'en-US',
    'Content-Type': 'application/json',
    skillplatform: 'RemoteManagement',
    'x-xbl-contract-version': '4',
    'x-xbl-client-name': 'XboxApp',
    'x-xbl-client-type': 'UWA',
    'x-xbl-client-version': '39.39.22001.0',
  }
}

async function sendCommand(
  web: XstsToken,
  consoleId: string,
  type: string,
  command: string,
  parameters: unknown[] = [],
): Promise<void> {
  log.info('xccs', `Sending ${type}/${command} to ${consoleId}`)
  await requestJson<unknown>(`${BASE}/commands`, {
    method: 'POST',
    headers: headers(web),
    body: JSON.stringify({
      destination: 'Xbox',
      type,
      command,
      sessionId: randomUUID(),
      sourceId: 'com.microsoft.smartglass',
      parameters,
      linkedXboxId: consoleId,
    }),
    scope: 'xccs',
    retries: 1,
  })
  log.info('xccs', `${command} accepted by the service`)
}

export async function powerOff(web: XstsToken, consoleId: string): Promise<void> {
  await sendCommand(web, consoleId, 'Power', 'TurnOff')
}

export async function powerOn(web: XstsToken, consoleId: string): Promise<void> {
  await sendCommand(web, consoleId, 'Power', 'WakeUp')
}

/** Type a string into whatever text field the console has focused. */
export async function sendText(
  web: XstsToken,
  consoleId: string,
  text: string,
): Promise<void> {
  await sendCommand(web, consoleId, 'Shell', 'InjectString', [{ replacementString: text }])
}

export interface ConsoleStatus {
  powerState: string
  name?: string
  consoleType?: string
}

/**
 * Current state of one console.
 *
 * The service has moved this payload around between contract versions, so read
 * the power state from either the top level or a nested status object rather
 * than assuming one shape.
 */
export async function getConsoleStatus(
  web: XstsToken,
  consoleId: string,
): Promise<ConsoleStatus> {
  const res = await requestJson<Record<string, unknown>>(`${BASE}/consoles/${consoleId}`, {
    headers: headers(web),
    scope: 'xccs',
    retries: 1,
  })
  const nested = (res.status ?? {}) as Record<string, unknown>
  const powerState =
    (res.powerState as string) ?? (nested.powerState as string) ?? 'Unknown'
  return {
    powerState,
    name: res.name as string | undefined,
    consoleType: res.consoleType as string | undefined,
  }
}

/** True when the console can accept a remote wake at all. */
export function isWakeable(powerState: string): boolean {
  // Instant-on standby keeps the network adapter listening. A console in
  // energy-saving mode or genuinely powered down cannot hear the request.
  return powerState === 'ConnectedStandby' || powerState === 'Standby'
}

/**
 * Wake a console and wait for it to report On.
 *
 * Returns whether it actually came up. A false result is not fatal: the
 * streaming service performs its own wake during provisioning, so the caller
 * should carry on rather than refuse to connect.
 */
export async function wakeAndWait(
  web: XstsToken,
  consoleId: string,
  opts: { timeoutMs?: number; onProgress?: (state: string) => void } = {},
): Promise<boolean> {
  const { timeoutMs = 45_000, onProgress } = opts

  let status: ConsoleStatus
  try {
    status = await getConsoleStatus(web, consoleId)
  } catch (err) {
    log.warn('xccs', `Could not read console status: ${String(err)}`)
    return false
  }

  if (status.powerState === 'On') {
    log.info('xccs', 'Console is already on')
    return true
  }
  if (!isWakeable(status.powerState)) {
    log.warn(
      'xccs',
      `Console reports "${status.powerState}" and cannot be woken remotely ` +
        '(needs Instant-on power mode)',
    )
    return false
  }

  await powerOn(web, consoleId)

  const deadline = Date.now() + timeoutMs
  let last = status.powerState
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000))
    try {
      const next = await getConsoleStatus(web, consoleId)
      if (next.powerState !== last) {
        last = next.powerState
        log.info('xccs', `Console power state: ${last}`)
        onProgress?.(last)
      }
      if (next.powerState === 'On') return true
    } catch (err) {
      // A console mid-boot drops requests; keep waiting rather than give up.
      log.debug('xccs', `Status poll failed while waking: ${String(err)}`)
    }
  }

  log.warn('xccs', `Console did not report On within ${timeoutMs / 1000}s`)
  return false
}
