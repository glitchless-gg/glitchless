// What a game check says: the report for the game's maker (markdown), the three sentences to send them with the link,
// and the dashboard made for their game. Plain words with players as the unit ("a player on a phone waits 31
// seconds"), and always that the numbers come from Glitchless's test machine, not from the game's players. The
// measurements an agent wants (percentiles, findings' ids) go in their own part at the end.

export const CHECK_PAGE = 'check';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const r0 = (v) => Math.round(v);
const r1 = (v) => Math.round(v * 10) / 10;
const mb = (b) => (b >= 1048576 ? `${r1(b / 1048576)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const median = (xs) => {
  const s = xs.filter(isNum).sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const seconds = (s) => (s >= 90 ? `${r1(s / 60)} minutes` : `${r0(s)} seconds`);

// Engines by the names check-page.js finds them by, as people write them.
const ENGINE_WORDS = { three: 'Three.js', phaser: 'Phaser', babylon: 'Babylon.js', playcanvas: 'PlayCanvas', unity: 'Unity', godot: 'Godot', gamemaker: 'GameMaker', construct: 'Construct', gdevelop: 'GDevelop', defold: 'Defold', pixi: 'PixiJS', 'pico-8': 'PICO-8', kaplay: 'KAPLAY', ruffle: 'Flash (played with Ruffle)', emscripten: 'WebAssembly (Emscripten)' };

// What the game is made with, in words: "Phaser 3.88 on WebGL", "Unity", "a 2D canvas, no engine Glitchless knows".
export function engineWords(page) {
  if (!page) return null;
  const e = page.engines?.[0];
  const drawing = page.webgpu ? 'WebGPU' : page.contexts?.includes('webgl2') || page.contexts?.includes('webgl') ? 'WebGL' : page.contexts?.includes('2d') ? 'a 2D canvas' : null;
  if (e) {
    const name = ENGINE_WORDS[e.name] || e.name.replace(/^rpg maker/, 'RPG Maker');
    const version = e.version && e.name !== 'three' ? ` ${e.version}` : e.version ? ` r${String(e.version).replace(/^r/, '')}` : '';
    return `${name}${version}${drawing && !['unity', 'godot', 'gamemaker'].includes(e.name) ? ` on ${drawing}` : ''}`;
  }
  return drawing ? `${drawing === 'a 2D canvas' ? 'a 2D canvas' : drawing}, with no engine Glitchless recognises` : 'an HTML page with no canvas';
}

// One profile's numbers: loading, frames, freezes, errors and memory, from Glitchless's summary of its session when
// there is one, else from what the bot measured itself.
export function profileNumbers(run, summary) {
  const s = summary?.runs?.find((x) => x.session_id === run.session_id) || null;
  const steps = (run.steps || []).filter((st) => st.frames?.n);
  const frames = steps.map((st) => st.frames);
  const worst = steps.reduce((w, st) => ((st.frames.p95 ?? 0) > (w?.frames.p95 ?? 0) ? st : w), null);
  // The longest single frame, and when: a freeze players notice (over 50 ms).
  const longest = steps.reduce((w, st) => ((st.frames.max ?? 0) > (w?.frames.max ?? 0) ? st : w), null);
  const heaps = (run.steps || []).map((st) => st.heap_mb).filter(isNum);
  const third = Math.max(1, Math.floor(heaps.length / 3));
  const avg = (xs) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
  const [h1, h2, h3] = [avg(heaps.slice(0, third)), avg(heaps.slice(third, third * 2)), avg(heaps.slice(-third))];
  const heap = heaps.length >= 3 ? { start: heaps[0], end: heaps.at(-1), peak: Math.max(...heaps), climbing: heaps.at(-1) - heaps[0] >= 15 && h3 > h2 && h2 > h1 } : null;
  // Late frames from the bot's own clock when Glitchless's summary is missing (the same 1.15× budget).
  const counted = frames.reduce((a, f) => a + f.n, 0);
  const localSlow = counted ? r1((frames.reduce((a, f) => a + (f.late || 0), 0) / counted) * 100) : null;
  return {
    profile: run.profile,
    played_s: run.seconds_played ?? null,
    ready_s: run.load?.ready_s ?? null,
    load_timed_out: !!run.load?.timed_out,
    bytes: run.load?.bytes ?? null,
    requests: run.load?.requests ?? null,
    late_pct: s?.pct_over_budget ?? localSlow,
    budget_ms: s?.budget_ms ?? null,
    p50: s?.p50 ?? median(frames.map((f) => f.p50)),
    p95: s?.p95 ?? median(frames.map((f) => f.p95)),
    hitches: s?.hitches ?? null,
    errors: s?.errors ?? null,
    gpu: s?.gpu ?? null,
    draws: median(frames.map((f) => f.draws)),
    freeze: longest && longest.frames.max > 50 ? { t: longest.t, max: longest.frames.max, words: longest.words, label: longest.label || longest.level || null } : null,
    worst: worst && worst.frames.p95 > 25 ? { t: worst.t, p95: worst.frames.p95, max: worst.frames.max, words: worst.words, label: worst.label || worst.level || null, screen: worst.screen || null } : null,
    heap,
  };
}

// "1 in 40 frames" for a share of frames that were late.
function lateWords(pct) {
  if (!isNum(pct)) return null;
  if (pct < 0.5) return 'fewer than 1 in 200 frames';
  if (pct >= 40) return `${r0(pct)}% of frames`;
  return `1 in ${r0(100 / pct)} frames`;
}

// The errors of the check, merged: Glitchless's (with where they happened) first, then what the browser printed.
function errorList(result) {
  const out = [];
  const runs = result.profiles.filter((p) => p.session_id).length;
  for (const e of result.summary?.errors || []) out.push({ message: e.message, location: e.location || null, count: e.count, runs: e.sessions, of: runs, kind: e.kind });
  for (const p of result.profiles)
    for (const m of p.errors || []) {
      const msg = m.replace(/^console: /, '');
      if (out.some((e) => e.message && (msg.includes(e.message) || e.message.includes(msg)))) continue;
      const have = out.find((e) => e.message === msg && !e.location);
      if (have) have.runs = Math.min(runs, (have.runs || 1) + 1);
      else out.push({ message: msg, location: null, count: null, runs: 1, of: runs, console: m.startsWith('console: ') });
    }
  return out.filter((e) => e.message);
}

// What the bot saw that a dashboard with Glitchless installed would count: levels and waves on screen (or the scenes
// an engine adapter reported), the modes its buttons offer, and the inputs the game answered to.
const MODE = /^(easy|normal|medium|hard|expert|insane|endless|story|arcade|survival|classic|versus|vs\.?|co-?op|multiplayer|single ?player|1 ?player|2 ?players?|practice|tutorial|daily( challenge)?|challenge|campaign|online|local|time attack|zen|casual|ranked|sandbox|creative|level select|free play|puzzle|speedrun)$/i;
export function whatTheBotSaw(result) {
  const labels = {};
  const modes = new Set();
  const levels = new Set();
  for (const p of result.profiles) {
    for (const [k, n] of Object.entries(p.page?.labels || {})) labels[k] = (labels[k] || 0) + n;
    for (const b of Object.keys(p.page?.buttons || {})) if (MODE.test(b.trim())) modes.add(b.trim());
    for (const st of p.steps || []) {
      if (st.label) labels[st.label] = (labels[st.label] || 0) + 1;
      if (st.level) levels.add(st.level);
    }
  }
  for (const l of Object.keys(result.summary?.levels || {})) levels.add(l);
  const order = (a, b) => a.localeCompare(b, undefined, { numeric: true });
  const shown = Object.keys(labels).sort(order).slice(0, 12);
  const worked = [...new Set(result.profiles.flatMap((p) => p.inputs?.worked || []))];
  return { labels: shown, levels: [...levels].sort(order).slice(0, 12), modes: [...modes].slice(0, 8), worked };
}

// The sentences that lead: the most useful thing the check found first (an error, a phone that can't keep up, a long
// load, memory that climbs), else that it ran well. Each is about players.
export function headlines(result) {
  const out = [];
  const nums = Object.fromEntries(result.profiles.map((p) => [p.profile, profileNumbers(p, result.summary)]));
  const d = nums.desktop;
  const ph = nums.phone;
  const errors = errorList(result).filter((e) => !e.console);
  if (errors.length) {
    const e = errors[0];
    const every = e.of > 1 && e.runs >= e.of;
    const at = whereWords(e.location);
    out.push({ weight: 100, text: `${every ? 'every run hit' : e.of > 1 ? `${e.runs} of ${e.of} runs hit` : 'the run hit'} an error${at ? ` in ${at}` : ''} ("${e.message.slice(0, 90)}")${errors.length > 1 ? `, one of ${errors.length} different errors` : ''}, so players ${every ? 'likely' : 'may'} hit it too` });
  }
  const loadOf = (n) => (n?.load_timed_out ? `more than ${r0(n.ready_s)} seconds` : isNum(n?.ready_s) ? `about ${r0(Math.max(1, n.ready_s))} seconds` : null);
  if (ph && isNum(ph.late_pct) && ph.late_pct >= 10) out.push({ weight: 80 + ph.late_pct / 5, text: `on a phone-speed CPU the game can't keep up: ${lateWords(ph.late_pct)} came late${d && isNum(d.late_pct) ? `, against ${lateWords(d.late_pct)} on a desktop` : ''}, so a player on a mid-range phone feels it stutter` });
  if (d && isNum(d.late_pct) && d.late_pct >= 5) out.push({ weight: 85, text: `even on a fast desktop, ${lateWords(d.late_pct)} came late${d.worst ? `, worst ${r0(d.worst.t)} seconds in (${d.worst.label || d.worst.words}): frames took up to ${r0(d.worst.max || d.worst.p95)} ms` : ''}` });
  for (const n of [d, ph].filter(Boolean)) {
    const perMin = isNum(n.hitches) && n.played_s ? n.hitches / (n.played_s / 60) : 0;
    if (perMin < 3) continue;
    out.push({ weight: 75 + Math.min(10, perMin), text: `the game froze for a moment ${plural(n.hitches, 'time')} in ${seconds(n.played_s)} ${n.profile === 'phone' ? 'on the phone' : 'on a desktop'}${n.freeze ? `, the longest for ${r0(n.freeze.max)} ms${n.freeze.label ? ` on ${n.freeze.label}` : ''}` : ''}` });
    break;
  }
  const slowLoad = ph?.ready_s >= 15 ? ph : d?.ready_s >= 8 ? d : null;
  if (slowLoad) out.push({ weight: 60 + Math.min(30, slowLoad.ready_s), text: `a player ${slowLoad === ph ? 'on a phone over 4G' : 'on a desktop'} waits ${loadOf(slowLoad)} before it's ready${isNum(slowLoad.bytes) ? `, while it downloads ${mb(slowLoad.bytes)}` : ''}` });
  for (const n of [d, ph].filter(Boolean))
    if (n.heap?.climbing) {
      out.push({ weight: 70, text: `its memory kept climbing ${n.profile === 'phone' ? 'on the phone' : 'on the desktop'}, from ${n.heap.start} to ${n.heap.end} MB in ${seconds(n.played_s || 60)}, so a long session may run out (phones close the tab)` });
      break;
    }
  const missing = result.profiles.flatMap((p) => p.load?.missing || []);
  const gone = new Set(missing.map((m) => m.url)).size;
  if (gone) out.push({ weight: 40, text: `it asks for ${plural(gone, 'file')} that ${gone === 1 ? "isn't" : "aren't"} there (${missing[0].status})` });
  if (!out.length && d) {
    const fine = [`it ran smoothly on a desktop (${lateWords(d.late_pct) || 'almost no frames'} late)`];
    if (ph) fine.push(isNum(ph.late_pct) ? `on a phone-speed CPU ${lateWords(ph.late_pct)} came late` : 'it held up on a phone-speed CPU');
    if (isNum(d.ready_s)) fine.push(`it's ready to play in ${loadOf(d)}`);
    out.push({ weight: 10, text: `good news: ${fine.join(', ')}, and the bots hit no errors` });
  }
  return out.sort((a, b) => b.weight - a.weight).map((h) => h.text);
}

// The three sentences to send the game's maker, with the link.
export function checkDm(result) {
  const lead = headlines(result);
  const link = result.share?.url || result.dashboard_url || '';
  const name = result.game.name;
  const where = result.profiles.some((p) => p.profile === 'phone') ? (result.profiles.some((p) => p.profile === 'desktop') ? ' on a desktop and on a throttled phone' : ' on a throttled phone') : ' on a desktop';
  const first = `I had Glitchless's bots play ${name} for a few minutes${where}, and ${link ? `made a dashboard of what they found: ${link}` : 'wrote up what they found.'}`;
  const finding = lead.slice(0, 2).join('; ');
  const close = `It's from our test machine, not your players: with Glitchless in the game, your coding agent gets the same from every player's session${link ? ', and the board is yours to keep' : ''}.`;
  return `${first}\n\n${finding ? `${finding[0].toUpperCase()}${finding.slice(1)}. ` : ''}${close}`;
}

// The report, in markdown.
export function checkReport(result) {
  const { game, target } = result;
  const runs = result.profiles;
  const nums = runs.map((p) => profileNumbers(p, result.summary));
  const page = runs.find((p) => p.page)?.page || runs.find((p) => p.page_start)?.page_start;
  const engine = engineWords(page);
  const out = [`# Game check: ${game.name}`, ''];
  out.push(`${target.page_url}${target.site ? ` (${target.site})` : ''} · checked ${result.checked_at.slice(0, 16).replace('T', ' ')} UTC by Glitchless's bots${engine ? ` · made with ${engine}` : ''}`, '');
  const lead = headlines(result);
  if (lead.length) out.push(...lead.slice(0, 3).map((h) => `- ${h[0].toUpperCase()}${h.slice(1)}.`), '');
  const link = result.share?.url || result.dashboard_url;
  if (link) out.push(`The dashboard: ${link}${result.share?.url ? ` (unlisted, shows this check only, for 30 days)` : ''}`, '');
  for (const n of result.notes || []) out.push(`> ${n}`, '');

  out.push('## What the bots did', '');
  for (const p of runs) {
    const label = p.profile === 'phone' ? 'On a phone' : 'On a desktop';
    if (p.stopped && !p.steps?.length) {
      out.push(`- **${label}** (${p.words}): ${p.stopped}.`);
      continue;
    }
    const tried = p.inputs?.tried?.length ? ` It tried ${p.inputs.tried.join('; ')}.` : '';
    const worked = p.inputs?.worked?.length ? ` The screen changed most with ${p.inputs.worked.slice(0, 2).join(', then ')}.` : p.inputs?.tried?.length ? ' No input changed the screen more than waiting did, so the bot may not have got past the start.' : '';
    const carried = (p.steps || []).filter((s) => s.carried_on).length;
    out.push(`- **${label}** (${p.words}): played ${seconds(p.seconds_played || 0)}. ${(p.notes || []).filter((n) => n.startsWith('To start')).join(' ')}${tried}${worked}${carried ? ` The screen stopped changing ${plural(carried, 'time')} (a game over or a menu), and the bot carried on.` : ''}`);
  }
  if (result.ai) out.push(`- The inputs were picked by ${result.ai.model}, which looked at the screen ${plural(result.ai.calls, 'time')}.`);
  out.push('');

  const cols = nums.map((n) => (n.profile === 'phone' ? 'Phone' : 'Desktop'));
  const row = (label, f) => `| ${label} | ${nums.map((n) => f(n) ?? '–').join(' | ')} |`;
  out.push('## Loading and play', '', `| | ${cols.join(' | ')} |`, `| --- | ${cols.map(() => '---:').join(' | ')} |`);
  out.push(row('Ready to play after', (n) => (isNum(n.ready_s) ? `${n.load_timed_out ? 'over ' : ''}${r0(Math.max(1, n.ready_s))} s` : null)));
  out.push(row('Downloaded', (n) => (isNum(n.bytes) ? mb(n.bytes) : null)));
  out.push(row('Late frames', (n) => lateWords(n.late_pct)));
  out.push(row('A typical frame', (n) => (isNum(n.p50) ? `${r1(n.p50)} ms` : null)));
  out.push(row('The slowest 1 in 20 frames', (n) => (isNum(n.p95) ? `${r1(n.p95)} ms or more` : null)));
  out.push(row('Freezes (a frame over 50 ms)', (n) => (isNum(n.hitches) ? String(n.hitches) : null)));
  out.push(row('Draw calls a frame', (n) => (isNum(n.draws) ? String(n.draws) : null)));
  out.push(row('JavaScript memory', (n) => (n.heap ? `${n.heap.start} → ${n.heap.end} MB${n.heap.climbing ? ', climbing' : ''}` : null)));
  out.push('');
  const budget = nums.find((n) => n.budget_ms)?.budget_ms;
  out.push(`A frame is late when it takes more than 1.15 times the screen's frame time${budget ? ` (${r1(budget)} ms)` : ''}; players feel late frames as stutter.`);
  for (const n of nums)
    if (n.freeze) out.push(`${n.profile === 'phone' ? 'On the phone' : 'On the desktop'}, the longest freeze came ${r0(n.freeze.t)} seconds in${n.freeze.label ? `, on ${n.freeze.label}` : ''}: one frame took ${r0(n.freeze.max)} ms.`);
  for (const n of nums)
    if (n.worst) out.push(`${n.profile === 'phone' ? 'On the phone' : 'On the desktop'}, the slowest moment came ${r0(n.worst.t)} seconds in${n.worst.label ? `, on ${n.worst.label}` : ''}, while the bot was ${n.worst.screen ? `playing (${n.worst.screen})` : `using ${n.worst.words}`}: frames took up to ${r0(n.worst.max || n.worst.p95)} ms.`);
  const missing = [...new Map(runs.flatMap((p) => p.load?.missing || []).map((m) => [m.url, m])).values()];
  if (missing.length) out.push('', `Files the game asks for that aren't there: ${missing.slice(0, 6).map((m) => `\`${m.url}\` (${m.status})`).join(', ')}${missing.length > 6 ? ', …' : ''}.`);
  out.push('');

  const errors = errorList(result);
  out.push('## Errors', '');
  if (!errors.length) out.push('The bots hit no errors.');
  for (const e of errors.slice(0, 8)) out.push(`- \`${e.message.slice(0, 200)}\`${e.location ? ` at ${e.location}` : ''}${e.count ? `: ${plural(e.count, 'time')}` : ''}${e.of > 1 ? `, in ${e.runs} of ${e.of} runs` : ''}${e.console ? ' (printed to the console)' : ''}`);
  out.push('');

  const saw = whatTheBotSaw(result);
  out.push('## With Glitchless installed', '');
  out.push('These numbers are from two bot runs. With Glitchless in the game, the same comes from every player\'s session, on their own phones and computers, and the dashboard\'s other pages fill in:');
  out.push(`- Where players stop${saw.labels.length || saw.levels.length ? `: the bot saw ${listWords((saw.levels.length ? saw.levels : saw.labels).slice(0, 6))}` : ''}, and how many get through each.`);
  if (saw.modes.length) out.push(`- Which modes keep players: ${listWords(saw.modes)}.`);
  out.push(`- What players do${saw.worked.length ? ` with ${saw.worked.slice(0, 2).join(' and with ')}` : ''}: the game's own actions, counted per player, and who comes back the next day.`);
  out.push('- Errors with the level, the device and what the player did just before.');
  if (target.site === 'itch.io') out.push("- With the itch.io page connected, its views, downloads and ratings next to the plays Glitchless counts.");
  out.push('', 'To add it, paste this into your coding agent: "Add Glitchless (www.glitchless.gg) to this game, then make it a dashboard."', '');

  out.push('## The fine print', '');
  const m = result.machine || {};
  out.push(`- Every number here comes from Glitchless's test machine (${[m.os, m.cpu, nums.find((n) => n.gpu)?.gpu, m.browser].filter(Boolean).join(', ')}), not from the game's players.${nums.some((n) => n.profile === 'phone') ? " The phone is that same computer with its CPU slowed 4×, a phone's screen and a 4G-like connection, not a real phone." : ''}`);
  out.push('- The check is private: its game and dashboard are in the checker\'s own Glitchless workspace, nothing ranks games, and its bot runs are marked as bots, so they never count as players.');
  out.push(`- It played a few minutes from one computer and asked the site's robots.txt first.${target.site === 'itch.io' ? ' itch.io\'s game frame was played on its own, at the size the page shows it.' : ''}`);
  out.push('');

  out.push('## For your coding agent', '');
  out.push(`Glitchless game "${game.in_glitchless || game.name}", service \`${game.service}\`${game.id ? ` (${game.id})` : ''}, version \`${game.version}\`, sessions ${runs.map((p) => p.session_id && `\`${p.session_id}\` (${p.profile})`).filter(Boolean).join(', ') || 'none'}; read them with glitchless_triage or glitchless_session.`);
  const f = result.findings || [];
  if (f.length) {
    out.push('', 'Findings:');
    for (const x of f.slice(0, 8)) out.push(`- [${x.severity}] ${x.title} (\`${x.id}\`)`);
  }
  const adapters = [...new Set(runs.flatMap((p) => p.page?.adapters || []))];
  const adapterErrors = [...new Set(runs.flatMap((p) => p.page?.adapter_errors || []))];
  if (adapters.length) out.push('', `The check handed the game's ${listWords(adapters.map((a) => ENGINE_WORDS[a] || a))} engine to Glitchless's adapter, as installing Glitchless with its defaults would.`);
  if (adapterErrors.length) out.push('', `Adapter problems: ${adapterErrors.join('; ')}.`);
  const notes = runs.flatMap((p) => (p.notes || []).filter((n) => !n.startsWith('To start')));
  if (notes.length) out.push('', ...notes.map((n) => `- ${n}`));
  return out.join('\n');
}

// Where an error happened, short: "fireLaser" for a function in an inline script, "player.js:120" for a file.
function whereWords(location) {
  if (!location) return null;
  const m = String(location).match(/^(.+?) \((.*?):(\d+)(?::\d+)?\)$/);
  if (m) return m[2] === '?' || !m[2] ? m[1] : `${m[1]} (${m[2].split(/[\\/]/).pop()}:${m[3]})`;
  return String(location).split(/[\\/]/).pop();
}

function listWords(xs) {
  const a = [...xs];
  return a.length <= 1 ? a.join('') : `${a.slice(0, -1).join(', ')} and ${a.at(-1)}`;
}

// The dashboard made for the game: the check's page first (the one its share link shows), then the pages that fill
// in once Glitchless is installed, named so, with notes built from what the bot saw. ≤ 200 characters a note.
export function checkDashboard(result) {
  const saw = whatTheBotSaw(result);
  const where = (saw.levels.length ? saw.levels : saw.labels).slice(0, 4);
  const bot = 'From Glitchless\'s bots on its test machine, not players.';
  const installed = 'Fills in with Glitchless installed:';
  const cut = (s) => (s.length > 200 ? `${s.slice(0, 197)}…` : s);
  const check = {
    id: CHECK_PAGE,
    title: 'Game check',
    icon: 'overview',
    panels: [
      { type: 'stat', metric: 'avg_fps', title: 'Frames a second', size: 's', note: cut(`${bot} Desktop and phone runs together.`) },
      { type: 'stat', metric: 'frame_p95', title: 'Slowest 1 in 20 frames (ms)', size: 's', note: cut(`${bot} Over 1.15× the screen's frame time is a late frame.`) },
      { type: 'stat', metric: 'hitches_per_min', title: 'Freezes a minute', size: 's', note: cut(`${bot} A freeze is a frame over 50 ms, well above the frames around it.`) },
      { type: 'stat', metric: 'errors', title: 'Errors', size: 's', note: bot },
      { type: 'versions', by: '$profile', title: 'Desktop and a throttled phone', size: 'l', note: cut(`${bot} Phone: the same computer with its CPU slowed 4×, a phone's screen and a 4G-like connection.`) },
      { type: 'frame_time', title: 'Frame time while the bots played', size: 'm', note: bot },
      ...(result.findings?.length ? [{ type: 'findings', title: 'What to fix first', size: 'm', limit: 6 }] : []),
      { type: 'errors', title: 'Errors the bots hit', size: 'm', limit: 8, note: bot },
      { type: 'table', event: 'glitchless_check', title: 'What the bots did', size: 'm', columns: ['profile', 'step', 'input', 'screen', 'label'], limit: 12, note: 'Each step of the bots\' play: the inputs they tried and whether the screen moved.' },
      { type: 'levels', title: 'Levels (with Glitchless installed)', size: 'l', note: cut(`${installed} where players stop and how many get through${where.length ? `. The bots saw ${listWords(where)}` : ''}.`) },
    ],
  };
  const players = {
    id: 'players',
    title: 'Players · with Glitchless installed',
    icon: 'players',
    panels: [
      { type: 'stat', metric: 'players', title: 'Players', size: 's', note: cut(`${installed} people who played, never bots.`) },
      { type: 'stat', metric: 'median_session_s', title: 'A typical session (s)', size: 's', note: installed.replace(':', '.') },
      { type: 'stat', metric: 'crash_free_pct', title: 'Sessions without a crash (%)', size: 's', note: installed.replace(':', '.') },
      { type: 'stat', metric: 'rage_quit_pct', title: 'Quit in frustration (%)', size: 's', note: cut(`${installed} players who left right after dying or failing.`) },
      { type: 'retention', title: 'Players coming back', size: 'l', note: cut(`${installed} who comes back the next day and the next week (with player IDs on).`) },
      { type: 'deaths', title: 'Where players die', size: 'm', note: cut(`${installed} deaths by level and cause.`) },
      { type: 'levels', title: 'Levels', size: 'm', note: cut(`${installed} starts, clears and fails per level${where.length ? ` (the bots saw ${listWords(where)})` : ''}.`) },
    ],
  };
  const play = {
    id: 'play',
    title: 'How they play · with Glitchless',
    icon: 'events',
    panels: [
      { type: 'events', title: "The game's own events", size: 'l', note: cut(`${installed} what the game counts with track(): ${saw.worked.length ? `the actions behind ${saw.worked.slice(0, 2).join("; ")}` : 'its actions'}, picks and purchases.`) },
      { type: 'versions', by: '$mode', title: 'Modes side by side', size: 'l', note: cut(`${installed} each mode's numbers, with the mode set as a session property${saw.modes.length ? `. The bots saw ${listWords(saw.modes)}` : ''}.`) },
      { type: 'reports', title: 'Bug reports from players', size: 'm', note: cut(`${installed} players send a bug report from the game (F8), with a screenshot.`) },
    ],
  };
  return [check, players, play, { id: 'performance', title: 'Performance', view: 'performance' }, { id: 'errors', title: 'Errors', view: 'errors' }, { id: 'sessions', title: "The bots' runs", icon: 'sessions', view: 'sessions' }];
}
