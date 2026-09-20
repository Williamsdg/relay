import { contextBridge, ipcRenderer } from 'electron'
import type { PersistedState } from '../main/settings.js'
import type {
  AuthState,
  LogLine,
  SessionHandle,
  XboxConsole,
  RemoteIceCandidate,
} from '../shared/types.js'

/**
 * The renderer's entire view of privileged capability. Nothing here hands a
 * token across the bridge — the renderer can ask for exchanges but never holds
 * a credential itself.
 */
const api = {
  log: {
    history: (): Promise<LogLine[]> => ipcRenderer.invoke('log:history'),
    /** Record a renderer-side event (WebRTC, media, input) in the shared log. */
    write: (level: LogLine['level'], scope: string, message: string): void => {
      ipcRenderer.send('log:write', level, scope, message)
    },
    onLine: (cb: (line: LogLine) => void) => {
      const handler = (_e: unknown, line: LogLine) => cb(line)
      ipcRenderer.on('log', handler)
      return () => {
        ipcRenderer.off('log', handler)
      }
    },
  },
  auth: {
    state: (): Promise<AuthState> => ipcRenderer.invoke('auth:state'),
    restore: (): Promise<AuthState> => ipcRenderer.invoke('auth:restore'),
    signIn: (): Promise<AuthState> => ipcRenderer.invoke('auth:signIn'),
    signOut: (): Promise<AuthState> => ipcRenderer.invoke('auth:signOut'),
  },
  settings: {
    get: (): Promise<PersistedState> => ipcRenderer.invoke('settings:get'),
    set: (next: Partial<PersistedState>): Promise<PersistedState> =>
      ipcRenderer.invoke('settings:set', next),
  },
  consoles: {
    list: (): Promise<XboxConsole[]> => ipcRenderer.invoke('consoles:list'),
    powerOff: (serverId: string): Promise<void> =>
      ipcRenderer.invoke('console:powerOff', serverId),
    powerOn: (serverId: string): Promise<void> =>
      ipcRenderer.invoke('console:powerOn', serverId),
    /** Wake and wait; resolves to whether the console reported On. */
    ensureOn: (serverId: string): Promise<boolean> =>
      ipcRenderer.invoke('console:ensureOn', serverId),
  },
  window: {
    /** Returns the new fullscreen state. */
    toggleFullscreen: (): Promise<boolean> => ipcRenderer.invoke('window:toggleFullscreen'),
    /** Save a PNG data URL; resolves to the path written, or null if cancelled. */
    saveImage: (dataUrl: string): Promise<string | null> =>
      ipcRenderer.invoke('window:saveImage', dataUrl),
  },
  session: {
    start: (opts: {
      serverId: string
      width: number
      height: number
    }): Promise<{ handle: SessionHandle; config: { keepAlivePulseInSeconds?: number } }> =>
      ipcRenderer.invoke('session:start', opts),
    sdp: (offerSdp: string): Promise<{ sdp: string; versions: Record<string, number> }> =>
      ipcRenderer.invoke('session:sdp', offerSdp),
    ice: (candidates: RTCIceCandidateInit[]): Promise<RemoteIceCandidate[]> =>
      ipcRenderer.invoke('session:ice', candidates),
    keepalive: (): Promise<void> => ipcRenderer.invoke('session:keepalive'),
    stop: (): Promise<void> => ipcRenderer.invoke('session:stop'),
    onState: (cb: (state: string) => void) => {
      const handler = (_e: unknown, s: string) => cb(s)
      ipcRenderer.on('session:state', handler)
      return () => {
        ipcRenderer.off('session:state', handler)
      }
    },
  },
}

contextBridge.exposeInMainWorld('relay', api)

export type RelayApi = typeof api
