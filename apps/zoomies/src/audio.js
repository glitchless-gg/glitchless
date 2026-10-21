// Tiny WebAudio blip synth — no assets needed. M toggles mute.
import { params } from './params.js';

let ctx = null;
let master = null;
let muted = params.mute || params.autoplay;

function ensure() {
  if (muted) return null;
  if (!ctx) {
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      master = ctx.createGain();
      master.gain.value = 0.22;
      master.connect(ctx.destination);
    } catch {
      return null;
    }
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

window.addEventListener('keydown', () => ensure(), { passive: true });
window.addEventListener('pointerdown', () => ensure(), { passive: true });

function tone(freq, dur, { type = 'square', vol = 0.5, slide = 0, delay = 0 } = {}) {
  const c = ensure();
  if (!c || c.state !== 'running') return;
  const t0 = c.currentTime + delay;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(vol, t0 + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(master);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

export const sfx = {
  get muted() {
    return muted;
  },
  toggleMute() {
    muted = !muted;
    if (!muted) ensure();
    return muted;
  },
  jump: () => tone(330, 0.16, { type: 'square', vol: 0.18, slide: 320 }),
  land: () => tone(140, 0.08, { type: 'triangle', vol: 0.25, slide: -60 }),
  bone: () => {
    tone(880, 0.07, { type: 'square', vol: 0.12 });
    tone(1320, 0.1, { type: 'square', vol: 0.12, delay: 0.06 });
  },
  golden: () => [523, 659, 784, 1047, 1319].forEach((f, i) => tone(f, 0.14, { type: 'triangle', vol: 0.3, delay: i * 0.06 })),
  ball: () => [392, 523, 659, 784, 1047].forEach((f, i) => tone(f, 0.1, { type: 'square', vol: 0.15, delay: i * 0.045 })),
  stomp: () => tone(220, 0.12, { type: 'square', vol: 0.25, slide: -150 }),
  death: () => {
    tone(440, 0.18, { type: 'square', vol: 0.2, slide: -200 });
    tone(220, 0.35, { type: 'triangle', vol: 0.3, slide: -150, delay: 0.15 });
  },
  checkpoint: () => [659, 988].forEach((f, i) => tone(f, 0.15, { type: 'triangle', vol: 0.3, delay: i * 0.08 })),
  complete: () => [523, 659, 784, 1047, 784, 1047].forEach((f, i) => tone(f, 0.18, { type: 'triangle', vol: 0.3, delay: i * 0.1 })),
};
