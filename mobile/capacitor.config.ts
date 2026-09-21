import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'io.williamsdigital.relay',
  appName: 'Relay',
  webDir: 'dist',
  ios: {
    // The stream fills the screen; a white flash on launch is jarring.
    backgroundColor: '#0b0f0c',
    contentInset: 'never',
  },
  server: {
    // Xbox hosts send no CORS headers, so every request goes through the
    // native HTTP layer rather than the WebView's fetch.
    androidScheme: 'https',
  },
}

export default config
