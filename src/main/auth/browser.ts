/**
 * Interactive Microsoft sign-in.
 *
 * SISU hands back a login URL whose success redirect targets a custom scheme
 * (`ms-xal-<appid>://auth?code=…`) that no browser can actually load. We open
 * the page in a dedicated window and intercept the navigation attempt to pull
 * the authorization code out of it.
 */
import { BrowserWindow } from 'electron'
import { log } from '../logger.js'
import { REDIRECT_URI } from './flow.js'

export class SignInCancelled extends Error {
  constructor() {
    super('Sign-in was cancelled')
    this.name = 'SignInCancelled'
  }
}

export function promptForAuthCode(loginUrl: string, expectedState: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const win = new BrowserWindow({
      width: 520,
      height: 720,
      title: 'Sign in to Xbox',
      autoHideMenuBar: true,
      webPreferences: { nodeIntegration: false, contextIsolation: true, partition: 'xbox-login' },
    })

    let settled = false
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      fn()
      if (!win.isDestroyed()) win.destroy()
    }

    /** Returns true if this URL was the redirect we were waiting for. */
    const inspect = (url: string): boolean => {
      if (!url.startsWith(REDIRECT_URI)) return false
      // The custom scheme is not parseable as http(s); read the query directly.
      const query = new URLSearchParams(url.split('?')[1] ?? '')
      const error = query.get('error')
      if (error) {
        finish(() =>
          reject(new Error(`Microsoft returned "${error}": ${query.get('error_description') ?? ''}`)),
        )
        return true
      }
      const code = query.get('code')
      const state = query.get('state')
      if (!code) {
        finish(() => reject(new Error('The sign-in redirect carried no authorization code')))
        return true
      }
      // Guards against a redirect belonging to a different sign-in attempt.
      if (state && state !== expectedState) {
        finish(() => reject(new Error('The sign-in response did not match this request')))
        return true
      }
      log.info('auth', 'Authorization code captured')
      finish(() => resolve(code))
      return true
    }

    const onNavigate = (event: Electron.Event, url: string) => {
      if (inspect(url)) event.preventDefault()
    }

    win.webContents.on('will-redirect', onNavigate)
    win.webContents.on('will-navigate', onNavigate)
    // Electron routes unknown schemes here rather than through will-navigate.
    win.webContents.setWindowOpenHandler(({ url }) => {
      inspect(url)
      return { action: 'deny' }
    })
    win.webContents.on('did-fail-load', (_e, _code, _desc, failedUrl) => {
      inspect(failedUrl)
    })

    win.on('closed', () => {
      if (!settled) {
        settled = true
        reject(new SignInCancelled())
      }
    })

    win.loadURL(loginUrl).catch((err) => finish(() => reject(err)))
  })
}
