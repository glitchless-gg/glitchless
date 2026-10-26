// Phaser adapter (Phaser 3.60+ and Phaser 4): times every game step from Phaser's own loop and splits it
// into update and render CPU time, counts WebGL draw calls, turns scenes into levels, reports failed
// loads, context loss and a game loop that stopped, and lets agents inspect the display lists.

import { SDK_VERSION } from './core.js';

// Phaser.Scenes constants, the same in Phaser 3 and 4.
const START = 2;
const PAUSED = 6;
const STATUS = ['pending', 'init', 'start', 'loading', 'creating', 'running', 'paused', 'sleeping', 'shutdown', 'destroyed'];
// Scene keys that are menus, loaders or overlays rather than levels: "Boot", "Preloader", "MainMenu",
// "UIScene", "HUD", "GameOver"… Matched on words, after splitting camelCase and underscores.
const NOT_A_LEVEL = /\b(boot|preload(er)?|load(er|ing)?|splash|intro|title|menu|main ?menu|ui|hud|overlay|pause[d]?|game ?over|settings|options|credits|leaderboard|shop)\b/i;
const GAUGE_EVERY = 30; // frames between gauge samples; hitches sample on the spot
const SPAWN_BURST = 50; // game objects added in one step that count as a spawn burst
const LOOP_STALL_MS = 2000;

export function instrumentPhaser(gd, { game, Phaser, levels = 'auto', gauges = true, countDrawCalls = true } = {}) {
  if (!gd || !game?.events) throw new Error('instrumentPhaser(glitchless, { game }): game is required');
  if (game.__glitchless) return gd.render;
  game.__glitchless = true;

  const P = Phaser || globalThis.Phaser;
  const version = P?.VERSION || null;
  gd.sdk = `glitchless-phaser/${SDK_VERSION}`;
  gd.engine = { name: 'phaser', version, renderer: null };
  gd.useFrameClock();

  const step = { start: 0, updateMs: 0, renderStart: 0, calls: 0, tris: 0, added: 0, textures: 0, sceneChanged: false };
  const draws = { calls: 0, tris: 0, linked: 0, programs: 0 };
  const hooked = new WeakSet();
  const loads = { inFlight: 0, count: 0, failed: 0, ms: 0, slowest: [] };
  let sceneCount = -1;
  let frame = 0;
  let lastStepAt = 0;
  let lastObjects = null;
  let manualLevels = false;
  let levelScene = null;
  let shot = null;
  let halted = false;
  let lastUncaught = null;

  // A level call from the game itself switches scene levels off: the game knows its levels better.
  const levelStart = gd.levelStart.bind(gd);
  gd.levelStart = (id, attrs) => {
    manualLevels = true;
    levelScene = null;
    return levelStart(id, attrs);
  };

  const levelOf = (scene) => {
    const key = scene?.sys?.settings?.key;
    if (key == null || levels === false) return null;
    if (typeof levels === 'function') return levels(scene) ?? null;
    if (Array.isArray(levels)) return levels.includes(key) ? key : null;
    const words = String(key).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z])([A-Z][a-z])/g, '$1 $2').replace(/[_\-.]+/g, ' ');
    return NOT_A_LEVEL.test(words) ? null : key;
  };

  const sceneStarted = (scene) => {
    step.sceneChanged = true;
    if (manualLevels) return;
    const name = levelOf(scene);
    if (name == null) return;
    levelScene = scene;
    levelStart(name); // a restart is a new attempt, like a level start in any other game
  };
  const sceneLeft = (scene) => {
    step.sceneChanged = true;
    if (!manualLevels && scene === levelScene) {
      levelScene = null;
      gd.level = null; // back in a menu: frames there have no level
    }
  };

  const hookScene = (scene) => {
    if (hooked.has(scene) || !scene?.sys?.events) return;
    hooked.add(scene);
    const ev = scene.sys.events;
    ev.on('start', () => sceneStarted(scene));
    ev.on('shutdown', () => sceneLeft(scene));
    ev.on('sleep', () => sceneLeft(scene));
    ev.on('destroy', () => sceneLeft(scene));
    ev.on('wake', () => {
      step.sceneChanged = true;
      const name = manualLevels ? null : levelOf(scene);
      if (name != null) {
        levelScene = scene;
        gd.level = String(name); // the same attempt carrying on, so no level_start
      }
    });
    ev.on('addedtoscene', () => step.added++);
    const load = scene.sys.load;
    if (load?.on) {
      let t0 = 0;
      load.on('start', () => {
        loads.inFlight++;
        t0 = performance.now();
      });
      load.on('loaderror', (file) => {
        loads.failed++;
        const src = String(file?.src || file?.url || '');
        gd.reportError({ kind: 'asset', message: `Failed to load ${file?.type || 'file'} "${file?.key}": ${basename(src) || 'unknown'}`, source: src || undefined, attrs: { scene: scene.sys.settings.key } });
      });
      load.on('complete', (loader, done, failed) => {
        loads.inFlight = Math.max(0, loads.inFlight - 1);
        const ms = Math.round(performance.now() - t0);
        loads.count += done || 0;
        loads.ms += ms;
        loads.slowest.push({ scene: scene.sys.settings.key, files: done || 0, ms });
        loads.slowest.sort((a, b) => b.ms - a.ms).splice(5);
        if (done || failed) gd.track('assets_loaded', { scene: scene.sys.settings.key, count: done || 0, failed: failed || 0, ms });
      });
    }
    // Scenes that were already running when the adapter arrived (it is usually installed right after
    // new Phaser.Game(), but may come later).
    const status = scene.sys.settings.status;
    if (status >= START && status <= PAUSED && !levelScene) sceneStarted(scene);
  };

  const hookScenes = () => {
    const list = game.scene?.scenes;
    if (!list || list.length === sceneCount) return;
    sceneCount = list.length;
    for (const scene of list) hookScene(scene);
  };

  const liveScenes = () => (game.scene?.scenes || []).filter((s) => {
    const st = s.sys?.settings?.status;
    return st >= START && st <= PAUSED;
  });

  // Counts that climb when something leaks or spawns too much. They go in ctx, where the findings
  // compare a slow level's gauges with the smoothest one's.
  const sampleGauges = () => {
    if (!gauges) return null;
    let objects = 0;
    let particles = 0;
    let bodies = 0;
    let tweens = 0;
    let listeners = listenerTotal(game.events);
    for (const s of liveScenes()) {
      objects += countObjects(s.children?.list);
      particles += countParticles(s.children?.list);
      const arcade = s.physics?.world;
      if (arcade?.bodies) bodies += (arcade.bodies.size ?? 0) + (arcade.staticBodies?.size ?? 0);
      const matter = s.matter?.world?.localWorld?.bodies;
      if (matter) bodies += matter.length;
      tweens += s.tweens?.getTweens?.().length ?? 0;
      listeners += listenerTotal(s.sys.events);
    }
    const values = { game_objects: objects, particles, physics_bodies: bodies, tweens, listeners, sounds: game.sound?.sounds?.length ?? 0 };
    gd.setContext(values);
    lastObjects = objects;
    return values;
  };

  const install = () => {
    const renderer = game.renderer;
    const gl = renderer?.gl || null;
    gd.engine.renderer = gl ? 'webgl' : renderer ? 'canvas' : 'headless';
    if (gl && countDrawCalls) watchGl(gl, draws);
    hookScenes();
    game.textures?.on?.('addtexture', () => step.textures++);
    const canvas = game.canvas;
    canvas?.addEventListener('webglcontextlost', () => {
      // Phaser calls preventDefault itself, so the context can come back.
      gd.reportError({ kind: 'webgl_context_lost', message: 'WebGL context lost', attrs: gd.render.memory() });
    });
    canvas?.addEventListener('webglcontextrestored', () => gd.track('webgl_context_restored'));

    game.events.on('prestep', (time) => {
      lastStepAt = performance.now();
      halted = false;
      gd.tick(time); // times the step before this one, with the stats it left behind
      frame++;
      hookScenes();
      if (frame % GAUGE_EVERY === 0) sampleGauges();
      step.start = performance.now();
      step.added = 0;
      step.textures = 0;
      step.sceneChanged = false;
      draws.calls = 0;
      draws.tris = 0;
      draws.linked = 0;
    });
    game.events.on('poststep', () => {
      step.updateMs = performance.now() - step.start;
    });
    game.events.on('prerender', () => {
      step.renderStart = performance.now();
    });
    game.events.on('postrender', (r) => {
      const ms = performance.now() - (step.renderStart || performance.now());
      const calls = gl ? draws.calls : r?.drawCount ?? 0;
      step.calls = calls;
      step.tris = draws.tris;
      step.linked = draws.linked;
      gd.onRender(ms, calls, draws.tris, step.updateMs);
      step.renderMs = ms;
      if (shot) {
        const done = shot;
        shot = null;
        done(copyCanvas(game.canvas, done.maxWidth));
      }
    });
    // Time spent paused or in a background tab is not a frame.
    for (const name of ['pause', 'resume', 'hidden', 'visible']) game.events.on(name, () => gd.skipFrame());
  };

  // An uncaught error inside Phaser's update or render stops its requestAnimationFrame loop for good:
  // the screen freezes and the player can only leave. Report that as its own crash.
  if (typeof window !== 'undefined') {
    window.addEventListener('error', (e) => {
      lastUncaught = { message: String(e.error?.message ?? e.message ?? 'Unknown error').slice(0, 200), name: e.error?.name, stack: e.error?.stack, source: e.filename, line: e.lineno, col: e.colno };
    });
    const watch = setInterval(() => {
      if (game.pendingDestroy || game.isDestroyed) return clearInterval(watch);
      if (halted || !lastStepAt || !lastUncaught || document.hidden || game.isPaused || !game.loop?.running) return;
      if (performance.now() - lastStepAt < LOOP_STALL_MS) return;
      halted = true;
      const cause = lastUncaught.name ? `${lastUncaught.name}: ${lastUncaught.message}` : lastUncaught.message;
      // The original error's stack, so this points at the same line.
      const { stack, source, line, col } = lastUncaught;
      gd.reportError({ kind: 'game_loop_stopped', message: `Phaser's game loop stopped after an uncaught error: ${cause}`, error: stack ? { stack } : null, source, line, col, attrs: { stalled_ms: Math.round(performance.now() - lastStepAt) } });
      gd.flush();
    }, 1000);
    watch.unref?.(); // Node (tests): don't keep the process alive
  }

  if (game.isBooted) install();
  else game.events.once('ready', install);

  gd.render = {
    game,
    engine: 'phaser',
    get gl() {
      return game.renderer?.gl || null;
    },
    memory() {
      const list = game.textures?.list;
      return { geometries: null, textures: list ? Object.keys(list).length : null, programs: game.renderer?.gl && countDrawCalls ? draws.programs : null, game_objects: lastObjects };
    },
    assetsInFlight: () => loads.inFlight,
    assetStats: () => (loads.count ? { count: loads.count, failed: loads.failed, ms: loads.ms, slowest: loads.slowest } : null),
    // What the step that just ended did: called when its frame turns out to be a hitch.
    hitchDetail(dt) {
      const share = Math.max(16, dt * 0.4);
      const causes = [];
      if (step.linked > 0) causes.push('shader_compile');
      if (step.sceneChanged) causes.push('scene_change');
      if (step.added >= SPAWN_BURST) causes.push('object_spawn');
      if (step.textures > 0) causes.push('texture_upload');
      if (step.updateMs >= share) causes.push('script');
      if ((step.renderMs || 0) >= share) causes.push('render');
      sampleGauges();
      return {
        causes,
        fields: { process_ms: round1(step.updateMs), render_ms: round1(step.renderMs), objects_added: step.added, textures_added: step.textures, programs_linked: step.linked },
      };
    },
    inspectScene: (opts) => inspectPhaser(game, { ...opts, version }),
    captureMap: () => {
      gd.log('captureMap is not available for Phaser yet; heatmaps draw without a level picture');
      return null;
    },
    // The drawing buffer is only readable right after Phaser renders, so wait for the next frame.
    screenshot: ({ maxWidth = 960 } = {}) =>
      new Promise((resolve) => {
        const done = (img) => {
          clearTimeout(timer);
          resolve(img);
        };
        done.maxWidth = maxWidth;
        shot = done;
        const timer = setTimeout(() => {
          shot = null;
          resolve(copyCanvas(game.canvas, maxWidth)); // the loop isn't running: take what's there
        }, 1000);
      }),
  };
  return gd.render;
}

// What an agent needs to spot "900 Image objects nobody destroys" or "the update listener added on
// every restart": per live scene, the display list by type and texture, physics bodies, tweens and
// event listeners.
export function inspectPhaser(game, { top = 10, version = globalThis.Phaser?.VERSION ?? null } = {}) {
  if (!game?.scene) return null;
  const groups = new Map();
  const scenes = [];
  for (const scene of game.scene.scenes || []) {
    const st = scene.sys?.settings?.status;
    if (!(st >= START && st <= PAUSED)) continue;
    const byType = {};
    let objects = 0;
    let visible = 0;
    walk(scene.children?.list, (o) => {
      objects++;
      if (o.visible !== false) visible++;
      byType[o.type] = (byType[o.type] || 0) + 1;
      const texture = o.texture?.key && o.texture.key !== '__DEFAULT' ? o.texture.key : null;
      const key = `${scene.sys.settings.key}|${o.type}|${texture ?? ''}`;
      const g = groups.get(key) || { scene: scene.sys.settings.key, type: o.type, texture, count: 0, visible: 0, active: 0 };
      g.count++;
      if (o.visible !== false) g.visible++;
      if (o.active !== false) g.active++;
      groups.set(key, g);
    });
    const arcade = scene.physics?.world;
    const busyEvents = busiest(scene.sys.events);
    scenes.push({
      key: scene.sys.settings.key,
      status: STATUS[st] || String(st),
      objects,
      visible,
      update_list: scene.sys.updateList?.length ?? scene.sys.updateList?.getActive?.().length ?? null,
      by_type: byType,
      physics_bodies: arcade?.bodies ? (arcade.bodies.size ?? 0) + (arcade.staticBodies?.size ?? 0) : scene.matter?.world?.localWorld?.bodies?.length ?? null,
      tweens: scene.tweens?.getTweens?.().length ?? null,
      particles: countParticles(scene.children?.list),
      listeners: listenerTotal(scene.sys.events),
      // The same handler added on every restart piles up here: scene events outlive shutdown.
      busiest_events: busyEvents,
    });
  }
  const textures = game.textures?.list ? Object.keys(game.textures.list).filter((k) => !k.startsWith('__')) : [];
  return {
    phaser: version,
    renderer: game.renderer?.gl ? 'webgl' : game.renderer ? 'canvas' : 'headless',
    fps_target: game.loop?.targetFps ?? null,
    fps_actual: game.loop?.actualFps ? Math.round(game.loop.actualFps) : null,
    scenes,
    textures: textures.length,
    sounds: game.sound?.sounds?.length ?? null,
    game_listeners: listenerTotal(game.events),
    top_groups: [...groups.values()]
      .map((g) => ({
        ...g,
        // Many objects of one kind, most of them hidden or inactive: dead objects kept around instead of
        // destroyed or recycled through a Group pool.
        pool_candidate: g.count >= 50 && g.visible < g.count * 0.5,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, top),
  };
}

// Counts draw calls, triangles and shader programs by wrapping the context's functions: Phaser keeps
// no counters. A program linked mid-game is a shader compile, a common cause of a first-use stutter.
function watchGl(gl, out) {
  const tris = (mode, count, instances = 1) => (mode === gl.TRIANGLES ? Math.floor(count / 3) : mode === gl.TRIANGLE_STRIP || mode === gl.TRIANGLE_FAN ? Math.max(0, count - 2) : 0) * instances;
  const wrap = (name, triangles) => {
    const original = gl[name];
    if (typeof original !== 'function' || original.__glitchless) return;
    const counted = function (...args) {
      out.calls++;
      out.tris += triangles(...args);
      return original.apply(this, args);
    };
    counted.__glitchless = true;
    gl[name] = counted;
  };
  wrap('drawArrays', (mode, first, count) => tris(mode, count));
  wrap('drawElements', (mode, count) => tris(mode, count));
  wrap('drawArraysInstanced', (mode, first, count, n) => tris(mode, count, n));
  wrap('drawElementsInstanced', (mode, count, type, offset, n) => tris(mode, count, n));
  wrap('drawRangeElements', (mode, start, end, count) => tris(mode, count));
  const link = gl.linkProgram;
  if (typeof link === 'function' && !link.__glitchless) {
    gl.linkProgram = function (...args) {
      out.linked++;
      out.programs++;
      return link.apply(this, args);
    };
    gl.linkProgram.__glitchless = true;
  }
  const remove = gl.deleteProgram;
  if (typeof remove === 'function' && !remove.__glitchless) {
    gl.deleteProgram = function (program, ...rest) {
      if (program) out.programs = Math.max(0, out.programs - 1);
      return remove.call(this, program, ...rest);
    };
    gl.deleteProgram.__glitchless = true;
  }
}

function walk(list, fn, depth = 0) {
  if (!list || depth > 8) return;
  for (const o of list) {
    fn(o);
    if (Array.isArray(o.list)) walk(o.list, fn, depth + 1); // a Container's children
  }
}

function countObjects(list) {
  let n = 0;
  walk(list, () => n++);
  return n;
}

function countParticles(list) {
  let n = 0;
  walk(list, (o) => {
    if (typeof o.getAliveParticleCount === 'function') n += o.getAliveParticleCount();
  });
  return n;
}

function listenerTotal(emitter) {
  if (!emitter?.eventNames) return 0;
  let n = 0;
  for (const name of emitter.eventNames()) n += emitter.listenerCount(name);
  return n;
}

function busiest(emitter, top = 5) {
  if (!emitter?.eventNames) return [];
  return emitter
    .eventNames()
    .map((name) => ({ event: String(name), listeners: emitter.listenerCount(name) }))
    .filter((e) => e.listeners > 1)
    .sort((a, b) => b.listeners - a.listeners)
    .slice(0, top);
}

function copyCanvas(src, maxWidth = 960) {
  if (!src?.width) return null;
  const scale = Math.min(1, maxWidth / src.width);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(src.width * scale);
  canvas.height = Math.round(src.height * scale);
  canvas.getContext('2d').drawImage(src, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.8);
}

function basename(url) {
  return String(url).split(/[?#]/)[0].split('/').pop();
}

function round1(v) {
  return v == null ? null : Math.round(v * 10) / 10;
}
