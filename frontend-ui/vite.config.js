import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8094',
        changeOrigin: true,
        // Do NOT rewrite — gateway expects /api/... routes as-is
      },
      '/admin': {
        target: 'http://localhost:5174',
        changeOrigin: true
      }
    }
  }
})
