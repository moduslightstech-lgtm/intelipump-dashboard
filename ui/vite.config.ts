import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

const liveApi = process.env.VITE_API_BASE_URL || '/api'
const useRelativeApi = liveApi === '/api' || liveApi.startsWith('/')
const apiTarget = process.env.VITE_DEV_API_TARGET || 'http://localhost:8000'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: useRelativeApi
      ? {
          '/api': {
            target: apiTarget,
            changeOrigin: true,
          },
        }
      : {
          // Local auth/admin when VITE_APP_API_BASE_URL is empty
          '/api/v1': {
            target: apiTarget,
            changeOrigin: true,
          },
        },
  },
  test: {
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
  },
})
