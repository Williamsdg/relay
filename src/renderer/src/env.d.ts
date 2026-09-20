import type { RelayApi } from '../../preload/index.js'

declare global {
  interface Window {
    relay: RelayApi
  }
}

export {}
