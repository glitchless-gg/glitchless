import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: { port: 5180, strictPort: true },
  preview: { port: 4180 },
  build: { outDir: 'dist', sourcemap: true, chunkSizeWarningLimit: 4000 },
});
