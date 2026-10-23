// Player bug reports (SPEC §2 bug_report): what a player typed, a screenshot, where they were, and what the game
// was doing just before. Stores keep them apart from the events, the way they keep map thumbnails: a small record
// that lists cheaply (everything but the screenshot) and the screenshot, read one report at a time. So no report
// reaches the event files, rollups, summaries or Parquet, and a 200 KB picture never slows a query.
//
// Every store has:
//   reports(projectId, service, { from, to })  records of the range, newest first (at most MAX_REPORTS)
//   getReport(projectId, service, id)          one record with its `screenshot` (a data URL), or null
//   deleteReport(projectId, service, id)       deletes one, screenshot and all (a player asked): true if it was there

import crypto from 'node:crypto';

export const MAX_REPORTS = 500;
const MAX_NOTE = 2000;
const MAX_RECENT = 30;
const MAX_FRAMES = 12;
const MAX_ITEM_JSON = 1000;

// A report is stored once: the same report sent again (a retried batch) gets the same id.
export function reportId(projectId, e) {
  return 'r_' + crypto.createHash('sha256').update([projectId, e.service, e.session_id, e.ts, e.note ?? ''].join('\n')).digest('hex').slice(0, 20);
}

// A bug_report event → { record, screenshot }. The record is bounded (a store may keep it and the screenshot in one
// database row), and `screenshot` is the data URL or null.
export function splitReport(projectId, e) {
  const { screenshot, note, recent, frames, device, ...rest } = e;
  const shot = typeof screenshot === 'string' && screenshot.startsWith('data:image/') ? screenshot : null;
  const record = {
    ...rest,
    project_id: projectId,
    id: reportId(projectId, e),
    note: typeof note === 'string' ? note.slice(0, MAX_NOTE) : '',
    recent: bounded(recent, MAX_RECENT),
    frames: bounded(frames, MAX_FRAMES),
    device: device && typeof device === 'object' && !Array.isArray(device) && JSON.stringify(device).length <= MAX_ITEM_JSON * 2 ? device : null,
    has_screenshot: !!shot,
  };
  return { record, screenshot: shot };
}

// The last `n` small objects of a list.
function bounded(list, n) {
  if (!Array.isArray(list)) return [];
  return list.filter((x) => x && typeof x === 'object' && !Array.isArray(x) && JSON.stringify(x).length <= MAX_ITEM_JSON).slice(-n);
}

// A screenshot data URL → { type, ext, bytes } when it is base64 (what every SDK sends), else null.
export function decodeScreenshot(dataUrl) {
  const m = /^data:(image\/(jpeg|png|webp|gif));base64,/.exec(dataUrl || '');
  if (!m) return null;
  return { type: m[1], ext: m[2] === 'jpeg' ? 'jpg' : m[2], bytes: Buffer.from(dataUrl.slice(m[0].length), 'base64') };
}

export function encodeScreenshot(type, bytes) {
  return `data:${type};base64,${Buffer.from(bytes).toString('base64')}`;
}

// The reports a query shows: the range's (as stored), narrowed by its env, version, sessions and session type.
export function reportsOf(list, ctx) {
  const q = ctx.q;
  return list.filter((r) => {
    if (q.env && r.env !== q.env) return false;
    if (q.version && r.version !== q.version) return false;
    if (q.sessions && !q.sessions.has(r.session_id)) return false;
    // The context's sessions are already those of the type (a daily context has none to check against).
    if (q.type && q.type !== 'all' && !ctx.daily && !ctx.sessions.has(r.session_id)) return false;
    return true;
  });
}

// One report as a list shows it. The device is the report's own, else its session's.
export function reportSummary(r, ctx = null) {
  const position = [r.x, r.y, r.z].some((v) => typeof v === 'number') ? { x: r.x ?? null, y: r.y ?? null, z: r.z ?? null } : null;
  return {
    id: r.id,
    ts: r.ts,
    session_id: r.session_id,
    level: r.level ?? null,
    version: r.version,
    env: r.env,
    note: r.note,
    position,
    device: deviceLine(r.device || ctx?.sessions?.get(r.session_id)?.device),
    has_screenshot: !!r.has_screenshot,
  };
}

// One report in full: what the player was doing (recent events, frame windows) and, unless left out, the screenshot.
export function reportDetail(r, ctx = null, { screenshot = true } = {}) {
  return {
    ...reportSummary(r, ctx),
    sdk: r.sdk ?? null,
    recent: r.recent || [],
    frames: r.frames || [],
    ...(screenshot ? { screenshot: r.screenshot ?? null } : {}),
  };
}

// "Chrome 141 · macOS · Apple M2 (high)": what the dashboard and agents need to know about the machine.
function deviceLine(d) {
  if (!d || typeof d !== 'object') return null;
  const browser = [d.browser, d.browser_version].filter(Boolean).join(' ');
  const parts = [browser, d.model, d.os, d.gpu].filter((x) => typeof x === 'string' && x);
  if (!parts.length) return null;
  return parts.join(' · ') + (d.gpu_tier ? ` (${d.gpu_tier})` : '');
}

// How to get back to a level to reproduce what players reported there, in the game's engine (findings.js engineOf).
const REPRODUCE = {
  godot: (level) => `reproduce it on ${level} (run the game from the Godot editor and play to the place in the screenshot)`,
  unity: (level) => `reproduce it on ${level} (enter Play mode in the Unity Editor and play to the place in the screenshot)`,
  unreal: (level) => `reproduce it on ${level} (play it in the editor with Play In Editor, to the place in the screenshot; with the Glitchless Toolset and Unreal MCP, Measure there)`,
  gamemaker: (level) => `reproduce it on ${level} (run the game from GameMaker and play to the place in the screenshot, or room_goto the room in a test build)`,
  web: (level) => `reproduce it on ${level} (load the level over WebMCP if the game has a tool for it)`,
};

// Several reports on one level in the window: what players said there, with a link to each report.
export function reportFindings(ctx, totalSessions, engine = 'web') {
  const byLevel = new Map();
  for (const r of ctx.reports || []) {
    if (r.level == null) continue;
    (byLevel.get(r.level) || byLevel.set(r.level, []).get(r.level)).push(r);
  }
  const out = [];
  for (const [level, list] of byLevel) {
    if (list.length < 3) continue;
    const sessions = new Set(list.map((r) => r.session_id));
    const notes = list.map((r) => r.note.trim().replace(/\s+/g, ' ')).filter(Boolean);
    const quoted = [...new Set(notes)].slice(0, 3).map((n) => `"${n.length > 120 ? n.slice(0, 117) + '…' : n}"`);
    const versions = [...new Set(list.map((r) => r.version))];
    out.push({
      id: `reports-${level}`,
      severity: list.length >= 10 || sessions.size >= 5 ? 'high' : 'medium',
      category: 'reports',
      title: `${list.length} bug reports on ${level}`,
      summary:
        `Players sent ${list.length} bug reports on ${level} from ${sessions.size} ${sessions.size === 1 ? 'session' : 'sessions'}${versions.length === 1 ? ` (all on ${versions[0]})` : ''}.` +
        (quoted.length ? ` They wrote: ${quoted.join('; ')}.` : ' None of them wrote a note.'),
      evidence: {
        level,
        reports: list.length,
        sessions: sessions.size,
        versions,
        latest: list.slice(0, 10).map((r) => ({ id: r.id, ts: r.ts, session_id: r.session_id, version: r.version, note: r.note, has_screenshot: !!r.has_screenshot })),
      },
      suggestion: `Read each report with its screenshot and position (glitchless_bug_reports with its id), then open its session to see what led up to it. Reports that say the same thing at the same place are one bug: ${(REPRODUCE[engine] || REPRODUCE.web)(level)}, fix it, and bump the version so new reports show whether it is gone.`,
      link: { page: 'reports', level },
      impact: sessions.size / totalSessions,
    });
  }
  return out;
}

// A session's reports as timeline entries (the replay shows where each was sent).
export function reportTimeline(list, sessionId) {
  return list.filter((r) => r.session_id === sessionId).map((r) => ({ type: 'bug_report', ts: r.ts, level: r.level ?? null, id: r.id, note: r.note, has_screenshot: !!r.has_screenshot }));
}
