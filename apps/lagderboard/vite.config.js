import { defineConfig, loadEnv } from 'vite';

// Where the game will live. A production build links shares and its link preview here unless VITE_LAGDERBOARD_URL
// says otherwise; a dev server links shares to itself.
const DEFAULT_URL = 'https://lagderboard.glitchless.gg/';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const configured = (env.VITE_LAGDERBOARD_URL || process.env.VITE_LAGDERBOARD_URL || '').replace(/\/?$/, '/');
  const url = configured !== '/' ? configured : mode === 'production' ? DEFAULT_URL : '';
  return {
    base: './',
    define: { __LAGDERBOARD_URL__: JSON.stringify(url) },
    plugins: [
      {
        name: 'lagderboard-url',
        // Link previews need absolute URLs, so the address goes into index.html at build time.
        transformIndexHtml: (html) => html.replaceAll('%LAGDERBOARD_URL%', url || DEFAULT_URL),
      },
    ],
    server: {
      port: 5183,
      strictPort: true,
    },
    preview: {
      port: 4183,
    },
    build: {
      outDir: 'dist',
      sourcemap: true,
      chunkSizeWarningLimit: 1200,
    },
  };
});
