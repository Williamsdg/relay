import { contextBridge, ipcRenderer } from 'electron'
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
  consoles: {
    list: (): Promise<XboxConsole[]> => ipcRenderer.invoke('consoles:list'),
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
