/**
 * The seams between protocol logic and whatever platform it runs on.
 *
 * Everything in `src/core` is written against these interfaces so the same
 * code drives the Electron app and the iOS app. Desktop fulfils them with
 * Node's fetch and the macOS Keychain; iOS fulfils them with Capacitor's
 * native HTTP (which bypasses CORS, unreachable from a WebView otherwise) and
 * the iOS keychain.
 */

export interface HttpRequest {
  method?: string
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
  /** Retries for transient failures; 4xx must never be retried. */
  retries?: number
  scope?: string
}

export interface HttpResponse {
  status: number
  /** Response body as text; empty string when there is none. */
  text: string
  headers: Record<string, string>
}

/** Performs an HTTP request without CORS restrictions. */
export type HttpClient = (url: string, req?: HttpRequest) => Promise<HttpResponse>

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export type Logger = (level: LogLevel, scope: string, message: string) => void

/** Credential persistence, backed by the platform's secure storage. */
export interface SecureStore {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  remove(key: string): Promise<void>
}
