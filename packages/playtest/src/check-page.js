// What a game check adds to the page it plays, before any of the game's own scripts run (Playwright's addInitScript):
// the Glitchless browser SDK, started for the check's game as a synthetic session, and a watch on what the page is
// made of: its engine, its canvases, its draw calls and the words on its screens. The bot (check-bot.js) and the
// report read the watch from window.__GLITCHLESS_CHECK__. Nothing here changes how the game runs, except that an
// engine the SDK has an adapter for (Three.js, Phaser, Babylon.js, PlayCanvas) is handed to it, as if the game had
// Glitchless installed with its defaults.

// The script, as one string: the SDK's <script> build (window.Glitchless), then the watch, called with `init`
// ({ glitchless: options for Glitchless.init, adapters: false to leave engines alone }).
export function checkInitScript({ sdk, init }) {
  return `${sdk}\n;(${pageWatch.toString()})(${JSON.stringify(init)});`;
}

// Runs in the page. Kept free of anything outside itself: it is sent as source.
function pageWatch(init) {
  // Only the page the check opened: an ad's or a video's frame inside it is not the game.
  if (window.top !== window || window.__GLITCHLESS_CHECK__) return;
  const W = (window.__GLITCHLESS_CHECK__ = { contexts: [], draws: 0, adapters: [], adapterErrors: [], three: { renderers: [], scenes: [], revision: null }, dts: [], labels: {}, buttons: {}, started: performance.now() });
  let gd = null;
  try {
    gd = window.Glitchless.init(init.glitchless);
  } catch (err) {
    W.initError = String(err?.message || err);
  }

  // Canvases as the game makes them: which kind of drawing each one does (webgl2, webgl, 2d, webgpu).
  const canvases = [];
  const getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, attrs) {
    const ctx = getContext.call(this, type, attrs);
    if (ctx && !canvases.some((c) => c.canvas === this)) canvases.push({ canvas: this, type: String(type).toLowerCase() });
    return ctx;
  };
  // Draw calls on any WebGL context, counted per frame below (an engine adapter counts its own too).
  for (const C of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
    if (!C) continue;
    for (const name of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'drawRangeElements']) {
      const fn = C.prototype[name];
      if (typeof fn !== 'function') continue;
      C.prototype[name] = function () {
        W.draws++;
        return fn.apply(this, arguments);
      };
    }
  }
  // WebGPU, where the game asks for it.
  if (navigator.gpu?.requestAdapter) {
    const request = navigator.gpu.requestAdapter.bind(navigator.gpu);
    navigator.gpu.requestAdapter = (...a) => {
      W.webgpu = true;
      return request(...a);
    };
  }

  // Frame times and draw calls per frame on the check's own clock, which the bot reads and clears every step.
  let last = 0;
  let drawsAt = 0;
  W.drawFrames = [];
  const raf = (now) => {
    if (last && !document.hidden) {
      W.dts.push(now - last);
      if (W.dts.length > 4000) W.dts.splice(0, 2000);
      W.drawFrames.push(W.draws - drawsAt);
      if (W.drawFrames.length > 4000) W.drawFrames.splice(0, 2000);
    }
    drawsAt = W.draws;
    last = now;
    requestAnimationFrame(raf);
  };
  requestAnimationFrame(raf);

  // Three.js tells devtools about each renderer and scene it makes, bundled or not: listen as devtools would.
  const devtools = window.__THREE_DEVTOOLS__ instanceof EventTarget ? window.__THREE_DEVTOOLS__ : new EventTarget();
  if (!window.__THREE_DEVTOOLS__) window.__THREE_DEVTOOLS__ = devtools;
  devtools.addEventListener('register', (e) => (W.three.revision = e.detail?.revision ?? W.three.revision));
  devtools.addEventListener('observe', (e) => {
    const o = e.detail;
    if (o?.isScene) W.three.scenes.push(o);
    else if (o && typeof o.render === 'function' && o.domElement) W.three.renderers.push(o);
    attach();
  });

  // Phaser makes its game with new Phaser.Game(config): wrap the constructor as Phaser arrives, to hand the game over.
  let phaser = window.Phaser;
  const wrapPhaser = (P) => {
    if (!P?.Game || P.Game.__glitchlessCheck) return;
    try {
      const Game = P.Game;
      const wrapped = new Proxy(Game, {
        construct(target, args, newTarget) {
          const game = Reflect.construct(target, args, newTarget === wrapped ? target : newTarget);
          W.phaserGame = game;
          attach();
          return game;
        },
      });
      wrapped.__glitchlessCheck = true;
      P.Game = wrapped;
    } catch {}
  };
  try {
    Object.defineProperty(window, 'Phaser', {
      configurable: true,
      enumerable: true,
      get: () => phaser,
      set: (v) => {
        phaser = v;
        wrapPhaser(v);
      },
    });
  } catch {}

  const adapt = (name, fn) => {
    if (init.adapters === false || !gd || W.adapters.includes(name)) return;
    try {
      fn();
      W.adapters.push(name);
    } catch (err) {
      W.adapterErrors.push(`${name}: ${String(err?.message || err).slice(0, 160)}`);
    }
  };
  function attach() {
    const G = window.Glitchless;
    if (W.three.renderers.length) adapt('three', () => G.instrumentThree(gd, { renderer: W.three.renderers[0], scene: W.three.scenes[0] }));
    const game = W.phaserGame || (window.game?.scene && window.game?.events ? window.game : null);
    if (game) adapt('phaser', () => G.instrumentPhaser(gd, { game, Phaser: phaser }));
    const B = window.BABYLON;
    const engine = B?.EngineStore?.Instances?.[0] || B?.Engine?.Instances?.[0];
    if (engine?.scenes?.length) adapt('babylon', () => G.instrumentBabylon(gd, { engine, scene: engine.scenes[0], BABYLON: B }));
    const pc = window.pc;
    const app = pc?.app || pc?.Application?.getApplication?.() || pc?.AppBase?.getApplication?.();
    if (app?.graphicsDevice) adapt('playcanvas', () => G.instrumentPlayCanvas(gd, { app, pc }));
  }
  // Babylon.js and PlayCanvas are found once the game has made its engine: look a few times while it loads.
  let looks = 0;
  const look = setInterval(() => {
    attach();
    if (++looks >= 30) clearInterval(look);
  }, 1000);

  // What the page is, read when the bot asks: the engine (by what each leaves on the page), the canvas it draws on,
  // and the words on its screens (levels and waves, the buttons it offers).
  W.read = () => {
    const engines = [];
    const add = (name, version) => engines.push({ name, version: version == null ? null : String(version) });
    // A global by name, a page's top-level const too (Godot's GODOT_CONFIG): indirect eval reads the global scope.
    const global = (name) => {
      try {
        return (0, eval)(`typeof ${name} === 'undefined' ? undefined : ${name}`);
      } catch {
        return undefined;
      }
    };
    const has = (name) => global(name) !== undefined;
    const scripts = [...document.scripts].map((s) => s.src || '').join(' ');
    if (W.three.revision || window.__THREE__ || W.three.renderers.length) add('three', W.three.revision || window.__THREE__ || null);
    if (phaser?.VERSION) add('phaser', phaser.VERSION);
    if (window.BABYLON) add('babylon', window.BABYLON.Engine?.Version);
    if (window.pc?.Application || window.pc?.AppBase) add('playcanvas', window.pc.version);
    if (has('createUnityInstance') || window.unityInstance || has('UnityLoader') || /\.loader\.js|UnityLoader\.js|\.framework\.js/.test(scripts) || document.querySelector('#unity-canvas, #unity-container')) add('unity', window.unityInstance?.Module?.unityVersion);
    if (has('GODOT_CONFIG') || typeof global('Engine')?.isWebGLAvailable === 'function') add('godot', null);
    if (has('GameMaker_Init') || /game\.js.*html5game|html5game\//.test(scripts)) add('gamemaker', null);
    if (window.C3_RuntimeInterface || has('cr_getC2Runtime') || /c3runtime|c2runtime/.test(scripts)) add('construct', null);
    if (window.gdjs) add('gdevelop', null);
    if (has('EngineLoader') || /dmloader\.js/.test(scripts)) add('defold', null);
    if (window.PIXI || window.__PIXI_APP__) add('pixi', window.PIXI?.VERSION);
    if (window.pico8_buttons) add('pico-8', null);
    if (window.kaplay || window.kaboom) add('kaplay', null);
    if (window.Utils?.RPGMAKER_NAME) add(`rpg maker ${window.Utils.RPGMAKER_NAME}`, window.Utils.RPGMAKER_VERSION);
    if (window.RufflePlayer) add('ruffle', null);
    if (!engines.length && window.Module?.HEAPU8) add('emscripten', null);

    const visible = (el) => {
      const r = el.getBoundingClientRect();
      return r.width > 2 && r.height > 2 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth && getComputedStyle(el).visibility !== 'hidden';
    };
    const area = (el) => {
      const r = el.getBoundingClientRect();
      return Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
    };
    const shown = canvases.filter((c) => document.contains(c.canvas) && visible(c.canvas)).sort((a, b) => area(b.canvas) - area(a.canvas));
    const main = shown[0];
    const rect = main ? main.canvas.getBoundingClientRect() : null;
    const frames = [...document.querySelectorAll('iframe')].filter(visible).sort((a, b) => area(b) - area(a));
    const frame = frames[0] && area(frames[0]) > innerWidth * innerHeight * 0.25 ? frames[0] : null;

    // Words on the screen: levels, waves and the like the game writes in its page, and the buttons it offers.
    const text = (document.body?.innerText || '').slice(0, 20000);
    const now = [];
    for (const m of text.matchAll(/\b(level|lvl|wave|stage|round|world|floor|day|chapter|act|zone|room)\s*:?\s*(\d{1,3})\b/gi)) {
      const label = `${m[1][0].toUpperCase()}${m[1].slice(1).toLowerCase()} ${m[2]}`;
      W.labels[label] = (W.labels[label] || 0) + 1;
      if (!now.includes(label)) now.push(label);
    }
    for (const b of document.querySelectorAll('button, [role=button], input[type=button], input[type=submit], a')) {
      const t = (b.innerText || b.value || '').trim().replace(/\s+/g, ' ');
      if (t && t.length <= 32 && visible(b)) W.buttons[t] = (W.buttons[t] || 0) + 1;
    }
    return {
      title: document.title || null,
      engines,
      adapters: W.adapters,
      adapter_errors: W.adapterErrors,
      init_error: W.initError || null,
      contexts: [...new Set(canvases.filter((c) => document.contains(c.canvas)).map((c) => c.type))],
      webgpu: !!W.webgpu,
      canvas: main ? { type: main.type, x: rect.left, y: rect.top, width: rect.width, height: rect.height, pixels: [main.canvas.width, main.canvas.height] } : null,
      frame: frame && !main ? { src: frame.src, ...JSON.parse(JSON.stringify(frame.getBoundingClientRect())) } : null,
      labels: W.labels,
      screen_labels: now,
      buttons: W.buttons,
      heap_mb: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
      session: gd?.sessionId || null,
      level: gd?.level ?? null,
      sdk_engine: gd?.engine?.name || null,
      sent: gd?.stats?.sent ?? 0,
      failed: gd?.stats?.failed ?? 0,
    };
  };

  // Just the rectangle of the canvas the game draws on (the largest one shown), for the bot's clicks and screenshots:
  // cheap enough to ask for between inputs, unlike read().
  W.area = () => {
    let best = null;
    let size = 0;
    for (const c of canvases) {
      if (!c.canvas.isConnected) continue;
      const r = c.canvas.getBoundingClientRect();
      const a = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
      if (a > size) [best, size] = [r, a];
    }
    return best ? { x: best.left, y: best.top, width: best.width, height: best.height } : null;
  };

  // Frames since the last step, for the bot's timeline: { n, late, p50, p95, max, draws } (ms; draw calls a frame).
  // Late, as Glitchless counts it: over 1.15× the frame budget the SDK found for this screen (60, 120 Hz…).
  W.take = () => {
    const xs = W.dts.splice(0).sort((a, b) => a - b);
    const draws = W.drawFrames.splice(0);
    const budget = gd?.budgetMs || 1000 / 60;
    const q = (p) => (xs.length ? Math.round(xs[Math.min(xs.length - 1, Math.floor(p * xs.length))] * 10) / 10 : null);
    const drawn = draws.filter((d) => d > 0);
    return { n: xs.length, late: xs.filter((x) => x > budget * 1.15).length, p50: q(0.5), p95: q(0.95), max: xs.length ? Math.round(xs[xs.length - 1]) : null, draws: drawn.length ? Math.round(drawn.reduce((a, b) => a + b, 0) / drawn.length) : null };
  };

  // What the bot did, on the check's own board ("What the bot did"): a few events a run, never per input.
  W.step = (attrs) => {
    try {
      gd?.track('glitchless_check', attrs);
    } catch {}
  };
}
