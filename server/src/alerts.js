// Alerts: tells a game's developers when it gets worse (a new error, more crashes or slower frames after a
// release, a new high finding) in Discord, Slack or email, with a line they can paste into their coding agent.
// The rules, the check and the messages are here; where settings and state live and how a message is sent is
// the host's (Glitchless Cloud keeps them per game; a self-hosted server uses GLITCHLESS_ALERT_WEBHOOK).
//
// A check reads the last day of one service, as glitchless_triage does by default, so the finding an alert
// names is in the agent's triage. Each rule gives signals with a stable key, made from the finding id
// (findings.js). A signal fires when it starts to hold and its key isn't active: the key is claimed with a
// conditional write, so it fires once however many checks run. It stays active while the signal holds at a
// lower bar, and clears only after it has not held for a day, so an alert never flaps.
import { buildContext, errorList, versions } from './analytics.js';
import { findings } from './findings.js';
import { reportsOf } from './reports.js';
import { DEFAULT_PROJECT } from './auth.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const ALERT_RULES = ['new_error', 'crash_free', 'frame_p95', 'finding'];
// What a game gets when it turns alerts on. Every number here is in SPEC §3e.
export const ALERT_DEFAULTS = {
  rules: { new_error: true, crash_free: true, frame_p95: true, finding: true },
  newErrorSessions: 3, // a new error alerts once this many sessions have hit it
};
export const LIMITS = {
  newForMs: DAY, // an error is new for a day after its first occurrence
  seedDays: 7, // read once per service, so errors from before alerts were on aren't new
  versionSessions: 20, // sessions each of the two newest versions needs in the day before they are compared
  crashFreeDrop: 2, // percentage points (and z ≥ 2) to fire; it holds while the drop is at least crashFreeHold
  crashFreeHold: 1,
  p95Rise: 0.2, // 20% and p95MinMs to fire; it holds while the rise is at least p95Hold
  p95MinMs: 2,
  p95Hold: 0.1,
  clearAfterMs: DAY, // a key that hasn't held for this long clears, and can fire again
  touchMs: HOUR, // how often a held key's heldAt is written
  perCheck: 5, // alerts one check sends for one service at most; the rest wait for the next check
  seenKeepMs: 30 * DAY, // error fingerprints not seen for this long are forgotten
  seenMax: 2000,
};
const PRIORITY = ['new_error', 'crash_free', 'frame_p95', 'finding'];
const ENTER = new Set(['critical', 'high']);
const STAY = new Set(['critical', 'high', 'medium']);

// The context the rules read: what query `name` gets from app.js, with no drill-downs.
export async function contextFor(store, projectId, q) {
  const query = { service: q.service, from: q.from, to: q.to, env: q.env || null, version: null, type: 'all', sessions: null, plan: q.plan ?? null };
  let ctx;
  if (store.context) ctx = await store.context(projectId, query, 'alerts');
  else ctx = buildContext(await store.query(projectId, query), query, await store.rollups(projectId, query));
  ctx.reports = store.reports ? reportsOf(await store.reports(projectId, q.service, { from: q.from, to: q.to }), ctx) : [];
  return ctx;
}

// The rules, on what one check measured. Pure: everything it knows comes in.
//   errors, versions, findings   errorList(), versions() and findings() of the last day
//   history                       errorList() of the last LIMITS.seedDays, on a service's first check (else null)
//   seen                          { fingerprint: [first, last] } from earlier checks (null on the first)
//   active                        Map key → { firedAt, heldAt } of keys that fired and haven't cleared
//   settings                      { rules, newErrorSessions }; enabledAt (ms) when alerts were turned on
// → { signals: [{ key, rule, finding, holds, ...data }], seen }, one signal per key.
export function evaluate({ errors = [], versions: vers = [], findings: found = [], history = null, seen = null, active = new Map(), settings = {}, enabledAt = 0, now }) {
  const rules = { ...ALERT_DEFAULTS.rules, ...settings.rules };
  const minSessions = settings.newErrorSessions ?? ALERT_DEFAULTS.newErrorSessions;
  const next = new Map(Object.entries(seen || {}));
  // An error without a fingerprint (an SDK sends one with each error) can't be told apart from the next.
  errors = errors.filter((i) => i.fingerprint);
  for (const i of [...(history || []).filter((h) => h.fingerprint), ...errors]) {
    const was = next.get(i.fingerprint);
    next.set(i.fingerprint, [Math.min(was?.[0] ?? Infinity, i.first_seen), Math.max(was?.[1] ?? 0, i.last_seen ?? i.first_seen)]);
  }
  const signals = [];

  if (rules.new_error) {
    for (const issue of errors) {
      const key = `error-${issue.fingerprint}`;
      const first = next.get(issue.fingerprint)[0];
      const fresh = first >= enabledAt && now - first <= LIMITS.newForMs;
      signals.push({ key, rule: 'new_error', finding: key, holds: active.has(key) || (fresh && issue.sessions >= minSessions), issue, first });
    }
  }

  // The two newest versions with a few sessions, as the version finding picks them (findings.js).
  const recent = vers.filter((v) => v.sessions >= 5);
  if (recent.length >= 2) {
    const [prev, cur] = recent.slice(-2);
    const finding = `version-${prev.version}-${cur.version}`;
    const enough = prev.sessions >= LIMITS.versionSessions && cur.sessions >= LIMITS.versionSessions;
    if (rules.crash_free && prev.crash_free_pct != null && cur.crash_free_pct != null) {
      const key = `crash-free-${prev.version}-${cur.version}`;
      const drop = round1(prev.crash_free_pct - cur.crash_free_pct);
      const z = crashZ(prev, cur);
      const holds = enough && (active.has(key) ? drop >= LIMITS.crashFreeHold : drop >= LIMITS.crashFreeDrop && z >= 2);
      signals.push({ key, rule: 'crash_free', finding, holds, prev, cur, drop, z });
    }
    if (rules.frame_p95 && prev.frame_p95 > 0 && cur.frame_p95 > 0) {
      const key = `frame-p95-${prev.version}-${cur.version}`;
      const rise = cur.frame_p95 / prev.frame_p95 - 1;
      const holds = enough && (active.has(key) ? rise >= LIMITS.p95Hold : rise >= LIMITS.p95Rise && cur.frame_p95 - prev.frame_p95 >= LIMITS.p95MinMs);
      signals.push({ key, rule: 'frame_p95', finding, holds, prev, cur, rise });
    }
  }

  if (rules.finding) {
    for (const f of found) {
      // A release's own rules decide on version findings, with their minimum sessions.
      if (f.id.startsWith('version-') && (rules.crash_free || rules.frame_p95)) continue;
      const holds = active.has(f.id) ? STAY.has(f.severity) : ENTER.has(f.severity);
      signals.push({ key: f.id, rule: 'finding', finding: f.id, holds, f });
    }
  }

  // One signal per key (a new error is also its error finding): it holds if any rule holds it, and the first
  // rule that holds speaks for it.
  const byKey = new Map();
  for (const s of signals.sort((a, b) => PRIORITY.indexOf(a.rule) - PRIORITY.indexOf(b.rule))) {
    const was = byKey.get(s.key);
    if (!was) byKey.set(s.key, s);
    else if (s.holds && !was.holds) byKey.set(s.key, s);
  }

  const kept = [...next].filter(([, [, last]]) => now - last <= LIMITS.seenKeepMs).sort((a, b) => b[1][1] - a[1][1]).slice(0, LIMITS.seenMax);
  return { signals: [...byKey.values()], seen: Object.fromEntries(kept) };
}

// Two-proportion z for "cur crashes more often than prev" (crash_free_pct is rounded to 0.1, so counts are close).
function crashZ(prev, cur) {
  const c1 = Math.round((prev.sessions * (100 - prev.crash_free_pct)) / 100);
  const c2 = Math.round((cur.sessions * (100 - cur.crash_free_pct)) / 100);
  const p = (c1 + c2) / (prev.sessions + cur.sessions);
  const se = Math.sqrt(p * (1 - p) * (1 / prev.sessions + 1 / cur.sessions));
  return se ? round1((c2 / cur.sessions - c1 / prev.sessions) / se) : 0;
}

// What the rules read about one service: its last day, and (history) the errors of its last LIMITS.seedDays.
export async function measure(store, projectId, { service, env = null, plan = null, now, history = false }) {
  const q = { service, env, plan };
  const ctx = await contextFor(store, projectId, { ...q, from: now - DAY, to: now });
  return {
    history: history ? errorList(await contextFor(store, projectId, { ...q, from: now - LIMITS.seedDays * DAY, to: now })) : null,
    errors: errorList(ctx),
    versions: versions(ctx),
    findings: findings(ctx, await store.getMaps(projectId, service)),
  };
}

// One check of one service: reads its last day, applies the rules and claims what newly holds.
//   state (the host's, for this project): seen(service) → { seen, baselineAt } | null, saveSeen(service, { seen,
//     baselineAt }), active(service) → Map, claim(service, key, record) → true for the one check that wins,
//     hold(service, key, record), release(service, key)
//   read: measure() (tests pass fixtures)
// The first check after alerts are turned on (enabledAt) is the baseline: what already holds then is claimed
// without a message, so turning alerts on doesn't send what the dashboard already shows. New errors are the
// exception: they are new by their first occurrence, which the history says.
// → the signals that fired (at most LIMITS.perCheck), each ready for alertMessage().
export async function checkService({ store, state, projectId, service, settings = {}, enabledAt = 0, plan = null, now = Date.now(), read = measure }) {
  const stored = await state.seen(service);
  const baseline = !stored || !(stored.baselineAt >= enabledAt);
  const measured = await read(store, projectId, { service, env: settings.env || null, plan, now, history: !stored });
  const active = await state.active(service);
  const { signals, seen } = evaluate({ ...measured, seen: stored?.seen, active, settings, enabledAt, now });
  await state.saveSeen(service, { seen, baselineAt: baseline ? now : stored.baselineAt });

  const fired = [];
  for (const s of signals) {
    const was = active.get(s.key);
    if (!s.holds) {
      if (was && now - was.heldAt >= LIMITS.clearAfterMs) await state.release(service, s.key);
      continue;
    }
    if (was) {
      if (now - was.heldAt >= LIMITS.touchMs) await state.hold(service, s.key, { ...was, heldAt: now });
      continue;
    }
    const quiet = baseline && s.rule !== 'new_error';
    if (!quiet && fired.length >= LIMITS.perCheck) continue;
    const record = { key: s.key, rule: s.rule, finding: s.finding, firedAt: now, heldAt: now, ...(quiet ? { quiet: true } : {}) };
    if ((await state.claim(service, s.key, record)) && !quiet) fired.push({ ...s, service, at: now });
  }
  // Keys no rule spoke for this time (a finding that went away, a version pair a newer release replaced).
  const spoken = new Set(signals.map((s) => s.key));
  for (const [key, was] of active) if (!spoken.has(key) && now - was.heldAt >= LIMITS.clearAfterMs) await state.release(service, key);
  return fired;
}

// The dashboard page an alert links to, as a hash route: '#/errors/<fingerprint>', '#/performance?level=…'.
export function dashboardRoute(page, params = {}) {
  if (params.fingerprint) return `#/errors/${encodeURIComponent(params.fingerprint)}`;
  return `#/${page === 'overview' ? '' : page}${params.level ? `?level=${encodeURIComponent(params.level)}` : ''}`;
}

// ── messages ──

const SEVERITY_OF = { new_error: (s) => (s.issue.fatal ? 'high' : 'medium'), crash_free: () => 'high', frame_p95: (s) => (s.rise >= 0.3 ? 'high' : 'medium'), finding: (s) => s.f.severity };

// What one alert says, in any channel: { rule, severity, title (one line), facts (lines of evidence), finding,
// paste (the line for a coding agent), link, game, at }. link(page, params) → the dashboard URL, or null.
export function alertMessage(s, { link = () => null } = {}) {
  const game = clean(s.service, 80);
  const base = { key: s.key, rule: s.rule, severity: SEVERITY_OF[s.rule](s), finding: s.finding, game, at: s.at, paste: `Use glitchless_triage on ${game}, then look at finding ${clean(s.finding, 200)}` };
  if (s.rule === 'new_error') {
    const i = s.issue;
    return {
      ...base,
      title: `New error in ${game}: ${clean(i.message, 140)}`,
      facts: [
        `${count(i.count, 'time')} in ${count(i.sessions, 'session')} (${i.sessions_pct}% of sessions) in the last day, first at ${clock(s.first)} UTC.`,
        `${i.fatal ? 'Fatal. ' : ''}First in version ${clean(i.first_version, 40)}${i.levels?.length ? `, on ${i.levels.slice(0, 4).map((l) => clean(l, 40)).join(', ')}` : ''}.`,
        ...(i.location ? [`At ${clean(i.location, 160)}.`] : []),
      ],
      paste: `${base.paste} (glitchless_get_error with fingerprint ${clean(i.fingerprint, 80)} has its stack).`,
      link: link('errors', { fingerprint: i.fingerprint }),
    };
  }
  if (s.rule === 'crash_free') {
    const { prev, cur } = s;
    return {
      ...base,
      title: `${game} ${clean(cur.version, 40)} crashes more than ${clean(prev.version, 40)}: ${prev.crash_free_pct}% → ${cur.crash_free_pct}% crash-free sessions`,
      facts: [`${clean(cur.version, 40)}: ${cur.crash_free_pct}% crash-free over ${count(cur.sessions, 'session')} in the last day.`, `${clean(prev.version, 40)}: ${prev.crash_free_pct}% crash-free over ${count(prev.sessions, 'session')}.`, `Down ${s.drop} points (z = ${s.z}).`],
      paste: `${base.paste}.`,
      link: link('versions'),
    };
  }
  if (s.rule === 'frame_p95') {
    const { prev, cur } = s;
    return {
      ...base,
      title: `${game} ${clean(cur.version, 40)} runs slower than ${clean(prev.version, 40)}: p95 frame time ${prev.frame_p95}ms → ${cur.frame_p95}ms`,
      facts: [`${clean(cur.version, 40)}: p95 ${cur.frame_p95}ms, p50 ${cur.frame_p50}ms over ${count(cur.sessions, 'session')} in the last day.`, `${clean(prev.version, 40)}: p95 ${prev.frame_p95}ms, p50 ${prev.frame_p50}ms over ${count(prev.sessions, 'session')}.`, `${Math.round(s.rise * 100)}% slower at p95.`],
      paste: `${base.paste}.`,
      link: link('versions'),
    };
  }
  const f = s.f;
  return {
    ...base,
    title: `New ${f.severity} finding in ${game}: ${clean(f.title, 160)}`,
    facts: [clean(f.summary, 400), ...(f.impact_pct != null ? [`Affects ${f.impact_pct}% of sessions in the last day.`] : [])],
    paste: `${base.paste}.`,
    link: f.link?.fingerprint ? link('errors', { fingerprint: f.link.fingerprint }) : link(f.link?.page || 'overview', f.link?.level ? { level: f.link.level } : {}),
  };
}

// The test button's message: every part of a real one, saying what it is.
export function testMessage({ service, at, link = () => null }) {
  const game = clean(service, 80);
  return {
    key: 'test',
    rule: 'test',
    severity: 'info',
    finding: null,
    game,
    at,
    title: `Test alert for ${game}: alerts reach this channel`,
    facts: ['A real alert says what changed in one line, then its numbers, a link to the page and the finding to fix.', 'Nothing is wrong with your game.'],
    paste: `Use glitchless_triage on ${game}.`,
    link: link('overview'),
  };
}

const COLORS = { critical: 0xd83a52, high: 0xe5534b, medium: 0xe8a33d, low: 0x6b7a90, info: 0x4f8cff };

// Discord's webhook body. Text from games (error messages, level names) is escaped, and nobody is pinged.
export function discordPayload(m) {
  const lines = [...m.facts.map(discordText), '', ...(m.finding ? [`Finding \`${code(m.finding)}\``] : []), 'Paste into your coding agent:', '```', code(m.paste), '```'];
  return {
    username: 'Glitchless',
    content: cut(`**${discordText(m.title)}**`, 2000),
    allowed_mentions: { parse: [] },
    embeds: [{ ...(m.link ? { title: 'Open in Glitchless', url: m.link } : {}), description: cut(lines.join('\n'), 4000), color: COLORS[m.severity] ?? COLORS.info, footer: { text: cut(`Glitchless · ${m.game} · ${m.severity}`, 200) }, timestamp: new Date(m.at).toISOString() }],
  };
}

// Slack's incoming-webhook body (Block Kit). Slack wants &, < and > escaped, which also stops links and mentions.
export function slackPayload(m) {
  return {
    text: cut(slackText(m.title), 3000),
    unfurl_links: false,
    unfurl_media: false,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: cut(`*${slackText(m.title)}*`, 3000) } },
      { type: 'section', text: { type: 'mrkdwn', text: cut(m.facts.map(slackText).join('\n'), 3000) } },
      { type: 'section', text: { type: 'mrkdwn', text: cut(`Paste into your coding agent:\n\`\`\`${slackText(code(m.paste))}\`\`\``, 3000) } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: cut([m.link && `<${m.link}|Open in Glitchless>`, m.finding && `finding \`${slackText(code(m.finding))}\``, m.severity].filter(Boolean).join(' · '), 3000) }] },
    ],
  };
}

// Email: plain text and simple HTML. `footer` says why the reader gets it and where to change it.
export function emailMessage(m, { footer = '' } = {}) {
  const subject = cut(`[Glitchless] ${m.title}`, 200);
  const text = [m.title, '', ...m.facts, '', ...(m.link ? [`Dashboard: ${m.link}`] : []), ...(m.finding ? [`Finding: ${m.finding}`] : []), '', 'Paste this into your coding agent:', `  ${m.paste}`, ...(footer ? ['', '--', footer] : [])].join('\n');
  const h = escapeHtml;
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f6f7f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1d2330">
<div style="max-width:600px;margin:0 auto;background:#fff;border:1px solid #e3e6eb;border-radius:8px;padding:24px">
<p style="margin:0 0 4px;font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:#6b7a90">Glitchless · ${h(m.game)} · ${h(m.severity)}</p>
<h1 style="margin:0 0 16px;font-size:18px;line-height:1.35">${h(m.title)}</h1>
${m.facts.map((f) => `<p style="margin:0 0 8px;font-size:14px;line-height:1.5">${h(f)}</p>`).join('\n')}
${m.link ? `<p style="margin:16px 0"><a href="${h(m.link)}" style="display:inline-block;background:#1d2330;color:#fff;text-decoration:none;padding:9px 14px;border-radius:6px;font-size:14px">Open in Glitchless</a>${m.finding ? ` <span style="font-size:13px;color:#6b7a90;margin-left:8px">finding <code>${h(m.finding)}</code></span>` : ''}</p>` : ''}
<p style="margin:16px 0 6px;font-size:13px;color:#6b7a90">Paste this into your coding agent:</p>
<pre style="margin:0;padding:12px;background:#f1f3f6;border-radius:6px;font-size:13px;white-space:pre-wrap;word-break:break-word">${h(m.paste)}</pre>
${footer ? `<p style="margin:20px 0 0;font-size:12px;color:#6b7a90">${h(footer)}</p>` : ''}
</div></body></html>`;
  return { subject, text, html };
}

// ── a self-hosted server: GLITCHLESS_ALERT_WEBHOOK (server/src/local.js) ──

// The `state` checkService takes, in memory: a restart starts a new baseline.
export function memoryAlertState() {
  const seen = new Map();
  const keys = new Map();
  const id = (service, key) => `${service}\n${key}`;
  return {
    keys,
    seen: async (service) => seen.get(service) ?? null,
    saveSeen: async (service, value) => void seen.set(service, value),
    active: async (service) => new Map([...keys].filter(([k]) => k.startsWith(`${service}\n`)).map(([, v]) => [v.key, v])),
    claim: async (service, key, record) => (keys.has(id(service, key)) ? false : (keys.set(id(service, key), record), true)),
    hold: async (service, key, record) => void keys.set(id(service, key), record),
    release: async (service, key) => void keys.delete(id(service, key)),
  };
}

// Checks every service of one project now (the baseline) and every `everyMs` after, while the process runs, and
// posts what fires to one webhook: Slack's format for hooks.slack.com, else Discord's, unless `format` says.
// appUrl: where this server's dashboard is, for the links.
export function watchAlerts({ store, url, format = null, projectId = DEFAULT_PROJECT, appUrl = null, everyMs = 15 * MINUTE, fetch = globalThis.fetch, logger = console, now = Date.now }) {
  const state = memoryAlertState();
  const enabledAt = now();
  const kind = format || (new URL(url).hostname === 'hooks.slack.com' ? 'slack' : 'discord');
  const link = (page, params) => (appUrl ? `${appUrl}/${dashboardRoute(page, params)}` : null);
  async function check() {
    const t = now();
    const sent = [];
    for (const { service, last_seen } of await store.services(projectId)) {
      if (last_seen < t - DAY) continue;
      for (const s of await checkService({ store, state, projectId, service, enabledAt, now: t })) {
        const m = alertMessage(s, { link });
        const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(kind === 'slack' ? slackPayload(m) : discordPayload(m)), signal: AbortSignal.timeout(10_000) });
        if (!res.ok) logger.warn(`[alerts] the webhook answered HTTP ${res.status}`);
        sent.push(m);
      }
    }
    return sent;
  }
  const run = () => check().catch((err) => logger.warn('[alerts]', err.message));
  const first = run();
  const timer = setInterval(run, everyMs);
  timer.unref?.();
  return { check, first, stop: () => clearInterval(timer) };
}

// ── text from games ──

// One line, no control characters, at most `max` characters.
function clean(value, max) {
  const s = String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
  return cut(s, max);
}

function cut(s, max) {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// Inside a code span or block: no backticks to break out with.
const code = (s) => String(s ?? '').replace(/`/g, "'");
const discordText = (s) => String(s).replace(/[\\*_~`|>#[\]()<:-]/g, '\\$&').replace(/@/g, '@\u200b');
const slackText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeHtml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const count = (n, word) => `${Number(n).toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;
const clock = (ms) => new Date(ms).toISOString().slice(11, 16);
const round1 = (v) => Math.round(v * 10) / 10;
