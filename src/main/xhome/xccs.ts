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
