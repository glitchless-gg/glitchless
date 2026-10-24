// Store reviews and store vitals: what players write about a game on its store pages, and what each store measures of
// it (Google Play's slow rendering, crashes and ANRs; the App Store's hangs, launch time and animation hitches), joined
// to what Glitchless measures, by build and version. "The reviews say it stutters since the update" becomes which
// build, which devices, and the frame times and crashes measured on that build's version; "Play says 1.4.2 crashes for
// 3% of users" sits next to the crash-free sessions Glitchless saw on 1.4.2, with a line where the two disagree.
// Store-neutral: a store adapter (steam.js, app-store.js here; Google Play and the App Store Connect API in Glitchless
// Cloud) turns its answers into the shapes below; storage, the join, the board panels, the finding and the queries are
// here, once, for every store. SPEC §3f.
//
// A review, as every store gives it:
//   { store, id, ts, up, rating, lang, text, topics, version, device: { os, cpu, gpu, ram_mb, model } | null,
//     <store>: { …what only that store has } }
// `up` is the store's thumbs-up (a star rating of 4 or 5 where the store has stars, then `rating` is 1–5); `version`
// is the game's version when the store says which one was reviewed (Google Play, the App Store; null on Steam, where
// the join finds it); text is cut to 500 characters after its topics are found.
//
// A vital, as every store gives it: { metric, value, version, build, day, period: 'day' | 'version', users,
// percentile, device } — a rate in percent, a time in ms or a rate per hour, as VITALS says. Google Play's come per day
// and version code (`build`); the App Store's per version, over the versions Apple keeps (`period: 'version'`).
//
// A host hands the core every store a game is connected to (createApp({ stores })), as ctx.stores:
//   { <store>: { store, app_id, synced_at, keys, summary: { desc, positive, negative, total } | null,
//                hours: [[hour, up, down, down_perf, up_deck, down_deck, down_perf_deck]],   counts per hour
//                reviews: [Review], reviews_from, capped,                                       newest first
//                releases: [Mark], notes: [Mark],      the store's release history; notes (patch notes) when it has none
//                vitals: [Vital], snapshots: { devices?, hangs? },
//                players: [[ts, n]] | null, sales: [{ day, units, returns }] | null,
//                wishlists: [{ day, adds, deletes, purchases, gifts }] | null } }
//   Mark: { source, build_id?, version?, from, title?, url?, approx? }
import { versions, pct, round } from './analytics.js';

const HOUR = 3_600_000;
const DAY = 86_400_000;
// What a store has beyond reviews: players online, sales, a segment of reviewers counted apart (Steam Deck), the
// session fact that names a session's build when the game's SDK sends it (SPEC §4c), whether its reviews name their
// version, and the vitals it reports.
export const STORES = {
  steam: { name: 'Steam', players: true, sales: true, segment: 'Steam Deck', buildFact: 'steam_build', versioned: false, vitals: [] },
  google_play: { name: 'Google Play', players: false, sales: false, segment: null, buildFact: null, versioned: true, vitals: ['slow_rendering_20fps', 'slow_rendering_30fps', 'crash_rate', 'anr_rate'] },
  app_store: { name: 'App Store', players: false, sales: false, segment: null, buildFact: null, versioned: true, vitals: ['hang_rate', 'launch_time', 'animation_hitch_rate'] },
};
const storeName = (store) => STORES[store]?.name ?? store;
const NOT_CONNECTED = 'This game has no store connected (Glitchless Cloud: Settings → Integrations).';

// What a store measures of a game, and what of Glitchless's own measures it compares with (`vs`).
//   slow_rendering_*  Google Play: users in a day with slow rendering (frames slower than 20 or 30 fps) — Glitchless:
//                     sessions with over a quarter of their frames that slow
//   crash_rate        Google Play: users in a day with a crash — Glitchless: sessions that crashed
//   anr_rate          Google Play: users in a day whose game stopped answering for 5 seconds (no Glitchless match)
//   hang_rate         the App Store: seconds the game hung, per hour of use — Glitchless: hitches a minute
//   launch_time       the App Store: launch to first frame — Glitchless: time to first frame
//   animation_hitch_rate  the App Store: ms of hitches per second of animation — Glitchless: hitches a minute
export const VITALS = {
  slow_rendering_20fps: { label: 'Slow rendering (under 20 fps)', unit: '%', vs: 'slow20_pct' },
  slow_rendering_30fps: { label: 'Slow rendering (under 30 fps)', unit: '%', vs: 'slow30_pct' },
  crash_rate: { label: 'Crash rate', unit: '%', vs: 'crashed_pct' },
  anr_rate: { label: 'ANR rate', unit: '%', vs: null },
  hang_rate: { label: 'Hang rate', unit: 's/h', vs: 'hitches_per_min' },
  launch_time: { label: 'Launch time', unit: 'ms', vs: 'ttff_p50' },
  animation_hitch_rate: { label: 'Animation hitches', unit: 'ms/s', vs: 'hitches_per_min' },
};

// Stored items live this long past their day or month (the longest plan's retention).
const KEEP_DAYS = 400;
// A day's reviews are one stored item, under DynamoDB's 400 KB: past this many bytes a review is counted, its text
// not kept.
const DAY_BYTES = 300_000;
// What a read hands the join: reviews newest first, at most this many, and counts per hour over at least 30 days
// (a finding compares the latest build with the time before it).
const READ_REVIEWS = 3000;
const LOOKBACK = 30 * DAY;
const RECORD_DAYS = 62;
const SNAPSHOTS = ['devices', 'hangs'];

// ───────────────────────────── topics ─────────────────────────────

// What a negative review about how the game runs mentions, in the languages most reviews are written in. Latin and
// Cyrillic words match from the start of a word (Latin ones whole); CJK and Hangul as written.
export const TOPICS = {
  stutter: [/\b(?:micro-?)?stutter\w*|\bhitch(?:es|ing|y)?\b|\bjudder\w*|\bframe ?drops?\b|\bframe ?pacing\b|\bchoppy\b|\bruckel\w*|\bruckler\b|\bsaccad\w*|\btirones\b|\bengasg\w*/i, /(?<![а-яё])(?:статтер|подтормаж)/i, /卡顿|掉帧|カクつ|カクカク|끊김|버벅/],
  lag: [/\blag(?:s|gy|ging|ged)?\b|\binput delay\b/i, /(?<![а-яё])(?:лаг|тормоз)/i, /延迟|렉(?:이|걸|심|때)/],
  fps: [/\bfps\b|\bframe ?rates?\b|\bframes per second\b/i, /帧数|帧率|フレームレート|프레임/],
  freeze: [/\bfreez(?:e|es|ing)\b|\bfroze(?:n)?\b|\bnot responding\b|\bfriert\b|\beingefroren\b|\bcongel\w*|\bse traba\b|\btrava(?:ndo|mento|s|r|ou)?\b/i, /(?<![а-яё])(?:зависа|фриз)/i, /卡死|死机|フリーズ|固ま|멈춤|멈춰/],
  crash: [/\bcrash(?:es|ed|ing|y)?\b|\bctd\b|\bcrashea\w*|\bcrasha\w*|\babst(?:u|ü)rz\w*|\bst(?:u|ü)rzt\b[^.!?]{0,30}\bab\b|\bplant(?:e|ent|age)\b|\bwon'?t (?:launch|start)\b|\bfails? to (?:launch|start)\b|\bse cierra\b|\bfecha sozinho\b/i, /(?<![а-яё])(?:вылет|краш)/i, /闪退|崩溃|クラッシュ|落ちる|튕(?:김|겨|기)/],
};
const TOPIC_WORDS = { stutter: 'stutter', lag: 'lag', fps: 'fps', freeze: 'freezes', crash: 'crashes' };

export function reviewTopics(text) {
  return Object.keys(TOPICS).filter((t) => TOPICS[t].some((re) => re.test(text)));
}

// A review's text as kept: BBCode and control characters out, whitespace to single spaces, topics found in all of
// it, then cut to 500 characters. → { text, topics }
export function reviewText(raw) {
  const text = plain(raw);
  return { topics: reviewTopics(text), text: text.length > 500 ? `${text.slice(0, 499).trimEnd()}…` : text };
}

// Counted apart (Steam Deck on Steam).
const inSegment = (r) => r.steam?.deck === true;

// ───────────────────────────── stored data ─────────────────────────────

// A game's store data in a pk/sk store: get(pk, sk), put(item), query(pk, prefix), remove(pk, sk) (Glitchless Cloud's
// control table; a JSON file will do). One writer at a time per game and store (the host's sync holds a lease).
//
//   STORE#<projectId>#<store>  R#<YYYY-MM-DD>     { reviews, extra }   that day's reviews (UTC); `extra`: ids counted,
//                                                                      their text not kept, past the item's size
//   STORE#<projectId>#<store>  RH#<YYYY-MM>       { hours: { <hour>: [up, down, down_perf, up_deck, down_deck, down_perf_deck] } }
//   STORE#<projectId>#<store>  PL#<YYYY-MM>       { samples: [[ts, players]] }
//   STORE#<projectId>#<store>  SALES#<YYYY-MM>    { days: { <YYYY-MM-DD>: { units, returns } } }   (the store's days)
//   STORE#<projectId>#<store>  WISH#<YYYY-MM>     { days: { <YYYY-MM-DD>: { adds, deletes, purchases, gifts } } }
//   STORE#<projectId>#<store>  VIT#<YYYY-MM>      { rows: { <key>: Vital } }   vitals by day (a day sent again replaces)
//   STORE#<projectId>#<store>  VITV               { rows: { <key>: Vital } }   vitals by version, the latest of each
//   STORE#<projectId>#<store>  SNAP#<name>        the latest of a snapshot: devices (the worst devices and GPUs), hangs
//   STORE#<projectId>#<store>  RELEASES | NOTES   { items: [Mark] }
//   STORE#<projectId>#<store>  META               { summary, synced_at, reviews }
//   STORE#<projectId>#<store>  X#<name>           what the store adapter keeps for itself (Steam: its builds)
//
// Every day or month item has `expiresAt` (seconds), 400 days after its period.
export function createStoreData(kv) {
  const pk = (projectId, store) => `STORE#${projectId}#${store}`;
  const expires = (endMs) => Math.floor((endMs + KEEP_DAYS * DAY) / 1000);
  const monthEnd = (month) => Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1);
  const vitalKey = (v) => [v.period === 'version' ? '' : v.day, v.build ?? v.version, v.metric, v.percentile ?? '', v.device ?? ''].join('|');

  async function addReviews(key, reviews) {
    const byDay = new Map();
    for (const r of reviews) {
      const day = isoDay(r.ts);
      if (!byDay.has(day)) byDay.set(day, new Map());
      byDay.get(day).set(r.id, r);
    }
    const hours = new Map(); // month → { hour: counts } of the reviews that are new
    let added = 0;
    for (const [day, fresh] of byDay) {
      const item = (await kv.get(key, `R#${day}`)) ?? { reviews: [], extra: [] };
      const seen = new Set([...item.reviews.map((r) => r.id), ...(item.extra ?? [])]);
      // Bytes, as DynamoDB counts an item (UTF-8): a CJK character is three of them.
      let bytes = Buffer.byteLength(JSON.stringify(item.reviews));
      const extra = [...(item.extra ?? [])];
      const kept = [...item.reviews];
      for (const r of fresh.values()) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        added++;
        const size = Buffer.byteLength(JSON.stringify(r)) + 1;
        if (bytes + size <= DAY_BYTES) {
          kept.push(r);
          bytes += size;
        } else extra.push(r.id);
        const month = day.slice(0, 7);
        if (!hours.has(month)) hours.set(month, {});
        const h = (hours.get(month)[Math.floor(r.ts / HOUR) * HOUR] ??= [0, 0, 0, 0, 0, 0]);
        const perf = !r.up && r.topics.length > 0;
        h[r.up ? 0 : 1]++;
        if (perf) h[2]++;
        if (inSegment(r)) {
          h[r.up ? 3 : 4]++;
          if (perf) h[5]++;
        }
      }
      if (kept.length === item.reviews.length && extra.length === (item.extra ?? []).length) continue;
      kept.sort((a, b) => b.ts - a.ts);
      await kv.put({ pk: key, sk: `R#${day}`, reviews: kept, extra, expiresAt: expires(Date.parse(`${day}T00:00:00Z`) + DAY) });
    }
    for (const [month, add] of hours) {
      const item = (await kv.get(key, `RH#${month}`)) ?? { hours: {} };
      for (const [hour, c] of Object.entries(add)) item.hours[hour] = (item.hours[hour] ?? [0, 0, 0, 0, 0, 0]).map((v, i) => v + c[i]);
      await kv.put({ pk: key, sk: `RH#${month}`, hours: item.hours, expiresAt: expires(monthEnd(month)) });
    }
    return added;
  }

  async function addDays(key, prefix, rows, pick) {
    const byMonth = new Map();
    for (const row of rows) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(row.day)) continue;
      const month = row.day.slice(0, 7);
      if (!byMonth.has(month)) byMonth.set(month, []);
      byMonth.get(month).push(row);
    }
    for (const [month, list] of byMonth) {
      const item = (await kv.get(key, `${prefix}#${month}`)) ?? { days: {} };
      // A day the store sends again (late settlements) replaces what was there.
      for (const row of list) item.days[row.day] = pick(row);
      await kv.put({ pk: key, sk: `${prefix}#${month}`, days: item.days, expiresAt: expires(monthEnd(month)) });
    }
  }

  async function addVitals(key, vitals) {
    const byMonth = new Map();
    const byVersion = [];
    for (const v of vitals) {
      if (!VITALS[v.metric] || !Number.isFinite(v.value)) continue;
      if (v.period === 'version') byVersion.push(v);
      else if (/^\d{4}-\d{2}-\d{2}$/.test(v.day ?? '')) {
        const month = v.day.slice(0, 7);
        if (!byMonth.has(month)) byMonth.set(month, []);
        byMonth.get(month).push(v);
      }
    }
    for (const [month, list] of byMonth) {
      const item = (await kv.get(key, `VIT#${month}`)) ?? { rows: {} };
      for (const v of list) item.rows[vitalKey(v)] = v;
      await kv.put({ pk: key, sk: `VIT#${month}`, rows: item.rows, expiresAt: expires(monthEnd(month)) });
    }
    if (byVersion.length) {
      const item = (await kv.get(key, 'VITV')) ?? { rows: {} };
      for (const v of byVersion) item.rows[vitalKey(v)] = v;
      // The latest versions' only: a store keeps a few versions of these.
      const rows = Object.entries(item.rows).sort((a, b) => (b[1].day ?? '').localeCompare(a[1].day ?? '')).slice(0, 400);
      await kv.put({ pk: key, sk: 'VITV', rows: Object.fromEntries(rows) });
    }
  }

  return {
    // What one sync brought: any of { reviews, players: [ts, n] (or a list of them), releases, notes, summary, sales,
    // wishlists, vitals, snapshots: { devices?, hangs? }, extras: { <name>: object } }. → reviews added
    async write(projectId, store, batch) {
      const key = pk(projectId, store);
      const added = batch.reviews?.length ? await addReviews(key, batch.reviews) : 0;
      if (batch.players) {
        const byMonth = new Map();
        for (const [ts, n] of Array.isArray(batch.players[0]) ? batch.players : [batch.players]) {
          const month = isoDay(ts).slice(0, 7);
          if (!byMonth.has(month)) byMonth.set(month, []);
          byMonth.get(month).push([ts, n]);
        }
        for (const [month, list] of byMonth) {
          const item = (await kv.get(key, `PL#${month}`)) ?? { samples: [] };
          const have = new Set(item.samples.map(([t]) => t));
          item.samples.push(...list.filter(([t]) => !have.has(t)));
          await kv.put({ pk: key, sk: `PL#${month}`, samples: item.samples.sort((a, b) => a[0] - b[0]), expiresAt: expires(monthEnd(month)) });
        }
      }
      if (batch.releases) await kv.put({ pk: key, sk: 'RELEASES', items: batch.releases.slice(-100) });
      if (batch.notes) await kv.put({ pk: key, sk: 'NOTES', items: batch.notes.slice(-50) });
      if (batch.vitals?.length) await addVitals(key, batch.vitals);
      for (const [name, value] of Object.entries(batch.snapshots ?? {})) if (SNAPSHOTS.includes(name) && value) await kv.put({ pk: key, sk: `SNAP#${name}`, ...value });
      for (const [name, value] of Object.entries(batch.extras ?? {})) await kv.put({ pk: key, sk: `X#${name}`, ...value });
      if (batch.sales?.length) await addDays(key, 'SALES', batch.sales, ({ units, returns }) => ({ units, returns }));
      if (batch.wishlists?.length) await addDays(key, 'WISH', batch.wishlists, ({ adds, deletes, purchases, gifts }) => ({ adds, deletes, purchases, gifts }));
      const meta = (await kv.get(key, 'META')) ?? {};
      await kv.put({ pk: key, sk: 'META', summary: batch.summary ?? meta.summary ?? null, synced_at: batch.syncedAt ?? Date.now(), reviews: (meta.reviews ?? 0) + added });
      return added;
    },

    // What the store adapter kept for itself under X#<name>, or null.
    async extra(projectId, store, name) {
      const item = await kv.get(pk(projectId, store), `X#${name}`);
      if (!item) return null;
      const { pk: _, sk, ...rest } = item;
      return rest;
    },

    // The data for a range, as ctx.stores takes it (without app_id and keys, which the host adds). Counts per hour
    // from 30 days before `to` at the latest; reviews newest first from `recordsFrom` (default: the same, at most 62
    // days back), at most 3,000 (`capped` says when there were more); vitals by day over the same days, and by version.
    async read(projectId, store, { from, to, recordsFrom = null }) {
      const key = pk(projectId, store);
      const since = Math.min(from, to - LOOKBACK);
      const months = monthsBetween(since, to);
      const [meta, releases, notes, byVersion, ...rest] = await Promise.all([
        kv.get(key, 'META'),
        kv.get(key, 'RELEASES'),
        kv.get(key, 'NOTES'),
        kv.get(key, 'VITV'),
        ...SNAPSHOTS.map((s) => kv.get(key, `SNAP#${s}`)),
        ...months.flatMap((m) => ['RH', 'PL', 'SALES', 'WISH', 'VIT'].map((p) => kv.get(key, `${p}#${m}`))),
      ]);
      const snaps = rest.slice(0, SNAPSHOTS.length);
      const monthly = rest.slice(SNAPSHOTS.length);
      const hours = [];
      const players = [];
      const sales = [];
      const wishlists = [];
      const vitals = Object.values(byVersion?.rows ?? {});
      const [lo, hi] = [isoDay(since), isoDay(to)];
      months.forEach((m, i) => {
        const [rh, pl, sa, wi, vi] = monthly.slice(i * 5, i * 5 + 5);
        for (const [hour, c] of Object.entries(rh?.hours ?? {})) if (+hour >= since - HOUR && +hour <= to) hours.push([+hour, ...c]);
        for (const s of pl?.samples ?? []) if (s[0] >= since && s[0] <= to) players.push(s);
        for (const [day, v] of Object.entries(sa?.days ?? {})) sales.push({ day, ...v });
        for (const [day, v] of Object.entries(wi?.days ?? {})) wishlists.push({ day, ...v });
        for (const v of Object.values(vi?.rows ?? {})) if (v.day >= lo && v.day <= hi) vitals.push(v);
      });
      const recLo = recordsFrom ?? Math.max(since, to - RECORD_DAYS * DAY);
      const reviews = [];
      let capped = false;
      for (const prefix of dayPrefixes(recLo, to)) {
        for (const item of (await kv.query(key, prefix)).reverse()) {
          for (const r of item.reviews ?? []) if (r.ts >= recLo && r.ts <= to) reviews.push(r);
          if (item.extra?.length) capped = true;
        }
        if (reviews.length >= READ_REVIEWS) {
          capped = true;
          break;
        }
      }
      reviews.sort((a, b) => b.ts - a.ts);
      const strip = (item) => {
        if (!item) return null;
        const { pk: _, sk, ...value } = item;
        return value;
      };
      return {
        store,
        synced_at: meta?.synced_at ?? null,
        summary: meta?.summary ?? null,
        hours: hours.sort((a, b) => a[0] - b[0]),
        reviews: reviews.slice(0, READ_REVIEWS),
        reviews_from: recLo,
        capped,
        releases: releases?.items ?? [],
        notes: notes?.items ?? [],
        vitals,
        snapshots: Object.fromEntries(SNAPSHOTS.map((s, i) => [s, strip(snaps[i])]).filter(([, v]) => v)),
        players: STORES[store]?.players ? players.sort((a, b) => a[0] - b[0]) : null,
        sales: sales.length ? sales.sort((a, b) => (a.day < b.day ? -1 : 1)) : null,
        wishlists: wishlists.length ? wishlists.sort((a, b) => (a.day < b.day ? -1 : 1)) : null,
      };
    },

    async stats(projectId, store) {
      const meta = await kv.get(pk(projectId, store), 'META');
      return meta ? { reviews: meta.reviews ?? 0, syncedAt: meta.synced_at ?? null, summary: meta.summary ?? null } : null;
    },

    // Everything synced for a game from one store (a disconnected or changed app).
    async clear(projectId, store) {
      const items = await kv.query(pk(projectId, store), '');
      for (const item of items) await kv.remove(item.pk, item.sk);
      return items.length;
    },
  };
}

// Day-item prefixes from `to` back to `from`, newest first: R#2026-10-3 (the 30th and 31st), R#2026-10-2 (20th–29th),
// R#2026-10-1, R#2026-10-0, then the month before, so a read stops once it has enough.
function dayPrefixes(from, to) {
  const out = [];
  for (const month of monthsBetween(from, to).reverse()) {
    for (const d of ['3', '2', '1', '0']) {
      const first = Date.parse(`${month}-${d === '0' ? '01' : `${d}0`}T00:00:00Z`);
      const last = d === '3' ? Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1) : Date.parse(`${month}-${d === '0' ? '10' : `${Number(d) + 1}0`}T00:00:00Z`);
      if (Number.isNaN(first) || first > to || last <= from) continue;
      out.push(`R#${month}-${d}`);
    }
  }
  return out;
}

function monthsBetween(from, to) {
  const out = [];
  const d = new Date(Math.max(0, from));
  let y = d.getUTCFullYear();
  let m = d.getUTCMonth();
  while (Date.UTC(y, m, 1) <= to) {
    out.push(`${y}-${String(m + 1).padStart(2, '0')}`);
    if (++m === 12) [y, m] = [y + 1, 0];
  }
  return out;
}

const isoDay = (ts) => new Date(ts).toISOString().slice(0, 10);

// ───────────────────────────── the join ─────────────────────────────

// Each release of a game on a store, oldest first: when it went live and which Glitchless version it was. From the
// store's release history (Steam: the builds set live on the default branch, with the publisher key; the App Store:
// its versions), else for a store whose reviews and vitals name their version, the versions they name, else the builds
// the game's sessions name (the SDK's Steam build, SPEC §4c), else the store's patch notes, else the versions
// Glitchless saw first. → [{ key, label, version, build_id, from, to, source, title }]
export function storeReleases(ctx, st) {
  if (!st) return [];
  return (st.releaseCache ??= releasesOf(ctx, st));
}

function releasesOf(ctx, st) {
  const vers = versionsOf(ctx);
  const fact = STORES[st.store]?.buildFact;
  const known = [...new Set([...vers.map((v) => v.version), ...(st.versions ?? [])])].filter(Boolean).sort((a, b) => b.length - a.length);
  const usable = (list) => (list ?? []).filter((m) => Number.isFinite(m.from));
  let marks = usable(st.releases);
  if (!marks.length && STORES[st.store]?.versioned) marks = versionsNamed(st);
  if (!marks.length && fact) marks = buildsSeen(ctx, fact);
  if (!marks.length) marks = usable(st.notes);
  if (!marks.length) marks = vers.filter((v) => v.sessions >= 3).map((v) => ({ source: 'version', version: v.version, from: v.first_seen }));
  marks = [...marks].sort((a, b) => a.from - b.from);
  return marks.map((m, i) => {
    const to = marks[i + 1]?.from ?? Infinity;
    const buildId = m.build_id != null ? String(m.build_id) : null;
    const version = m.version ?? (buildId && fact ? versionOfBuild(ctx, fact, buildId) : null) ?? versionIn(m.title, known) ?? dominantVersion(vers, m.from, to);
    const label = buildId && m.source !== 'store_version' ? `build ${buildId}${version ? ` (${version})` : ''}` : m.source === 'patch_notes' ? (version ?? (m.title?.length > 40 ? `${m.title.slice(0, 39)}…` : (m.title ?? ''))) : version;
    return { key: (m.source === 'store_version' ? version : buildId) ?? version ?? `notes-${m.from}`, label, version, build_id: buildId, from: m.from, to, source: m.source, title: m.title || null, ...(m.approx ? { approx: true } : {}), ...(m.url ? { url: m.url } : {}) };
  });
}

// The versions a store's reviews and vitals name, each from its first review (or day of vitals).
function versionsNamed(st) {
  const first = new Map();
  const build = new Map();
  for (const r of st.reviews ?? []) if (r.version) first.set(r.version, Math.min(first.get(r.version) ?? Infinity, r.ts));
  for (const v of st.vitals ?? []) {
    if (!v.version) continue;
    if (v.build != null) build.set(v.version, String(v.build));
    if (v.period !== 'version' && v.day) first.set(v.version, Math.min(first.get(v.version) ?? Infinity, Date.parse(`${v.day}T00:00:00Z`)));
    else if (!first.has(v.version)) first.set(v.version, Infinity);
  }
  return [...first].filter(([, from]) => Number.isFinite(from)).map(([version, from]) => ({ source: 'store_version', version, from, ...(build.has(version) ? { build_id: build.get(version) } : {}) }));
}

// Builds the sessions name (session_start's device[fact]) seen in 3 or more sessions: each from its first session.
function buildsSeen(ctx, fact) {
  const builds = new Map();
  for (const s of ctx.sessions?.values() ?? []) {
    const b = s.device?.[fact];
    if (b == null || b === '' || b === 0) continue;
    const at = s.start ?? s.first_ts;
    const g = builds.get(String(b)) ?? { first: Infinity, n: 0 };
    g.first = Math.min(g.first, at);
    g.n++;
    builds.set(String(b), g);
  }
  return [...builds].filter(([, g]) => g.n >= 3).map(([id, g]) => ({ source: 'sessions', build_id: id, from: g.first }));
}

// The version most of the sessions that name this build ran.
function versionOfBuild(ctx, fact, buildId) {
  const n = new Map();
  for (const s of ctx.sessions?.values() ?? []) if (String(s.device?.[fact] ?? '') === buildId && s.version) n.set(s.version, (n.get(s.version) || 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

// A known version written in a build description or patch notes title ("Patch 1.4.2", "v1.4.2 hotfix").
function versionIn(title, known) {
  if (!title) return null;
  return known.find((v) => new RegExp(`(^|[^\\w.])v?${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\w.])`, 'i').test(title)) ?? null;
}

// The version most sessions ran that Glitchless first saw while this release was live.
function dominantVersion(vers, from, to) {
  const live = vers.filter((v) => v.first_seen >= from - 6 * HOUR && v.first_seen < to);
  return live.sort((a, b) => b.sessions - a.sessions)[0]?.version ?? null;
}

function versionsOf(ctx) {
  return (ctx.reviewVersions ??= versions(ctx, { events: 0 }));
}

// The version most sessions ran that Glitchless first saw before a release went live: what players had before it,
// when the store names no release before (a first sync knows only the build on each branch now).
function versionBefore(ctx, ts) {
  return versionsOf(ctx).filter((v) => v.first_seen < ts - 6 * HOUR).sort((a, b) => b.sessions - a.sessions)[0]?.version ?? null;
}

// The release a review belongs to: the one it names (a store that says which version was reviewed), else the one
// live when it was written.
function releaseOf(rels, r) {
  if (r.version) {
    const named = rels.filter((x) => x.version === r.version);
    if (named.length) return named.at(-1);
  }
  let at = null;
  for (const x of rels) if (x.from <= r.ts) at = x;
  return at;
}

const emptyCounts = () => ({ reviews: 0, up: 0, down: 0, perf: 0, up_deck: 0, down_deck: 0, perf_deck: 0 });

// Review counts over [from, to) from the hourly counts.
function countsIn(hours, from, to) {
  const c = emptyCounts();
  for (const [hour, up, down, perf, upDeck, downDeck, perfDeck] of hours) {
    if (hour < from || hour >= to) continue;
    c.up += up;
    c.down += down;
    c.perf += perf;
    c.up_deck += upDeck;
    c.down_deck += downDeck;
    c.perf_deck += perfDeck;
  }
  c.reviews = c.up + c.down;
  return c;
}

// Review counts of the reviews kept that `keep` takes (a store whose reviews name their version is counted by version,
// from the reviews themselves).
function countsOf(reviews, keep) {
  const c = emptyCounts();
  for (const r of reviews) {
    if (!keep(r)) continue;
    const perf = !r.up && r.topics.length > 0;
    c[r.up ? 'up' : 'down']++;
    if (perf) c.perf++;
    if (inSegment(r)) {
      c[r.up ? 'up_deck' : 'down_deck']++;
      if (perf) c.perf_deck++;
    }
  }
  c.reviews = c.up + c.down;
  return c;
}

// A release's reviews in [from, to]: by the version they name where the store says it, else by when they were written.
function releaseCounts(st, rels, rel, from, to) {
  if (STORES[st.store]?.versioned) return countsOf(st.reviews, (r) => r.ts >= from && r.ts <= to && releaseOf(rels, r) === rel);
  return countsIn(st.hours, Math.max(rel.from, from), Math.min(rel.to, to + 1));
}

// Each release live in [from, to] with its reviews in the window and what Glitchless measured on its version, newest
// first. Reviews from before the first release Glitchless knows of are a row of their own.
function releaseRows(ctx, st, rels, from, to) {
  const vers = new Map(versionsOf(ctx).map((v) => [v.version, v]));
  const segment = Boolean(STORES[st.store]?.segment);
  const versioned = STORES[st.store]?.versioned;
  const row = (r, c) => {
    const v = r.version ? vers.get(r.version) : null;
    return {
      key: r.key,
      label: r.label,
      version: r.version,
      build_id: r.build_id,
      source: r.source,
      from: r.from,
      to: Number.isFinite(r.to) ? r.to : null,
      reviews: c.reviews,
      positive_pct: pct(c.up, c.reviews),
      negative: c.down,
      perf_negative: c.perf,
      perf_pct: pct(c.perf, c.reviews),
      deck_pct: segment ? pct(c.up_deck + c.down_deck, c.reviews) : null,
      sessions: v?.sessions ?? null,
      frame_p95: v?.frame_p95 ?? null,
      crash_free_pct: v ? v.crash_free_pct : null,
    };
  };
  const live = rels.filter((r) => (versioned ? true : r.from <= to && r.to > from));
  const rows = live.map((r) => row(r, releaseCounts(st, rels, r, from, to))).filter((r) => !versioned || r.reviews);
  const first = rels[0];
  if (!first || first.from > from) {
    const c = versioned ? countsOf(st.reviews, (r) => r.ts >= from && r.ts <= to && !releaseOf(rels, r)) : countsIn(st.hours, from, first ? Math.min(first.from, to + 1) : to + 1);
    if (c.reviews) rows.unshift(row({ key: 'before', label: first ? `before ${first.label}` : 'every build', version: first ? versionBefore(ctx, first.from) : null, build_id: null, source: null, from: null, to: first?.from ?? Infinity }, c));
  }
  return rows.reverse();
}

// The store a panel or query names, else the game's first connected one.
function pickStore(ctx, store) {
  const all = ctx.stores ?? {};
  if (store) return all[store] ?? null;
  return Object.values(all)[0] ?? null;
}

// ── board panels (board.js) ──

// The store panel types: default titles (with the panel's `store`), sizes, and whether a share link shows them (units,
// returns and wishlists are a game's business, so only on a link made to show sums).
export const STORE_PANELS = {
  store_reviews: { title: (p) => `${p.store ? storeName(p.store) : 'Store'} reviews by build`, size: 'l', shared: true },
  store_vitals: { title: (p) => `${p.store ? storeName(p.store) : 'Store'} vitals next to Glitchless`, size: 'l', shared: true },
  store_players: { title: (p) => `On ${p.store ? storeName(p.store) : 'the store'} now vs measured`, size: 'm', shared: true },
  store_sales: { title: () => 'Units, returns and wishlists', size: 'm', shared: 'sums' },
};

// A store panel's own field: `store`, one of STORES (default: the game's first connected store). → fields or throws.
export function storePanelFields(p, at, BoardError) {
  if (p.store == null) return {};
  if (!STORES[p.store]) throw new BoardError(`${at}.store must be one of ${Object.keys(STORES).join(', ')}`);
  return { store: p.store };
}

// A page per connected store on the automatic dashboard: its reviews by build, its vitals next to Glitchless's, its
// players online, frame times (to read next to the reviews), its units, returns and wishlists.
export function storePages(ctx, { frames = false } = {}) {
  return Object.entries(ctx.stores ?? {}).map(([store, st]) => ({
    id: store.replace(/_/g, '-'),
    title: storeName(store),
    icon: 'flag',
    panels: [
      { type: 'store_reviews', store, size: 'l' },
      ...(STORES[store]?.vitals.length ? [{ type: 'store_vitals', store, size: 'l' }] : []),
      ...(STORES[store]?.players ? [{ type: 'store_players', store, size: 'm' }] : []),
      ...(frames ? [{ type: 'frame_time', size: 'm' }] : []),
      ...(st.sales || st.wishlists || st.keys?.financial ? [{ type: 'store_sales', store, size: 'l' }] : []),
    ],
  }));
}

export function storePanel(ctx, p) {
  const st = pickStore(ctx, p.store);
  if (!st) return { empty: true, why: p.store && ctx.stores ? `This game has no ${storeName(p.store)} connection (Glitchless Cloud: Settings → Integrations).` : NOT_CONNECTED };
  const named = { store: st.store, store_name: storeName(st.store) };
  if (p.type === 'store_reviews') return { ...named, ...reviewsPanel(ctx, st) };
  if (p.type === 'store_vitals') return { ...named, ...vitalsPanel(ctx, st) };
  if (p.type === 'store_players') return { ...named, ...playersPanel(ctx, st) };
  if (p.type === 'store_sales') return { ...named, ...salesPanel(ctx, st) };
  return {};
}

const notSynced = (st) => `${storeName(st.store)} has not been synced yet: the first sync runs within the hour.`;

function reviewsPanel(ctx, st) {
  const { from, to } = ctx;
  const total = countsIn(st.hours, from, to + 1);
  if (!total.reviews) return { empty: true, why: st.synced_at ? `No ${storeName(st.store)} reviews were written in this window.` : notSynced(st), summary: st.summary };
  const bucket = to - from > 3 * DAY ? DAY : HOUR;
  const first = Math.floor(from / bucket) * bucket;
  const ts = [];
  for (let t = first; t <= to; t += bucket) ts.push(t);
  const up = ts.map(() => 0);
  const down = ts.map(() => 0);
  const perf = ts.map(() => 0);
  for (const [hour, u, d, dp] of st.hours) {
    if (hour < from || hour > to) continue; // the hours the total counts
    const i = Math.floor((hour - first) / bucket);
    if (i < 0 || i >= ts.length) continue;
    up[i] += u;
    down[i] += d;
    perf[i] += dp;
  }
  const rels = storeReleases(ctx, st);
  return {
    summary: st.summary,
    bucket_ms: bucket,
    ts,
    series: [
      { label: 'Positive', values: up },
      { label: 'Negative', values: down },
      { label: 'Negative about performance', values: perf },
    ],
    markers: rels.filter((r) => r.from >= from && r.from <= to).map((r) => ({ ts: r.from, label: r.label })),
    builds: releaseRows(ctx, st, rels, from, to),
    source: rels[0]?.source ?? null,
    segment: STORES[st.store]?.segment ?? null,
    total: total.reviews,
    positive_pct: pct(total.up, total.reviews),
    perf_negative: total.perf,
  };
}

// Players online, as the store counts them each sync, next to the sessions Glitchless saw playing in that minute: the
// gap is the players whose build sends no telemetry (an older build, telemetry turned off, a version without the SDK).
function playersPanel(ctx, st) {
  if (!st.players) return { empty: true, why: `${storeName(st.store)} doesn't count players online.` };
  const samples = st.players.filter(([ts]) => ts >= ctx.from && ts <= ctx.to);
  if (!samples.length) return { empty: true, why: st.synced_at ? `No players-online counts in this window: ${storeName(st.store)} is asked once an hour.` : notSynced(st) };
  const counted = samples.map(([, n]) => n);
  const peak = samples.reduce((b, s) => (s[1] > b[1] ? s : b), samples[0]);
  const base = { ts: samples.map(([ts]) => ts), peak: { ts: peak[0], store: peak[1] } };
  const label = `On ${storeName(st.store)}`;
  if (ctx.daily) return { ...base, series: [{ label, values: counted }], latest: { ts: samples.at(-1)[0], store: samples.at(-1)[1], glitchless: null }, coverage_pct: null, why_no_coverage: 'Measured players are counted by the minute for ranges of 31 days or less.' };
  const perMinute = new Map();
  for (const s of ctx.sessions.values()) for (const m of s.minutes ?? []) perMinute.set(m, (perMinute.get(m) || 0) + 1);
  const measured = samples.map(([ts]) => {
    const m = Math.floor(ts / 60_000) * 60_000;
    return Math.max(perMinute.get(m) || 0, perMinute.get(m - 60_000) || 0);
  });
  const sum = (xs) => xs.reduce((a, b) => a + b, 0);
  return {
    ...base,
    series: [
      { label, values: counted },
      { label: 'Measured by Glitchless', values: measured },
    ],
    latest: { ts: samples.at(-1)[0], store: counted.at(-1), glitchless: measured.at(-1) },
    coverage_pct: pct(sum(measured), sum(counted)),
  };
}

function salesPanel(ctx, st) {
  if (!st.sales && !st.wishlists) return { empty: true, why: st.keys?.financial ? `No units, returns or wishlists in this window yet: ${storeName(st.store)} reports them once a day.` : st.store === 'steam' ? 'Units, returns and wishlists need a Financial API Group key (Glitchless Cloud: Settings → Integrations → Steam).' : `No units or returns from ${storeName(st.store)}.` };
  const lo = isoDay(ctx.from);
  const hi = isoDay(ctx.to);
  const days = [...new Set([...(st.sales ?? []), ...(st.wishlists ?? [])].map((r) => r.day).filter((d) => d >= lo && d <= hi))].sort();
  if (!days.length) return { empty: true, why: 'No units, returns or wishlists in this window.' };
  const sales = new Map((st.sales ?? []).map((r) => [r.day, r]));
  const wish = new Map((st.wishlists ?? []).map((r) => [r.day, r]));
  const col = (m, k) => days.map((d) => m.get(d)?.[k] ?? (m.size ? 0 : null));
  const sum = (m, k) => days.reduce((a, d) => a + (m.get(d)?.[k] ?? 0), 0);
  const units = sum(sales, 'units');
  const returns = sum(sales, 'returns');
  return {
    ts: days.map((d) => Date.parse(`${d}T00:00:00Z`)),
    ...(st.sales ? { sales_series: [{ label: 'Units sold', values: col(sales, 'units') }, { label: 'Returns', values: col(sales, 'returns') }] } : {}),
    ...(st.wishlists ? { wishlist_series: [{ label: 'Wishlist adds', values: col(wish, 'adds') }, { label: 'Wishlist deletes', values: col(wish, 'deletes') }] } : {}),
    totals: {
      units: st.sales ? units : null,
      returns: st.sales ? returns : null,
      return_pct: st.sales ? pct(returns, units) : null,
      wishlist_adds: st.wishlists ? sum(wish, 'adds') : null,
      wishlist_deletes: st.wishlists ? sum(wish, 'deletes') : null,
      wishlist_purchases: st.wishlists ? sum(wish, 'purchases') : null,
    },
  };
}

// ── store vitals next to Glitchless ──

// What Glitchless measured of each version, in the terms the stores' vitals compare with: sessions, frame-time p95,
// hitches a minute, crash-free and crashed sessions, sessions with over a quarter of their frames slower than 20 or 30
// fps (from their frame-time sketch), and time to first frame. Sessions-based measures need a range of 31 days or less.
function measuredByVersion(ctx) {
  if (ctx.measuredCache) return ctx.measuredCache;
  const out = new Map();
  for (const v of versionsOf(ctx)) out.set(v.version, { sessions: v.sessions, frame_p95: v.frame_p95, hitches_per_min: v.hitches_per_min, crash_free_pct: v.crash_free_pct, crashed_pct: v.crash_free_pct == null ? null : round(100 - v.crash_free_pct, 1), slow20_pct: null, slow30_pct: null, ttff_p50: null });
  const per = new Map();
  for (const s of ctx.daily ? [] : (ctx.sessions?.values() ?? [])) {
    const g = per.get(s.version) ?? { framed: 0, slow20: 0, slow30: 0, ttff: [] };
    if (typeof s.sketch?.quantile === 'function' && s.sketch.n) {
      g.framed++;
      const q75 = s.sketch.quantile(0.75);
      if (q75 > 50) g.slow20++;
      if (q75 > 1000 / 30) g.slow30++;
    }
    if (Number.isFinite(s.ttff)) g.ttff.push(s.ttff);
    per.set(s.version, g);
  }
  for (const [version, g] of per) {
    const m = out.get(version);
    if (!m) continue;
    if (g.framed) Object.assign(m, { slow20_pct: pct(g.slow20, g.framed), slow30_pct: pct(g.slow30, g.framed) });
    if (g.ttff.length) m.ttff_p50 = g.ttff.sort((a, b) => a - b)[Math.floor(g.ttff.length / 2)];
  }
  return (ctx.measuredCache = out);
}

// Each version's store vitals over the window (by day: users-weighted where the store says how many users; by version:
// the latest), with what Glitchless measured, newest first. A version is the store's version name, or its build
// (version code) when that is what the game passes to Glitchless.init.
function vitalsByVersion(ctx, st) {
  const lo = isoDay(ctx.from);
  const hi = isoDay(ctx.to);
  const groups = new Map();
  for (const v of st.vitals ?? []) {
    if (v.period !== 'version' && (v.day < lo || v.day > hi)) continue;
    if (v.device) continue;
    // By version code where the store gives one (a day read before the code's name was known has no name).
    const id = v.build != null ? `b:${v.build}` : v.version ? `v:${v.version}` : null;
    if (!id) continue;
    const g = groups.get(id) ?? { version: null, build: v.build ?? null, latest: v.day ?? null, metrics: {} };
    g.version ??= v.version ?? null;
    const key = v.percentile ? `${v.metric}:${v.percentile}` : v.metric;
    (g.metrics[key] ??= []).push(v);
    if (v.day && (!g.latest || v.day > g.latest)) g.latest = v.day;
    groups.set(id, g);
  }
  for (const g of groups.values()) g.version ??= String(g.build);
  const measured = measuredByVersion(ctx);
  const rows = [...groups.values()].map((g) => {
    const store = {};
    for (const [key, list] of Object.entries(g.metrics)) {
      const byVersion = list.filter((v) => v.period === 'version').sort((a, b) => (b.day ?? '').localeCompare(a.day ?? ''));
      if (byVersion.length) store[key] = round(byVersion[0].value, 2);
      else {
        const weighted = list.every((v) => v.users > 0);
        store[key] = round(weighted ? list.reduce((a, v) => a + v.value * v.users, 0) / list.reduce((a, v) => a + v.users, 0) : list.reduce((a, v) => a + v.value, 0) / list.length, 2);
      }
    }
    const m = measured.get(g.version) ?? (g.build != null ? measured.get(String(g.build)) : null) ?? null;
    return { version: g.version, build: g.build, latest: g.latest, store, glitchless: m, notes: m ? disagreements(st.store, g.version, store, m) : [] };
  });
  return rows.sort((a, b) => compareVersions(b, a));
}

function compareVersions(a, b) {
  if (a.build != null && b.build != null && Number.isFinite(Number(a.build)) && Number.isFinite(Number(b.build))) return Number(a.build) - Number(b.build);
  const pa = String(a.version).split(/[^0-9]+/).map(Number);
  const pb = String(b.version).split(/[^0-9]+/).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return (a.latest ?? '').localeCompare(b.latest ?? '');
}

// Where a store and Glitchless say different things about a version, in a line each, with the likely reason: the
// store counts users in a day, Glitchless counts sessions, and each sees what the other can't.
function disagreements(store, version, s, m) {
  const name = storeName(store);
  const out = [];
  const twice = (a, b, min) => a != null && b != null && a >= b * 2 && a - b >= min;
  for (const [metric, fps] of [['slow_rendering_20fps', 20], ['slow_rendering_30fps', 30]]) {
    const a = s[metric];
    const b = m[VITALS[metric].vs];
    if (twice(a, b, 3)) out.push({ metric, store_value: a, glitchless_value: b, says: `${name} counts ${a}% of users with slow rendering (under ${fps} fps) on ${version}, Glitchless measured ${b}% of sessions: most of the slow play doesn't reach Glitchless (devices or builds without telemetry, or frames before the SDK starts).` });
    else if (twice(b, a, 3)) out.push({ metric, store_value: a, glitchless_value: b, says: `Glitchless measured ${b}% of sessions on ${version} with over a quarter of their frames under ${fps} fps, ${name} counts ${a}% of users: ${name} counts a user once a day, and only on the devices it watches.` });
  }
  const c = s.crash_rate;
  const k = m.crashed_pct;
  if (twice(c, k, 0.5)) out.push({ metric: 'crash_rate', store_value: c, glitchless_value: k, says: `${name} counts crashes for ${c}% of users on ${version}, Glitchless recorded ${k}% of sessions crashing: native crashes, and crashes before the SDK starts, never reach Glitchless.` });
  else if (twice(k, c, 0.5)) out.push({ metric: 'crash_rate', store_value: c, glitchless_value: k, says: `Glitchless recorded ${k}% of sessions crashing on ${version}, ${name} counts ${c}% of users: Glitchless also counts a stopped game loop or a fatal script error, which the OS doesn't see as a crash.` });
  const l = s['launch_time:p50'] ?? s.launch_time;
  const t = m.ttff_p50;
  if (l != null && t != null && Math.max(l, t) >= 2 * Math.min(l, t) && Math.abs(l - t) >= 500) out.push({ metric: 'launch_time', store_value: l, glitchless_value: t, says: `${name} measures a ${Math.round(l)} ms launch on ${version}, Glitchless ${Math.round(t)} ms to the first frame: ${l > t ? 'the launch includes what happens before the SDK starts (the engine, a splash screen)' : 'Glitchless counts until the game draws its first frame, after the launch the OS times'}.` });
  return out;
}

function vitalsPanel(ctx, st) {
  if (!STORES[st.store]?.vitals.length) return { empty: true, why: `${storeName(st.store)} reports no vitals.` };
  const rows = vitalsByVersion(ctx, st);
  if (!rows.length) return { empty: true, why: st.synced_at ? `No ${storeName(st.store)} vitals in this window yet: ${st.store === 'google_play' ? 'Google Play reports them a day or two late' : 'they need an App Store Connect API key'}.` : notSynced(st) };
  const keys = [...new Set(rows.flatMap((r) => Object.keys(r.store)))].sort((a, b) => STORES[st.store].vitals.indexOf(a.split(':')[0]) - STORES[st.store].vitals.indexOf(b.split(':')[0]) || a.localeCompare(b));
  return {
    columns: keys.map((key) => {
      const [metric, percentile] = key.split(':');
      return { key, metric, percentile: percentile ?? null, label: `${VITALS[metric].label}${percentile ? ` ${percentile}` : ''}`, unit: VITALS[metric].unit };
    }),
    rows,
    notes: rows.flatMap((r) => r.notes.map((n) => ({ version: r.version, ...n }))),
    devices: st.snapshots?.devices ?? null,
    hangs: st.snapshots?.hangs ?? null,
  };
}

// The store_vitals query (app.js): one store's vitals by version next to Glitchless's, optionally one `version`.
export function storeVitals(ctx, params = new URLSearchParams()) {
  const store = params.get('store')?.trim() || null;
  if (store && !STORES[store]) return { connected: false, why: `store is one of ${Object.keys(STORES).join(', ')}`, stores: Object.keys(ctx.stores ?? {}) };
  const st = store ? pickStore(ctx, store) : (Object.values(ctx.stores ?? {}).find((x) => STORES[x.store]?.vitals.length) ?? pickStore(ctx, null));
  if (!st) return { connected: false, why: store && ctx.stores ? `This game has no ${storeName(store)} connection (Glitchless Cloud: Settings → Integrations).` : NOT_CONNECTED, stores: Object.keys(ctx.stores ?? {}) };
  const panel = vitalsPanel(ctx, st);
  const version = params.get('version')?.trim();
  const rows = panel.rows ? (version ? panel.rows.filter((r) => r.version === version || String(r.build) === version) : panel.rows) : [];
  return { connected: true, store: st.store, store_name: storeName(st.store), stores: Object.keys(ctx.stores ?? {}), app_id: st.app_id, synced_at: st.synced_at, ...(panel.empty ? { empty: true, why: panel.why } : { columns: panel.columns, rows, notes: panel.notes.filter((n) => !version || n.version === version), devices: panel.devices, hangs: panel.hangs }) };
}

// ── the finding (findings.js) ──

// For each store: negative reviews about stutter, lag, fps, freezes or crashes rising after a build. The latest
// release in the last 30 days with 5+ reviews since it went live (on a store whose reviews name their version, 5+
// reviews of it), whose share of such reviews is 10+ points and half again above the 30 days before it, with 3 or more
// of them. With the build's frame-time p95 and crash-free sessions (and the version before's), the store's segment
// (Steam Deck) and the devices reviewers show. `others`: the findings so far, for the performance findings to start with.
export function storeFindings(ctx, others = []) {
  return Object.values(ctx.stores ?? {}).flatMap((st) => storeFinding(ctx, st, others));
}

function storeFinding(ctx, st, others) {
  if (!st?.hours?.length) return [];
  const rels = storeReleases(ctx, st);
  const versioned = STORES[st.store]?.versioned;
  const to = ctx.to;
  for (let i = rels.length - 1; i >= 0; i--) {
    const rel = rels[i];
    if (rel.from > to || rel.from < to - LOOKBACK) continue;
    const prev = rels[i - 1] ?? null;
    const after = versioned ? countsOf(st.reviews, (r) => r.ts <= to && releaseOf(rels, r) === rel) : countsIn(st.hours, rel.from, Math.min(rel.to, to + 1));
    if (after.reviews < 5) continue;
    const since = Math.max(prev?.from ?? -Infinity, rel.from - LOOKBACK);
    const before = versioned ? countsOf(st.reviews, (r) => r.ts >= rel.from - LOOKBACK && r.ts <= to && releaseOf(rels, r) && releaseOf(rels, r) !== rel && releaseOf(rels, r).from < rel.from) : countsIn(st.hours, since, rel.from);
    const share = after.perf / after.reviews;
    const was = before.reviews ? before.perf / before.reviews : 0;
    const rising = after.perf >= 3 && share - was >= 0.1 && share >= was * 1.5 && (before.reviews >= 5 ? z(after.perf, after.reviews, before.perf, before.reviews) >= 1.64 : share >= 0.25);
    if (!rising) return [];
    return [finding(ctx, st, rel, prev, after, before, others)];
  }
  return [];
}

// Two-proportion z statistic: how sure it is that a/n is above b/m.
function z(a, n, b, m) {
  const p = (a + b) / (n + m);
  const se = Math.sqrt(p * (1 - p) * (1 / n + 1 / m));
  return se ? (a / n - b / m) / se : 0;
}

function finding(ctx, st, rel, prev, after, before, others) {
  const name = storeName(st.store);
  const segment = STORES[st.store]?.segment;
  const vers = new Map(versionsOf(ctx).map((v) => [v.version, v]));
  const cur = rel.version ? vers.get(rel.version) : null;
  const prevVersion = prev?.version ?? versionBefore(ctx, rel.from);
  const old = prevVersion && prevVersion !== rel.version ? vers.get(prevVersion) : null;
  // The texts of the complaints since the release (the latest 3,000 reviews; counts come from the hours).
  const rels = storeReleases(ctx, st);
  const complaints = st.reviews.filter((r) => !r.up && r.topics.length && r.ts <= ctx.to && releaseOf(rels, r) === rel);
  const topics = {};
  for (const r of complaints) for (const t of r.topics) topics[t] = (topics[t] || 0) + 1;
  const named = Object.entries(topics).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const devices = tally(complaints.map((r) => r.device?.gpu || r.device?.model).filter(Boolean)).slice(0, 5);
  const shown = complaints.filter((r) => r.device?.gpu || r.device?.model).length;
  const segShare = after.perf ? after.perf_deck / after.perf : 0;
  const sharePct = pct(after.perf, after.reviews);
  const wasPct = before.reviews ? pct(before.perf, before.reviews) : 0;
  const words = named.length ? joinWords(named.slice(0, 2).map(([t]) => TOPIC_WORDS[t])) : 'how it runs';
  const related = others.filter((f) => f.category === 'performance' && (!rel.version || !f.evidence?.version || f.evidence.version === rel.version)).slice(0, 3);
  const versioned = STORES[st.store]?.versioned;
  const measured = cur
    ? ` Glitchless measured ${rel.version} over ${cur.sessions} ${cur.sessions === 1 ? 'session' : 'sessions'}: frame-time p95 ${cur.frame_p95 ?? '–'}ms${old?.frame_p95 != null ? ` (${old.version}: ${old.frame_p95}ms)` : ''}, crash-free sessions ${cur.crash_free_pct}%${old ? ` (${old.version}: ${old.crash_free_pct}%)` : ''}.`
    : rel.version
      ? ` Glitchless has no sessions of ${rel.version} in this window.`
      : ' Glitchless could not tell which version this build is: send the Steam build from the game (the SDKs do, SPEC §4c), or put the version you pass to Glitchless.init in the build description or the patch notes title.';
  const p95Worse = cur?.frame_p95 != null && old?.frame_p95 ? cur.frame_p95 > old.frame_p95 * 1.15 : false;
  const crashWorse = cur && old ? old.crash_free_pct - cur.crash_free_pct >= 2 : false;
  const segLine = segment && after.perf_deck ? ` ${after.perf_deck} of the ${after.perf} played mostly on ${segment}.` : '';
  const devLine = devices.length ? ` ${st.store === 'steam' ? 'GPUs' : 'Devices'} the reviewers show: ${devices.map((g) => `${g.value} (${g.count})`).join(', ')}${shown < complaints.length ? `; ${complaints.length - shown} show none` : ''}.` : '';
  const tips = [];
  if (rel.version && (old || cur)) tips.push(`Compare ${old ? `${old.version} and ${rel.version}` : rel.version} with glitchless_compare_versions, then read glitchless_performance with version ${rel.version}: its hitch causes are what these players feel.`);
  if (related.length) tips.push(`Start with ${related.map((f) => f.id).join(', ')}.`);
  if (segment === 'Steam Deck' && segShare >= 0.4) tips.push("Most of these players are on a Steam Deck: measure the build there (glitchless_deck_measure), at the Deck's resolution and with its GPU tier.");
  if (topics.crash) tips.push('For the crashes, glitchless_get_error lists the errors and crashes of that version.');
  if (STORES[st.store]?.vitals.length) tips.push(`glitchless_store_vitals with store "${st.store}" has what ${name} itself measured of ${rel.version ?? 'it'}.`);
  tips.push(`glitchless_store_reviews with store "${st.store}", build "${rel.build_id ?? rel.version ?? rel.key}" and sentiment negative lists what they wrote.`);
  const since = versioned ? `of ${rel.label}` : `since ${rel.label} went live`;
  return {
    id: `store-reviews-${st.store}-${slug(rel.key)}`,
    severity: (sharePct >= 30 && after.perf >= 10) || p95Worse || crashWorse ? 'high' : 'medium',
    category: 'reviews',
    title: `${name} reviews about ${words} rose ${versioned ? `on ${rel.label}` : `after ${rel.label}`}: ${after.perf} of ${after.reviews} ${versioned ? 'reviews of it' : 'since it went live'}${before.reviews ? ` (${wasPct}% before)` : ''}`,
    summary:
      `${after.perf} of the ${after.reviews} ${name} reviews ${since}${versioned ? '' : ` (${isoDay(rel.from)}${rel.approx ? ', or before' : ''})`} are negative and mention ${named.length ? named.map(([t, n]) => `${TOPIC_WORDS[t]} (${n})`).join(', ') : 'how the game runs'}, against ${wasPct}% of the ${before.reviews} reviews ${versioned ? 'of the versions before it' : 'before it'}.` +
      segLine +
      devLine +
      measured,
    evidence: {
      store: st.store,
      release: { key: rel.key, label: rel.label, build_id: rel.build_id, version: rel.version, source: rel.source, from: rel.from, ...(rel.approx ? { approx: true } : {}) },
      previous: prev ? { key: prev.key, label: prev.label, version: prev.version, from: prev.from } : null,
      reviews_after: after.reviews,
      perf_negative_after: after.perf,
      perf_pct_after: sharePct,
      reviews_before: before.reviews,
      perf_negative_before: before.perf,
      perf_pct_before: wasPct,
      topics,
      ...(segment ? { segment: { name: segment, perf_negative: after.perf_deck, pct: pct(after.perf_deck, after.perf), all_reviews_pct: pct(after.up_deck + after.down_deck, after.reviews) } } : {}),
      devices,
      version: cur ? pick(cur) : null,
      previous_version: old ? pick(old) : null,
      related_findings: related.map((f) => f.id),
      examples: complaints.slice(0, 3).map((r) => ({ ts: r.ts, topics: r.topics, ...(segment ? { segment: inSegment(r) } : {}), device: r.device?.gpu ?? r.device?.model ?? null, text: r.text.length > 200 ? `${r.text.slice(0, 199)}…` : r.text })),
    },
    suggestion: tips.join(' '),
    link: { page: st.store.replace(/_/g, '-') },
    impact: after.perf / after.reviews,
  };
}

const pick = (v) => ({ version: v.version, sessions: v.sessions, frame_p95: v.frame_p95, hitches_per_min: v.hitches_per_min, crash_free_pct: v.crash_free_pct, first_seen: v.first_seen });

// ── the reviews query (app.js store_reviews, the glitchless_store_reviews MCP tool) ──

// The window's reviews of one store (`store`; default the game's first connected one), filtered: `build` (a build
// ID, a version or a release's label), `sentiment` (positive or negative), `keyword` (a topic: stutter, lag, fps,
// freeze, crash; or any text), `deck` (Steam: played mostly on Steam Deck), `device` (part of the GPU or device name;
// `gpu` is the same), `limit` (default 20, at most 100). With counts by build, topic and device over what matched.
export function storeReviews(ctx, params = new URLSearchParams()) {
  const get = (k) => params.get(k)?.trim() || null;
  const store = get('store');
  if (store && !STORES[store]) return { connected: false, why: `store is one of ${Object.keys(STORES).join(', ')}`, stores: Object.keys(ctx.stores ?? {}), reviews: [] };
  const st = pickStore(ctx, store);
  if (!st) return { connected: false, why: store && ctx.stores ? `This game has no ${storeName(store)} connection (Glitchless Cloud: Settings → Integrations).` : NOT_CONNECTED, stores: Object.keys(ctx.stores ?? {}), reviews: [] };
  const rels = storeReleases(ctx, st);
  const build = get('build')?.toLowerCase();
  const sentiment = get('sentiment');
  const keyword = get('keyword')?.toLowerCase();
  const topic = keyword && Object.keys(TOPICS).find((t) => keyword === t || keyword === `${t}s` || keyword === `${t}es` || keyword === TOPIC_WORDS[t] || (t === 'stutter' && keyword.startsWith('stutter')));
  const deck = ['1', 'true', 'yes'].includes(get('deck')?.toLowerCase());
  const device = (get('device') ?? get('gpu'))?.toLowerCase();
  const limit = Math.min(100, Math.max(1, Number(get('limit')) || 20));
  const release = build ? rels.find((r) => [r.key, r.build_id, r.version, r.label].some((x) => x != null && String(x).toLowerCase() === build)) : null;
  if (build && !release) return { connected: true, store: st.store, app_id: st.app_id, error: `no build or version "${get('build')}" among this game's releases on ${storeName(st.store)}`, releases: rels.map((r) => r.label), reviews: [] };
  const inRange = st.reviews.filter((r) => r.ts >= ctx.from && r.ts <= ctx.to);
  const matched = inRange.filter((r) => {
    if (release && releaseOf(rels, r) !== release) return false;
    if (sentiment === 'positive' && !r.up) return false;
    if (sentiment === 'negative' && r.up) return false;
    if (topic ? !r.topics.includes(topic) : keyword && !r.text.toLowerCase().includes(keyword)) return false;
    if (deck && !inSegment(r)) return false;
    if (device && ![r.device?.gpu, r.device?.model].some((x) => x?.toLowerCase().includes(device))) return false;
    return true;
  });
  const topics = {};
  for (const r of matched) for (const t of r.topics) topics[t] = (topics[t] || 0) + 1;
  const total = countsIn(st.hours, ctx.from, ctx.to + 1);
  const segment = STORES[st.store]?.segment ?? null;
  return {
    connected: true,
    store: st.store,
    store_name: storeName(st.store),
    stores: Object.keys(ctx.stores ?? {}),
    app_id: st.app_id,
    summary: st.summary,
    synced_at: st.synced_at,
    window_reviews: total.reviews,
    texts_from: Math.max(st.reviews_from ?? ctx.from, ctx.from),
    capped: Boolean(st.capped),
    matched: matched.length,
    negative: matched.filter((r) => !r.up).length,
    ...(segment ? { segment: { name: segment, reviews: matched.filter(inSegment).length } } : {}),
    topics,
    devices: tally(matched.map((r) => r.device?.gpu || r.device?.model).filter(Boolean)).slice(0, 8),
    builds: releaseRows(ctx, st, rels, ctx.from, ctx.to),
    reviews: matched.slice(0, limit).map((r) => {
      const rel = releaseOf(rels, r);
      return { ...r, build: rel?.label ?? null, version: r.version ?? rel?.version ?? null };
    }),
  };
}

// ── helpers ──

function tally(values) {
  const m = new Map();
  for (const v of values) m.set(v, (m.get(v) || 0) + 1);
  return [...m].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || (a.value < b.value ? -1 : 1));
}

function joinWords(list) {
  return list.length > 1 ? `${list.slice(0, -1).join(', ')} and ${list.at(-1)}` : list[0];
}

function slug(v) {
  return String(v)
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

// BBCode and control characters out, whitespace to single spaces.
export function plain(v) {
  return String(v ?? '')
    .replace(/\[\/?[a-z0-9*]+(?:=[^\]]*)?\]/gi, ' ')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
