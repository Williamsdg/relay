/**
 * Xbox Console Command Service — power and shell commands.
 *
 * A different service from the streaming host, on a different relying party
 * (`http://xboxlive.com`), so it needs its own token and auth header format.
 * Commands reach the console as push notifications, so success here means the
 * service accepted the command, not that the console acted on it.
 */
import type { HttpApi } from './http.js'
import type { Logger } from './ports.js'
import { randomUuid, type XstsToken } from './auth.js'

const BASE = 'https://xccs.xboxlive.com'

export interface ConsoleStatus {
  powerState: string
  name?: string
  consoleType?: string
}

/** True when the console can accept a remote wake at all. */
export function isWakeable(powerState: string): boolean {
  // Instant-on standby keeps the network adapter listening. A console in
  // energy-saving mode or genuinely powered down cannot hear the request.
  return powerState === 'ConnectedStandby' || powerState === 'Standby'
}

export function createXccs(http: HttpApi, log: Logger) {
  const headers = (web: XstsToken): Record<string, string> => ({
    Authorization: `XBL3.0 x=${web.userHash};${web.token}`,
    'Accept-Language': 'en-US',
    'Content-Type': 'application/json',
    skillplatform: 'RemoteManagement',
    'x-xbl-contract-version': '4',
    'x-xbl-client-name': 'XboxApp',
    'x-xbl-client-type': 'UWA',
    'x-xbl-client-version': '39.39.22001.0',
  })

  async function sendCommand(
    web: XstsToken,
    consoleId: string,
    type: string,
    command: string,
    parameters: unknown[] = [],
  ): Promise<void> {
    log('info', 'xccs', `Sending ${type}/${command} to ${consoleId}`)
    await http.request(`${BASE}/commands`, {
      method: 'POST',
      headers: headers(web),
      body: JSON.stringify({
        destination: 'Xbox',
        type,
        command,
        sessionId: randomUuid(),
        sourceId: 'com.microsoft.smartglass',
        parameters,
        linkedXboxId: consoleId,
      }),
      scope: 'xccs',
      retries: 1,
    })
    log('info', 'xccs', `${command} accepted by the service`)
  }

  const powerOff = (web: XstsToken, id: string) => sendCommand(web, id, 'Power', 'TurnOff')
  const powerOn = (web: XstsToken, id: string) => sendCommand(web, id, 'Power', 'WakeUp')

  /** The payload has moved between contract versions, so read both shapes. */
  async function getConsoleStatus(web: XstsToken, consoleId: string): Promise<ConsoleStatus> {
    const res = await http.requestJson<Record<string, unknown>>(`${BASE}/consoles/${consoleId}`, {
      headers: headers(web),
      scope: 'xccs',
      retries: 1,
    })
    const nested = (res.status ?? {}) as Record<string, unknown>
    return {
      powerState: (res.powerState as string) ?? (nested.powerState as string) ?? 'Unknown',
      name: res.name as string | undefined,
      consoleType: res.consoleType as string | undefined,
    }
  }

  /**
   * Wake a console and wait for it. A false result is not fatal: the streaming
   * service performs its own wake during provisioning, so the caller should
   * carry on rather than refuse to connect.
   */
  async function wakeAndWait(
    web: XstsToken,
    consoleId: string,
    opts: { timeoutMs?: number; onProgress?: (state: string) => void } = {},
  ): Promise<boolean> {
    const { timeoutMs = 45_000, onProgress } = opts

    let status: ConsoleStatus
    try {
      status = await getConsoleStatus(web, consoleId)
    } catch (err) {
      log('warn', 'xccs', `Could not read console status: ${String(err)}`)
      return false
    }

    if (status.powerState === 'On') {
      log('info', 'xccs', 'Console is already on')
      return true
    }
    if (!isWakeable(status.powerState)) {
      log(
        'warn',
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
          log('info', 'xccs', `Console power state: ${last}`)
          onProgress?.(last)
        }
        if (next.powerState === 'On') return true
      } catch {
        // A console mid-boot drops requests; keep waiting rather than give up.
      }
    }
    log('warn', 'xccs', `Console did not report On within ${timeoutMs / 1000}s`)
    return false
  }

  return { powerOff, powerOn, getConsoleStatus, wakeAndWait }
}
