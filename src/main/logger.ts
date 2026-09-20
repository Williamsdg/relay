/**
 * Central log buffer. Everything the connection does is recorded here and
 * mirrored into the renderer's diagnostics panel, so a failed connect names the
 * step that failed rather than surfacing as a spinner that never resolves.
 */
import { app, shell } from 'electron'
import { appendFileSync, mkdirSync, statSync, renameSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { LogLine } from '../shared/types.js'

type Sink = (line: LogLine) => void

const MAX_LINES = 2000
const buffer: LogLine[] = []
const sinks = new Set<Sink>()

/**
 * Where the log is written.
 *
 * A packaged app launched from Finder has no stdout anybody will ever see, so
 * without a file on disk a bug report is just "it didn't work". Resolved
 * lazily because `app.getPath` is unavailable until Electron is ready.
 */
let logFile: string | null = null
let logFileChecked = false

function currentLogFile(): string | null {
  if (logFileChecked) return logFile
  logFileChecked = true
  try {
    const dir = join(app.getPath('userData'), 'logs')
    mkdirSync(dir, { recursive: true })
    const path = join(dir, 'relay.log')
    // Keep one previous run's worth rather than growing without bound.
    if (existsSync(path) && statSync(path).size > 5_000_000) {
      renameSync(path, join(dir, 'relay.previous.log'))
    }
    logFile = path
  } catch {
    logFile = null
  }
  return logFile
}

export function logFilePath(): string | null {
  return currentLogFile()
}

export function revealLogFile(): void {
  const path = currentLogFile()
  if (path) shell.showItemInFolder(path)
}

function push(level: LogLine['level'], scope: string, message: string) {
  const line: LogLine = { ts: Date.now(), level, scope, message }
  buffer.push(line)
  if (buffer.length > MAX_LINES) buffer.shift()
  const prefix = `[${scope}]`
  if (level === 'error') console.error(prefix, message)
  else if (level === 'warn') console.warn(prefix, message)
  else console.log(prefix, message)
  for (const sink of sinks) sink(line)

  const path = currentLogFile()
  if (path) {
    try {
      appendFileSync(
        path,
        `${new Date(line.ts).toISOString()} [${level}] ${scope}: ${message}\n`,
      )
    } catch {
      // Losing the file log must never break the app; the in-memory buffer
      // and the diagnostics panel still work.
    }
  }
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
