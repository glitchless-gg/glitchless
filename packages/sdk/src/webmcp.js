// WebMCP: the running game becomes a tool server for coding agents.
//
// Two transports, same tool definitions:
//  • webmcp.dev bridge (works today with Claude Code / Codex / Cursor):
//      claude mcp add webmcp -- npx -y @jason.today/webmcp@latest --mcp
//    then ask the agent for a WebMCP token and paste it into the widget on the game page.
//  • W3C WebMCP (`document.modelContext.registerTool`, Chrome origin trial) for in-browser agents.

const TEXT = (obj) => (typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2));

export function builtInTools(gd) {
  return [
    {
      name: 'glitchless_live_performance',
      description:
        'Live frame-time stats for the running game session: fps, p50/p95/worst frame time vs the frame budget, draw calls, triangles, geometry/texture/shader counts, JS heap, hitch count, current level and game context gauges (e.g. particle counts). Call this first when investigating stutter or slowness.',
      inputSchema: { type: 'object', properties: {} },
      readOnly: true,
      execute: () => {
        const s = gd.liveStats();
        if (!s) return 'No frames rendered yet.';
        return {
          service: gd.opts.service,
          version: gd.opts.version,
          level: gd.level,
          refresh_hz: s.hz,
          frame_budget_ms: round(s.budget),
          fps: round(s.fps),
          frame_ms: { p50: round(s.p50), p95: round(s.p95), worst: round(s.max), window_frames: gd.ringCount },
          renderer: { draw_calls: s.render?.calls ?? null, triangles: s.render?.triangles ?? null, render_cpu_ms: round(s.render?.ms) },
          memory: { ...s.memory, js_heap_mb: s.heap },
          hitches_this_session: gd.stats.hitches,
          errors_this_session: gd.stats.errors,
          context_gauges: gd.ctx,
          recent_hitches: gd.recentHitches.slice(-5),
        };
      },
    },
    {
      name: 'glitchless_measure',
      description:
        'Measure frame performance over the next N seconds (default 5, max 30) and return a summary: frame-time percentiles, hitches with likely causes, draw calls avg/max, peak context gauges, and geometry/texture deltas (leaks). Use it before and after a code change, or while triggering a game action, to get a clean A/B number.',
      inputSchema: { type: 'object', properties: { seconds: { type: 'number', description: 'Duration to measure, 1-30 seconds' } } },
      readOnly: true,
      execute: async ({ seconds = 5 } = {}) => gd.measure(Math.min(30, Math.max(1, Number(seconds) || 5))),
    },
    {
      name: 'glitchless_errors',
      description: 'JavaScript errors, unhandled promise rejections and WebGL context losses seen in this session, grouped by fingerprint, with stack traces, occurrence counts and the game events right before the first occurrence.',
      inputSchema: { type: 'object', properties: {} },
      readOnly: true,
      execute: () => {
        const issues = [...gd.errorLog.values()].sort((a, b) => b.count - a.count);
        return issues.length ? { issues } : 'No errors in this session. 🎉';
      },
    },
    {
      name: 'glitchless_game_events',
      description: 'The most recent gameplay events in this session (level starts/completes/fails, deaths with world position and cause, custom design events like pickups), newest last.',
      inputSchema: { type: 'object', properties: { limit: { type: 'number', description: 'Max events (default 40)' } } },
      readOnly: true,
      execute: ({ limit = 40 } = {}) => gd.history.slice(-Math.min(200, Number(limit) || 40)),
    },
    {
      name: 'glitchless_inspect_scene',
      description:
        'Summarize the live scene. Three.js: object counts by type, unique geometries/materials, lights and shadow casters, the most numerous object groups (flagging groups that should use InstancedMesh or shared geometry/material) and the heaviest meshes by triangle count. Phaser: each running scene\'s display list by type and texture, physics bodies, tweens, particles and event listeners (a count that grows on every restart is a leak), plus the most numerous object groups (flagging dead objects that should be destroyed or pooled). Babylon.js: per scene, meshes, active meshes and whether they are frozen, instances and thin instances, materials, textures, lights, shadow generators and render observers, plus mesh groups flagging copies that should be instances or thin instances and materials that should be shared. PlayCanvas: entities, mesh instances, materials, lights, scripts by type, the device\'s shaders and textures, plus entity groups flagging copies that should be instanced or batched.',
      inputSchema: { type: 'object', properties: { top: { type: 'number', description: 'How many object groups to list (default 10)' } } },
      readOnly: true,
      execute: ({ top = 10 } = {}) => gd.render?.inspectScene?.({ top }) ?? 'No scene attached: call instrumentThree, instrumentPhaser, instrumentBabylon or instrumentPlayCanvas after Glitchless.init.',
    },
    {
      name: 'glitchless_screenshot',
      description: 'Capture a JPEG screenshot of the game canvas as it is right now.',
      inputSchema: { type: 'object', properties: {} },
      readOnly: true,
      image: true,
      execute: () => gd.render?.screenshot?.() ?? 'No renderer attached.',
    },
    {
      name: 'glitchless_session',
      description: 'Identity and context of this play session: service, version, env, session/player ids, device and GPU tier, uptime, telemetry destination and a link to the session in the Glitchless dashboard.',
      inputSchema: { type: 'object', properties: {} },
      readOnly: true,
      execute: () => ({
        service: gd.opts.service,
        version: gd.opts.version,
        env: gd.opts.env,
        session_id: gd.sessionId,
        player_id: gd.playerId,
        uptime_s: Math.round((Date.now() - gd.startedAt) / 1000),
        device: gd.device(),
        intake: gd.opts.intake,
        events_sent: gd.stats.sent,
        dashboard: gd.opts.dashboardUrl ? `${gd.opts.dashboardUrl}/#/sessions/${gd.sessionId}` : null,
        game_tools: gd.customTools.map((t) => t.name),
      }),
    },
    {
      name: 'glitchless_annotate',
      description: 'Drop an annotation into this session\'s telemetry timeline (e.g. "agent: switched confetti to InstancedMesh"). It shows up in the Glitchless dashboard next to the frame-time graph, so humans can see what the agent changed and when.',
      inputSchema: { type: 'object', properties: { note: { type: 'string' } }, required: ['note'] },
      execute: ({ note }) => {
        gd.track('annotation', { note: String(note).slice(0, 280), author: 'agent' });
        return 'Annotation recorded.';
      },
    },
  ];
}

export class WebMCPBridge {
  constructor(gd, config = {}) {
    this.gd = gd;
    // Bottom-right, the corner games already keep free for the overlay: the pairing button sits just left of
    // it instead of over the game's own HUD. An explicit `position` goes where it says.
    this.placeByOverlay = !config.position;
    this.config = { bridge: true, standard: true, position: 'bottom-right', color: '#14213D', ...config };
    this.bridge = null;
    this.standard = false;
    this.registered = new Set();
    this.aborts = [];
    this.start();
  }

  status() {
    if (this.bridge?.isConnected) return 'connected';
    if (this.standard) return 'ready';
    if (this.bridge) return 'pair me';
    return 'off';
  }

  // Read lazily: games usually register their own tools right after init, while the bridge client
  // is still loading — whatever exists when a transport comes up gets registered then, the rest via add().
  allTools() {
    return [...builtInTools(this.gd), ...this.gd.customTools];
  }

  async start() {
    const mc = typeof document !== 'undefined' && (document.modelContext || navigator.modelContext);
    if (this.config.standard && mc?.registerTool) {
      this.standard = true;
      for (const t of this.allTools()) this.registerStandard(mc, t);
    }
    if (this.config.bridge) {
      try {
        const { default: WebMCP } = await import('./vendor/webmcp.js');
        this.bridge = new WebMCP({ color: this.config.color, position: this.config.position, size: '30px', padding: '14px' });
        const widget = document.getElementById(this.bridge.elementId);
        if (widget && this.placeByOverlay && this.gd.overlay) widget.style.right = '290px';
        for (const t of this.allTools()) this.registerBridge(t);
      } catch (err) {
        this.gd.log('WebMCP bridge unavailable', err);
      }
    }
  }

  add(tool) {
    const mc = document.modelContext || navigator.modelContext;
    if (this.standard && mc) this.registerStandard(mc, tool);
    if (this.bridge) this.registerBridge(tool);
  }

  registerStandard(mc, t) {
    const ac = new AbortController();
    this.aborts.push(ac);
    Promise.resolve(
      mc.registerTool(
        {
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: { readOnlyHint: !!t.readOnly },
          execute: async (args) => TEXT(await t.execute(args || {})),
        },
        { signal: ac.signal },
      ),
    ).catch((err) => this.gd.log('modelContext.registerTool failed', t.name, err));
  }

  registerBridge(t) {
    this.bridge.registerTool(t.name, t.description, t.inputSchema, async (args) => {
      try {
        const result = await t.execute(args || {});
        if (t.image && typeof result === 'string' && result.startsWith('data:image/')) {
          const [meta, data] = result.split(',');
          return { content: [{ type: 'image', data, mimeType: meta.slice(5, meta.indexOf(';')) }] };
        }
        return { content: [{ type: 'text', text: TEXT(result) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    });
  }
}

function round(v) {
  return v == null ? null : Math.round(v * 100) / 100;
}
