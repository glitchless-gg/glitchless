import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: { port: 5179, strictPort: true },
  preview: { port: 4179 },
  build: { outDir: 'dist', sourcemap: true, chunkSizeWarningLimit: 8000 },
});
