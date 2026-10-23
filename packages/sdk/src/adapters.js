// What the Babylon.js and PlayCanvas adapters share: level names, canvas captures, the watch for a render loop that
// stopped, and the thresholds for what one frame uploads.

// What one frame has to upload before it counts as a cause of that frame's hitch (as in three.js).
export const TEXTURE_BURST = 4;
export const TEXTURE_PIXELS = 1 << 20;
export const BUFFER_BURST = 32;
export const BUFFER_BYTES = 4 << 20;
export const SPAWN_BURST = 50; // objects added in one frame that count as a spawn burst
export const GAUGE_EVERY = 30; // frames between gauge samples; hitches sample on the spot

// Scene names that are menus, loaders or overlays rather than levels: "Boot", "Preloader", "MainMenu", "UI", "HUD",
// "GameOver"… Matched on words, after splitting camelCase and underscores (as the Phaser adapter does).
const NOT_A_LEVEL = /\b(boot|preload(er)?|load(er|ing)?|splash|intro|title|menu|main ?menu|ui|hud|overlay|pause[d]?|game ?over|settings|options|credits|leaderboard|shop)\b/i;

export function readsAsLevel(name) {
  const words = String(name).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z])([A-Z][a-z])/g, '$1 $2').replace(/[_\-.]+/g, ' ');
  return !NOT_A_LEVEL.test(words);
}

// A JPEG of the canvas, at most maxWidth wide. Call it right after the engine renders: without
// preserveDrawingBuffer the drawing buffer is cleared once the frame is shown.
export function copyCanvas(src, maxWidth = 960) {
  if (!src?.width || typeof document === 'undefined') return null;
  const scale = Math.min(1, maxWidth / src.width);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(src.width * scale);
  canvas.height = Math.round(src.height * scale);
  canvas.getContext('2d').drawImage(src, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.8);
}

// A canvas as a JPEG small enough for a map event (as three.js's captureMap does).
export function mapJpeg(canvas) {
  let quality = 0.75;
  let image = canvas.toDataURL('image/jpeg', quality);
  while (image.length > 60_000 && quality > 0.3) {
    quality -= 0.15;
    image = canvas.toDataURL('image/jpeg', quality);
  }
  return image;
}

// A screenshot taken right after the next frame renders: `park(done)` hands `done` to the adapter, which calls it with
// copyCanvas() at the end of its next frame. If no frame comes within a second (the loop stopped), whatever the canvas
// holds is taken.
export function nextFrameShot(canvas, maxWidth, park) {
  return new Promise((resolve) => {
    const done = (img) => {
      clearTimeout(timer);
      resolve(img);
    };
    done.maxWidth = maxWidth;
    park(done);
    const timer = setTimeout(() => {
      park(null);
      resolve(copyCanvas(canvas(), maxWidth));
    }, 1000);
  });
}

// An uncaught error inside an engine's frame can stop its loop for good (Babylon.js queues the next frame only after a
// frame finishes): the screen freezes and the player can only leave. Reported once per stop, with that error's stack.
export function watchLoopStop(gd, { engineName, lastFrameAt, running, stallMs = 2000 }) {
  if (typeof window === 'undefined' || typeof setInterval === 'undefined') return;
  let lastUncaught = null;
  let halted = false;
  let haltedAt = 0;
  window.addEventListener('error', (e) => {
    lastUncaught = { message: String(e.error?.message ?? e.message ?? 'Unknown error').slice(0, 200), name: e.error?.name, stack: e.error?.stack, source: e.filename, line: e.lineno, col: e.colno };
  });
  const watch = setInterval(() => {
    const at = lastFrameAt();
    if (halted && at > haltedAt) halted = false; // frames came back
    if (halted || !at || !lastUncaught || (typeof document !== 'undefined' && document.hidden) || !running()) return;
    if (performance.now() - at < stallMs) return;
    halted = true;
    haltedAt = at;
    const cause = lastUncaught.name ? `${lastUncaught.name}: ${lastUncaught.message}` : lastUncaught.message;
    const { stack, source, line, col } = lastUncaught;
    gd.reportError({ kind: 'game_loop_stopped', message: `${engineName}'s render loop stopped after an uncaught error: ${cause}`, error: stack ? { stack } : null, source, line, col, attrs: { stalled_ms: Math.round(performance.now() - at) } });
    gd.flush();
  }, 1000);
  watch.unref?.(); // Node (tests): don't keep the process alive
  return () => clearInterval(watch);
}

// Times of recent events (shader compiles), to count how many came in a window before a hitch. Keeps the last 512.
export function recentTimes() {
  const times = [];
  return {
    add(t) {
      times.push(t);
      if (times.length > 512) times.splice(0, times.length - 512);
    },
    since(t) {
      let n = 0;
      for (let i = times.length - 1; i >= 0 && times[i] >= t; i--) n++;
      return n;
    },
  };
}

export function basename(url) {
  return String(url).split(/[?#]/)[0].split('/').pop();
}

export function round1(v) {
  return v == null || Number.isNaN(v) ? null : Math.round(v * 10) / 10;
}
