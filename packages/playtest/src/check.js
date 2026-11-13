// A game check: Glitchless's bots play any web game someone posted, with nothing installed in it, and make a report
// and a dashboard for it, so its maker can see what Glitchless would do for their game. Used by
// `glitchless-playtest --check URL` and the glitchless_playtest MCP tool's `check_url`.
//
//   1. Find the game behind the address (an itch.io page's frame: check-site.js) and ask the site's robots.txt.
//   2. Make a game for it in Glitchless (with a workspace key on Glitchless Cloud; an open server takes any name).
//   3. Play it in real Chrome twice: desktop on this computer's GPU, then a throttled phone (check-bot.js), with the
//      browser SDK added to the page before it runs (check-page.js), its sessions synthetic.
//   4. Read back what Glitchless made of it (the playtest summary and findings), design the game's dashboard, put a
//      picture of the game on it, and on Glitchless Cloud make an unlisted share link to it.
//   5. Write the report and the three sentences to send its maker (check-report.js).
//
// A check is private: its game, board and link are in the checker's own workspace, and nothing ranks games. It plays
// for a few minutes from one computer, and stops where the site asks bots to stay out or checks for a human.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { loadPlaywright, CHROME_ARGS } from './run.js';
import { checkInitScript } from './check-page.js';
import { resolveGame, robotsCheck, refusal, CHECK_UA_SUFFIX } from './check-site.js';
import { PROFILES, explore, aiPlayer, profileWords, AI_MODEL } from './check-bot.js';
import { checkReport, checkDm, checkDashboard, CHECK_PAGE } from './check-report.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Seconds of play per profile by default; the phone plays two thirds as long. A check never plays past MAX_PLAY_S.
export const CHECK_SECONDS = 90;
const MAX_PLAY_S = 240;
const LOAD_CAP_S = { desktop: 60, phone: 120 };

export function slugify(s) {
  return (
    String(s || '')
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'game'
  );
}

/**
 * @param {object} o
 * @param {string} o.url             the game's address: an itch.io page, a github.io, Vercel or Netlify page, any web game
 * @param {string} [o.server]        Glitchless server (default $GLITCHLESS_URL or http://localhost:7777)
 * @param {string} [o.apiKey]        a workspace key (gl_ws_…) on Glitchless Cloud: makes the game and the share link
 * @param {string} [o.name]          the game's name in Glitchless (default: its page's title)
 * @param {number} [o.seconds]       seconds of desktop play (default 90; the phone plays two thirds as long)
 * @param {string[]} [o.profiles]    'desktop', 'phone' or both (default both)
 * @param {boolean} [o.ai]           let a Claude model pick the inputs (needs ANTHROPIC_API_KEY and @anthropic-ai/sdk)
 * @param {string} [o.outDir]        where the report and screenshots go (default .glitchless/checks/<game>-<time>)
 */
export async function gameCheck({ url, server = process.env.GLITCHLESS_URL || 'http://localhost:7777', apiKey = process.env.GLITCHLESS_API_KEY || '', name, seconds = CHECK_SECONDS, profiles = ['desktop', 'phone'], ai = false, aiModel, headed = false, channel = 'chrome', adapters = true, outDir, cwd = process.cwd(), share = true, log = () => {} } = {}) {
  if (!url) throw new Error('A game check needs the game\'s address (url).');
  const base = String(server).replace(/\/$/, '');
  const want = profiles.filter((p) => PROFILES[p]);
  if (!want.length) throw new Error(`profiles are ${Object.keys(PROFILES).join(' and ')}`);
  const desktopS = Math.max(15, Math.min(MAX_PLAY_S, Number(seconds) || CHECK_SECONDS));
  const playS = { desktop: desktopS, phone: Math.max(15, Math.round((desktopS * 2) / 3)) };
  const notes = [];

  const { chromium } = await loadPlaywright(cwd);
  const launch = (ch) => chromium.launch({ headless: !headed, channel: ch, args: [...CHROME_ARGS, '--mute-audio', '--autoplay-policy=no-user-gesture-required'] });
  const browser = await launch(channel === 'chromium' ? undefined : channel).catch((err) => {
    if (channel === 'chromium') throw err;
    log(`Could not launch ${channel} (${err.message.split('\n')[0]}); using Playwright's Chromium.`);
    return launch(undefined);
  });
  try {
    // The browser's own User-Agent, with the check named at its end, so a site can tell this visit apart.
    const probe = await browser.newPage();
    const chromeUa = (await probe.evaluate(() => navigator.userAgent)).replace('HeadlessChrome', 'Chrome');
    await probe.close();
    const major = chromeUa.match(/Chrome\/(\d+)/)?.[1] || '140';
    const ua = { desktop: `${chromeUa} ${CHECK_UA_SUFFIX}`, phone: `Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Mobile Safari/537.36 ${CHECK_UA_SUFFIX}` };

    const robots = new Map();
    const target = await resolveGame(url, { ua: ua.desktop, log, robots });
    if (!target.title) target.title = await pageTitle(target.play_url, ua.desktop);
    const gameName = String(name || target.title || new URL(target.page_url).hostname).trim().slice(0, 80);
    log(`Game check: ${gameName} (${target.play_url})`);

    const dest = await checkDestination({ base, apiKey, name: gameName, log });
    const sdk = await sdkScript(base, cwd);
    const version = `check-${new Date().toISOString().slice(0, 10)}`;
    const dir = outDir ? path.resolve(cwd, outDir) : path.join(cwd, '.glitchless', 'checks', `${slugify(gameName)}-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}`);
    fs.mkdirSync(dir, { recursive: true });
    const player = ai ? await aiPlayer({ model: aiModel || AI_MODEL, cwd }) : null;

    const started = Date.now();
    const runs = [];
    let landscape = target.size ? target.size.width > target.size.height * 1.1 : null;
    for (const p of want) {
      const profile = { ...PROFILES[p] };
      if (p === 'desktop' && target.size) profile.viewport = { width: target.size.width, height: target.size.height };
      if (p === 'phone' && landscape) profile.viewport = { width: profile.viewport.height, height: profile.viewport.width };
      log(`${p}: ${profileWords(profile)}`);
      const run = await playProfile(browser, { profile, target, dest, sdk, version, seconds: playS[p], ua: ua[p], dir, adapters, ai: player, robots, log });
      runs.push(run);
      if (run.stopped) {
        notes.push(run.stopped);
        if (run.refused) break; // the site doesn't want bots: no second visit
      }
      if (landscape == null && run.page?.canvas) landscape = run.page.canvas.width > run.page.canvas.height * 1.1;
    }

    const ids = runs.map((r) => r.session_id).filter(Boolean);
    const read = readerFor(base, apiKey, dest);
    let summary = null;
    let findings = [];
    if (ids.length) {
      log(`reading what Glitchless made of ${ids.length} run(s) …`);
      summary = await waitForSummary(read, dest.service, ids, started, { log, timeoutMs: dest.cloud ? 180_000 : 30_000 }).catch((err) => {
        notes.push(`Glitchless's summary of the runs couldn't be read: ${err.message}`);
        return null;
      });
      findings = await read('findings', { service: dest.service, sessions: ids.join(','), from: started - 60_000, to: Date.now() + 60_000 })
        .then((b) => b.findings || [])
        .catch(() => []);
      // Chrome keeps a public page from reaching a server on this computer or its network (Local Network Access).
      const localHost = (u) => /^(localhost|127\.|\[::1\]|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)|\.local(host)?(:\d+)?$/.test(safeHost(u) || '');
      if (!summary?.runs?.length && localHost(base) && !localHost(target.play_url)) notes.push(`Nothing the bots measured reached ${base}: Chrome keeps a public page like this one from sending to a server on this computer (Local Network Access). Check public games against Glitchless Cloud; the numbers below are the bots' own.`);
    }

    const result = {
      checked_at: new Date(started).toISOString(),
      url,
      target,
      game: { name: gameName, in_glitchless: dest.name || gameName, id: dest.game_id, service: dest.service, cloud: dest.cloud, version },
      machine: { os: `${os.type()} ${os.release()}`, cpu: os.cpus()[0]?.model || null, gpu: summary?.runs?.find((r) => r.gpu)?.gpu || null, browser: `Chrome ${browser.version()}` },
      ai: player ? { model: player.model, calls: player.calls } : null,
      profiles: runs,
      summary,
      findings,
      notes,
      dir,
    };

    // The game's dashboard, a picture of it as the board's banner, and an unlisted link to the check's page: only when
    // what the bots measured reached Glitchless, or the board and its link would show nothing.
    if (ids.length && !summary?.runs?.length) notes.push(`No dashboard or share link: ${summary ? 'nothing the bots measured reached Glitchless' : "Glitchless's summary of the runs couldn't be read"}, so they would show nothing.`);
    if (summary?.runs?.length) {
      const pages = checkDashboard(result);
      await write(base, apiKey, dest, 'PUT', `/v1/dashboard?service=${encodeURIComponent(dest.service)}`, { pages })
        .then(() => (result.dashboard = { pages: pages.map((p) => p.title) }))
        .catch((err) => notes.push(`The dashboard wasn't saved: ${err.message}`));
      const picture = runs.find((r) => r.profile === 'desktop')?.shots?.find((s) => /playing/.test(s)) || runs.flatMap((r) => r.shots || []).find((s) => /playing|end/.test(s));
      if (picture && fs.statSync(picture).size <= 300_000) {
        await upload(base, apiKey, dest, `/v1/brand/banner?service=${encodeURIComponent(dest.service)}`, fs.readFileSync(picture), 'image/jpeg').catch((err) => notes.push(`The board's banner wasn't set: ${err.message}`));
      }
      result.dashboard_url = dest.dashboard ? `${dest.dashboard}#/${CHECK_PAGE}` : `${base}/?service=${encodeURIComponent(dest.service)}#/${CHECK_PAGE}`;
      if (share && dest.cloud) {
        result.share = await shareLink(base, apiKey, dest, { from: started - 60_000, to: Date.now() + 120_000 }).catch((err) => {
          notes.push(`No share link: ${err.message}`);
          return null;
        });
      } else if (share) notes.push('No share link: share links are a Glitchless Cloud feature (sign in with a workspace key, gl_ws_…). The dashboard is on this server.');
    }

    result.report = checkReport(result);
    result.dm = checkDm(result);
    const files = { report: path.join(dir, 'report.md'), dm: path.join(dir, 'message.txt'), json: path.join(dir, 'check.json') };
    fs.writeFileSync(files.report, `${result.report}\n`);
    fs.writeFileSync(files.dm, `${result.dm}\n`);
    fs.writeFileSync(files.json, `${JSON.stringify({ ...result, report: undefined, dm: undefined }, null, 2)}\n`);
    result.files = { ...files, shots: runs.flatMap((r) => r.shots || []) };
    return result;
  } finally {
    await browser.close();
  }
}

// ───────────────────────────── playing one profile ─────────────────────────────

async function playProfile(browser, { profile, target, dest, sdk, version, seconds, ua, dir, adapters, ai, robots, log }) {
  const ctx = await browser.newContext({
    viewport: profile.viewport,
    deviceScaleFactor: profile.deviceScaleFactor || 1,
    isMobile: !!profile.isMobile,
    hasTouch: !!profile.touch,
    userAgent: ua,
    // The SDK sends to Glitchless from inside the game's page: a page whose CSP lists only its own hosts would block it.
    bypassCSP: true,
  });
  const run = { profile: profile.name, words: profileWords(profile), viewport: profile.viewport, url: target.play_url, load: null, errors: [], shots: [], steps: [], notes: [], held_back: 0 };
  const intakeHost = safeHost(dest.intake);
  const ours = (u) => safeHost(u) === intakeHost && /\/v1\//.test(u);
  // A game with Glitchless already in it would send the bots' play to its own game as players' sessions: every send
  // to a Glitchless intake (any SDK: /v1/intake?token=…) with another token than the check's is held back.
  await ctx.route(/\/v1\/intake(\?|$)/, (route) => {
    let token = null;
    try {
      token = new URL(route.request().url()).searchParams.get('token');
    } catch {}
    if (token === dest.client_token) return route.continue();
    run.held_back++;
    return route.abort('blockedbyclient');
  });
  const page = await ctx.newPage();
  // Popups and new tabs the game opens (ads, links) are closed: the check stays on the game.
  ctx.on('page', (p) => p !== page && p.close().catch(() => {}));
  page.on('dialog', (d) => d.dismiss().catch(() => {}));
  const cdp = await ctx.newCDPSession(page);
  if (profile.cpu > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: profile.cpu });
  if (profile.network) {
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', { offline: false, ...profile.network });
  }
  await page.addInitScript({
    content: checkInitScript({
      sdk,
      init: {
        adapters,
        glitchless: { service: dest.service, version, env: 'check', intake: dest.intake, clientToken: dest.client_token, sessionType: 'synthetic', overlay: false, webmcp: false, privacy: 'anonymous', properties: { profile: profile.name } },
      },
    }),
  });

  // What loading costs: bytes, requests, what's missing (4xx) or failed, and requests still in flight.
  const net = { bytes: 0, requests: 0, missing: new Map(), failed: new Map(), inflight: new Set(), lastActivity: Date.now() };
  page.on('request', (r) => {
    if (ours(r.url())) return;
    net.requests++;
    net.inflight.add(r);
    net.lastActivity = Date.now();
  });
  const done = (r) => {
    net.inflight.delete(r);
    net.lastActivity = Date.now();
  };
  page.on('requestfinished', (r) => {
    done(r);
    if (ours(r.url())) return;
    r.sizes()
      .then((s) => (net.bytes += s.responseBodySize + s.responseHeadersSize))
      .catch(() => {});
  });
  page.on('requestfailed', (r) => {
    done(r);
    if (/BLOCKED_BY_CLIENT/.test(r.failure()?.errorText || '')) return; // a send held back above
    if (ours(r.url())) {
      run.failed_sends = (run.failed_sends || 0) + 1;
      return;
    }
    const why = r.failure()?.errorText || 'failed';
    if (!/ERR_ABORTED/.test(why)) net.failed.set(shortUrl(r.url()), why);
  });
  page.on('response', (res) => {
    if (res.status() >= 400 && !ours(res.url())) net.missing.set(shortUrl(res.url()), res.status());
  });
  page.on('pageerror', (err) => run.errors.length < 50 && run.errors.push(String(err?.message || err).split('\n')[0].slice(0, 300)));
  // The browser's own complaints about the check's sends to Glitchless (CORS, a blocked address) aren't the game's.
  const aboutUs = (t) => (intakeHost && t.includes(intakeHost) && /\/v1\//.test(t)) || /\/v1\/intake\?token=/.test(t);
  page.on('console', (m) => m.type() === 'error' && run.errors.length < 50 && !/Failed to load resource/.test(m.text()) && !aboutUs(m.text()) && run.errors.push(`console: ${m.text().split('\n')[0].slice(0, 300)}`));

  // A click that leaves the game's site is undone.
  const origin = new URL(target.play_url).origin;
  let wentAway = null;
  page.on('framenavigated', (f) => {
    if (f === page.mainFrame() && f.url() !== 'about:blank' && safeOrigin(f.url()) !== origin) wentAway = f.url();
  });

  const t0 = Date.now();
  try {
    let res;
    try {
      res = await page.goto(target.play_url, { waitUntil: 'commit', referer: target.referer || undefined, timeout: 60_000 });
    } catch (err) {
      run.stopped = `${profile.name}: the game didn't load (${err.message.split('\n')[0]})`;
      return run;
    }
    await page.waitForLoadState('domcontentloaded', { timeout: 60_000 }).catch(() => {});
    const refused = refusal({ status: res?.status(), headers: res ? await res.allHeaders().catch(() => ({})) : {}, title: await page.title().catch(() => ''), body: await page.evaluate(() => document.body?.innerText?.slice(0, 4000) || '').catch(() => '') });
    if (refused) {
      run.stopped = `${target.play_url}: ${refused}, so the check stopped without playing`;
      run.refused = true;
      return run;
    }
    if (res && res.status() >= 400) {
      run.stopped = `${target.play_url} answered HTTP ${res.status()}`;
      return run;
    }

    // Loaded: the load event, then the network quiet for 2 s (a game that streams while it plays is cut off at the cap).
    const cap = (LOAD_CAP_S[profile.name] || 60) * 1000;
    await page.waitForLoadState('load', { timeout: cap }).catch(() => {});
    while (Date.now() - t0 < cap && (net.inflight.size > 0 || Date.now() - net.lastActivity < 2000)) await page.waitForTimeout(250);
    let info = await readPage(page);
    // The game in a frame of its own (a page that embeds it): play the frame itself, as for itch.io.
    if (!info?.canvas && info?.frame?.src && /^https?:/.test(info.frame.src) && safeOrigin(info.frame.src) !== origin) {
      const robotsFrame = await robotsCheck(info.frame.src, { ua, cache: robots });
      if (robotsFrame.allowed) {
        run.notes.push(`The game runs in a frame from ${safeHost(info.frame.src)}: the check played that frame.`);
        run.url = info.frame.src;
        await page.goto(info.frame.src, { waitUntil: 'load', referer: target.play_url, timeout: cap }).catch(() => {});
        while (Date.now() - t0 < cap && (net.inflight.size > 0 || Date.now() - net.lastActivity < 2000)) await page.waitForTimeout(250);
        info = await readPage(page);
      }
    }
    run.load = { ready_s: round1((net.lastActivity - t0) / 1000), timed_out: Date.now() - t0 >= cap, bytes: net.bytes, requests: net.requests };
    run.page_start = info;
    if (!info) {
      run.stopped = `${profile.name}: the page never answered`;
      return run;
    }
    if (info.init_error || !info.session) {
      run.stopped = `${profile.name}: Glitchless didn't start in the page (${info.init_error || 'no session'})`;
      return run;
    }
    run.session_id = info.session;
    log(`  loaded in ${run.load.ready_s} s, ${mb(net.bytes)} MB${info.engines.length ? `, ${info.engines.map((e) => e.name).join(' + ')}` : ''}`);

    const area = async () => {
      const r = await page.evaluate(() => window.__GLITCHLESS_CHECK__?.area?.() ?? null).catch(() => null);
      if (r && r.width >= 40 && r.height >= 40) return { x: Math.max(0, r.x), y: Math.max(0, r.y), width: Math.min(r.width, profile.viewport.width), height: Math.min(r.height, profile.viewport.height) };
      return { x: 0, y: 0, width: profile.viewport.width, height: profile.viewport.height };
    };
    const shot = async (name) => {
      const file = path.join(dir, `${profile.name}-${name}.jpg`);
      await page.screenshot({ path: file, type: 'jpeg', quality: 70 }).catch(() => null);
      return fs.existsSync(file) ? file : null;
    };
    const guard = setInterval(() => {
      if (!wentAway) return;
      run.notes.push(`A click led away from the game (${safeHost(wentAway)}); the bot went back.`);
      wentAway = null;
      page.goto(run.url, { waitUntil: 'load', timeout: 30_000 }).catch(() => {});
    }, 500);
    try {
      const played = await explore(page, { profile, seconds, cdp, area, shot, ai, log });
      Object.assign(run, { steps: played.steps, inputs: played.inputs, shots: played.shots, idle_change: played.idle_change, seconds_played: played.elapsed_s });
      run.notes.push(...played.notes);
    } finally {
      clearInterval(guard);
    }
    run.page = await readPage(page);
    // Ending the page makes the SDK send session_end and whatever it still holds.
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide'))).catch(() => {});
    await page.waitForTimeout(1500);
  } finally {
    run.load ||= { ready_s: null, bytes: net.bytes, requests: net.requests };
    run.load.missing = [...net.missing].slice(0, 12).map(([url, status]) => ({ url, status }));
    run.load.failed = [...net.failed].filter(([url]) => !/\/v1\/intake/.test(url)).slice(0, 12).map(([url, why]) => ({ url, why }));
    if (run.failed_sends) run.notes.push(`${run.failed_sends} of the check's sends to Glitchless failed.`);
    if (run.held_back) run.notes.push(`The game already sends to Glitchless itself: its ${run.held_back} send${run.held_back === 1 ? ' was' : 's were'} held back during the check, so the bots never counted as its players.`);
    run.errors = [...new Set(run.errors)];
    await ctx.close().catch(() => {});
  }
  return run;
}

const readPage = (page) => page.evaluate(() => window.__GLITCHLESS_CHECK__?.read?.() ?? null).catch(() => null);
const round1 = (v) => Math.round(v * 10) / 10;
const mb = (b) => Math.round((b / 1048576) * 10) / 10;
const safeHost = (u) => {
  try {
    return new URL(u).host;
  } catch {
    return null;
  }
};
const safeOrigin = (u) => {
  try {
    return new URL(u).origin;
  } catch {
    return null;
  }
};
const shortUrl = (u) => {
  try {
    const x = new URL(u);
    return `${x.host}${x.pathname}`.slice(0, 120);
  } catch {
    return String(u).slice(0, 120);
  }
};

// The page's own title, for the game's name when the address doesn't give one.
async function pageTitle(url, ua) {
  try {
    const html = await fetch(url, { headers: { 'user-agent': ua }, signal: AbortSignal.timeout(15_000) }).then((r) => r.text());
    const t = html.match(/<title[^>]*>([^<]{1,120})<\/title>/i)?.[1]?.trim();
    return t ? t.replace(/&amp;/g, '&').replace(/&#39;|&#x27;/g, "'").replace(/&quot;/g, '"') : null;
  } catch {
    return null;
  }
}

// ───────────────────────────── Glitchless ─────────────────────────────

// The game the check sends to. With a workspace key (Glitchless Cloud), a game by this name, made if there's none, and
// its client token; on an open server (the open-source one), a service by this name with its development token. A
// check saves its own dashboard and banner, so it only reuses a game an earlier check made (its dashboard opens on the
// check page) or one that never sent anything: a real game by the same name is left alone, and the check goes to
// "<name> (game check)" instead.
export async function checkDestination({ base, apiKey, name, log = () => {}, fetchImpl = fetch }) {
  // Whether `service` (of game `project`) belongs to a real game: a dashboard that isn't a check's, or data without one.
  const taken = async (service, project, hasData) => {
    const headers = { 'x-glitchless-client': 'game-check', ...(apiKey ? { 'x-glitchless-api-key': apiKey } : {}), ...(project ? { 'x-glitchless-project': project } : {}) };
    const saved = await fetchImpl(`${base}/v1/dashboard?service=${encodeURIComponent(service)}`, { headers })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    const pages = saved?.dashboard?.pages;
    return pages?.length ? pages[0].id !== CHECK_PAGE : hasData;
  };
  if (apiKey?.startsWith('gl_ws_')) {
    const agent = async (method, p, body) => {
      const res = await fetchImpl(`${base}/v1/agent${p}`, { method, headers: { 'x-glitchless-api-key': apiKey, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`Glitchless ${method} /v1/agent${p}: ${data.error || `HTTP ${res.status}`}`);
      return data;
    };
    const { games, intake } = await agent('GET', '/games');
    const find = (n) => games.find((g) => g.name.toLowerCase() === n.toLowerCase());
    const serviceOf = (g, n) => g?.services?.find((s) => !s.server_of)?.service || slugify(n);
    let gameName = name;
    let game = find(gameName);
    if (game && (await taken(serviceOf(game, gameName), game.id, !!game.services?.length))) {
      log(`"${game.name}" is a game of its own in your workspace, with its own data: the check goes to "${name} (game check)"`);
      gameName = `${name} (game check)`;
      game = find(gameName);
    }
    let token = game?.client_token;
    let dashboard = game?.dashboard;
    if (!game) {
      log(`making the game "${gameName}" in your workspace`);
      const made = await agent('POST', '/games', { name: gameName }).catch((err) => {
        throw new Error(`${err.message} A check makes a game of its own: make room in the workspace, or check into a game an earlier check made, by its name (check_name, or --name).`);
      });
      game = made.game;
      token = made.client_token;
      dashboard = made.dashboard;
    } else log(`using the game "${game.name}" an earlier check made`);
    return { cloud: true, game_id: game.id, name: game.name, service: serviceOf(game, gameName), client_token: token, intake: intake || base, dashboard };
  }
  const services = await fetchImpl(`${base}/v1/query/services`, { headers: { 'x-glitchless-client': 'game-check', ...(apiKey ? { 'x-glitchless-api-key': apiKey } : {}) } })
    .then((r) => (r.ok ? r.json() : null))
    .then((b) => new Set((b?.services || []).map((x) => x.service)))
    .catch(() => new Set());
  let service = slugify(name);
  let gameName = name;
  if (await taken(service, null, services.has(service))) {
    log(`"${service}" is a game of its own on this server: the check goes to "${service}-check"`);
    service = `${service}-check`;
    gameName = `${name} (game check)`;
  }
  return { cloud: false, game_id: null, name: gameName, service, client_token: process.env.GLITCHLESS_CLIENT_TOKEN || 'gl_pub_dev', intake: base, dashboard: null };
}

function headersFor(apiKey, dest) {
  return { 'x-glitchless-client': 'game-check', ...(apiKey ? { 'x-glitchless-api-key': apiKey } : {}), ...(apiKey?.startsWith('gl_ws_') && dest.game_id ? { 'x-glitchless-project': dest.game_id } : {}) };
}

function readerFor(base, apiKey, dest) {
  return async (name, params) => {
    const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
    const res = await fetch(`${base}/v1/query/${name}?${qs}`, { headers: headersFor(apiKey, dest) });
    if (!res.ok) throw new Error(`HTTP ${res.status} on ${name}: ${(await res.text()).slice(0, 200)}`);
    const body = await res.json();
    if (body.error) throw new Error(body.error);
    return body;
  };
}

async function write(base, apiKey, dest, method, p, body) {
  const res = await fetch(`${base}${p}`, { method, headers: { ...headersFor(apiKey, dest), 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function upload(base, apiKey, dest, p, bytes, type) {
  const res = await fetch(`${base}${p}`, { method: 'PUT', headers: { ...headersFor(apiKey, dest), 'content-type': type }, body: bytes });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// The summary of the check's sessions, once each has ended (Glitchless Cloud's lake can take a minute or two).
async function waitForSummary(read, service, ids, started, { log, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (true) {
    const body = await read('playtest', { service, sessions: ids.join(','), from: started - 60_000, to: Date.now() + 60_000 });
    last = body.summary;
    const ended = new Set((last?.runs || []).filter((r) => r.ended).map((r) => r.session_id));
    if (ids.every((id) => ended.has(id))) return last;
    if (Date.now() > deadline) {
      log(`  ${ids.filter((id) => !ended.has(id)).length} run(s) not complete in Glitchless yet; using what arrived`);
      return last;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
}

// An unlisted link to the check's page that shows the check's bot runs (bots: true), for 30 days.
async function shareLink(base, apiKey, dest, { from, to }) {
  const res = await fetch(`${base}/v1/agent/games/${dest.game_id}/shares`, {
    method: 'POST',
    headers: { 'x-glitchless-api-key': apiKey, 'content-type': 'application/json' },
    body: JSON.stringify({ service: dest.service, page: CHECK_PAGE, name: 'Game check', days: 30, from, to, bots: true }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  // A server from before share links could show bot runs would make a link that shows nothing: take it back.
  if (data.share?.bots !== true) {
    await fetch(`${base}/v1/agent/games/${dest.game_id}/shares/${data.share?.id}`, { method: 'DELETE', headers: { 'x-glitchless-api-key': apiKey } }).catch(() => {});
    throw new Error('this Glitchless server makes share links that show players only, so a link would show an empty board (it needs the share links that show a game check\'s bot runs)');
  }
  return { url: data.url, id: data.share.id, expires_at: data.share.expiresAt };
}

// The browser SDK's <script> build: the copy the Glitchless server serves (it matches what that server reads), else
// one built in this checkout or installed with the glitchless package.
export async function sdkScript(base, cwd = process.cwd()) {
  try {
    const res = await fetch(`${base}/sdk/glitchless.js`, { signal: AbortSignal.timeout(15_000) });
    if (res.ok && /javascript/.test(res.headers.get('content-type') || '')) return await res.text();
  } catch {}
  const candidates = [path.resolve(HERE, '../../sdk/dist/glitchless.js')];
  for (const from of [path.join(cwd, 'noop.js'), import.meta.url]) {
    try {
      candidates.push(path.resolve(path.dirname(createRequire(from).resolve('glitchless')), '../dist/glitchless.js'));
    } catch {}
  }
  const found = candidates.find((f) => fs.existsSync(f));
  if (found) return fs.readFileSync(found, 'utf8');
  throw new Error(`No Glitchless browser SDK to add to the page: ${base}/sdk/glitchless.js didn't answer and no built copy was found (in the Glitchless repo: npm run build -w glitchless).`);
}
