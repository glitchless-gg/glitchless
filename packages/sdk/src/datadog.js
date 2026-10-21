// Optional bridge into Datadog RUM (browser SDK v7). Glitchless speaks game semantics; this maps them
// onto RUM primitives so the same session is visible in Datadog with no extra game code:
//   level attempt → RUM Operation (+ duration vital)    death / pickups → RUM Action
//   frame window  → custom duration vital "frame_p95"   hitch → custom duration vital "hitch"
//   errors        → RUM Error                           level / GPU tier → global context
// Every call is guarded: RUM API names have moved between majors, and telemetry must never break a game.

const CDN_REGION = {
  'datadoghq.com': 'us1',
  'us3.datadoghq.com': 'us3',
  'us5.datadoghq.com': 'us5',
  'datadoghq.eu': 'eu1',
  'ap1.datadoghq.com': 'ap1',
  'ap2.datadoghq.com': 'ap2',
};

export class DatadogBridge {
  constructor(opts) {
    this.cfg = { site: 'datadoghq.com', ...opts.datadog };
    this.opts = opts;
    this.rum = null;
    this.pending = [];
    if (typeof window === 'undefined') return;
    if (window.DD_RUM?.init) this.attach(window.DD_RUM, false);
    else if (this.cfg.applicationId && this.cfg.clientToken) this.load();
  }

  load() {
    const region = CDN_REGION[this.cfg.site] || 'us1';
    const s = document.createElement('script');
    s.src = this.cfg.scriptUrl || `https://www.datadoghq-browser-agent.com/${region}/v7/datadog-rum.js`;
    s.async = true;
    s.onload = () => window.DD_RUM && this.attach(window.DD_RUM, true);
    document.head.appendChild(s);
  }

  attach(rum, init) {
    if (init) {
      rum.init({
        applicationId: this.cfg.applicationId,
        clientToken: this.cfg.clientToken,
        site: this.cfg.site,
        service: this.opts.service,
        env: this.opts.env,
        version: this.opts.version,
        sessionSampleRate: 100,
        sessionReplaySampleRate: this.cfg.replay ? 100 : 0,
        trackUserInteractions: true,
        trackResources: true,
        trackLongTasks: true,
        defaultPrivacyLevel: 'mask-user-input',
        // Experimental in v7.9+: replay WebGL canvases instead of a blank rectangle.
        ...(this.cfg.replay ? { sessionReplayCanvasRecording: { enable: true, quality: 'low' } } : {}),
      });
    }
    this.rum = rum;
    this.call('setGlobalContextProperty', 'game', { service: this.opts.service, sdk: 'glitchless' });
    const queued = this.pending;
    this.pending = [];
    queued.forEach(([m, args]) => this.call(m, ...args));
  }

  call(method, ...args) {
    if (!this.rum) {
      if (this.pending.length < 200) this.pending.push([method, args]);
      return;
    }
    try {
      this.rum[method]?.(...args);
    } catch {
      // never let RUM API drift break the game loop
    }
  }

  levelStart(level) {
    this.call('setGlobalContextProperty', 'game.level', level);
    this.call('startOperation', 'level', { operationKey: level, context: { level } });
    this.call('startDurationVital', `level_${level}`, { context: { level } });
  }

  levelComplete(level, ctx) {
    this.call('succeedOperation', 'level', { operationKey: level, context: { level, ...ctx } });
    this.call('stopDurationVital', `level_${level}`, { context: { level, outcome: 'complete' } });
  }

  levelFail(level, cause) {
    this.call('failOperation', 'level', 'error', { operationKey: level, context: { level, cause } });
    this.call('stopDurationVital', `level_${level}`, { context: { level, outcome: 'fail', cause } });
  }

  action(name, ctx) {
    this.call('addAction', name, ctx);
  }

  error(err, ctx) {
    this.call('addError', err, ctx);
  }

  frameWindow(fw) {
    const now = Date.now();
    if (fw.ft_p95 != null) {
      this.call('addDurationVital', 'frame_p95', {
        startTime: now - fw.ft_p95,
        duration: fw.ft_p95,
        context: { level: fw.level, fps: fw.fps, draw_calls: fw.draw_calls, hitches: fw.hitches, ...prefix(fw.ctx) },
      });
    }
    this.call('setGlobalContextProperty', 'game.fps', fw.fps);
  }
}

function prefix(ctx = {}) {
  const out = {};
  for (const [k, v] of Object.entries(ctx)) out[`ctx_${k}`] = v;
  return out;
}
