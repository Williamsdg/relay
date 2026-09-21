/**
 * iOS HTTP adapter.
 *
 * Requests go through Capacitor's native HTTP rather than the WebView's fetch.
 * That is not an optimisation: the Xbox hosts send no CORS headers, so an
 * in-page fetch is blocked outright, exactly as it would be in any browser.
 * Native HTTP runs outside the web security context and is unaffected.
 */
import { CapacitorHttp } from '@capacitor/core'
import type { HttpClient } from '@core/ports.js'

export const nativeHttp: HttpClient = async (url, req = {}) => {
  const res = await CapacitorHttp.request({
    url,
    method: (req.method ?? 'GET') as 'GET' | 'POST' | 'PUT' | 'DELETE',
    headers: req.headers,
    data: req.body,
    // Capacitor parses JSON eagerly; we want the raw text so the shared layer
    // can decide, and so an empty body stays distinguishable from `null`.
    responseType: 'text',
    connectTimeout: req.timeoutMs ?? 15_000,
    readTimeout: req.timeoutMs ?? 15_000,
  })

  const headers: Record<string, string> = {}
  for (const [key, value] of Object.entries(res.headers ?? {})) {
    headers[key.toLowerCase()] = String(value)
  }

  // A native response body can arrive already decoded; normalise to text.
  const text =
    typeof res.data === 'string' ? res.data : res.data == null ? '' : JSON.stringify(res.data)

  return { status: res.status, text, headers }
}
