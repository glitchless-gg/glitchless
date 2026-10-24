import { loadFont as loadOutfit } from '@remotion/google-fonts/Outfit';
import { loadFont as loadInter } from '@remotion/google-fonts/Inter';
import { loadFont as loadMono } from '@remotion/google-fonts/JetBrainsMono';

export const display = loadOutfit('normal', { weights: ['800'], subsets: ['latin'] }).fontFamily;
export const inter = loadInter('normal', { weights: ['500', '600', '700'], subsets: ['latin'] }).fontFamily;
export const mono = loadMono('normal', { weights: ['400', '500', '700'], subsets: ['latin'] }).fontFamily;

export const FPS = 30;

// Glitchless: navy, mint for good, coral for trouble.
export const C = {
  navy: '#14213d',
  deep: '#0b1426',
  panel: '#101a31',
  tile: '#1d2e52',
  line: 'rgba(197,208,228,0.14)',
  mint: '#2ee6a6',
  coral: '#ff6b57',
  text: '#ffffff',
  soft: '#c5d0e4',
  muted: '#9fb0cf',
  faint: '#6f7f9e',
  claude: '#e08a68',
  violet: '#a99bff',
};
