/**
 * Central log buffer. Everything the connection does is recorded here and
 * mirrored into the renderer's diagnostics panel, so a failed connect names the
 * step that failed rather than surfacing as a spinner that never resolves.
 */
import type { LogLine } from '../shared/types.js'

type Sink = (line: LogLine) => void

const MAX_LINES = 2000
const buffer: LogLine[] = []
const sinks = new Set<Sink>()

function push(level: LogLine['level'], scope: string, message: string) {
  const line: LogLine = { ts: Date.now(), level, scope, message }
  buffer.push(line)
  if (buffer.length > MAX_LINES) buffer.shift()
  const prefix = `[${scope}]`
  if (level === 'error') console.error(prefix, message)
  else if (level === 'warn') console.warn(prefix, message)
  else console.log(prefix, message)
  for (const sink of sinks) sink(line)
}

export const log = {
  debug: (scope: string, message: string) => push('debug', scope, message),
  info: (scope: string, message: string) => push('info', scope, message),
  warn: (scope: string, message: string) => push('warn', scope, message),
  error: (scope: string, message: string) => push('error', scope, message),
  history: () => [...buffer],
  subscribe(sink: Sink) {
    sinks.add(sink)
    return () => sinks.delete(sink)
  },
}

/** Redact tokens so logs can be pasted into a bug report safely. */
export function redact(value: string): string {
  if (value.length <= 12) return '***'
  return `${value.slice(0, 6)}…${value.slice(-4)} (${value.length} chars)`
}
