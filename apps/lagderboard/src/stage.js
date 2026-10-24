// Renderer, scene, camera, floor and the sun. Every device gets the same settings (pixel ratio capped at 2, one
// 1024 px shadow map, MSAA), so a score compares devices, not quality presets.
import * as THREE from 'three';

export const BG = 0x070b18;

export function createStage(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(BG);
  scene.fog = new THREE.Fog(BG, 40, 160);

  const camera = new THREE.PerspectiveCamera(48, window.innerWidth / window.innerHeight || 1, 0.1, 4000);

  scene.add(new THREE.HemisphereLight(0x8aa4ff, 0x0b0820, 0.9));
  const sun = new THREE.DirectionalLight(0xfff1dd, 2.2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.bias = -0.0008;
  sun.shadow.normalBias = 0.04;
  scene.add(sun, sun.target);

  const floor = new THREE.Mesh(new THREE.CircleGeometry(1, 96), new THREE.MeshLambertMaterial({ color: 0x0c1226 }));
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  floor.name = 'floor';
  scene.add(floor);

  const grid = new THREE.PolarGridHelper(1, 24, 12, 96, 0x2ee6a6, 0x1d2a55);
  grid.material.transparent = true;
  grid.material.opacity = 0.22;
  grid.material.depthWrite = false;
  grid.position.y = 0.01;
  grid.name = 'grid';
  scene.add(grid);

  const view = { azimuth: 0.6, distance: 20, height: 8, target: new THREE.Vector3(0, 2, 0), shake: 0 };

  // Frame a mound `h` tall with a base `radius` wide: a phone in portrait crops the sides a little, so the
  // mound stays big on screen instead of shrinking to fit the width.
  function frame(h, radius, dt) {
    const aspect = camera.aspect;
    const vfov = THREE.MathUtils.degToRad(camera.fov);
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * aspect);
    const wantW = 2 * radius * (aspect < 1 ? 0.78 : 1.15);
    const wantH = h * 2.3 + 4;
    const dist = Math.max(wantW / 2 / Math.tan(hfov / 2), wantH / 2 / Math.tan(vfov / 2)) + radius * 0.35;
    if (!Number.isFinite(dist)) return; // a zero-size window (a hidden pane) has no aspect yet
    if (!Number.isFinite(view.distance)) view.distance = dist;
    const k = 1 - Math.exp(-dt * 3.5);
    view.distance += (dist - view.distance) * k;
    view.height += (h * 0.95 + 3 - view.height) * k;
    view.target.y += (h * 0.55 + 0.6 - view.target.y) * k;
  }

  function update(dt, time, { h, radius, orbit = 0.07 }) {
    frame(h, radius, dt);
    view.azimuth += orbit * dt;
    const s = view.shake;
    const jx = s ? (Math.sin(time * 61) + Math.sin(time * 37)) * s * 0.5 : 0;
    const jy = s ? Math.sin(time * 53) * s * 0.5 : 0;
    camera.position.set(Math.cos(view.azimuth) * view.distance + jx, view.height + jy, Math.sin(view.azimuth) * view.distance);
    camera.lookAt(view.target);

    const span = Math.max(12, radius * 1.4 + 6);
    sun.position.set(span * 0.55, span * 1.4, span * 0.35);
    sun.target.position.set(0, 0, 0);
    const cam = sun.shadow.camera;
    if (Math.abs(cam.right - span) > 0.5) {
      cam.left = -span;
      cam.right = span;
      cam.top = span;
      cam.bottom = -span;
      cam.near = 0.5;
      cam.far = span * 4;
      cam.updateProjectionMatrix();
    }
    const ground = Math.max(60, view.distance * 3);
    floor.scale.setScalar(ground);
    grid.scale.setScalar(Math.max(18, radius * 2.2));
    scene.fog.near = view.distance * 0.9;
    scene.fog.far = view.distance * 3.2;
  }

  function resize() {
    if (!window.innerWidth || !window.innerHeight) return;
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight, false);
  }
  window.addEventListener('resize', resize);

  return { renderer, scene, camera, sun, view, update, resize };
}
