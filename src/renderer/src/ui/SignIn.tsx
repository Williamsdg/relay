import type { AuthState } from '../../../shared/types.js'

export function SignIn({ auth, onSignIn }: { auth: AuthState; onSignIn: () => void }) {
  const busy = auth.status === 'signing-in'
  return (
    <div className="centered">
      <div className="card">
        <h1>Connect to your Xbox</h1>
        <p className="muted">
          Sign in with the Microsoft account your console is registered to. Relay stores your
          credentials in the macOS Keychain and signs you in automatically from then on.
        </p>
        {auth.status === 'error' && <p className="error">{auth.message}</p>}
        <button className="primary" onClick={onSignIn} disabled={busy}>
          {busy ? auth.step : 'Sign in with Microsoft'}
        </button>
      </div>
    </div>
  )
}
