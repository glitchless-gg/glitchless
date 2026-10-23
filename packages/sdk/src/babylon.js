// Babylon.js adapter (Babylon.js 5 and later, WebGL or WebGPU): times every frame from the engine's own loop and
// splits it into update and render CPU time, reads Babylon's own counters (draw calls, active indices, shader
// compiles, GPU frame time), turns scenes into levels when the game names them, reports context loss, shader errors,
// failed texture loads and a render loop that stopped, and lets agents inspect the scene.

import { SDK_VERSION } from './core.js';
import { watchGl } from './three.js';
import { TEXTURE_BURST, TEXTURE_PIXELS, BUFFER_BURST, BUFFER_BYTES, SPAWN_BURST, GAUGE_EVERY, copyCanvas, mapJpeg, nextFrameShot, watchLoopStop, recentTimes, basename, round1 } from './adapters.js';

export function instrumentBabylon(gd, { engine, scene, BABYLON, levels = 'auto', gauges = true, gpuTime = true } = {}) {
  engine = engine || scene?.getEngine?.();
  if (!gd || !engine?.onBeginFrameObservable) throw new Error('instrumentBabylon(glitchless, { engine, scene }): engine is required');
  if (engine.__glitchless) return gd.render;
  engine.__glitchless = true;

  const B = BABYLON || globalThis.BABYLON || null;
  const version = engine.constructor?.Version ?? B?.Engine?.Version ?? null;
  const gl = engine._gl || null;
  const renderer = engine.isWebGPU ? 'webgpu' : gl ? 'webgl' : 'headless';
  gd.sdk = `glitchless-babylon/${SDK_VERSION}`;
  gd.engine = { name: 'babylon', version, renderer };
  gd.useFrameClock();

  // The frame being drawn, and the one before it (what hitchDetail reads).
  const frame = newFrame();
  const done = newFrame();
  const hooked = new WeakSet();
  const rendered = new WeakSet();
  const levelNames = new WeakMap();
  const textures = new Set(); // textures still loading, checked for failures with the gauges
  const work = gl ? watchGl(gl, gd) : null;
  let frameNo = 0;
  let lastFrameAt = 0;
  let renderStart = null;
  let compileStart = 0;
  let manualLevels = false;
  let loadNext = false;
  let levelScene = null;
  let shot = null;
  const compiles = recentTimes();

  const live = () => (engine.scenes || []).filter((s) => !s.isDisposed);
  const main = () => (scene && !scene.isDisposed ? scene : live().at(-1) || null);

  // A level call from the game itself switches scene levels off: the game knows its levels better. The frames that
  // build and first draw the level are its load, not play.
  const levelStart = gd.levelStart.bind(gd);
  gd.levelStart = (id) => {
    manualLevels = true;
    levelScene = null;
    frame.sceneChanged = loadNext = true;
    return levelStart(id);
  };

  // A scene is a level when the game names it: scene.metadata.level (read whenever the scene renders, so setting it
  // again starts the next level), or what the `levels` function returns for it (asked once per scene).
  const levelOf = (s) => {
    if (typeof levels !== 'function') return s?.metadata?.level ?? null;
    if (!levelNames.has(s)) levelNames.set(s, levels(s) ?? null);
    return levelNames.get(s);
  };
  const checkLevel = (s) => {
    if (manualLevels || levels === false) return;
    const name = levelOf(s);
    if (name == null || (s === levelScene && String(name) === gd.level)) return;
    levelScene = s;
    frame.sceneChanged = true;
    levelStart(String(name)); // a new scene for the same level is a new attempt
  };
  const sceneLeft = (s) => {
    frame.sceneChanged = true;
    if (!manualLevels && s === levelScene) {
      levelScene = null;
      gd.level = null; // back in a menu: frames there have no level
    }
  };

  const hookScene = (s) => {
    if (!s || hooked.has(s)) return;
    hooked.add(s);
    frame.sceneChanged = true;
    s.onBeforeAnimationsObservable?.add(() => {
      renderStart = null;
      if (!rendered.has(s)) {
        rendered.add(s);
        frame.sceneChanged = true; // a scene's first frame compiles and uploads what it shows
      }
      checkLevel(s);
    });
    // Game code (before-render observers, animations, physics) runs before the render targets; drawing after.
    s.onBeforeRenderTargetsRenderObservable?.add(() => {
      if (renderStart == null) renderStart = performance.now();
    });
    s.onAfterRenderObservable?.add(() => {
      if (renderStart != null) frame.renderMs += performance.now() - renderStart;
      renderStart = null;
      frame.tris += (s.getActiveIndices?.() || 0) / 3;
    });
    // Babylon announces a new texture before it has its URL: it is checked for a failed load later.
    s.onNewTextureAddedObservable?.add((t) => {
      if (t && textures.size < 500) textures.add(t);
    });
    s.onDisposeObservable?.add(() => sceneLeft(s));
  };

  // Counts that climb when something leaks or spawns too much. They go in ctx, where the findings compare a slow
  // level's gauges with the smoothest one's.
  const sampleGauges = () => {
    checkTextures();
    if (!gauges) return null;
    let meshes = 0;
    let active = 0;
    let materials = 0;
    let tex = 0;
    let particles = 0;
    let observers = 0;
    for (const s of live()) {
      meshes += s.meshes?.length ?? 0;
      active += s.getActiveMeshes?.().length ?? 0;
      materials += s.materials?.length ?? 0;
      tex += s.textures?.length ?? 0;
      for (const ps of s.particleSystems || []) particles += ps.getActiveCount?.() ?? 0;
      observers += (s.onBeforeRenderObservable?.observers?.length ?? 0) + (s.onAfterRenderObservable?.observers?.length ?? 0);
    }
    const values = { meshes, active_meshes: active, materials, textures: tex, particles, render_observers: observers };
    gd.setContext(values);
    return values;
  };

  // Babylon keeps a texture's load failure on the texture: look at the ones that were loading.
  const checkTextures = () => {
    for (const t of textures) {
      if (!t.url) textures.delete(t); // made in code (a DynamicTexture, a render target): nothing to load
      else if (t.loadingError) {
        textures.delete(t);
        const url = String(t.url || '');
        const file = basename(url) || 'unknown';
        gd.reportError({ kind: 'asset', message: t.name && t.name !== t.url ? `Failed to load texture "${t.name}": ${file}` : `Failed to load texture: ${file}`, source: url || undefined, attrs: { error: t.errorObject?.message ? String(t.errorObject.message).slice(0, 200) : null } });
      } else if (t.isDisposed?.() || t.isReady?.()) textures.delete(t);
    }
  };

  // Meshes, materials and textures added in a frame, from the scenes' own lists (Babylon 9 announces a new mesh only
  // after the frame): the totals at the start of each frame, and what they grew by since the last.
  const totals = { meshes: 0, materials: 0, textures: 0 };
  const count = () => {
    totals.meshes = totals.materials = totals.textures = 0;
    for (const s of engine.scenes || []) {
      totals.meshes += s.meshes?.length ?? 0;
      totals.materials += s.materials?.length ?? 0;
      totals.textures += s.textures?.length ?? 0;
    }
  };
  const drawCount = () => engine._drawCalls?.current ?? 0;
  const gpuCounter = () => {
    const ns = engine.getGPUFrameTimeCounter?.()?.current;
    return ns > 0 ? ns / 1e6 : null;
  };
  if (gpuTime && typeof engine.captureGPUFrameTime === 'function' && engine.getCaps?.()?.timerQuery) {
    try {
      engine.captureGPUFrameTime(true);
    } catch {
      // no timer queries here: frames still have CPU times
    }
  }

  // A frame runs from one begin to the next, so it owns the work Babylon does just after drawing: Babylon 9 processes a
  // new shader's source in the render and compiles it in a promise once the frame has ended.
  engine.onBeginFrameObservable.add(
    () => {
      const now = performance.now();
      lastFrameAt = now;
      count();
      if (frameNo) {
        frame.added = Math.max(0, totals.meshes - frame.meshes0);
        frame.materials = Math.max(0, totals.materials - frame.materials0);
        frame.textures = Math.max(0, totals.textures - frame.textures0);
        Object.assign(done, frame);
      }
      gd.tick(now); // times the frame before this one, with the stats it left behind
      frameNo++;
      if (frameNo % GAUGE_EVERY === 0) sampleGauges();
      Object.assign(frame, FRESH);
      frame.start = now;
      frame.draws0 = drawCount();
      frame.meshes0 = totals.meshes;
      frame.materials0 = totals.materials;
      frame.textures0 = totals.textures;
      frame.sceneChanged = loadNext;
      loadNext = false;
    },
    undefined,
    true, // before Babylon's own observers (the GPU timer), so they count as the frame's work
  );
  engine.onEndFrameObservable.add(() => {
    const cpu = performance.now() - frame.start;
    const now = drawCount();
    const draws = now >= frame.draws0 ? now - frame.draws0 : now; // a SceneInstrumentation resets the counter
    frame.updateMs = Math.max(0, cpu - frame.renderMs);
    frame.draws = draws;
    frame.gpuMs = gpuCounter();
    gd.onRender(frame.renderMs, draws, Math.round(frame.tris), frame.updateMs);
    if (shot) {
      const take = shot;
      shot = null;
      take(copyCanvas(engine.getRenderingCanvas?.(), take.maxWidth));
    }
  });
  engine.onBeforeShaderCompilationObservable?.add(() => (compileStart = performance.now()));
  engine.onAfterShaderCompilationObservable?.add(() => {
    const now = performance.now();
    frame.compiles++;
    frame.compileMs += now - compileStart;
    compiles.add(now);
  });
  engine.onNewSceneAddedObservable?.add(hookScene);
  for (const s of engine.scenes || []) hookScene(s);
  if (scene) hookScene(scene);

  // A loop started again after stopRenderLoop(): the time it was stopped is not a frame.
  const run = engine.runRenderLoop;
  if (typeof run === 'function') {
    engine.runRenderLoop = function (...args) {
      if (!this._activeRenderLoops?.length) gd.skipFrame();
      return run.apply(this, args);
    };
  }

  engine.onEffectErrorObservable?.add((e) => {
    gd.reportError({ kind: 'shader', message: `Shader failed to compile: ${effectName(e?.effect)}`, attrs: { errors: String(e?.errors ?? '').slice(0, 300) } });
  });
  // Babylon calls preventDefault on the canvas event itself, so the context can come back.
  engine.onContextLostObservable?.add(() => {
    gd.reportError({ kind: 'webgl_context_lost', message: engine.isWebGPU ? 'WebGPU device lost' : 'WebGL context lost', attrs: gd.render.memory() });
  });
  engine.onContextRestoredObservable?.add(() => gd.track(engine.isWebGPU ? 'webgpu_device_restored' : 'webgl_context_restored'));
  watchLoopStop(gd, { engineName: 'Babylon.js', lastFrameAt: () => lastFrameAt, running: () => !engine.isDisposed && (engine._activeRenderLoops?.length ?? 1) > 0 });

  gd.render = {
    engine,
    get scene() {
      return main();
    },
    BABYLON: B,
    gl,
    memory() {
      let geometries = 0;
      let tex = 0;
      let meshes = 0;
      let materials = 0;
      for (const s of live()) {
        geometries += s.geometries?.length ?? 0;
        tex += s.textures?.length ?? 0;
        meshes += s.meshes?.length ?? 0;
        materials += s.materials?.length ?? 0;
      }
      return { geometries, textures: tex, programs: effectCount(engine), meshes, materials };
    },
    assetsInFlight: () => live().reduce((n, s) => n + (s.getWaitingItemsCount?.() || 0), 0),
    assetStats: () => null,
    // What the frame that just ended did: called when that frame turns out to be a hitch.
    hitchDetail(dt) {
      const share = Math.max(16, dt * 0.4);
      const w = work && work.frame === gd.frameId - 1 ? work : null;
      const causes = [];
      // With parallel compiles (KHR_parallel_shader_compile) the stall for a new shader can come a few frames after
      // Babylon asks for it: compiles in the second before the frame count.
      const recent = compiles.since(performance.now() - dt - 1000);
      if (done.compiles > 0 || recent > 0 || w?.linked) causes.push('shader_compile');
      if (done.sceneChanged) causes.push('scene_change');
      if (done.added >= SPAWN_BURST) causes.push('object_spawn');
      if (w ? w.textures >= TEXTURE_BURST || w.pixels >= TEXTURE_PIXELS : done.textures > 0) causes.push('texture_upload');
      if (w && (w.buffers >= BUFFER_BURST || w.bufferBytes >= BUFFER_BYTES)) causes.push('geometry_upload');
      if (done.updateMs >= share) causes.push('script');
      if (done.renderMs >= share) causes.push('render');
      sampleGauges();
      return {
        causes,
        fields: {
          process_ms: round1(done.updateMs),
          render_ms: round1(done.renderMs),
          gpu_ms: round1(done.gpuMs),
          shaders_compiled: Math.max(done.compiles, recent, w?.linked ?? 0),
          shader_compile_ms: round1(done.compileMs),
          meshes_added: done.added,
          materials_added: done.materials,
          textures_added: done.textures,
          textures_uploaded: w?.textures ?? 0,
          buffers_uploaded: w?.buffers ?? 0,
        },
      };
    },
    inspectScene: (opts) => inspectBabylon(engine, { ...opts, version }),
    captureMap: (levelId, opts) => captureMap(gd, main(), B, levelId, opts),
    // The drawing buffer is only readable right after Babylon renders, so wait for the end of the next frame.
    screenshot: ({ maxWidth = 960 } = {}) => nextFrameShot(() => engine.getRenderingCanvas?.(), maxWidth, (take) => (shot = take)),
  };
  return gd.render;
}

const FRESH = newFrame();
function newFrame() {
  return { start: 0, draws0: 0, draws: 0, renderMs: 0, updateMs: 0, gpuMs: null, tris: 0, compiles: 0, compileMs: 0, meshes0: 0, materials0: 0, textures0: 0, added: 0, materials: 0, textures: 0, sceneChanged: false };
}

function effectCount(engine) {
  const effects = engine._compiledEffects;
  return effects ? Object.keys(effects).length : null;
}

function effectName(effect) {
  const n = effect?.name;
  if (typeof n === 'string') return n;
  return n?.vertex || n?.vertexElement || n?.fragment || n?.fragmentElement || (n?.vertexSource ? 'custom shader (inline source)' : 'unknown');
}

// What an agent needs to spot "300 meshes named shard, each with its own geometry and material": per live scene, the
// meshes by name and class with their geometries, materials, instances and thin instances, what is frozen, the
// effects (compiled shaders) and the observers that run every frame.
export function inspectBabylon(engine, { top = 10, version = engine?.constructor?.Version ?? null } = {}) {
  if (!engine?.scenes) return null;
  const groups = new Map();
  const scenes = [];
  for (const s of engine.scenes) {
    if (s.isDisposed) continue;
    let vertices = 0;
    let instances = 0;
    let thin = 0;
    let visible = 0;
    const byClass = {};
    for (const m of s.meshes || []) {
      const cls = m.getClassName?.() || 'Mesh';
      byClass[cls] = (byClass[cls] || 0) + 1;
      const isInstance = !!m.sourceMesh;
      if (isInstance) instances++;
      const thinCount = m.thinInstanceCount || 0;
      thin += thinCount;
      if (m.isVisible !== false && m.isEnabled?.() !== false) visible++;
      const v = m.getTotalVertices?.() || 0;
      vertices += v;
      const name = stem(m.name) || `(unnamed ${cls})`;
      const key = `${name}|${cls}`;
      const g = groups.get(key) || { name, class: cls, count: 0, visible: 0, vertices: 0, instances: 0, thin_instances: 0, geometries: new Set(), materials: new Set() };
      g.count++;
      if (m.isVisible !== false && m.isEnabled?.() !== false) g.visible++;
      g.vertices += isInstance ? 0 : v * Math.max(1, thinCount);
      if (isInstance) g.instances++;
      g.thin_instances += thinCount;
      const geo = (m.sourceMesh || m).geometry;
      if (geo) g.geometries.add(geo.uniqueId ?? geo.id);
      const mat = (m.sourceMesh || m).material;
      if (mat) g.materials.add(mat.uniqueId ?? mat.id);
      groups.set(key, g);
    }
    const lights = s.lights || [];
    scenes.push({
      level: s.metadata?.level ?? null,
      meshes: s.meshes?.length ?? 0,
      visible_meshes: visible,
      active_meshes: s.getActiveMeshes?.().length ?? null,
      active_meshes_frozen: !!s._activeMeshesFrozen,
      by_class: byClass,
      vertices,
      instances,
      thin_instances: thin,
      materials: s.materials?.length ?? 0,
      frozen_materials: (s.materials || []).filter((m) => m.isFrozen).length,
      textures: s.textures?.length ?? 0,
      lights: lights.length,
      shadow_generators: lights.filter((l) => l.getShadowGenerator?.()).length,
      particle_systems: s.particleSystems?.length ?? 0,
      particles: (s.particleSystems || []).reduce((n, ps) => n + (ps.getActiveCount?.() ?? 0), 0),
      animatables: s.animatables?.length ?? null,
      // An observer added on every spawn or restart and never removed piles up here, and runs every frame.
      before_render_observers: s.onBeforeRenderObservable?.observers?.length ?? null,
      after_render_observers: s.onAfterRenderObservable?.observers?.length ?? null,
      waiting_for: s.getWaitingItemsCount?.() ?? 0,
    });
  }
  return {
    babylon: version,
    renderer: engine.isWebGPU ? 'webgpu' : engine._gl ? `webgl${engine.webGLVersion > 1 ? '2' : '1'}` : 'headless',
    fps: engine.getFps ? Math.round(engine.getFps()) : null,
    effects_compiled: effectCount(engine),
    parallel_shader_compile: !!engine.getCaps?.()?.parallelShaderCompile,
    scenes,
    top_groups: [...groups.values()]
      .map(({ geometries, materials, ...g }) => ({
        ...g,
        unique_geometries: geometries.size,
        unique_materials: materials.size,
        // Many meshes that each own their geometry: draw them as instances or thin instances of one mesh.
        instancing_candidate: g.count >= 20 && g.instances === 0 && geometries.size > g.count * 0.5,
        // A material per copy is a draw call and a shader bind each (a compile each, for a ShaderMaterial with
        // its own source): share one.
        material_per_mesh: g.count >= 20 && materials.size > g.count * 0.5,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, top),
  };
}

// "shard-12", "spark_3", "enemy.004" → one group per kind of mesh.
function stem(name) {
  return String(name ?? '').replace(/[\s_.#-]*\d+$/, '');
}

// An orthographic picture of the level for the heatmap background, rendered into a render target with Babylon's own
// screenshot tools (needs the BABYLON namespace: pass it to instrumentBabylon, or the UMD build's global).
async function captureMap(gd, scene, B, levelId, { axis = 'xz', bounds, width, exclude } = {}) {
  if (!B?.FreeCamera || !B.Tools?.CreateScreenshotUsingRenderTargetAsync || !scene || !bounds) {
    gd.log('captureMap needs the BABYLON namespace (instrumentBabylon(glitchless, { engine, scene, BABYLON })), a scene and bounds');
    return null;
  }
  const [minA, minB] = bounds.min;
  const [maxA, maxB] = bounds.max;
  const spanA = maxA - minA;
  const spanB = maxB - minB;
  const aspect = spanA / spanB;
  const w = width || (aspect > 4 ? 1024 : 640);
  const h = Math.max(48, Math.min(640, Math.round(w / aspect)));
  const cA = (minA + maxA) / 2;
  const cB = (minB + maxB) / 2;
  const cam = new B.FreeCamera('glitchless-map', axis === 'xy' ? new B.Vector3(cA, cB, -1000) : new B.Vector3(cA, 1000, cB), scene);
  cam.mode = 1; // Camera.ORTHOGRAPHIC_CAMERA
  // Looking down the +z axis (xy), or straight down (xz: +z is up on screen, so the picture is flipped afterwards to
  // put the smallest z at the top, as the heatmap draws it).
  cam.rotation.set(axis === 'xy' ? 0 : Math.PI / 2, 0, 0);
  Object.assign(cam, { orthoLeft: -spanA / 2, orthoRight: spanA / 2, orthoTop: spanB / 2, orthoBottom: -spanB / 2, minZ: 0.1, maxZ: 5000 });
  // Push fog out of the way instead of turning it off: changing scene.fogMode recompiles every material.
  const fog = { start: scene.fogStart, end: scene.fogEnd, density: scene.fogDensity };
  Object.assign(scene, { fogStart: 1e6, fogEnd: 2e6, fogDensity: 0 });
  const hidden = (exclude || []).filter((m) => m?.isVisible);
  hidden.forEach((m) => (m.isVisible = false));
  try {
    const shot = await B.Tools.CreateScreenshotUsingRenderTargetAsync(scene.getEngine(), cam, { width: w, height: h }, 'image/jpeg', 1, false, undefined, false, false, true, 0.85);
    const image = shot && (await recompress(shot, axis !== 'xy'));
    if (!image) return null;
    gd.push({ type: 'map', level: String(levelId), axis, bounds, size: [w, h], image });
    return image;
  } catch (err) {
    gd.log('captureMap failed', err);
    return null;
  } finally {
    Object.assign(scene, { fogStart: fog.start, fogEnd: fog.end, fogDensity: fog.density });
    hidden.forEach((m) => (m.isVisible = true));
    cam.dispose();
    gd.skipFrame(); // the capture's frames are not the game's
  }
}

// The render target's JPEG, flipped top to bottom when asked, shrunk to fit a map event.
function recompress(dataUrl, flip) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      if (flip) {
        ctx.translate(0, img.height);
        ctx.scale(1, -1);
      }
      ctx.drawImage(img, 0, 0);
      resolve(mapJpeg(canvas));
    };
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}
