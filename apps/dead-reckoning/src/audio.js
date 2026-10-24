// A few synthesized blips (no files to load). The context starts on the first input, as browsers require.
let ctx = null;
let muted = false;

function ac() {
  if (muted) return null;
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

function tone({ type = 'square', from, to = from, dur = 0.08, gain = 0.05, delay = 0 }) {
  const a = ac();
  if (!a) return;
  const t = a.currentTime + delay;
  const o = a.createOscillator();
  const g = a.createGain();
  o.type = type;
  o.frequency.setValueAtTime(from, t);
  o.frequency.exponentialRampToValueAtTime(Math.max(20, to), t + dur);
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(a.destination);
  o.start(t);
  o.stop(t + dur + 0.02);
}

function noise(dur = 0.18, gain = 0.08) {
  const a = ac();
  if (!a) return;
  const buf = a.createBuffer(1, Math.floor(a.sampleRate * dur), a.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length) ** 2;
  const src = a.createBufferSource();
  const g = a.createGain();
  const f = a.createBiquadFilter();
  f.type = 'lowpass';
  f.frequency.value = 1400;
  g.gain.value = gain;
  src.buffer = buf;
  src.connect(f).connect(g).connect(a.destination);
  src.start();
}

export const sfx = {
  wake: () => ac(),
  jump: () => tone({ from: 320, to: 560, dur: 0.07, gain: 0.03 }),
  land: () => tone({ type: 'triangle', from: 140, to: 90, dur: 0.05, gain: 0.04 }),
  die: () => {
    noise(0.22, 0.09);
    tone({ type: 'sawtooth', from: 220, to: 55, dur: 0.22, gain: 0.04 });
  },
  pop: () => tone({ type: 'triangle', from: 900 + Math.random() * 300, to: 500, dur: 0.05, gain: 0.015 }),
  win: () => [523, 659, 784, 1047].forEach((f, i) => tone({ type: 'triangle', from: f, dur: 0.18, gain: 0.05, delay: i * 0.08 })),
  click: () => tone({ type: 'triangle', from: 660, dur: 0.04, gain: 0.03 }),
  setMuted(m) {
    muted = m;
    if (m && ctx) ctx.suspend().catch(() => {});
  },
  get muted() {
    return muted;
  },
};
