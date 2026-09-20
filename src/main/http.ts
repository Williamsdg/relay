/**
 * HTTP helper with timeouts and bounded retries.
 *
 * Xbox's auth and streaming endpoints fail transiently often enough that naive
 * one-shot fetches are the single biggest source of "it just won't connect".
 * Every call here gets a deadline; 5xx/429/network errors retry with jittered
 * backoff, 4xx do not (retrying a rejected token never helps).
 */
import { log } from './logger.js'

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly body: string,
    /** Xbox often explains a rejection in headers rather than the body. */
    readonly headers: Record<string, string> = {},
  ) {
    const hint =
      headers['x-err'] || headers['www-authenticate'] || headers['x-xblcorrelationid']
    super(
      `HTTP ${status} for ${new URL(url).pathname}` +
        (body ? ` — ${body.slice(0, 400)}` : '') +
        (hint ? ` [${hint}]` : ''),
    )
    this.name = 'HttpError'
  }
}

export interface RequestOptions {
  method?: string
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
  retries?: number
  scope?: string
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function isRetryable(err: unknown): boolean {
  if (err instanceof HttpError) return err.status >= 500 || err.status === 429
  return true // network-level failure
}

export async function request(url: string, opts: RequestOptions = {}): Promise<Response> {
  const {
    method = 'GET',
    headers = {},
    body,
    timeoutMs = 15_000,
    retries = 3,
    scope = 'http',
  } = opts

  let lastErr: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(url, { method, headers, body, signal: controller.signal })
      if (!res.ok) {
        const headers: Record<string, string> = {}
        res.headers.forEach((v, k) => {
          headers[k.toLowerCase()] = v
        })
        throw new HttpError(res.status, url, await res.text(), headers)
      }
      return res
    } catch (err) {
      lastErr = err
      const fatal = !isRetryable(err) || attempt === retries
      const label = err instanceof HttpError ? `HTTP ${err.status}` : String(err)
      if (fatal) {
        log.error(scope, `${method} ${new URL(url).pathname} failed: ${label}`)
        throw err
      }
      const backoff = Math.min(4000, 300 * 2 ** attempt) + Math.random() * 200
      log.warn(
        scope,
        `${method} ${new URL(url).pathname} ${label}; retry ${attempt + 1}/${retries} in ${Math.round(backoff)}ms`,
      )
      await sleep(backoff)
    } finally {
      clearTimeout(timer)
    }
  }
  throw lastErr
}

export async function requestJson<T>(url: string, opts: RequestOptions = {}): Promise<T> {
  const res = await request(url, opts)
  const text = await res.text()
  if (!text) return undefined as T
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error(`Expected JSON from ${url} but got: ${text.slice(0, 200)}`)
  }
}
