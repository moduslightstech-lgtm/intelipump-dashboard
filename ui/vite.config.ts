import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

const liveApi = process.env.VITE_API_BASE_URL || 'http://157.230.215.93:8000/api'
const useRelativeApi = liveApi === '/api' || liveApi.startsWith('/')

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: useRelativeApi
      ? {
          '/api': {
            target: 'http://157.230.215.93:8000',
            changeOrigin: true,
            secure: false,
          },
        }
      : {
          // Local auth/admin when VITE_APP_API_BASE_URL is empty
          '/api/v1': {
            target: 'http://localhost:8000',
            changeOrigin: true,
          },
        },
  },
  test: {
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
  },
})
