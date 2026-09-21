import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // The protocol, connection manager and input encoder are shared with the
      // desktop build rather than reimplemented here.
      '@core': resolve(__dirname, '../src/core'),
      '@shared': resolve(__dirname, '../src/shared'),
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
})
