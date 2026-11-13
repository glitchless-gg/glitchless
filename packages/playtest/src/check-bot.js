// The players of a game check: bots that play a web game with no help from it. The explorer clicks to start, tries
// the common controls in turn (arrow keys, WASD, Space and the usual action keys, the mouse, click and drag; taps,
// swipes and holds on a phone) and spends more of its time on whatever makes the screen change. With an Anthropic
// API key and `ai`, a Claude model looks at the screen every few seconds and picks the inputs instead. Either way,
// each step goes in a timeline, with the frames, memory and errors of that moment, so a report can say "after two
// minutes, frames took 80 ms".
//
// How much the screen changed is read from small PNG screenshots, compared pixel by pixel (decoded here with zlib).

import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// The two ways a check plays: desktop Chrome on this computer's own GPU, and a throttled phone: the same computer
// with its CPU slowed 4×, a phone's touch screen and a 4G-like connection. A phone is held the way the game wants:
// sideways for a game wider than it is tall.
export const PROFILES = {
  desktop: { name: 'desktop', viewport: { width: 1280, height: 720 }, cpu: 1, network: null, touch: false },
  phone: { name: 'phone', viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, touch: true, cpu: 4, network: { latency: 60, downloadThroughput: Math.round(9e6 / 8), uploadThroughput: Math.round(1.5e6 / 8) } },
};

export function profileWords(p) {
  if (p.name === 'phone') return `a throttled phone: this computer with its CPU slowed ${p.cpu}×, a ${p.viewport.width}×${p.viewport.height} touch screen and a 4G-like connection (9 Mbps, 60 ms)`;
  return `desktop Chrome on this computer's own GPU, at ${p.viewport.width}×${p.viewport.height}`;
}

// The inputs the explorer tries, and the words a report uses for each.
const DESKTOP_INPUTS = [
  { name: 'arrows', words: 'the arrow keys and Space', run: (io) => io.keys([['ArrowRight', 900], ['Space', 0], ['ArrowUp', 300], ['ArrowLeft', 700], ['Space', 0], ['ArrowDown', 300], ['ArrowRight', 600]]) },
  { name: 'wasd', words: 'W, A, S, D and Space', run: (io) => io.keys([['d', 900], ['Space', 0], ['w', 300], ['a', 700], ['Space', 0], ['s', 300], ['d', 600]]) },
  { name: 'mouse', words: 'moving the mouse and clicking', run: (io) => io.mouse(6) },
  { name: 'drag', words: 'clicking and dragging', run: (io) => io.drags(3) },
  { name: 'actions', words: 'Z, X, C, J, K, E, F, Tab, Shift and Enter', run: (io) => io.keys([['z', 0], ['x', 0], ['c', 0], ['j', 0], ['k', 0], ['e', 0], ['f', 0], ['Tab', 0], ['Shift', 300], ['Enter', 0]]) },
];
const PHONE_INPUTS = [
  { name: 'taps', words: 'tapping around the screen', run: (io) => io.taps(8) },
  { name: 'holds', words: 'holding the left and right of the screen', run: (io) => io.holds() },
  { name: 'swipes', words: 'swiping left, right, up and down', run: (io) => io.swipes() },
  { name: 'drag', words: 'touching and dragging', run: (io) => io.drags(3) },
];

// Below this share of pixels changed, a step's screen counts as still (0.1%: a blinking cursor, a clock).
const STILL = 0.001;

// Words on buttons that start a game or carry on after it ends, in the order they're tried.
const START = /^(play|play now|start|start game|new game|begin|go|let'?s go|continue|tap to (play|start)|click to (play|start)|press (any key|start)|ok|okay|got it|i understand|accept|enter|resume|retry|try again|play again|restart|next)!?$/i;

// A small random generator, so a check of the same game tries the same points.
function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ───────────────────────────── screen changes ─────────────────────────────

// A PNG (8-bit gray, RGB, gray with alpha or RGBA, not interlaced: what Chrome's screenshots are) → { width, height,
// gray: Uint8Array }, or null for anything else.
export function decodePng(buf) {
  if (!Buffer.isBuffer(buf) || buf.readUInt32BE(0) !== 0x89504e47) return null;
  let off = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let type = 0;
  let interlace = 0;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const kind = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (kind === 'IHDR') [width, height, depth, type, interlace] = [data.readUInt32BE(0), data.readUInt32BE(4), data[8], data[9], data[12]];
    else if (kind === 'IDAT') idat.push(data);
    else if (kind === 'IEND') break;
    off += 12 + len;
  }
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[type];
  if (!width || !height || depth !== 8 || !channels || interlace) return null;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[y * stride + x - channels] : 0;
      const b = y ? out[(y - 1) * stride + x] : 0;
      const c = x >= channels && y ? out[(y - 1) * stride + x - channels] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[y * stride + x] = v & 255;
    }
  }
  const gray = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const p = i * channels;
    gray[i] = channels >= 3 ? (out[p] * 3 + out[p + 1] * 6 + out[p + 2]) / 10 : out[p];
  }
  return { width, height, gray };
}

// How different two small screenshots are: the share of their pixels that clearly changed (by more than 12 of 255
// levels of gray), 0 (the same) to 1. A share, not a mean, so one small character walking across a still background
// counts as much as it looks.
export function screenChange(a, b) {
  if (!a || !b || a.width !== b.width || a.height !== b.height) return null;
  let changed = 0;
  for (let i = 0; i < a.gray.length; i++) if (Math.abs(a.gray[i] - b.gray[i]) > 12) changed++;
  return Math.round((changed / a.gray.length) * 10000) / 10000;
}

// ───────────────────────────── playing ─────────────────────────────

// Plays the page for `seconds`, already loaded, as `profile`. → { steps, inputs, labels, shots, notes }.
//   area()    → the game's rectangle in the page (its canvas, or the whole viewport)
//   shot(name) → saves a JPEG of the screen for the report, → its path
export async function explore(page, { profile, seconds, cdp, area, shot, ai = null, seed = 7, log = () => {} }) {
  const rand = random(seed);
  const touch = !!profile.touch;
  const inputs = touch ? PHONE_INPUTS : DESKTOP_INPUTS;
  const t0 = Date.now();
  const elapsed = () => Math.round((Date.now() - t0) / 100) / 10;
  const steps = [];
  const notes = [];
  const shots = [];
  const tried = new Map(inputs.map((i) => [i.name, { tries: 0, moved: 0, change: 0 }]));

  const small = async () => {
    const r = await area();
    if (!r || r.width < 4 || r.height < 4) return null;
    const scale = Math.min(1, 192 / (r.width * (profile.deviceScaleFactor || 1)));
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { x: r.x, y: r.y, width: r.width, height: r.height, scale }, captureBeyondViewport: false }).catch(() => ({}));
    return data ? decodePng(Buffer.from(data, 'base64')) : null;
  };
  const point = async (fx, fy) => {
    const r = await area();
    return { x: r.x + r.width * Math.min(0.97, Math.max(0.03, fx)), y: r.y + r.height * Math.min(0.97, Math.max(0.03, fy)) };
  };
  const tapAt = async (p) => (touch ? page.touchscreen.tap(p.x, p.y) : page.mouse.click(p.x, p.y));
  // A touch drag, as CDP touch events (Playwright's touchscreen only taps).
  const touchDrag = async (a, b, ms) => {
    const n = 8;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: a.x, y: a.y }] });
    for (let i = 1; i <= n; i++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: a.x + ((b.x - a.x) * i) / n, y: a.y + ((b.y - a.y) * i) / n }] });
      await page.waitForTimeout(ms / n);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  const io = {
    keys: async (seq) => {
      for (const [key, ms] of seq) {
        if (ms) {
          await page.keyboard.down(key);
          await page.waitForTimeout(ms);
          await page.keyboard.up(key);
        } else await page.keyboard.press(key);
        await page.waitForTimeout(120);
      }
    },
    mouse: async (n) => {
      for (let i = 0; i < n; i++) {
        const p = await point(rand(), rand());
        await page.mouse.move(p.x, p.y, { steps: 6 });
        await page.mouse.click(p.x, p.y);
        await page.waitForTimeout(250);
      }
    },
    drags: async (n) => {
      for (let i = 0; i < n; i++) {
        const a = await point(0.3 + rand() * 0.4, 0.4 + rand() * 0.3);
        const b = await point(rand(), rand());
        if (touch) await touchDrag(a, b, 500);
        else {
          await page.mouse.move(a.x, a.y);
          await page.mouse.down();
          await page.mouse.move(b.x, b.y, { steps: 12 });
          await page.mouse.up();
        }
        await page.waitForTimeout(200);
      }
    },
    taps: async (n) => {
      for (let i = 0; i < n; i++) {
        await tapAt(await point(rand(), rand()));
        await page.waitForTimeout(200);
      }
    },
    holds: async () => {
      for (const fx of [0.15, 0.85, 0.15, 0.85]) {
        const p = await point(fx, 0.7);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y }] });
        await page.waitForTimeout(600);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await page.waitForTimeout(100);
      }
    },
    swipes: async () => {
      for (const [a, b] of [[[0.5, 0.5], [0.1, 0.5]], [[0.5, 0.5], [0.9, 0.5]], [[0.5, 0.6], [0.5, 0.2]], [[0.5, 0.4], [0.5, 0.8]]]) {
        await touchDrag(await point(...a), await point(...b), 250);
        await page.waitForTimeout(150);
      }
    },
  };

  // Start the game, or carry on after it stops: a button that says Play (or Retry…), a click on the game, Enter, Space.
  const start = async (why) => {
    const button = await page
      .evaluate((source) => {
        const re = new RegExp(source, 'i');
        const shown = (el) => {
          const r = el.getBoundingClientRect();
          return r.width > 4 && r.height > 4 && r.top < innerHeight && r.left < innerWidth && r.bottom > 0 && getComputedStyle(el).visibility !== 'hidden';
        };
        for (const el of document.querySelectorAll('button, [role=button], input[type=button], input[type=submit], a, div, span')) {
          const t = (el.innerText || el.value || '').trim().replace(/\s+/g, ' ');
          if (!t || t.length > 24 || !re.test(t) || !shown(el)) continue;
          if (el.tagName === 'A' && el.href && new URL(el.href, location.href).origin !== location.origin) continue; // never off the game's site
          if (el.children.length > 2) continue; // a container that merely holds the word
          const r = el.getBoundingClientRect();
          return { text: t, x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }
        return null;
      }, START.source)
      .catch(() => null);
    const did = [];
    if (button) {
      await tapAt(button);
      did.push(`pressed "${button.text}"`);
      await page.waitForTimeout(600);
    }
    await tapAt(await point(0.5, 0.5));
    did.push(touch ? 'tapped the game' : 'clicked the game');
    if (!touch) {
      await page.keyboard.press('Enter');
      await page.waitForTimeout(300);
      await page.keyboard.press('Space');
      did.push('pressed Enter and Space');
    }
    await page.waitForTimeout(800);
    log(`  ${why}: ${did.join(', ')}`);
    return did.join(', ');
  };

  // How much the screen changes by itself (an animated title screen changes a little): the bar for "an input did something".
  const idle = async () => {
    const a = await small();
    await page.waitForTimeout(700);
    return screenChange(a, await small()) ?? 0;
  };

  // One step: an input (or the AI's choice), with the screen watched while it runs, then the frames and memory.
  const step = async (input, run, extra = {}) => {
    const before = await small();
    const t = elapsed();
    await run();
    const after = await small();
    const change = screenChange(before, after);
    const stats = await page.evaluate(() => ({ frames: window.__GLITCHLESS_CHECK__?.take(), page: window.__GLITCHLESS_CHECK__?.read() })).catch(() => ({}));
    const label = extra.label || stats.page?.screen_labels?.[0] || null;
    const s = { t, input: input.name, words: input.words, change, frames: stats.frames || null, heap_mb: stats.page?.heap_mb ?? null, level: stats.page?.level ?? null, ...extra, label };
    steps.push(s);
    const screen = change == null ? 'unknown' : change < STILL ? 'still' : change < 0.4 ? 'moving' : 'new screen';
    await page.evaluate((a) => window.__GLITCHLESS_CHECK__?.step(a), { profile: profile.name, step: steps.length, input: input.words.slice(0, 48), screen, ...(label ? { label: String(label).slice(0, 40) } : {}) }).catch(() => {});
    return s;
  };

  // A step with no input at all, the same length as an input's: what the screen does by itself (an animated title,
  // enemies moving). An input "did something" when the screen changed clearly more than that.
  const rest = { name: 'idle', words: 'nothing (the bot waited)', run: () => page.waitForTimeout(3000) };
  let base = await idle();
  shots.push(await shot('loaded'));
  const started = await start('starting');
  notes.push(`To start, the bot ${started}.`);
  let calm = (await step(rest, rest.run)).change ?? 0;
  let still = 0;
  let next = 0;
  const end = t0 + seconds * 1000;
  let shotMid = false;

  while (Date.now() < end) {
    if (!shotMid && Date.now() > t0 + seconds * 500) {
      shots.push(await shot('playing'));
      shotMid = true;
    }
    let s;
    if (ai) {
      const choice = await ai.choose(page, { area: await area(), touch, recent: steps.slice(-3) }).catch((err) => {
        notes.push(`The AI player stopped (${err.message.split('\n')[0]}); the explorer carried on.`);
        return null;
      });
      if (!choice) {
        ai = null; // out of calls, or it failed: the explorer plays the rest
        continue;
      }
      s = await step({ name: 'ai', words: choice.words }, () => ai.act(page, choice, { point, touch, touchDrag }), { screen: choice.screen, kind: choice.kind, label: choice.label || null });
    } else {
      // First every input once, then mostly the ones that moved the screen most, and now and then the others again.
      const ranked = [...tried.entries()].sort((a, b) => b[1].change / Math.max(1, b[1].tries) - a[1].change / Math.max(1, a[1].tries));
      const untried = inputs.find((i) => !tried.get(i.name).tries);
      const pick = untried || (next++ % 4 === 3 ? inputs[Math.floor(rand() * inputs.length)] : inputs.find((i) => i.name === ranked[next % 2]?.[0]) || inputs[0]);
      s = await step(pick, () => pick.run(io));
      const st = tried.get(pick.name);
      st.tries++;
      st.change += s.change ?? 0;
      if ((s.change ?? 0) > calm * 1.3 + 0.002) st.moved++;
    }
    // The screen stopped changing: a game over, a menu, or a stall. Try to carry on, and say so.
    if ((s.change ?? 1) < STILL) still++;
    else still = 0;
    if (still >= 2) {
      s.carried_on = await start('the screen stopped changing');
      still = 0;
      calm = (await step(rest, rest.run)).change ?? calm;
    }
  }
  shots.push(await shot('end'));
  // The inputs that moved the screen more than waiting did, most first.
  const worked = [...tried.entries()].filter(([, st]) => st.moved).sort((a, b) => b[1].change / b[1].tries - a[1].change / a[1].tries).map(([name]) => inputs.find((i) => i.name === name).words);
  return { steps, notes, shots: shots.filter(Boolean), inputs: { tried: [...tried.entries()].filter(([, st]) => st.tries).map(([name]) => inputs.find((i) => i.name === name).words), worked }, idle_change: base, calm_change: calm, elapsed_s: elapsed() };
}

// ───────────────────────────── the AI player ─────────────────────────────

export const AI_MODEL = 'claude-haiku-5-5';

const AI_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['screen', 'kind', 'label', 'actions'],
  properties: {
    screen: { type: 'string', description: 'What is on screen now, in under 15 words' },
    kind: { type: 'string', enum: ['loading', 'title', 'menu', 'playing', 'paused', 'game_over', 'other'] },
    label: { type: 'string', description: 'The level, wave, stage or mode the screen shows (e.g. "Wave 3"), or ""' },
    actions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['do', 'key', 'ms', 'x', 'y', 'x2', 'y2'],
        properties: {
          do: { type: 'string', enum: ['press', 'hold', 'click', 'drag', 'wait'] },
          key: { type: 'string', description: 'For press and hold: ArrowLeft, ArrowRight, ArrowUp, ArrowDown, Space, Enter, Escape, Shift or one letter or digit; else ""' },
          ms: { type: 'integer', description: 'How long to hold or wait, 0 to 2000' },
          x: { type: 'number', description: 'Where to click or start a drag, 0 (left) to 1 (right) across the game' },
          y: { type: 'number', description: '0 (top) to 1 (bottom)' },
          x2: { type: 'number', description: 'Where a drag ends; else 0' },
          y2: { type: 'number' },
        },
      },
    },
  },
};

const KEYS = /^(Arrow(Up|Down|Left|Right)|Space|Enter|Escape|Shift|[a-z0-9])$/;

// Resolve the Anthropic SDK from the project first, then from here, as Playwright is (an optional peer dependency).
async function loadAnthropic(cwd = process.cwd()) {
  const unwrap = (mod) => mod?.default ?? mod;
  for (const from of [path.join(cwd, 'noop.js'), import.meta.url]) {
    try {
      const req = createRequire(from);
      return unwrap(await import(pathToFileURL(req.resolve('@anthropic-ai/sdk')).href));
    } catch {}
  }
  throw new Error('The AI player needs the Anthropic SDK: npm install @anthropic-ai/sdk (and ANTHROPIC_API_KEY set)');
}

// An AI player: a Claude model (Haiku by default, for cost) that sees the game every few seconds and picks the inputs.
// The key comes from the environment (ANTHROPIC_API_KEY, or an `ant auth login` profile) and is never printed.
export async function aiPlayer({ model = AI_MODEL, maxCalls = 40, cwd, client = null } = {}) {
  client ||= new (await loadAnthropic(cwd))();
  let calls = 0;
  return {
    model,
    get calls() {
      return calls;
    },
    async choose(page, { area, touch, recent }) {
      if (calls >= maxCalls) return null;
      calls++;
      const scale = Math.min(1, 768 / area.width);
      const jpeg = await page.screenshot({ type: 'jpeg', quality: 60, clip: area, scale: 'css' });
      const context = recent.map((s) => `t=${s.t}s ${s.screen ? `screen: ${s.screen}` : ''} did: ${s.words}${s.change != null ? ` (screen change ${s.change})` : ''}`).join('\n');
      const res = await client.messages.create({
        model,
        max_tokens: 1024,
        thinking: { type: 'disabled' },
        output_config: { effort: 'low', format: { type: 'json_schema', schema: AI_SCHEMA } },
        system:
          'You are playtesting a web game for its developer, to see how it runs. Play it like a new player would: get past menus and title screens, then keep playing and moving, and try what the game offers. ' +
          `The game is played with ${touch ? 'a touch screen (use click for a tap and drag for a swipe; no keys)' : 'a keyboard and mouse'}. ` +
          'Never buy anything, sign in, type personal details, open links or leave the game. Answer with what is on screen and up to 6 inputs for the next 3 seconds.',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpeg.toString('base64') } },
              { type: 'text', text: `The game's screen now (${Math.round(area.width * scale)} px wide).${context ? `\nThe last steps:\n${context}` : ''}` },
            ],
          },
        ],
      });
      if (res.stop_reason === 'refusal') throw new Error('the model declined to play this game');
      const text = res.content.find((b) => b.type === 'text')?.text;
      const out = JSON.parse(text);
      const actions = (out.actions || []).slice(0, 6).filter((a) => a.do !== 'press' && a.do !== 'hold' ? true : KEYS.test(normalKey(a.key)) && !touch);
      return { screen: String(out.screen || '').slice(0, 120), kind: out.kind, label: String(out.label || '').slice(0, 40), actions, words: describe(actions) };
    },
    async act(page, choice, { point, touch, touchDrag }) {
      for (const a of choice.actions) {
        const ms = Math.max(0, Math.min(2000, a.ms | 0));
        if (a.do === 'press') await page.keyboard.press(normalKey(a.key));
        else if (a.do === 'hold') {
          await page.keyboard.down(normalKey(a.key));
          await page.waitForTimeout(ms || 400);
          await page.keyboard.up(normalKey(a.key));
        } else if (a.do === 'click') {
          const p = await point(a.x, a.y);
          if (touch) await page.touchscreen.tap(p.x, p.y);
          else await page.mouse.click(p.x, p.y);
        } else if (a.do === 'drag') {
          const [p, q] = [await point(a.x, a.y), await point(a.x2, a.y2)];
          if (touch) await touchDrag(p, q, 400);
          else {
            await page.mouse.move(p.x, p.y);
            await page.mouse.down();
            await page.mouse.move(q.x, q.y, { steps: 10 });
            await page.mouse.up();
          }
        } else await page.waitForTimeout(Math.min(ms, 1500));
        await page.waitForTimeout(120);
      }
    },
  };
}

function normalKey(k) {
  const s = String(k || '').trim();
  if (/^space$/i.test(s) || s === ' ') return 'Space';
  if (/^(enter|return)$/i.test(s)) return 'Enter';
  if (/^(esc|escape)$/i.test(s)) return 'Escape';
  if (/^shift$/i.test(s)) return 'Shift';
  if (/^(left|right|up|down)$/i.test(s)) return `Arrow${s[0].toUpperCase()}${s.slice(1).toLowerCase()}`;
  if (/^arrow(up|down|left|right)$/i.test(s)) return `Arrow${s.slice(5, 6).toUpperCase()}${s.slice(6).toLowerCase()}`;
  return s.length === 1 ? s.toLowerCase() : s;
}

function describe(actions) {
  const words = actions.map((a) => (a.do === 'press' ? `pressed ${normalKey(a.key)}` : a.do === 'hold' ? `held ${normalKey(a.key)}` : a.do === 'click' ? 'clicked' : a.do === 'drag' ? 'dragged' : 'waited'));
  return [...new Set(words)].join(', ') || 'waited';
}
