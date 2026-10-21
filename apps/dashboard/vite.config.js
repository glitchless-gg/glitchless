import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const api = process.env.GLITCHLESS_API || 'http://localhost:7777';

export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    port: 5174,
    proxy: { '/v1': { target: api, changeOrigin: true }, '/play': api, '/sdk': api },
  },
  build: { chunkSizeWarningLimit: 1500 },
});
