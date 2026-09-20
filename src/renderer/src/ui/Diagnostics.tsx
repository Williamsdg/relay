import { useEffect, useRef } from 'react'
import type { LogLine } from '../../../shared/types.js'

/**
 * The connection log, verbatim. When a connect fails this is the difference
 * between "it didn't work" and knowing which call returned what.
 */
export function Diagnostics({ logs, onClose }: { logs: LogLine[]; onClose: () => void }) {
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [logs.length])

  const copy = () => {
    const text = logs
      .map((l) => `${new Date(l.ts).toISOString()} [${l.level}] ${l.scope}: ${l.message}`)
      .join('\n')
    void navigator.clipboard.writeText(text)
  }

  return (
    <aside className="diagnostics">
      <div className="card-head">
        <h2>Diagnostics</h2>
        <div className="spacer" />
        <button className="ghost" onClick={copy}>
          Copy
        </button>
        <button className="ghost" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="log">
        {logs.map((line, i) => (
          <div key={i} className={`log-line ${line.level}`}>
            <span className="muted small">
              {new Date(line.ts).toLocaleTimeString()} {line.scope}
            </span>
            <span>{line.message}</span>
          </div>
        ))}
        <div ref={endRef} />
      </div>
    </aside>
  )
}
