// Three.js adapter: hooks the renderer for per-frame stats, the loading manager for asset timing,
// the canvas for context loss, and adds scene inspection + level map capture.

export function instrumentThree(gd, { renderer, scene, camera, THREE } = {}) {
  if (!gd || !renderer) throw new Error('instrumentThree(gd, { renderer, scene, camera }) — renderer is required');
  if (renderer.__glitchless) return gd.render;
  renderer.__glitchless = true;

  const originalRender = renderer.render.bind(renderer);
  const info = renderer.info;
  renderer.render = function glitchlessRender(s, c) {
    const t0 = performance.now();
    originalRender(s, c);
    const r = info.render;
    gd.onRender(performance.now() - t0, r.drawCalls ?? r.calls ?? 0, r.triangles ?? 0);
  };

  const gl = typeof renderer.getContext === 'function' ? renderer.getContext() : null;
  const canvas = renderer.domElement;
  canvas?.addEventListener('webglcontextlost', (e) => {
    e.preventDefault(); // required, or the context can never be restored
    gd.reportError({ kind: 'webgl_context_lost', message: 'WebGL context lost', attrs: gd.render.memory() });
  });
  canvas?.addEventListener('webglcontextrestored', () => gd.track('webgl_context_restored'));

  const assets = { count: 0, failed: 0, inFlight: 0, startedAt: 0, ms: 0, items: new Map(), slowest: [] };
  const manager = THREE?.DefaultLoadingManager;
  if (manager) {
    const chain = (key, fn) => {
      const prev = manager[key];
      manager[key] = (...args) => {
        fn(...args);
        prev?.(...args);
      };
    };
    chain('onStart', () => {
      if (!assets.startedAt) assets.startedAt = performance.now();
    });
    chain('itemStart', (url) => {
      assets.inFlight++;
      assets.items.set(url, performance.now());
    });
    chain('itemEnd', (url) => {
      assets.inFlight = Math.max(0, assets.inFlight - 1);
      const t = assets.items.get(url);
      if (t != null) {
        const ms = performance.now() - t;
        assets.count++;
        assets.slowest.push({ url: url.split('/').pop().slice(0, 80), ms: Math.round(ms) });
        assets.slowest.sort((a, b) => b.ms - a.ms).splice(5);
        assets.items.delete(url);
      }
    });
    chain('itemError', (url) => {
      assets.failed++;
      gd.reportError({ kind: 'asset', message: `Failed to load asset: ${url.split('/').pop()}`, source: url });
    });
    chain('onLoad', () => {
      assets.ms = Math.round(performance.now() - (assets.startedAt || 0));
      gd.track('assets_loaded', { count: assets.count, ms: assets.ms, failed: assets.failed });
    });
  }

  gd.render = {
    renderer,
    scene,
    camera,
    THREE,
    gl,
    memory() {
      const m = info.memory || {};
      return {
        geometries: m.geometries ?? null,
        textures: m.textures ?? null,
        programs: Array.isArray(info.programs) ? info.programs.length : m.programs ?? null,
      };
    },
    assetsInFlight: () => assets.inFlight,
    assetStats: () => (assets.count ? { count: assets.count, failed: assets.failed, ms: assets.ms, slowest: assets.slowest } : null),
    inspectScene: (opts) => inspectScene(scene, opts),
    rawRender: originalRender,
    captureMap: (levelId, opts) => captureMap(gd, levelId, opts),
    screenshot: (opts) => screenshot(gd.render, opts),
  };
  return gd.render;
}

// Summarize the scene graph — what an agent needs to spot "600 unique geometries named confetti".
export function inspectScene(scene, { top = 10 } = {}) {
  if (!scene) return null;
  const byType = {};
  const byName = new Map();
  const geometries = new Set();
  const materials = new Set();
  let objects = 0;
  let visibleMeshes = 0;
  let triangles = 0;
  let lights = 0;
  let shadowCasters = 0;
  const heavy = [];
  scene.traverse((o) => {
    objects++;
    byType[o.type] = (byType[o.type] || 0) + 1;
    if (o.isLight) lights++;
    if (!o.isMesh && !o.isPoints && !o.isLine) return;
    if (o.visible) visibleMeshes++;
    if (o.castShadow) shadowCasters++;
    const g = o.geometry;
    if (g) geometries.add(g.uuid);
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    mats.forEach((m) => m && materials.add(m.uuid));
    const tris = g ? (g.index ? g.index.count : g.attributes.position?.count || 0) / 3 : 0;
    const count = o.isInstancedMesh ? o.count : 1;
    triangles += tris * count;
    const key = o.name || `(unnamed ${o.type})`;
    const e = byName.get(key) || { name: key, type: o.type, count: 0, triangles: 0, geometries: new Set(), materials: new Set() };
    e.count++;
    e.triangles += tris * count;
    if (g) e.geometries.add(g.uuid);
    mats.forEach((m) => m && e.materials.add(m.uuid));
    byName.set(key, e);
    if (tris * count > 5000) heavy.push({ name: key, type: o.type, triangles: Math.round(tris * count) });
  });
  const groups = [...byName.values()]
    .map((e) => ({
      name: e.name,
      type: e.type,
      count: e.count,
      triangles: Math.round(e.triangles),
      unique_geometries: e.geometries.size,
      unique_materials: e.materials.size,
      // Many objects that each own their geometry/material = missed instancing/sharing opportunity.
      instancing_candidate: e.count >= 20 && e.geometries.size > e.count * 0.5,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, top);
  return {
    objects,
    visible_meshes: visibleMeshes,
    triangles: Math.round(triangles),
    unique_geometries: geometries.size,
    unique_materials: materials.size,
    lights,
    shadow_casters: shadowCasters,
    by_type: byType,
    top_groups: groups,
    heaviest_meshes: heavy.sort((a, b) => b.triangles - a.triangles).slice(0, 5),
  };
}

// Render an orthographic side (xy) or top-down (xz) thumbnail of the level for heatmap backgrounds.
function captureMap(gd, levelId, { axis = 'xz', bounds, width, exclude } = {}) {
  const { renderer, scene, THREE } = gd.render;
  if (!THREE || !scene || !bounds) {
    gd.log('captureMap needs THREE, scene and bounds');
    return null;
  }
  try {
    const [minA, minB] = bounds.min;
    const [maxA, maxB] = bounds.max;
    const spanA = maxA - minA;
    const spanB = maxB - minB;
    const aspect = spanA / spanB;
    const w = width || (aspect > 4 ? 1024 : 640);
    const h = Math.max(48, Math.min(640, Math.round(w / aspect)));
    const cam = new THREE.OrthographicCamera(minA, maxA, maxB, minB, 0.1, 10000);
    if (axis === 'xy') {
      cam.position.set(0, 0, 1000);
      cam.lookAt(0, 0, 0);
    } else {
      // Looking straight down: screen-up should be -z so the map reads like a top-down view.
      cam.position.set(0, 1000, 0);
      cam.up.set(0, 0, -1);
      cam.lookAt(0, 0, 0);
      cam.top = -minB;
      cam.bottom = -maxB;
    }
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();

    const rt = new THREE.WebGLRenderTarget(w, h);
    const prevTarget = renderer.getRenderTarget();
    // Push fog out of the way instead of removing it: toggling scene.fog off would make three.js
    // compile fog-less variants of every material (a shader-compile hitch at every level load).
    const fog = scene.fog;
    const prevFog = fog && { near: fog.near, far: fog.far, density: fog.density };
    if (fog?.isFog) Object.assign(fog, { near: 1e6, far: 2e6 });
    if (fog?.isFogExp2) fog.density = 0;
    // Optional: hide things that clutter a map (player, sky dome, effects).
    const hidden = (exclude || []).filter((o) => o?.visible);
    hidden.forEach((o) => (o.visible = false));
    renderer.setRenderTarget(rt);
    renderer.clear();
    gd.render.rawRender(scene, cam); // bypass our stats hook
    const pixels = new Uint8Array(w * h * 4);
    renderer.readRenderTargetPixels(rt, 0, 0, w, h, pixels);
    renderer.setRenderTarget(prevTarget);
    if (prevFog) Object.assign(fog, fog.isFogExp2 ? { density: prevFog.density } : { near: prevFog.near, far: prevFog.far });
    hidden.forEach((o) => (o.visible = true));
    rt.dispose();

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(w, h);
    for (let y = 0; y < h; y++) {
      // WebGL rows are bottom-up.
      img.data.set(pixels.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
    }
    ctx.putImageData(img, 0, 0);
    let quality = 0.75;
    let image = canvas.toDataURL('image/jpeg', quality);
    while (image.length > 60_000 && quality > 0.3) {
      quality -= 0.15;
      image = canvas.toDataURL('image/jpeg', quality);
    }
    gd.push({ type: 'map', level: String(levelId), axis, bounds, size: [w, h], image });
    return image;
  } catch (err) {
    gd.log('captureMap failed', err);
    return null;
  }
}

function screenshot({ renderer, scene, camera, rawRender }, { maxWidth = 960 } = {}) {
  const src = renderer.domElement;
  // Without preserveDrawingBuffer the drawing buffer is cleared after compositing,
  // so render a fresh frame and copy it in the same task.
  if (scene && camera) rawRender(scene, camera);
  const scale = Math.min(1, maxWidth / src.width);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(src.width * scale);
  canvas.height = Math.round(src.height * scale);
  canvas.getContext('2d').drawImage(src, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.8);
}
