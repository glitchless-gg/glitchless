import { defineConfig, loadEnv } from 'vite';

// Where Glitchless's own copy of the game lives; VITE_GAME_URL points the link card elsewhere.
const HOME = 'https://dead-reckoning.glitchless.gg/';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  // The game's address, for the share text and link previews (X, Discord, iMessage need the image's absolute
  // address): VITE_GAME_URL, else HOME in a production build. In development the page's own address.
  const site = (env.VITE_GAME_URL || (mode === 'production' ? HOME : '')).replace(/(.)\/?$/, '$1/');
  return {
    base: './',
    define: { 'import.meta.env.VITE_GAME_URL': JSON.stringify(site) },
    plugins: [
      {
        name: 'link-preview',
        transformIndexHtml: (html) => html.replaceAll('%OG_IMAGE%', `${site}og.png`).replaceAll('%GAME_URL%', site || './'),
      },
    ],
    server: {
      port: 5186,
      strictPort: true,
    },
    preview: {
      port: 4186,
    },
    build: {
      outDir: 'dist',
      sourcemap: true,
      chunkSizeWarningLimit: 1200,
    },
  };
});
