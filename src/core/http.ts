/**
 * HTTP helpers shared by every platform.
 *
 * Retry and timeout policy lives here rather than in each adapter, so desktop
 * and iOS behave identically under a flaky network — the adapters only have to
 * perform one raw request.
 */
import type { HttpClient, HttpRequest, Logger } from './ports.js'

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly body: string,
    /** Xbox often explains a rejection in headers rather than the body. */
    readonly headers: Record<string, string> = {},
  ) {
    const hint = headers['x-err'] || headers['www-authenticate'] || headers['x-xblcorrelationid']
    super(
      `HTTP ${status} for ${pathOf(url)}` +
        (body ? ` — ${body.slice(0, 400)}` : '') +
        (hint ? ` [${hint}]` : ''),
    )
    this.name = 'HttpError'
  }
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname
  } catch {
    return url
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 4xx never becomes success on a retry; 5xx, 429 and network faults might. */
function isRetryable(err: unknown): boolean {
  if (err instanceof HttpError) return err.status >= 500 || err.status === 429
  return true
}

export interface HttpApi {
  request(url: string, opts?: HttpRequest): Promise<string>
  requestJson<T>(url: string, opts?: HttpRequest): Promise<T>
  requestJsonOptional<T>(url: string, opts?: HttpRequest): Promise<T | undefined>
}

export function createHttp(client: HttpClient, log: Logger): HttpApi {
  async function request(url: string, opts: HttpRequest = {}): Promise<string> {
    const { retries = 3, scope = 'http', method = 'GET' } = opts
    let lastErr: unknown

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await client(url, opts)
        if (res.status < 200 || res.status >= 300) {
          throw new HttpError(res.status, url, res.text, res.headers)
        }
        return res.text
      } catch (err) {
        lastErr = err
        const label = err instanceof HttpError ? `HTTP ${err.status}` : String(err)
        if (!isRetryable(err) || attempt === retries) {
          log('error', scope, `${method} ${pathOf(url)} failed: ${label}`)
          throw err
        }
        const backoff = Math.min(4000, 300 * 2 ** attempt) + Math.random() * 200
        log(
          'warn',
          scope,
          `${method} ${pathOf(url)} ${label}; retry ${attempt + 1}/${retries} in ${Math.round(backoff)}ms`,
        )
        await sleep(backoff)
      }
    }
    throw lastErr
  }

  async function requestJsonOptional<T>(
    url: string,
    opts: HttpRequest = {},
  ): Promise<T | undefined> {
    const text = await request(url, opts)
    if (!text.trim()) return undefined
    try {
      return JSON.parse(text) as T
    } catch {
      throw new Error(`Expected JSON from ${pathOf(url)} but got: ${text.slice(0, 200)}`)
    }
  }

  async function requestJson<T>(url: string, opts: HttpRequest = {}): Promise<T> {
    const value = await requestJsonOptional<T>(url, opts)
    if (value === undefined) {
      throw new Error(`${pathOf(url)} returned an empty body where JSON was expected`)
    }
    return value
  }

  return { request, requestJson, requestJsonOptional }
}
