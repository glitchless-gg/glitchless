// Plays the configured scenarios in real Chrome with the game's autoplay bot, one at a time, then
// asks the Glitchless server for one summary of exactly the sessions this run produced.
// Bots run sequentially on purpose: parallel browsers fight over the GPU and wreck frame times.

import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

// Real GPU (Metal via ANGLE on macOS) and no background throttling, same as scripts/bots.js.
const CHROME_ARGS = ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'];

// Resolve Playwright from the game project first (where people install it), then from here.
export async function loadPlaywright(cwd = process.cwd()) {
  // Loaded by path, Playwright's CommonJS entry arrives wrapped in `default`.
  const unwrap = (mod) => (mod?.chromium ? mod : mod?.default);
  try {
    const req = createRequire(path.join(cwd, 'noop.js'));
    const pw = unwrap(await import(pathToFileURL(req.resolve('playwright')).href));
    if (pw?.chromium) return pw;
  } catch {}
  try {
    const pw = unwrap(await import('playwright'));
    if (pw?.chromium) return pw;
    throw new Error('no chromium export');
  } catch {
    throw new Error('Glitchless playtest needs Playwright to drive the browser. In your game project run: npm install -D playwright && npx playwright install chromium');
  }
}

export async function runScenarios(cfg, { scenarios = cfg.scenarios, game = cfg.game, log = () => {} } = {}) {
  const { chromium } = await loadPlaywright();
  const channel = cfg.channel === 'chromium' ? undefined : cfg.channel;
  const browser = await chromium.launch({ headless: !cfg.headed, channel, args: CHROME_ARGS }).catch(async (err) => {
    if (!channel) throw err;
    log(`Could not launch ${channel} (${err.message.split('\n')[0]}); falling back to Playwright's Chromium.`);
    return chromium.launch({ headless: !cfg.headed, args: CHROME_ARGS });
  });
  const started = Date.now();
  const results = [];
  let service = cfg.service;
  try {
    for (const [i, sc] of scenarios.entries()) {
      const qs = new URLSearchParams({ mute: '1', env: cfg.env, intake: cfg.server.replace(/\/$/, ''), ...Object.fromEntries(Object.entries(sc.params || {}).map(([k, v]) => [k, String(v)])) });
      const url = `${game}${game.includes('?') ? '&' : '?'}${qs}`;
      const ctx = await browser.newContext({ viewport: cfg.viewport });
      const page = await ctx.newPage();
      const t0 = Date.now();
      log(`run ${i + 1}/${scenarios.length}: ${sc.name || JSON.stringify(sc.params)} …`);
      await page.goto(url, { waitUntil: 'load' });
      const ready = await page.waitForFunction(() => window.__GLITCHLESS__?.sessionId, null, { timeout: 20_000 }).catch(() => null);
      if (!ready) {
        await ctx.close();
        throw new Error(`Glitchless never started on ${url}. Is the game running, and does it call Glitchless.init()?`);
      }
      const maxMs = (sc.max_s || 90) * 1000;
      let finished = false;
      while (Date.now() - t0 < maxMs) {
        await page.waitForTimeout(1000);
        finished = await page.evaluate((expr) => !!new Function(`return (${expr})`)(), cfg.done_when).catch(() => true);
        if (finished) break;
      }
      const info = await page.evaluate(() => ({
        session: window.__GLITCHLESS__?.sessionId,
        service: window.__GLITCHLESS__?.opts?.service,
        version: window.__GLITCHLESS__?.opts?.version,
        sent: window.__GLITCHLESS__?.stats?.sent,
        failed: window.__GLITCHLESS__?.stats?.failed,
      }));
      // Ending the page makes the SDK send session_end and flush whatever is still queued.
      await page.evaluate(() => window.dispatchEvent(new Event('pagehide'))).catch(() => {});
      await page.waitForTimeout(1000);
      await ctx.close();
      service ||= info.service;
      const seconds = Math.round((Date.now() - t0) / 1000);
      results.push({ scenario: sc.name || null, params: sc.params, session_id: info.session, game_version: info.version, seconds, finished, events_failed: info.failed || 0 });
      log(`  → ${info.session} · ${seconds}s${finished ? '' : ' (hit the time cap)'}${info.failed ? ` · ${info.failed} events failed to send` : ''}`);
    }
  } finally {
    await browser.close();
  }
  return { started, service, results };
}

// The SDK sends on a timer and on pagehide, so give the server a moment to have every session.
export async function fetchSummary(cfg, service, sessionIds, started, { log = () => {}, timeoutMs = 20_000 } = {}) {
  const base = cfg.server.replace(/\/$/, '');
  const qs = new URLSearchParams({ service, sessions: sessionIds.join(','), from: String(started - 60_000), to: String(Date.now() + 60_000) });
  const headers = { 'x-glitchless-client': 'playtest', ...(cfg.api_key ? { 'x-glitchless-api-key': cfg.api_key } : {}) };
  const deadline = Date.now() + timeoutMs;
  let last;
  while (true) {
    const res = await fetch(`${base}/v1/query/playtest?${qs}`, { headers });
    if (!res.ok) throw new Error(`Glitchless server ${base} answered HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = await res.json();
    if (body.error) throw new Error(`Glitchless server: ${body.error}`);
    last = body.summary;
    const seen = new Set((last?.runs || []).filter((r) => r.ended).map((r) => r.session_id));
    if (sessionIds.every((id) => seen.has(id))) return last;
    if (Date.now() > deadline) {
      log(`  ${sessionIds.filter((id) => !seen.has(id)).length} session(s) never reported an end; using what arrived.`);
      return last;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
}

export function gitInfo(cwd = process.cwd()) {
  try {
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const dirty = execFileSync('git', ['status', '--porcelain'], { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().length > 0;
    return { sha, dirty };
  } catch {
    return null;
  }
}

export function machineInfo(summary, channel) {
  const gpu = summary?.runs?.find((r) => r.gpu)?.gpu || null;
  return { os: `${os.type()} ${os.release()}`, cpu: os.cpus()[0]?.model || null, gpu, browser: summary?.runs?.find((r) => r.browser)?.browser || channel };
}

// Play every scenario and return a run record ready to save or compare.
export async function playtestRun(cfg, { game = cfg.game, scenarios = cfg.scenarios, log = () => {} } = {}) {
  const { started, service, results } = await runScenarios(cfg, { game, scenarios, log });
  if (!service) throw new Error('Could not tell which game this is. Pass --service or set "service" in glitchless.playtest.json.');
  const ids = results.map((r) => r.session_id).filter(Boolean);
  log(`collecting results for ${ids.length} session(s) from ${cfg.server} …`);
  const summary = await fetchSummary(cfg, service, ids, started, { log });
  return {
    created: new Date().toISOString(),
    game,
    server: cfg.server,
    service,
    git: gitInfo(),
    machine: machineInfo(summary, cfg.channel),
    scenarios: results,
    summary,
  };
}
