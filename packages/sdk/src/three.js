// Three.js adapter: hooks the renderer for per-frame stats, the loading manager for asset timing,
// the canvas for context loss, the WebGL context for what each frame uploads (hitch causes), and adds
// scene inspection + level map capture.

// What one frame has to upload before it counts as a cause of that frame's hitch.
const TEXTURE_BURST = 4; // textures uploaded or re-uploaded (a canvas texture with needsUpdate each frame is 1)
const TEXTURE_PIXELS = 1 << 20; // or one big upload: a megapixel (a 1024x1024 texture)
const BUFFER_BURST = 32; // geometry buffers uploaded (new meshes with their own geometry)
const BUFFER_BYTES = 4 << 20;

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
  const work = gl ? watchGl(gl, gd) : null;
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
    // What the frame that just ended sent to the GPU: called when that frame turns out to be a hitch.
    hitchDetail(dt) {
      const w = work && work.frame === gd.frameId - 1 ? work : null;
      const r = gd.lastRender && gd.lastRender.frameId >= gd.frameId - 1 ? gd.lastRender : null;
      const causes = [];
      if (w?.linked) causes.push('shader_compile');
      if (w && (w.textures >= TEXTURE_BURST || w.pixels >= TEXTURE_PIXELS)) causes.push('texture_upload');
      if (w && (w.buffers >= BUFFER_BURST || w.bufferBytes >= BUFFER_BYTES)) causes.push('geometry_upload');
      if (r && r.ms >= Math.max(16, dt * 0.4)) causes.push('render');
      return {
        causes,
        fields: {
          render_ms: r ? Math.round(r.ms * 10) / 10 : null,
          textures_uploaded: w?.textures ?? 0,
          texture_mpx: w ? Math.round(w.pixels / 1e4) / 100 : 0,
          buffers_uploaded: w?.buffers ?? 0,
          buffer_kb: w ? Math.round(w.bufferBytes / 1024) : 0,
          programs_linked: w?.linked ?? 0,
        },
      };
    },
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

// Counts what each frame sends to the GPU by wrapping the context's upload calls: texture uploads (and
// re-uploads: a CanvasTexture redrawn every frame), geometry buffers and shader programs linked. Three.js
// keeps no per-frame counters for these, and they are what a spawn burst costs. Counters are per frame
// (gd.frameId), so when a frame turns out to be a hitch, hitchDetail() reads the work of that frame.
function watchGl(gl, gd) {
  const work = { frame: -1, textures: 0, pixels: 0, buffers: 0, bufferBytes: 0, linked: 0 };
  const here = () => {
    if (work.frame === gd.frameId) return work;
    work.frame = gd.frameId;
    work.textures = work.pixels = work.buffers = work.bufferBytes = work.linked = 0;
    return work;
  };
  const size = (src) => (src ? (src.width || src.videoWidth || src.displayWidth || 0) * (src.height || src.videoHeight || src.displayHeight || 0) : 0);
  const wrap = (name, count) => {
    const original = gl[name];
    if (typeof original !== 'function' || original.__glitchless) return;
    const counted = function (...args) {
      try {
        count(here(), args);
      } catch {
        // counting must never break a draw
      }
      return original.apply(this, args);
    };
    counted.__glitchless = true;
    gl[name] = counted;
  };
  const texture = (w, pixels) => {
    w.textures++;
    w.pixels += pixels;
  };
  // texImage2D(target, level, internalformat, width, height, border, format, type, data) or (…, format, type, source)
  wrap('texImage2D', (w, a) => texture(w, typeof a[3] === 'number' && a.length >= 8 ? a[3] * a[4] : size(a[5])));
  // texSubImage2D(target, level, x, y, width, height, format, type, data) or (target, level, x, y, format, type, source)
  wrap('texSubImage2D', (w, a) => texture(w, a.length >= 8 && typeof a[6] === 'number' ? a[4] * a[5] : size(a[6])));
  wrap('texImage3D', (w, a) => texture(w, a[3] * a[4] * a[5]));
  wrap('texSubImage3D', (w, a) => texture(w, a[5] * a[6] * a[7]));
  wrap('compressedTexImage2D', (w, a) => texture(w, a[3] * a[4]));
  wrap('compressedTexSubImage2D', (w, a) => texture(w, a[4] * a[5]));
  wrap('bufferData', (w, a) => {
    w.buffers++;
    w.bufferBytes += typeof a[1] === 'number' ? a[1] : a[1]?.byteLength || 0;
  });
  wrap('bufferSubData', (w, a) => {
    w.buffers++;
    w.bufferBytes += a[2]?.byteLength || 0;
  });
  wrap('linkProgram', (w) => w.linked++);
  return work;
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

    // three.js only tone maps and encodes sRGB on the way to the screen: a render target gets linear
    // light, which read back as 8-bit colour looks far darker than the game. So the scene goes into a
    // linear (half-float where it can) target, and an output pass (as three's OutputPass does) applies the
    // game's own tone mapping and colour space into the target that is read back.
    const pass = outputPass(THREE, renderer);
    const hdr = pass && (renderer.extensions?.has?.('EXT_color_buffer_float') || renderer.extensions?.has?.('EXT_color_buffer_half_float'));
    const linear = pass ? new THREE.WebGLRenderTarget(w, h, hdr ? { type: THREE.HalfFloatType } : {}) : null;
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
    renderer.setRenderTarget(linear || rt);
    renderer.clear();
    gd.render.rawRender(scene, cam); // bypass our stats hook
    if (pass) {
      pass.material.uniforms.tDiffuse.value = linear.texture;
      renderer.setRenderTarget(rt);
      gd.render.rawRender(pass.scene, pass.camera);
    }
    const pixels = new Uint8Array(w * h * 4);
    renderer.readRenderTargetPixels(rt, 0, 0, w, h, pixels);
    renderer.setRenderTarget(prevTarget);
    if (prevFog) Object.assign(fog, fog.isFogExp2 ? { density: prevFog.density } : { near: prevFog.near, far: prevFog.far });
    hidden.forEach((o) => (o.visible = true));
    rt.dispose();
    linear?.dispose();
    pass?.dispose();

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

// A full-screen pass that turns linear light into what the screen shows: the renderer's tone mapping and
// exposure, then its output colour space. The same shader as three's OutputShader, built from the
// ShaderChunks of the game's own three.js (null before r155, whose chunks name these differently).
function outputPass(THREE, renderer) {
  const chunks = THREE.ShaderChunk;
  if (!THREE.RawShaderMaterial || !chunks?.tonemapping_pars_fragment || !chunks.colorspace_pars_fragment?.includes('sRGBTransferOETF')) return null;
  const names = [
    ['LinearToneMapping', 'LINEAR'],
    ['ReinhardToneMapping', 'REINHARD'],
    ['CineonToneMapping', 'CINEON'],
    ['ACESFilmicToneMapping', 'ACES_FILMIC'],
    ['AgXToneMapping', 'AGX'],
    ['NeutralToneMapping', 'NEUTRAL'],
  ];
  const defines = {};
  const tone = names.find(([k]) => THREE[k] != null && THREE[k] === renderer.toneMapping);
  if (tone) defines[`${tone[1]}_TONE_MAPPING`] = '';
  const space = renderer.outputColorSpace;
  const transfer = THREE.ColorManagement?.getTransfer?.(space);
  if (transfer != null ? transfer === THREE.SRGBTransfer : space === THREE.SRGBColorSpace) defines.SRGB_TRANSFER = '';
  const material = new THREE.RawShaderMaterial({
    defines,
    uniforms: { tDiffuse: { value: null }, toneMappingExposure: { value: renderer.toneMappingExposure ?? 1 } },
    vertexShader: `precision highp float;
      uniform mat4 modelViewMatrix;
      uniform mat4 projectionMatrix;
      attribute vec3 position;
      attribute vec2 uv;
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `precision highp float;
      uniform sampler2D tDiffuse;
      #include <tonemapping_pars_fragment>
      #include <colorspace_pars_fragment>
      varying vec2 vUv;
      void main() {
        gl_FragColor = texture2D(tDiffuse, vUv);
        #if defined(LINEAR_TONE_MAPPING)
          gl_FragColor.rgb = LinearToneMapping(gl_FragColor.rgb);
        #elif defined(REINHARD_TONE_MAPPING)
          gl_FragColor.rgb = ReinhardToneMapping(gl_FragColor.rgb);
        #elif defined(CINEON_TONE_MAPPING)
          gl_FragColor.rgb = CineonToneMapping(gl_FragColor.rgb);
        #elif defined(ACES_FILMIC_TONE_MAPPING)
          gl_FragColor.rgb = ACESFilmicToneMapping(gl_FragColor.rgb);
        #elif defined(AGX_TONE_MAPPING)
          gl_FragColor.rgb = AgXToneMapping(gl_FragColor.rgb);
        #elif defined(NEUTRAL_TONE_MAPPING)
          gl_FragColor.rgb = NeutralToneMapping(gl_FragColor.rgb);
        #endif
        #ifdef SRGB_TRANSFER
          gl_FragColor = sRGBTransferOETF(gl_FragColor);
        #endif
      }`,
    depthTest: false,
    depthWrite: false,
  });
  const geometry = new THREE.PlaneGeometry(2, 2);
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(geometry, material));
  return {
    material,
    scene,
    camera: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1),
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
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
