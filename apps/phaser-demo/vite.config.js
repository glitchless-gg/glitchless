import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: { port: 5175, strictPort: true },
  preview: { port: 4175 },
  build: { outDir: 'dist', sourcemap: true, chunkSizeWarningLimit: 2000 },
});
