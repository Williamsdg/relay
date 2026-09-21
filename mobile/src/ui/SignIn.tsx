export function SignIn({
  busy,
  error,
  onSignIn,
}: {
  busy: boolean
  error: string | null
  onSignIn: () => void
}) {
  return (
    <div className="screen centered">
      <div className="card">
        <h1>Relay</h1>
        <p className="muted">
          Stream your Xbox to this device. Sign in with the Microsoft account your console is
          registered to — Relay keeps your credentials in the iOS Keychain and signs you in
          automatically after this.
        </p>
        {error && <p className="error">{error}</p>}
        <button className="primary big" onClick={onSignIn} disabled={busy}>
          {busy ? 'Waiting for sign-in…' : 'Sign in with Microsoft'}
        </button>
      </div>
    </div>
  )
}
