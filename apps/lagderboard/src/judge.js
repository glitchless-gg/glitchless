// The referee. A run ends when Glitchless measures p95 frame time over the limit (slower than 30 fps) for HOLD_S
// seconds in a row. It asks gd.measure(), the same call coding agents make through the glitchless_measure WebMCP
// tool: a WINDOW_S probe starts every STEP_MS, so the windows overlap and a verdict comes four times a second.
// p95 frame time is the time the slowest 5% of frames took.

export const LIMIT_MS = 33.4; // the SDK's own jank line: two missed 60 Hz frames, i.e. under 30 fps
export const HOLD_S = 3;
const WINDOW_S = 1;
const STEP_MS = 250;

export class Judge {
  constructor(gd) {
    this.gd = gd;
    this.running = false;
    this.timer = null;
    this.streak = null; // { startedAt, cubes } of the first slow window in a row
    this.last = null; // the latest measurement, for the HUD
    this.onMeltdown = null;
  }

  // A 30 Hz screen (an iPhone in Low Power Mode) shows 33.3 ms frames even when idle, so its line sits a bit higher.
  limitMs() {
    return Math.max(LIMIT_MS, (this.gd.budgetMs || 0) * 1.2);
  }

  start(getCubes) {
    this.stop();
    this.getCubes = getCubes;
    this.running = true;
    this.streak = null;
    this.last = null;
    this.lastGood = null;
    this.timer = setInterval(() => this.probe(), STEP_MS);
  }

  stop() {
    this.running = false;
    clearInterval(this.timer);
    this.timer = null;
  }

  async probe() {
    const startedAt = performance.now();
    const cubes = this.getCubes();
    const r = await this.gd.measure(WINDOW_S);
    if (!this.running) return;
    let p95;
    if (typeof r === 'string' || !r.frames) {
      // No frames counted. In a background tab that's a pause; on screen it means frames took so long the SDK
      // dropped them as throttling (over 700 ms each), which is as slow as it gets.
      if (document.visibilityState !== 'visible') {
        this.streak = null;
        return;
      }
      p95 = Infinity;
    } else p95 = r.frame_ms.p95;
    const limit = this.limitMs();
    const over = p95 > limit;
    this.last = { p95, fps: r.fps ?? 0, frames: r.frames ?? 0, drawCalls: r.draw_calls?.avg ?? null, hitches: r.hitch_count ?? 0, cubes, over, limit };
    if (!over) {
      this.streak = null;
      this.lastGood = cubes; // the load at the start of the latest window that held 30 fps
      return;
    }
    // The score is the load at the start of the first slow window: the most cubes the device held while
    // Glitchless still measured it at 30 fps or better.
    if (!this.streak) this.streak = { startedAt, cubes, worstP95: p95 };
    this.streak.worstP95 = Math.max(this.streak.worstP95, p95);
    const heldMs = startedAt + WINDOW_S * 1000 - this.streak.startedAt;
    if (heldMs >= HOLD_S * 1000) {
      this.stop();
      this.onMeltdown?.({ score: this.streak.cubes, limitMs: limit, heldS: heldMs / 1000, lastP95: p95, worstP95: this.streak.worstP95, hz: this.gd.hz });
    }
  }

  // 0..1 through the hold, for the countdown ring. Stops short of 1: only a measurement ends the run.
  progress(now = performance.now()) {
    if (!this.streak) return 0;
    return Math.min(0.97, (now - this.streak.startedAt) / (HOLD_S * 1000));
  }
}
