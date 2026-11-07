// Zones (decision 6, `setZone`): how long players spend in each zone of an open world or an avatar hub, and how the
// game runs there. Asked for by an avatar-hub puzzle game (a hall, zones around it, puzzle levels in them) that sent
// its own zone timing because no panel showed it.
//
// Time in a zone is played time: the durations of the frame windows drawn there (`duration_s`, as hours played, SPEC
// §4), not the time between events. A frame window never spans two zones (the SDKs close it when the zone changes),
// none is drawn while the game is in the background or unfocused, and it has a duration in every SDK; events have no
// end and come unevenly, and the gap after the last one in a zone is unknown. So:
//   - a zone's share of play time comes from the rollup cells, which keep seconds per zone (`sec`): exact over any
//     range, as hours played are;
//   - each session keeps its own seconds per zone (`zs`, fixed point, ZONES a session, the rest under OTHER), so the
//     median time per session among the sessions that entered a zone, and how many did, come from the sessions over
//     31 days or less, and past that from the day rollups (`zt` per day group: sessions, a quantile map of their
//     seconds, players), exact while small and then estimated as every other per-session median (SPEC §7).
// Time outside every zone is the row `(none)`, so the shares add up to all play time; it has time only (its sessions
// and median are null: the day rollups keep sessions for the zones a session entered).
//
// frameRows() is the frame_time panel split by $zone or $level: frame time p50/p95, frames over budget and hitches per
// minute played per value, from the same cells as the Performance view's by_level and by_zone.

import { newCell, mergeCell, seconds, windowSeconds, FIXED, OTHER } from './rollups.js';
import { Distinct, QMap } from './sketches.js';
import { cellsOf, hasPlayerId, playersAreSessions, round, pct } from './analytics.js';
import { approximate } from './daily.js';

// Zones one session keeps seconds for; a session that wanders through more keeps the rest under OTHER.
export const ZONES = 32;
export const NONE = '(none)';
// The stat metrics about one zone (`zone` on the panel): its share of play time, and the median time in it of the
// sessions that went there.
export const ZONE_METRICS = {
  zone_time_pct: { label: 'Share of play time in zone', unit: '%' },
  zone_median_s: { label: 'Median time in zone', unit: 's' },
};
// What a frame_time panel can split by.
export const FRAME_BY = ['$zone', '$level'];

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// ── each session's seconds per zone (session-state.js) ──

// One frame window into a session: its played seconds under its zone, in the same fixed point as the cells' `sec`.
export function addZoneWindow(s, e) {
  if (!e.zone || !isNum(e.duration_s)) return;
  addZoneSeconds((s.zs ||= {}), e.zone, Math.round(windowSeconds(e) * FIXED.sec));
}

export function mergeZoneSeconds(a, zs) {
  if (!zs) return;
  for (const [zone, sec] of Object.entries(zs)) addZoneSeconds((a.zs ||= {}), zone, sec);
}

function addZoneSeconds(zs, zone, sec) {
  const key = zone in zs || Object.keys(zs).length < ZONES ? zone : OTHER;
  zs[key] = (zs[key] || 0) + sec;
}

// ── the day rollups' sessions per zone (daily.js) ──

// One finalized session into a day group: g.zt, zone → { n: sessions, q: their seconds (QMap), pl: players }.
export function addZoneDay(g, s, caps) {
  if (!s.zs) return;
  for (const [zone, sec] of Object.entries(s.zs)) {
    const x = zoneDayRow(g, zone, caps);
    x.n++;
    x.q.add(sec / FIXED.sec);
    if (hasPlayerId(s)) x.pl.add(s.player_id);
  }
}

function zoneDayRow(g, zone, caps) {
  const zt = (g.zt ||= new Map());
  let key = zone;
  if (!zt.has(key) && zt.size >= caps.zones) {
    key = OTHER;
    g.cut?.add('zones');
  }
  let x = zt.get(key);
  if (!x) zt.set(key, (x = { n: 0, q: new QMap(caps.quantiles), pl: new Distinct(...caps.zonePlayers) }));
  return x;
}

export function zoneDayToJSON(g) {
  return g.zt?.size ? [...g.zt].map(([zone, x]) => [zone, x.n, x.q.toJSON(), x.pl.toJSON()]) : undefined;
}

export function zoneDayFromJSON(list) {
  return list ? new Map(list.map(([zone, n, q, pl]) => [zone, { n, q: QMap.from(q), pl: Distinct.from(pl) }])) : undefined;
}

export function mergeZoneDays(into, g) {
  if (!g.zt) return;
  for (const [zone, x] of g.zt) {
    const y = zoneDayRow(into, zone, into.caps);
    y.n += x.n;
    y.q.merge(x.q);
    y.pl.merge(x.pl);
  }
}

// ── time in zone ──

// Each zone's share of play time and its sessions: { seconds, sessions, rows: [{ zone, seconds, share_pct, sessions,
// sessions_pct, players, median_s }] }, most time first, NONE among them (time only) when some play was outside every
// zone; null when the game set no zone in the range.
export function zoneTime(ctx) {
  if (ctx.zoneTime !== undefined) return ctx.zoneTime;
  const sec = new Map();
  let total = 0;
  for (const { c } of cellsOf(ctx)) {
    if (!c.sec) continue;
    total += c.sec;
    const key = c.zone ?? NONE;
    sec.set(key, (sec.get(key) || 0) + c.sec);
  }
  if (![...sec.keys()].some((k) => k !== NONE)) return (ctx.zoneTime = null);
  const { per, played } = ctx.daily ? dayZoneSessions(ctx) : rangeZoneSessions(ctx);
  const anonymous = playersAreSessions(ctx);
  const rows = [...sec]
    .map(([zone, s]) => {
      const x = per.get(zone);
      const none = zone === NONE;
      return {
        zone,
        seconds: round(s / FIXED.sec, 1),
        share_pct: pct(s, total),
        sessions: none ? null : (x?.sessions ?? 0),
        sessions_pct: none ? null : pct(x?.sessions ?? 0, played),
        players: none || anonymous ? null : (x?.players ?? null),
        median_s: x?.median_s ?? null,
      };
    })
    .sort((a, b) => b.seconds - a.seconds || (a.zone < b.zone ? -1 : 1));
  return (ctx.zoneTime = { seconds: round(total / FIXED.sec, 1), sessions: played, rows });
}

// Over 31 days or less: every session's own seconds per zone.
function rangeZoneSessions(ctx) {
  const per = new Map();
  let played = 0;
  for (const s of ctx.sessions.values()) {
    if (!s.cell?.sec) continue;
    played++;
    for (const [zone, sec] of Object.entries(s.zs || {})) {
      let x = per.get(zone);
      if (!x) per.set(zone, (x = { list: [], players: new Set() }));
      x.list.push(sec / FIXED.sec);
      if (hasPlayerId(s)) x.players.add(s.player_id);
    }
  }
  for (const [zone, x] of per) per.set(zone, { sessions: x.list.length, players: x.players.size, median_s: medianOf(x.list) });
  return { per, played };
}

// Past 31 days: the day groups' sessions per zone. A game that set zones before sessions kept their seconds has
// time from the cells but no sessions for those days.
function dayZoneSessions(ctx) {
  const g = ctx.daily.all;
  const per = new Map();
  for (const [zone, x] of g?.zt || []) {
    approximate(ctx, 'zone_time', x.q.approx || x.pl.approx || g.cut.has('zones'));
    per.set(zone, { sessions: x.n, players: x.pl.count(), median_s: round(x.q.quantile(0.5), 1) });
  }
  return { per, played: g?.fw ?? 0 };
}

function medianOf(list) {
  if (!list.length) return null;
  const xs = list.slice().sort((a, b) => a - b);
  return round(xs[Math.min(xs.length - 1, Math.floor(0.5 * xs.length))], 1);
}

// The Performance view's by_zone rows with each zone's time: share of play time, sessions that went there and their
// median time in it.
export function withZoneTime(ctx, rows) {
  const t = zoneTime(ctx);
  const of = new Map((t?.rows || []).map((r) => [r.zone, r]));
  return rows.map((r) => {
    const z = of.get(r.key);
    return { ...r, sessions: z?.sessions ?? 0, seconds: z?.seconds ?? 0, share_pct: z?.share_pct ?? 0, median_s: z?.median_s ?? null };
  });
}

// A breakdown by $zone without an event: time in each zone. Its rows `{ value, seconds, share_pct, sessions,
// sessions_pct, players, median_s }`, the top `limit` (10) by time; `counts: 'time'`.
export function zoneBreakdown(ctx, p) {
  const t = zoneTime(ctx);
  if (!t) return { empty: true, why: "The game sets no zone in this window: it names where the player is with setZone('hall'), and every frame drawn there counts as time in it." };
  const top = t.rows.slice(0, p.limit || 10);
  return { counts: 'time', total: t.seconds, sessions: t.sessions, rows: top.map(({ zone, ...r }) => ({ value: zone, ...r })), more: t.rows.length - top.length };
}

// A stat about one zone (`zone`): its share of play time, or the median time in it of the sessions that went there.
export function zoneStat(ctx, p) {
  const t = zoneTime(ctx);
  const row = t?.rows.find((r) => r.zone === p.zone);
  if (!row) return { empty: true, why: t ? `No frames were drawn in the zone "${p.zone}" in this window.` : "The game sets no zone in this window: it names where the player is with setZone('hall')." };
  if (p.metric === 'zone_time_pct') return { value: row.share_pct, unit: '%', seconds: row.seconds, total_s: t.seconds, sessions: row.sessions };
  return row.median_s == null ? { empty: true, why: `No session kept its time in "${p.zone}" in this window.` } : { value: row.median_s, unit: 's', sessions: row.sessions, sessions_pct: row.sessions_pct };
}

// ── frame time by zone or level ──

// The frame_time panel by $zone or $level: rows `{ value, frames, seconds, share_pct, p50, p95, p99, pct_over_budget,
// hitches, hitches_per_min, sessions }`, most played first, the top `limit` (10). Sessions per level are the sessions
// that drew frames there; per zone, those that kept seconds there.
export function frameRows(ctx, p) {
  const dim = p.by.slice(1);
  const groups = new Map();
  let total = 0;
  for (const { c } of cellsOf(ctx)) {
    if (!c.fw) continue;
    total += c.sec;
    const key = c[dim] ?? NONE;
    if (!groups.has(key)) groups.set(key, newCell());
    mergeCell(groups.get(key), c);
  }
  if (dim === 'zone' && ![...groups.keys()].some((k) => k !== NONE)) return { empty: true, why: "The game sets no zone in this window: it names where the player is with setZone('hall')." };
  const sessions = dim === 'zone' ? new Map((zoneTime(ctx)?.rows || []).map((r) => [r.zone, r.sessions])) : levelSessions(ctx);
  const rows = [...groups]
    .map(([value, g]) => {
      const secs = seconds(g);
      return {
        value,
        frames: g.frames,
        seconds: round(secs, 1),
        share_pct: pct(g.sec, total),
        p50: round(g.ft.quantile(0.5), 2),
        p95: round(g.ft.quantile(0.95), 2),
        p99: round(g.ft.quantile(0.99), 2),
        pct_over_budget: g.ft.n ? round((g.over / g.ft.n) * 100, 1) : 0,
        hitches: g.hitches,
        hitches_per_min: secs ? round(g.hitches / (secs / 60), 2) : null,
        sessions: sessions.get(value) ?? null,
      };
    })
    .sort((a, b) => b.seconds - a.seconds || (a.value < b.value ? -1 : 1));
  const top = rows.slice(0, p.limit || 10);
  return { by: p.by, rows: top, more: rows.length - top.length };
}

// Sessions that drew frames on each level: the sessions' own levels, or the day groups' (daily.js fwl).
function levelSessions(ctx) {
  const out = new Map();
  if (ctx.daily) {
    for (const [level, n] of ctx.daily.all?.fwl || []) out.set(level === '(menu)' ? NONE : level, n);
    return out;
  }
  for (const s of ctx.sessions.values()) for (const level of s.fwLevels || []) out.set(level ?? NONE, (out.get(level ?? NONE) || 0) + 1);
  return out;
}
