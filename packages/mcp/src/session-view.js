// What glitchless_session hands an agent from the session query's answer ({ session, timeline, frames }, SPEC §3): by
// default a summary, level by level in the order they were played (time, tries, deaths and their causes, the game's own
// events counted, hitches, rage inputs and how it ended there), then how the session ended. A 10-minute session's full
// answer is tens of thousands of characters, more than an agent can keep in mind next to the code; the summary is a
// couple of thousand. timelineView() gives the events themselves, filtered to one level or some kinds of event.

// The SDKs' own custom events: listed apart (rage inputs) or left out of a level's events (the game's own).
const SDK_EVENTS = new Set(['rage_input', 'screen_change', 'app_resume', 'webgl_context_restored', 'annotation', 'assets_loaded']);
// What doesn't go in a level's timeline: frame and server windows are per 5 s, and positions come 4 times a second.
const WINDOWS = new Set(['frame_window', 'server_window', 'pos', 'map']);
const ENDS = { level_complete: 'completed', level_fail: 'failed', level_abandon: 'abandoned' };

const secs = (ms) => Math.round(ms / 100) / 10;
const median = (xs) => {
  const v = xs.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  return v.length ? v[Math.floor((v.length - 1) / 2)] : null;
};
const add = (o, k, n = 1) => (o[k] = (o[k] || 0) + n);
const place = (e) => (e.x != null || e.y != null ? { x: e.x ?? null, y: e.y ?? null, z: e.z ?? null } : {});

export function sessionSummary({ session = {}, timeline = [], frames = [], server_windows: windows = [] }) {
  const events = [...timeline].sort((a, b) => a.ts - b.ts);
  const t0 = session.start ?? events[0]?.ts ?? 0;
  const end = Math.max(t0 + (session.duration_s ?? 0) * 1000, events.at(-1)?.ts ?? t0);
  const at = (ts) => secs(ts - t0);
  const levels = new Map();
  const row = (level) => {
    let l = levels.get(level);
    if (!l) levels.set(level, (l = { level, first_at_s: null, time_s: 0, tries: 0, completed: 0, failed: 0, abandoned: 0, deaths: 0, causes: {}, fail_causes: {}, events: {}, hitches: 0, worst_hitch_ms: null, hitch_causes: {}, errors: 0, rage_inputs: [], outcome: null }));
    return l;
  };
  // Time on a level runs from its start to its end (complete, fail, abandon), the next level's start, or the session's end.
  let open = null; // { level, from }
  const close = (ts, outcome) => {
    if (!open) return;
    const l = row(open.level);
    l.time_s += (ts - open.from) / 1000;
    l.outcome = outcome;
    open = null;
  };
  const menu = { time_s: 0, events: {}, hitches: 0, errors: 0 };
  const errors = new Map();
  const hitches = [];
  const rage = [];
  const reports = [];
  let disconnects = 0;
  for (const e of events) {
    if (e.type === 'level_start') {
      close(e.ts, 'left');
      const l = row(e.level);
      l.tries++;
      if (l.first_at_s == null) l.first_at_s = at(e.ts);
      if (e.attrs && Object.keys(e.attrs).length) l.attrs = e.attrs;
      open = { level: e.level, from: e.ts };
      continue;
    }
    if (ENDS[e.type] && e.level != null) {
      const l = row(e.level);
      l[ENDS[e.type]]++;
      if (e.type === 'level_fail' && e.cause) add(l.fail_causes, e.cause);
      if (open?.level === e.level) close(e.ts, ENDS[e.type]);
      else l.outcome = ENDS[e.type];
      continue;
    }
    // Everything else counts where it happened: its own level, else the level being played, else the menus.
    const where = e.level ?? open?.level ?? null;
    const l = where != null ? row(where) : null;
    if (l && l.first_at_s == null) l.first_at_s = at(e.ts);
    switch (e.type) {
      case 'death':
        if (l) {
          l.deaths++;
          add(l.causes, e.cause ?? 'unknown');
        }
        break;
      case 'custom':
        if (e.name === 'rage_input') {
          const r = { at_s: at(e.ts), level: where, key: e.attrs?.key ?? null, presses: e.attrs?.count ?? null, ...place(e) };
          rage.push(r);
          if (l) l.rage_inputs.push(r);
        } else if (!SDK_EVENTS.has(e.name)) add(l ? l.events : menu.events, e.name);
        break;
      case 'counts':
        for (const c of e.counts || []) if (c?.name) add(l ? l.events : menu.events, c.name, c.n || 1);
        break;
      case 'hitch': {
        const ms = e.duration_ms ?? e.ms ?? null;
        hitches.push({ at_s: at(e.ts), level: where, ms, causes: e.causes ?? [] });
        const into = l ?? menu;
        into.hitches++;
        if (l && ms != null && !(l.worst_hitch_ms >= ms)) l.worst_hitch_ms = Math.round(ms);
        if (l) for (const c of e.causes || []) add(l.hitch_causes, c);
        break;
      }
      case 'error': {
        (l ?? menu).errors++;
        const key = e.fingerprint ?? e.message;
        const x = errors.get(key);
        if (x) x.count++;
        else errors.set(key, { fingerprint: e.fingerprint ?? null, kind: e.kind ?? null, message: String(e.message ?? '').slice(0, 160), first_at_s: at(e.ts), level: where, count: 1 });
        break;
      }
      case 'bug_report':
        reports.push({ at_s: at(e.ts), level: where, note: String(e.note ?? '').slice(0, 160), ...place(e) });
        break;
      case 'disconnect':
        disconnects++;
        break;
    }
  }
  close(end, session.ended === false ? 'still playing' : 'session ended');
  const played = [...levels.values()].reduce((a, l) => a + l.time_s, 0);
  menu.time_s = Math.max(0, Math.round(((end - t0) / 1000 - played) * 10) / 10);
  const byLevel = new Map();
  for (const f of frames) (byLevel.get(f.level ?? null) || byLevel.set(f.level ?? null, []).get(f.level ?? null)).push(f);
  const frameStats = (list = []) => (list.length ? { windows: list.length, fps: median(list.map((f) => f.fps)), p95_ms: median(list.map((f) => f.p95)), worst_ms: Math.max(...list.map((f) => f.max ?? 0)) || null } : null);
  const rows = [...levels.values()].map((l) => {
    const f = frameStats(byLevel.get(l.level));
    return {
      level: l.level,
      first_at_s: l.first_at_s,
      time_s: Math.round(l.time_s * 10) / 10,
      tries: l.tries,
      ...(l.attrs ? { attrs: l.attrs } : {}),
      completed: l.completed,
      ...(l.failed ? { failed: l.failed, ...(Object.keys(l.fail_causes).length ? { fail_causes: l.fail_causes } : {}) } : {}),
      ...(l.abandoned ? { abandoned: l.abandoned } : {}),
      deaths: l.deaths,
      ...(Object.keys(l.causes).length ? { causes: l.causes } : {}),
      ...(Object.keys(l.events).length ? { events: l.events } : {}),
      hitches: l.hitches,
      ...(l.hitches ? { worst_hitch_ms: l.worst_hitch_ms, ...(Object.keys(l.hitch_causes).length ? { hitch_causes: l.hitch_causes } : {}) } : {}),
      ...(f ? { frames: f } : {}),
      ...(l.errors ? { errors: l.errors } : {}),
      ...(l.rage_inputs.length ? { rage_inputs: l.rage_inputs.map(({ level, ...r }) => r) } : {}),
      outcome: l.outcome,
    };
  });
  const s = session;
  const menuFrames = frameStats(byLevel.get(null));
  return {
    session: {
      session_id: s.session_id,
      player_id: s.player_id ?? null,
      session_type: s.session_type,
      ...(s.marked_tester ? { marked_tester: true } : {}),
      version: s.version,
      env: s.env,
      start: s.start != null ? new Date(s.start).toISOString() : null,
      duration_s: s.duration_s,
      device: [s.browser, s.os, s.gpu, s.gpu_tier && `${s.gpu_tier} tier`, s.steam_deck && 'Steam Deck'].filter(Boolean).join(', ') || null,
      ...(s.props ? { props: s.props } : {}),
      ...(s.groups?.length ? { groups: s.groups.map(({ kind, id, attrs }) => ({ kind, id, ...(attrs ? { attrs } : {}) })) } : {}),
      frame_p50_ms: s.p50 ?? null,
      frame_p95_ms: s.p95 ?? null,
      pct_over_budget: s.pct_over_budget ?? null,
    },
    levels: rows,
    ...(menu.time_s || Object.keys(menu.events).length || menu.hitches || menu.errors ? { outside_levels: { time_s: menu.time_s, ...(Object.keys(menu.events).length ? { events: menu.events } : {}), hitches: menu.hitches, ...(menuFrames ? { frames: menuFrames } : {}), ...(menu.errors ? { errors: menu.errors } : {}) } } : {}),
    hitches: { count: hitches.length, worst: [...hitches].sort((a, b) => (b.ms ?? 0) - (a.ms ?? 0)).slice(0, 5) },
    ...(errors.size ? { errors: [...errors.values()] } : {}),
    ...(rage.length ? { rage_inputs: rage } : {}),
    ...(reports.length ? { bug_reports: reports } : {}),
    ...(disconnects ? { disconnects } : {}),
    ...(windows.length ? { server: { windows: windows.length, tick_p95_max: Math.max(...windows.map((w) => w.tick_p95 ?? 0)) || null, players_max: Math.max(...windows.map((w) => w.players ?? 0)) } } : {}),
    outcome: {
      ended: s.ended ?? null,
      crashed: Boolean(s.crashed),
      rage_quit: Boolean(s.rage_quit),
      ...(s.rage_quit && s.rage ? { rage: s.rage } : {}),
      last_level: rows.at(-1)?.level ?? null,
      levels_completed: s.completed ?? rows.filter((l) => l.completed).map((l) => l.level),
    },
    timeline_events: events.filter((e) => !WINDOWS.has(e.type)).length,
  };
}

// The events themselves: `level` keeps that level's (its own, and what happened while it was played), `types` the
// events of those types or custom event names ("death,hitch", "room_done"; "frames" adds the frame windows). Each
// gets `at_s`, seconds from the session's start. At most `limit`, from the first; `total` says how many matched.
export function timelineView({ session = {}, timeline = [], frames = [] }, { level = null, types = null, limit = 150 } = {}) {
  const want = types ? new Set(String(types).split(',').map((x) => x.trim()).filter(Boolean)) : null;
  const events = [...timeline].sort((a, b) => a.ts - b.ts);
  const t0 = session.start ?? events[0]?.ts ?? 0;
  let current = null;
  const out = [];
  for (const e of events) {
    if (e.type === 'level_start') current = e.level;
    const where = e.level ?? current;
    if (ENDS[e.type] && e.level === current) current = null;
    if (WINDOWS.has(e.type)) continue;
    if (level != null && where !== level) continue;
    if (want && !want.has(e.type) && !(e.name && want.has(e.name)) && !(e.type === 'counts' && (e.counts || []).some((c) => want.has(c.name)))) continue;
    out.push({ at_s: secs(e.ts - t0), ...e });
  }
  const windows = want?.has('frames') || want?.has('frame_window') ? frames.filter((f) => level == null || f.level === level).map(({ ctx, ...f }) => ({ at_s: secs(f.ts - t0), ...f, ...ctx })) : null;
  return { total: out.length, events: out.slice(0, limit), ...(windows ? { frames: windows.slice(0, limit) } : {}) };
}
