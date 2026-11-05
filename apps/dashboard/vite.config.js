import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const api = process.env.GLITCHLESS_API || 'http://localhost:7777';
const page = (name) => fileURLToPath(new URL(name, import.meta.url));

// Two pages: the dashboard (index.html), and the jam's own (jam.html: jam rooms, served at /jam/ by the server). In
// development every path under /jam is the jam's page too.
const jamPages = {
  name: 'jam-pages',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      if (/^\/jam(\/[^.]*)?(\?.*)?$/.test(req.url)) req.url = '/jam.html';
      next();
    });
  },
};

export default defineConfig({
  plugins: [react(), jamPages],
  base: './',
  server: {
    port: 5174,
    proxy: { '/v1': { target: api, changeOrigin: true }, '/play': api, '/sdk': api },
  },
  build: { chunkSizeWarningLimit: 1500, rollupOptions: { input: { main: page('index.html'), jam: page('jam.html') } } },
});
