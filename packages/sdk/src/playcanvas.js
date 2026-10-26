// PlayCanvas adapter (the PlayCanvas engine 2.x, WebGL2 or WebGPU; editor projects and engine-only games):
// times every frame from the app's own loop ('frameupdate' to 'frameend') and splits it into update and render CPU
// time, reads the device's draw-call count and the shaders it creates, counts triangles and what each frame uploads,
// turns editor scenes into levels, reports failed asset loads, context loss and script errors, and lets agents inspect
// the entity hierarchy.

import { SDK_VERSION } from './core.js';
import { watchGl } from './three.js';
import { TEXTURE_BURST, TEXTURE_PIXELS, BUFFER_BURST, BUFFER_BYTES, SPAWN_BURST, GAUGE_EVERY, readsAsLevel, copyCanvas, mapJpeg, nextFrameShot, recentTimes, basename, round1 } from './adapters.js';

// Component systems whose components draw something: one added is one object on screen.
const DRAWN = ['render', 'model', 'sprite', 'element', 'particlesystem'];

export function instrumentPlayCanvas(gd, { app, pc, levels = 'auto', gauges = true } = {}) {
  if (!gd || typeof app?.on !== 'function' || !app.graphicsDevice) throw new Error('instrumentPlayCanvas(glitchless, { app }): app is required');
  if (app.__glitchless) return gd.render;
  app.__glitchless = true;

  const P = pc || globalThis.pc || null;
  const device = app.graphicsDevice;
  const gl = device.gl || null;
  gd.sdk = `glitchless-playcanvas/${SDK_VERSION}`;
  gd.engine = { name: 'playcanvas', version: P?.version ?? null, renderer: device.isWebGPU ? 'webgpu' : gl ? 'webgl' : 'headless' };
  gd.useFrameClock();

  // The frame being drawn, and the one before it (what hitchDetail reads).
  const frame = newFrame();
  const done = newFrame();
  const work = gl ? watchGl(gl, gd) : null;
  const loads = { inFlight: 0, count: 0, failed: 0, ms: 0, slowest: [], started: new Map() };
  let frameNo = 0;
  let manualLevels = false;
  let sceneChanged = false;
  let lastEntities = null;
  let shot = null;
  const compiles = recentTimes();

  // A level call from the game itself switches scene levels off: the game knows its levels better. The frames that
  // build and first draw the level are its load, not play.
  const levelStart = gd.levelStart.bind(gd);
  gd.levelStart = (id, attrs) => {
    manualLevels = true;
    frame.sceneChanged = sceneChanged = true;
    return levelStart(id, attrs);
  };

  const levelOf = (name) => {
    if (name == null || levels === false) return null;
    if (typeof levels === 'function') return levels(name) ?? null;
    if (Array.isArray(levels)) return levels.includes(name) ? name : null;
    return readsAsLevel(name) ? name : null;
  };

  // Editor scenes: changeScene() replaces the hierarchy, loadSceneHierarchy() adds one. A scene that reads as a level
  // starts it; changing to one that doesn't (a menu) ends it. The first frame after a load pays for what it shows.
  const sceneLoaded = (name, replaced) => {
    sceneChanged = true;
    if (manualLevels) return;
    const level = levelOf(name);
    if (level != null) levelStart(String(level));
    else if (replaced) gd.level = null;
  };
  const registry = app.scenes;
  for (const method of ['changeScene', 'loadSceneHierarchy', 'loadScene']) {
    const original = registry?.[method];
    if (typeof original !== 'function' || original.__glitchless) continue;
    const wrapped = function (item, callback, ...rest) {
      const name = sceneName(registry, item);
      return original.call(this, item, (err, ...result) => {
        if (!err) sceneLoaded(name, method === 'changeScene');
        return callback?.(err, ...result);
      }, ...rest);
    };
    wrapped.__glitchless = true;
    registry[method] = wrapped;
  }

  // Triangles: PlayCanvas counts them only in its profiler build.
  const draw = device.draw;
  if (typeof draw === 'function' && !draw.__glitchless) {
    device.draw = function (primitive, a1, a2, ...rest) {
      const instances = (typeof a1 === 'number' ? a1 : typeof a2 === 'number' ? a2 : 1) || 1; // 1.x: (primitive, numInstances); 2.x: (primitive, indexBuffer, numInstances)
      frame.tris += triangles(primitive) * instances;
      return draw.call(this, primitive, a1, a2, ...rest);
    };
    device.draw.__glitchless = true;
  }
  // Every new Shader is compiled here (WebGL compiles and links, WebGPU makes its modules): a shader built mid-game is
  // the first-use stutter.
  const createShader = device.createShaderImpl;
  if (typeof createShader === 'function' && !createShader.__glitchless) {
    device.createShaderImpl = function (...args) {
      const t0 = performance.now();
      try {
        return createShader.apply(this, args);
      } finally {
        const now = performance.now();
        frame.compiles++;
        frame.compileMs += now - t0;
        compiles.add(now);
      }
    };
    device.createShaderImpl.__glitchless = true;
  }
  for (const name of DRAWN) app.systems?.[name]?.on?.('add', () => frame.added++);

  // Counts that climb when something leaks or spawns too much. They go in ctx, where the findings compare a slow
  // level's gauges with the smoothest one's.
  const sampleGauges = () => {
    if (!gauges) return null;
    const c = countHierarchy(app.root);
    lastEntities = c.entities;
    const values = { entities: c.entities, mesh_instances: c.meshInstances, materials: c.materials.size, textures: device.textures?.size ?? 0, lights: c.lights };
    gd.setContext(values);
    return values;
  };

  // A frame runs from one 'frameupdate' to the next, so it owns what the game does between frames (timers, load
  // callbacks) as well.
  app.on('frameupdate', () => {
    const now = performance.now();
    const textures = device.textures?.size ?? 0;
    const buffers = device.buffers?.size ?? 0;
    if (frameNo) {
      frame.textures = Math.max(0, textures - frame.textures0);
      frame.buffers = Math.max(0, buffers - frame.buffers0);
      Object.assign(done, frame);
    }
    gd.tick(now); // times the frame before this one, with the stats it left behind
    frameNo++;
    if (frameNo % GAUGE_EVERY === 0) sampleGauges();
    Object.assign(frame, FRESH);
    frame.start = now;
    frame.textures0 = textures;
    frame.buffers0 = buffers;
    frame.sceneChanged = sceneChanged;
    sceneChanged = false;
  });
  // Scripts, animation and physics run between 'frameupdate' and 'framerender'; drawing between 'prerender' and
  // 'postrender'.
  app.on('framerender', () => (frame.updateMs = performance.now() - frame.start));
  app.on('prerender', () => (frame.renderStart = performance.now()));
  app.on('postrender', () => {
    frame.renderMs = performance.now() - (frame.renderStart || performance.now());
    frame.rendered = true;
    gd.onRender(frame.renderMs, device._drawCallsPerFrame ?? 0, Math.round(frame.tris), frame.updateMs);
  });
  app.on('frameend', () => {
    // After render(): a multisampled back buffer is resolved to the canvas by then.
    if (shot && frame.rendered) {
      const take = shot;
      shot = null;
      take(copyCanvas(device.canvas, take.maxWidth));
    }
  });

  // Context loss: PlayCanvas calls preventDefault on the canvas event itself, so the context can come back. WebGPU
  // devices say so with their own events.
  if (device.isWebGPU) {
    device.on?.('devicelost', () => gd.reportError({ kind: 'webgl_context_lost', message: 'WebGPU device lost', attrs: gd.render.memory() }));
    device.on?.('devicerestored', () => gd.track('webgpu_device_restored'));
  } else {
    device.canvas?.addEventListener?.('webglcontextlost', () => gd.reportError({ kind: 'webgl_context_lost', message: 'WebGL context lost', attrs: gd.render.memory() }));
    device.canvas?.addEventListener?.('webglcontextrestored', () => gd.track('webgl_context_restored'));
  }

  // Asset loads: in flight (a hitch during one has an asset_load cause), timed, and failures reported.
  const assets = app.assets;
  assets?.on?.('load:start', (asset) => {
    if (loads.started.has(asset)) return;
    loads.inFlight++;
    loads.started.set(asset, performance.now());
  });
  const finished = (asset) => {
    const t0 = loads.started.get(asset);
    if (t0 == null) return null;
    loads.started.delete(asset);
    loads.inFlight = Math.max(0, loads.inFlight - 1);
    return Math.round(performance.now() - t0);
  };
  assets?.on?.('load', (asset) => {
    const ms = finished(asset);
    if (ms == null) return;
    loads.count++;
    loads.ms += ms;
    loads.slowest.push({ asset: String(asset?.name ?? '').slice(0, 80), type: asset?.type ?? null, ms });
    loads.slowest.sort((a, b) => b.ms - a.ms).splice(5);
  });
  assets?.on?.('error', (err, asset) => {
    finished(asset);
    loads.failed++;
    const url = String(asset?.file?.url || asset?.getFileUrl?.() || '');
    gd.reportError({ kind: 'asset', message: `Failed to load ${asset?.type || 'asset'} "${asset?.name ?? '?'}": ${basename(url) || 'unknown'}`, source: url || undefined, attrs: { error: String(err?.message ?? err ?? '').slice(0, 200) } });
  });

  // The debug build (what Vite's dev server serves) catches an error in a script's initialize() or update(), logs it
  // and turns the script off, so it never reaches window.onerror; the release build lets it through, where the core
  // reports it. Both are the same 'js' error.
  const watchScripts = (component) => {
    if (!component?.on || component.__glitchless) return;
    component.__glitchless = true;
    component.on('error', (script, err, method) => {
      gd.reportError({ kind: 'js', error: err instanceof Error ? err : null, message: String(err?.message ?? err), attrs: { script: script?.__scriptType?.__name ?? null, method: method ?? null, script_disabled: true } });
    });
  };
  const scripts = app.systems?.script;
  scripts?.on?.('add', (entity, component) => watchScripts(component));
  for (const data of Object.values(scripts?.store || {})) watchScripts(data?.entity?.script);

  gd.render = {
    app,
    pc: P,
    gl,
    memory() {
      let geometries = 0;
      for (const b of device.buffers || []) if (b?.numVertices != null) geometries++; // vertex buffers: one per mesh
      return { geometries, textures: device.textures?.size ?? null, programs: device.shaders?.length ?? null, entities: lastEntities };
    },
    assetsInFlight: () => loads.inFlight,
    assetStats: () => (loads.count ? { count: loads.count, failed: loads.failed, ms: loads.ms, slowest: loads.slowest } : null),
    // What the frame that just ended did: called when that frame turns out to be a hitch.
    hitchDetail(dt) {
      const share = Math.max(16, dt * 0.4);
      const w = work && work.frame === gd.frameId - 1 ? work : null;
      const causes = [];
      // A shader compiled in parallel (KHR_parallel_shader_compile) can stall the frame that first draws with it, a
      // few frames later: compiles in the second before the frame count.
      const recent = compiles.since(performance.now() - dt - 1000);
      if (done.compiles > 0 || recent > 0 || w?.linked) causes.push('shader_compile');
      if (done.sceneChanged) causes.push('scene_change');
      if (done.added >= SPAWN_BURST) causes.push('object_spawn');
      if (w ? w.textures >= TEXTURE_BURST || w.pixels >= TEXTURE_PIXELS : done.textures > 0) causes.push('texture_upload');
      if (w ? w.buffers >= BUFFER_BURST || w.bufferBytes >= BUFFER_BYTES : done.buffers >= BUFFER_BURST) causes.push('geometry_upload');
      if (done.updateMs >= share) causes.push('script');
      if (done.renderMs >= share) causes.push('render');
      sampleGauges();
      return {
        causes,
        fields: {
          process_ms: round1(done.updateMs),
          render_ms: round1(done.renderMs),
          shaders_compiled: Math.max(done.compiles, recent),
          shader_compile_ms: round1(done.compileMs),
          objects_added: done.added,
          textures_added: done.textures,
          buffers_added: done.buffers,
          textures_uploaded: w?.textures ?? 0,
          buffers_uploaded: w?.buffers ?? 0,
          buffer_kb: w ? Math.round(w.bufferBytes / 1024) : 0,
        },
      };
    },
    inspectScene: (opts) => inspectPlayCanvas(app, { ...opts, version: P?.version ?? null }),
    captureMap: (levelId, opts) => captureMap(gd, app, P, levelId, opts),
    // The drawing buffer is only readable right after PlayCanvas renders, so wait for the end of the next frame.
    screenshot: ({ maxWidth = 960 } = {}) => nextFrameShot(() => device.canvas, maxWidth, (take) => (shot = take)),
  };
  return gd.render;
}

const FRESH = newFrame();
function newFrame() {
  return { start: 0, renderStart: 0, renderMs: 0, updateMs: 0, rendered: false, tris: 0, compiles: 0, compileMs: 0, added: 0, textures0: 0, textures: 0, buffers0: 0, buffers: 0, sceneChanged: false };
}

function triangles(p) {
  if (!p) return 0;
  const n = p.count || 0;
  // PRIMITIVE_TRIANGLES, PRIMITIVE_TRISTRIP, PRIMITIVE_TRIFAN (the WebGL values)
  return p.type === 4 ? Math.floor(n / 3) : p.type === 5 || p.type === 6 ? Math.max(0, n - 2) : 0;
}

function sceneName(registry, item) {
  if (item && typeof item === 'object') return item.name ?? null;
  if (typeof item !== 'string') return null;
  return registry.find?.(item)?.name ?? registry.findByUrl?.(item)?.name ?? basename(item).replace(/\.json$/, '');
}

function walk(root, fn) {
  if (!root) return;
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    fn(node);
    const kids = node.children;
    if (kids) for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
  }
}

function meshInstancesOf(e) {
  return e.c?.render?.meshInstances || e.c?.model?.meshInstances || null;
}

function countHierarchy(root) {
  const c = { entities: 0, meshInstances: 0, materials: new Set(), lights: 0 };
  walk(root, (e) => {
    if (e === root) return;
    c.entities++;
    const mis = meshInstancesOf(e);
    if (mis) {
      c.meshInstances += mis.length;
      for (const mi of mis) if (mi.material) c.materials.add(mi.material);
    }
    if (e.c?.light) c.lights++;
  });
  return c;
}

// What an agent needs to spot "400 entities named spark, each with its own mesh and material": the hierarchy's
// entities grouped by name, with their meshes, materials, batching and instancing, the scripts by type, lights and
// cameras, and what the device holds (shaders, textures, buffers).
export function inspectPlayCanvas(app, { top = 10, version = null } = {}) {
  if (!app?.root) return null;
  const device = app.graphicsDevice;
  const groups = new Map();
  const scripts = {};
  let entities = 0;
  let enabled = 0;
  let meshInstances = 0;
  let lights = 0;
  let shadowLights = 0;
  let cameras = 0;
  const materials = new Set();
  walk(app.root, (e) => {
    if (e === app.root) return;
    entities++;
    if (e.enabled) enabled++;
    if (e.c?.light) {
      lights++;
      if (e.c.light.castShadows) shadowLights++;
    }
    if (e.c?.camera) cameras++;
    for (const s of e.c?.script?.scripts || []) {
      const name = s.__scriptType?.__name || 'script';
      scripts[name] = (scripts[name] || 0) + 1;
    }
    const mis = meshInstancesOf(e);
    if (!mis) return;
    meshInstances += mis.length;
    const name = String(e.name ?? '').replace(/[\s_.#-]*\d+$/, '') || '(unnamed)';
    const kind = e.c.render?.type || (e.c.model ? 'model' : 'render');
    const key = `${name}|${kind}`;
    const g = groups.get(key) || { name, kind, count: 0, enabled: 0, mesh_instances: 0, instanced: 0, batched: 0, meshes: new Set(), materials: new Set() };
    g.count++;
    if (e.enabled) g.enabled++;
    g.mesh_instances += mis.length;
    if ((e.c.render?.batchGroupId ?? e.c.model?.batchGroupId ?? -1) >= 0) g.batched++;
    for (const mi of mis) {
      if (mi.mesh) g.meshes.add(mi.mesh);
      if (mi.material) {
        g.materials.add(mi.material);
        materials.add(mi.material);
      }
      if (mi.instancingCount > 0 || mi.instancingData) g.instanced++;
    }
    groups.set(key, g);
  });
  const stats = app.stats;
  return {
    playcanvas: version,
    renderer: device?.isWebGPU ? 'webgpu' : device?.gl ? 'webgl2' : 'headless',
    fps: stats?.frame?.fps ?? null,
    draw_calls_last_frame: stats?.drawCalls?.total ?? null,
    entities,
    enabled_entities: enabled,
    mesh_instances: meshInstances,
    materials: materials.size,
    lights,
    shadow_casting_lights: shadowLights,
    cameras,
    scripts,
    batch_groups: app.batcher?._batchGroups ? Object.keys(app.batcher._batchGroups).length : 0,
    device: { shaders: device?.shaders?.length ?? null, textures: device?.textures?.size ?? null, buffers: device?.buffers?.size ?? null, vram_mb: stats?.vram ? Math.round(((stats.vram.tex + stats.vram.vb + stats.vram.ib) / 1048576) * 10) / 10 : null },
    top_groups: [...groups.values()]
      .map(({ meshes, materials: mats, ...g }) => ({
        ...g,
        unique_meshes: meshes.size,
        unique_materials: mats.size,
        // Many entities that each own a mesh: one hardware-instanced mesh instance, or a static batch group.
        instancing_candidate: g.count >= 20 && g.instanced === 0 && g.batched === 0 && meshes.size > g.count * 0.5,
        // A material per copy breaks batching and binds a shader per draw: share one.
        material_per_entity: g.count >= 20 && mats.size > g.count * 0.5,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, top),
  };
}

// An orthographic picture of the level for the heatmap background: a camera rendering into a texture for one frame
// (needs the pc namespace: pass it to instrumentPlayCanvas, or the script build's global).
async function captureMap(gd, app, P, levelId, { axis = 'xz', bounds, width, exclude } = {}) {
  if (!P?.Entity || !P.Texture || !P.RenderTarget || !bounds || typeof P.Texture.prototype.read !== 'function') {
    gd.log('captureMap needs PlayCanvas 2.x, the pc namespace (instrumentPlayCanvas(glitchless, { app, pc })) and bounds');
    return null;
  }
  const device = app.graphicsDevice;
  const [minA, minB] = bounds.min;
  const [maxA, maxB] = bounds.max;
  const spanA = maxA - minA;
  const spanB = maxB - minB;
  const aspect = spanA / spanB;
  const w = width || (aspect > 4 ? 1024 : 640);
  const h = Math.max(48, Math.min(640, Math.round(w / aspect)));
  const cA = (minA + maxA) / 2;
  const cB = (minB + maxB) / 2;
  const texture = new P.Texture(device, { name: 'glitchless-map', width: w, height: h, format: P.PIXELFORMAT_RGBA8, mipmaps: false, minFilter: P.FILTER_LINEAR, magFilter: P.FILTER_LINEAR });
  const target = new P.RenderTarget({ colorBuffer: texture, depth: true });
  // The game's own camera: its layers (without the UI) and clear colour.
  let main = null;
  walk(app.root, (e) => {
    if (e.c?.camera && e.enabled && e.c.camera.enabled && !e.c.camera.renderTarget && (!main || e.c.camera.priority > main.priority)) main = e.c.camera;
  });
  const layers = (main?.layers || [P.LAYERID_WORLD, P.LAYERID_SKYBOX]).filter((id) => id !== P.LAYERID_UI);
  const cam = new P.Entity('glitchless-map');
  cam.addComponent('camera', { projection: P.PROJECTION_ORTHOGRAPHIC, orthoHeight: spanB / 2, aspectRatioMode: P.ASPECT_MANUAL, aspectRatio: aspect, nearClip: 0.1, farClip: 5000, renderTarget: target, layers, clearColor: main?.clearColor, priority: -100 });
  // PlayCanvas cameras look down -z: a side view as is (xy), or pitched straight down (xz, with -z up on screen, so
  // the smallest z is at the top as the heatmap draws it).
  if (axis === 'xy') cam.setPosition(cA, cB, 1000);
  else {
    cam.setPosition(cA, 1000, cB);
    cam.setEulerAngles(-90, 0, 0);
  }
  const hidden = (exclude || []).filter((e) => e?.enabled);
  hidden.forEach((e) => (e.enabled = false));
  app.root.addChild(cam);
  try {
    await new Promise((resolve) => app.once('frameend', resolve));
    const pixels = await texture.read(0, 0, w, h, { renderTarget: target, immediate: true });
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(w, h);
    const flip = !device.isWebGPU; // WebGL reads rows bottom-up
    for (let y = 0; y < h; y++) {
      const row = flip ? h - 1 - y : y;
      img.data.set(pixels.subarray(row * w * 4, (row + 1) * w * 4), y * w * 4);
    }
    ctx.putImageData(img, 0, 0);
    const image = mapJpeg(canvas);
    gd.push({ type: 'map', level: String(levelId), axis, bounds, size: [w, h], image });
    return image;
  } catch (err) {
    gd.log('captureMap failed', err);
    return null;
  } finally {
    hidden.forEach((e) => (e.enabled = true));
    cam.destroy();
    target.destroy();
    texture.destroy();
  }
}
