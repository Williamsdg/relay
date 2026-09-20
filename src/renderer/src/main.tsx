import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.js'
import './styles.css'

const root = createRoot(document.getElementById('root')!)

/**
 * If the preload bridge is missing, every call into `window.relay` throws and
 * React unmounts to a black window — the exact silent failure this app exists
 * to avoid. Say so instead.
 */
if (typeof window.relay !== 'object') {
  root.render(
    <div className="centered">
      <div className="card">
        <h1>Relay could not start</h1>
        <p className="error">
          The privileged bridge failed to load, so the app cannot reach Xbox. This is a build or
          packaging problem rather than a network one.
        </p>
        <p className="muted small">Re-run the build, then relaunch.</p>
      </div>
    </div>,
  )
} else {
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}
