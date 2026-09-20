/**
 * Desktop implementation of the streaming backend.
 *
 * Every call crosses the IPC bridge to the Electron main process, which owns
 * the tokens. The iOS build implements this same interface by calling the core
 * client directly, since there is no separate process there.
 */
import type { StreamBackend } from '../../core/stream/backend.js'

export const desktopBackend: StreamBackend = {
  startSession: (opts) => window.relay.session.start(opts),
  exchangeSdp: (offerSdp) => window.relay.session.sdp(offerSdp),
  exchangeIce: (candidates) => window.relay.session.ice(candidates),
  keepalive: () => window.relay.session.keepalive(),
  stopSession: () => window.relay.session.stop(),
  ensureConsoleOn: (serverId) => window.relay.consoles.ensureOn(serverId),
  log: (level, scope, message) => window.relay.log.write(level, scope, message),
}
